# 0004 — Strong INCR/DECR invariant for the call limiter

**Status:** accepted (2026-05-16)

## Context

The 2026-05-15 endurance run showed a transient limiter-Redis loss (~73 s)
cascade into ~110 s of total worker service loss — well past the 1–2 s chaos
SLA. Post-mortem ([docs/plan/to-review-and-properly-swift-moler.md](../plan/to-review-and-properly-swift-moler.md))
identified four independent causes; this ADR pins the structural fix for
two of them and the invariant that prevents their re-introduction:

- The limiter's `Effect.catchTag("RedisError")` fail-open path did not
  fire on every failure mode (notably: TCP black-hole, where ioredis
  silently buffers commands during reconnect and resolves them late, so
  the caller's `Effect` never sees a `RedisError`).
- An `INCR`/`DECR` asymmetry: when fail-open *did* fire and admitted the
  call, the cleanup path unconditionally emitted `DECR` for every
  `limiterEntry`. Limiters whose `INCR` never landed got `DECR`'d on
  termination → the cluster-wide counter drifted negative, allowing
  over-cap traffic for the rest of the run.

Stage-3 (per-call FIFO dispatch) is tracked separately; **that** decision
gets its own ADR.

## Decision: bounded limiter I/O at two layers

The limiter Redis connection has a hard wall-clock budget on every
command. Implemented at two cooperating layers:

| Layer | Setting | Where | Why |
|---|---|---|---|
| ioredis (primary) | `commandTimeout: 100` | `src/redis/LimiterRedisClient.ts` | Cap every command at the wire layer. The fix for the TCP black-hole stall — ioredis was holding a Promise pending forever during a TCP black-hole (no FIN, no RST), defeating the upstream `catchTag`. |
| ioredis | `enableOfflineQueue: false` | same | Reject during reconnect instead of silently buffering. Buffered-replay was producing late successes that defeated the Effect-side timeout. |
| ioredis | `maxRetriesPerRequest: 1` | same | Bound the ioredis internal retry loop so a single command cannot blow the 100 ms budget by repeated internal retries. |
| Effect (defense-in-depth) | `Effect.timeoutOrElse(Duration.millis(150))` → `LimiterTimeout` | `src/call/CallLimiter.ts` | Outer safety net. Only fires when ioredis itself fails to surface its own timeout (unrecoverable command state). The 50 ms gap guarantees the ioredis layer wins on every normal pathology. |

The Effect-layer bound also satisfies the must-run rule from ADR-0003:
the limiter call is `soft`-category, and `Effect.timeoutOrElse` interrupts
the underlying fiber on expiry — no leaked pending command.

## Decision: typed channels replace the `undefined`-marker contract

```ts
type LimiterDecision =
  | { _tag: "Allowed";  currentWindow: number }
  | { _tag: "Rejected" }       // limit-exceeded; success-channel outcome

type LimiterBackendError =
  | { _tag: "RedisError"; cause: RedisError }
  | { _tag: "LimiterTimeout"; budgetMs: 150 }

checkAndIncrement(id, limit): Effect<LimiterDecision, LimiterBackendError>
```

Rationale:

- `Rejected` (cap hit) is **not an error** — it's a planned admission
  outcome. The caller sends 486 / failover. Putting it on the success
  channel keeps the error channel honest (only true backend failures
  live there) and makes `Effect.catchTags` narrow exactly the failure
  modes that need fail-open treatment.
- `Effect<X, never>` for `Allowed/Rejected/undefined` — the pre-fix shape
  — could not distinguish "limiter said no" from "limiter could not say
  anything", which is what made the symmetric-`DECR` bug possible in the
  first place. The typed contract forces the caller to handle both
  failure tags explicitly.

The caller pattern at the SIP hot path (`applyRoute`):

```ts
const admission = yield* limiter.checkAndIncrement(entry.id, entry.limit).pipe(
  Effect.catchTags({
    RedisError:     (e) => log(...).pipe(Effect.as("admit-no-tag")),
    LimiterTimeout: (e) => log(...).pipe(Effect.as("admit-no-tag")),
  }),
)
```

Both backend errors fold into the same "admit-no-tag" admission so the
hot path branches stay narrow.

## Decision: a structural INCR ↔ DECR invariant

> **A successful limiter `INCR` is matched by exactly one `DECR`.
> On any error after a successful `INCR`, the `DECR` fires immediately
> — before the failure propagates out of `applyRoute`.**

This is the load-bearing invariant. It is enforced by three structural
choices, not by reviewer discipline at every call-site.

### 1. The `incrementSucceeded` flag on `CallLimiterState`

`Call.limiterEntries` element shape:

```ts
{ limiterId, limit, originWindow, incrementSucceeded?: boolean }
```

- `incrementSucceeded: true` — the matching Lua `INCR` landed on Redis.
- `incrementSucceeded: false` — the limiter was unavailable (`RedisError`
  / `LimiterTimeout`); the call was admitted fail-open; Redis was
  **not** incremented.
- `undefined` — older replicated entries from before this change. All
  pre-change admissions were successful `INCR`s (the pre-change code
  couldn't admit without one), so `undefined ≡ true`.

Every code path that emits `decrement-limiter` filters on
`incrementSucceeded !== false`:

- `src/b2bua/helpers.ts` — `terminateCallEffects` and
  `finalCleanupEffects` (the canonical termination-effect builders).
- `src/b2bua/rules/framework/InvariantEnforcer.ts` — the rule-path
  invariant that adds a `decrement-limiter` for any entry not already
  covered by a rule's soft effect.
- `src/call/CallState.ts` — the force-purge / orphan-sweep decrement
  loop.

A fail-open admission is therefore **never** `DECR`'d. The cluster
counter cannot drift negative.

### 2. Within-`applyRoute` rollback for the same-loop reject path

When `limiter[k]` returns `Rejected` after `limiter[0..k-1]` admitted,
the rejection branch attaches the in-progress `limiterEntries` to the
rejected call (or the failover call):

- **486 reject**: `addCdrEvent({ ...args.call, limiterEntries }, ...)` →
  `terminateCallEffects` filters out fail-open entries and emits
  `decrement-limiter` for each prior successful `INCR`. The rejected
  call terminates immediately, so the soft effects execute on the same
  call-lifecycle tick.
- **Failover**: `failoverCall = { ...args.call, callbackContext,
  limiterEntries }` → the failover call carries the entries through to
  its own terminate flow. Same `DECR` semantics, just deferred to the
  failover call's lifetime.
- **Failover-admission reject** (failover destination fails
  `classifyAdmission`): there is no surviving call to carry entries on,
  so the branch calls `eagerDecrement()` explicitly before returning the
  503 rejection.

### 3. Outer `Effect.onExit` for any post-INCR failure / defect

`applyRoute` ends with:

```ts
}).pipe(
  Effect.onExit((exit) =>
    Exit.isFailure(exit) ? eagerDecrement() : Effect.void,
  ),
)
```

`eagerDecrement` iterates `successfulIncrements` (the canonical record:
only entries where `admission.incrementSucceeded === true`) and runs the
matching `limiter.decrement(id, originWindow)` for each, wrapped in the
same `Effect.timeoutOrElse(config.limiterDecrementTimeoutMs)` + `catchTag`
pattern used by the existing force-purge path (best-effort cleanup; the
`DECR` is itself a soft effect — a missed one leaks at most one window).

`Effect.onExit` does not swallow the cause. The original `Exit.failure`
is re-emitted after `eagerDecrement` completes, so the caller still sees
the same failure.

This closes the residual leak path the in-handler reject branch could
not cover: a defect inside `createBLegFromRoute`, a fiber interrupt
during the post-loop log calls, a `Cause.Die` from a downstream limiter
issue — all of them surface as `Exit.isFailure(exit) === true` and
trigger eager DECR.

## The rule (operator-facing)

> Anywhere we record a successful limiter `INCR`, we must guarantee one
> matching `DECR`. The `incrementSucceeded` flag is the canonical record
> of "did Redis actually increment?". Any new code path that builds a
> `Call` with `limiterEntries` MUST preserve the flag on each entry, and
> any new termination-effect builder MUST filter on
> `incrementSucceeded !== false` before emitting `decrement-limiter`.
> Any new error path inside `applyRoute` is automatically covered by the
> outer `Effect.onExit` — but only as long as
> `successfulIncrements` is populated synchronously with each successful
> `INCR`.

## References

- [src/redis/LimiterRedisClient.ts](../../src/redis/LimiterRedisClient.ts) — ioredis options
- [src/call/CallLimiter.ts](../../src/call/CallLimiter.ts) — `LimiterDecision` / `LimiterBackendError` / outer timeout
- [src/decision/apply/applyRoute.ts](../../src/decision/apply/applyRoute.ts) — caller pattern + `eagerDecrement` + `Effect.onExit`
- [src/b2bua/helpers.ts](../../src/b2bua/helpers.ts) — `terminateCallEffects` / `finalCleanupEffects` filter
- [src/b2bua/rules/framework/InvariantEnforcer.ts](../../src/b2bua/rules/framework/InvariantEnforcer.ts) — rule-path filter
- [src/call/CallState.ts](../../src/call/CallState.ts) — force-purge filter
- [tests/call/limiter-fail-open.test.ts](../../tests/call/limiter-fail-open.test.ts) — T3 (`LimiterTimeout`) + T4 (`RedisError`)
- [tests/call/forcepurge-skips-decr-on-fail-open.test.ts](../../tests/call/forcepurge-skips-decr-on-fail-open.test.ts) — fail-open entries skipped on terminate
- [tests/decision/apply-route-incr-decr-invariant.test.ts](../../tests/decision/apply-route-incr-decr-invariant.test.ts) — Paths 2a, 2b, 3 of the strong invariant
- The plan: [docs/plan/to-review-and-properly-swift-moler.md](../plan/to-review-and-properly-swift-moler.md)
- Related: [ADR-0003 — Must-run effects under interruption](./0003-must-run-effects-under-interruption.md)
  (Trap 4 of ADR-0003 already noted the `INCR` ≠ `DECR` design asymmetry;
  this ADR makes the iff invariant structural rather than convention.)
