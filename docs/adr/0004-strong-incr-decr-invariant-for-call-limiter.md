# 0004 — Call limiter: bounded-deviation cap honoring under chaos

**Status:** accepted (2026-05-17)
**Supersedes:** ADR-0007 (eventual cap-honoring under chaos) — merged here.

## Context

The call limiter is a cluster-shared sliding-window counter
(`LIMITER_ACTIVE_WINDOWS × LIMITER_WINDOW_SECONDS` lookback; defaults
3 × 300 s = 15 min). It rate-limits concurrent calls per limiter id.
It is **not** a hard-cap admission controller, and this ADR explains
why that design choice forces every other choice in this file.

Three properties of the limiter are tightly coupled — pull on one and
the other two move:

1. **Fail-open admission under chaos.** When the limiter's Redis is
   unreachable or slow, the hot path admits without an `INCR`. The
   alternative (fail-closed) turns an unavailable limiter into a
   global outage, which is worse than letting a few extra calls
   through.
2. **Strong INCR ↔ DECR symmetry.** Fail-open admissions must *not*
   later emit a `DECR` (the matching `INCR` never landed), or the
   cluster counter drifts negative and lets unbounded over-cap
   traffic through for the rest of the run. Conversely, every
   *successful* `INCR` must be matched by exactly one `DECR` — or
   counts accumulate forever from dead-worker phantoms.
3. **Bounded reconcile via two cleanup clocks.** Phantom `INCR`s left
   behind by killed workers are removed either by peer keepalive
   detection (typical) or by the sliding-window rotating them out
   (worst case). The cap is honored from the outside *eventually*,
   not at every instant.

Together these three give the contract: **the externally observable
concurrent-call count converges to ≤ cap within ~2 × keepalive (~10 min)
in the typical case, and at worst within one full window lookback
(~15 min) when the keepalive path is itself degraded.** Inside that
envelope, the Redis-counted view may show a transient overshoot.
That is the design, not a bug.

The 2026-05-15 endurance run forced this clarification when a transient
limiter-Redis loss (~73 s) cascaded into ~110 s of worker service loss
and the post-mortem reviewers misread `limiterProbe.exceededCap=true`
as a regression. Two distinct things were conflated: the structural
symmetry property (this ADR's invariant) and the operational contract
(this ADR's bound). They are not the same property, but they are the
same design.

## Decision: bounded limiter I/O at two layers

The limiter Redis connection has a hard wall-clock budget on every
command. Implemented at two cooperating layers:

| Layer | Setting | Where | Why |
|---|---|---|---|
| ioredis (primary) | `commandTimeout: 100` | [src/redis/LimiterRedisClient.ts](../../src/redis/LimiterRedisClient.ts) | Cap every command at the wire layer. The fix for the TCP black-hole stall — ioredis was holding a Promise pending forever during a TCP black-hole (no FIN, no RST), defeating the upstream `catchTag`. |
| ioredis | `enableOfflineQueue: false` | same | Reject during reconnect instead of silently buffering. Buffered-replay was producing late successes that defeated the Effect-side timeout. |
| ioredis | `maxRetriesPerRequest: 1` | same | Bound the ioredis internal retry loop so a single command cannot blow the 100 ms budget by repeated internal retries. |
| Effect (defense-in-depth) | `Effect.timeoutOrElse(Duration.millis(150))` → `LimiterTimeout` | [src/call/CallLimiter.ts](../../src/call/CallLimiter.ts) | Outer safety net. Only fires when ioredis itself fails to surface its own timeout (unrecoverable command state). The 50 ms gap guarantees the ioredis layer wins on every normal pathology. |

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

The caller pattern at the SIP hot path ([applyRoute](../../src/decision/apply/applyRoute.ts)):

```ts
const admission = yield* limiter.checkAndIncrement(entry.id, entry.limit).pipe(
  Effect.catchTags({
    RedisError:     (e) => log(...).pipe(Effect.as("admit-no-tag")),
    LimiterTimeout: (e) => log(...).pipe(Effect.as("admit-no-tag")),
  }),
)
```

Both backend errors fold into the same "admit-no-tag" admission so the
hot path branches stay narrow. **This is fail-open by design.** A call
admitted via "admit-no-tag" is the source of a *phantom* — an admitted
call with no Redis-side `INCR` to match it. The next two decisions
exist to keep phantoms bounded and self-healing.

## Decision: a structural INCR ↔ DECR invariant

> **A successful limiter `INCR` is matched by exactly one `DECR`.
> A fail-open admission emits zero `DECR`s.
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

- [src/b2bua/helpers.ts](../../src/b2bua/helpers.ts) —
  `terminateCallEffects` and `finalCleanupEffects` (the canonical
  termination-effect builders).
- [src/b2bua/rules/framework/InvariantEnforcer.ts](../../src/b2bua/rules/framework/InvariantEnforcer.ts)
  — the rule-path invariant that adds a `decrement-limiter` for any
  entry not already covered by a rule's soft effect.
- [src/call/CallState.ts](../../src/call/CallState.ts) — the
  force-purge / orphan-sweep decrement loop.

A fail-open admission is therefore **never** `DECR`'d. The cluster
counter cannot drift negative from this path.

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

## Decision: the operational contract is sipp-observable, with a bounded reconcile

### The target

> For any chaos episode ending at time `T_end`, the externally
> observable concurrent-call count on a limited limiter id — measured
> as sipp's `CurrentCall` on the `endurance-limiter` stream, exposed
> in the analyzer as `concurrentCalls(endurance-limiter)` — converges
> to `≤ cap` within:
>
> - **typical**: `~2 × (KEEPALIVE_INTERVAL_SEC + KEEPALIVE_TIMEOUT_SEC)`
>   ≈ 10 min (peer keepalive detects the dead worker and runs the
>   cross-worker takeover that DECRs the phantoms);
> - **worst case**: `LIMITER_ACTIVE_WINDOWS × LIMITER_WINDOW_SECONDS`
>   ≈ 15 min (phantoms age out as their window rotates out of the
>   lookback, with no actor required).
>
> After chaos is fully over and all in-flight calls drain, the
> observable returns to 0.

The target is **outside-observable** on purpose: the limiter's job is
to keep the call-rate the cluster *lets through* under the cap, not to
keep an internal counter under the cap. An internal counter that
overshoots while no calls are actually being admitted is uninteresting
— and the symmetric case (counter says 10, twenty calls are
established) would be a real bug. Anchoring on the sipp-observed count
catches the latter and ignores the former.

### Why two clocks bound the reconcile

| Clock | Constant | Mechanism |
|---|---|---|
| Peer OPTIONS keepalive (typical) | `~2 × (KEEPALIVE_INTERVAL_SEC + KEEPALIVE_TIMEOUT_SEC)` ≈ 10 min | A peer worker detects the dead worker via OPTIONS failure on the next probe cycle (worst case ~1 full interval after death, plus the timeout), then runs the cross-worker takeover path and DECRs the dead worker's owned calls. The "2 ×" margin covers the case where the dead worker had just sent a successful OPTIONS-ack right before dying — you wait a full interval before the next probe even fires. |
| Limiter window rotation (worst case) | `LIMITER_ACTIVE_WINDOWS × LIMITER_WINDOW_SECONDS` ≈ 15 min | A phantom INCR from a dead worker ages out of the cap calculation when the window it lives in rotates out of the lookback. No actor required — pure passage of time. This is the fallback when the OPTIONS-detected cleanup itself is degraded by the same chaos that created the phantoms. |

The keepalive path is the *normal* recovery mechanism. The window
rotation is the *guaranteed* one. The two are deliberately independent:
a chaos that takes out keepalive does not extend the reconcile bound
past 15 min, and a chaos so tight that windows rotate before keepalive
fires still drains the phantoms.

### What is NOT the target

- **`LIMITER_INFLIGHT_PROBE` / `verdict.limiterProbe.inflight`** — the
  Redis-counted view. Diagnostic only. Will transiently exceed cap
  during the reconcile window after worker-affecting chaos; the
  symmetry invariant above guarantees it eventually settles.
- **`verdict.limiterProbe.exceededCap`** — a derived boolean of the
  above. Useful for narrating the recovery curve, not a pass/fail
  signal. The analyzer comments at the `LimiterStability` interface
  ([analyze-endurance.ts](../../tests/k8s/endurance/analyze-endurance.ts))
  mark this explicitly.
- **`verdict.limiterProbe.stabilizedAtCap`** — when read end-to-end
  over a long run this approximates "did the system pin at cap most
  of the time" but it includes the reconcile windows; do not treat it
  as the target either.

A `verdict.limiterProbe.exceededCap=true` from the analyzer is **not**
by itself a regression. Read it as "the diagnostic view saw a transient
overshoot"; check this ADR's reconcile bound against the
sipp-observable target to decide if anything is broken.

## Why this design and not the alternatives

| Alternative | Why we did not pick it |
|---|---|
| Hard-cap stateful admission controller (single coordinator process per limiter id, every INCR routes through it). | Adds a coordination hop on the hottest path. Loses fault-isolation: coordinator down ⇒ no admissions anywhere. The whole point of fail-open is to keep traffic flowing through Redis loss; a hard-cap coordinator inverts that. |
| `MULTI/EXEC` transactional INCR-and-check with rollback on overshoot. | Doubles Redis round-trips per INVITE. Still doesn't solve "worker died holding the call" — its phantom would persist until manual reconciliation, which is exactly what the window rotation already provides for free. |
| Tighter window (1 min × 3 = 3 min lookback). | Halves the worst-case reconcile bound but makes the cap noisier across the window boundary: an admission burst at second 59 of a window can briefly let `cap + ε` through as the boundary crosses. The 5-minute window is the smallest size where this boundary noise is empirically below 5 % of cap at the endurance test's offered load. |
| Per-worker local caps that sum to the cluster cap. | Worker-replacement events require redistributing the cap, which is its own coordination problem and bursts the global cap during the redistribution. |
| Fail-closed admission (reject on Redis loss). | A transient limiter outage becomes a global SIP outage. The bounded-overshoot we accept is empirically a smaller incident than the bounded-zero we would impose. |

## Scope: what this ADR claims and does not claim

- **Claims**: counter symmetry (no negative drift; every successful INCR
  matched by exactly one DECR; fail-open admissions emit zero DECRs),
  and externally observable convergence to `≤ cap` within the bound
  above.
- **Does not claim**: `inflight ≤ cap` at all times. The Redis-counted
  inflight view can transiently exceed `cap` during/just after chaos
  events that leave phantom INCRs from dead workers in the active
  windows. That is the *expected* trade-off of fail-open + bounded
  reconcile.

## Verification

The endurance analyzer's ExpectedImpact rules already evaluate
`concurrentCalls(endurance-limiter)` and `failureRate(endurance-limiter)`
per chaos event. To verify *this ADR's bound specifically*, the rule
windows on limiter-affecting events must extend through `T_end + 15 min`
rather than the analyzer's current 30-s post-event windows. Tracked
separately — current rules catch the *severe* breaches (>5 % limiter
failure for 30 s after event) but do not directly assert the 15-min
convergence; that is the follow-up.

Recurrence-prevention for the specific misread that motivated this
ADR: the comment on `analyzeLimiterStability` and the "Scope" section
above both point readers here when they encounter `exceededCap: true`.

## The rule (operator-facing)

> 1. Anywhere we record a successful limiter `INCR`, we must guarantee
>    one matching `DECR`. The `incrementSucceeded` flag is the canonical
>    record of "did Redis actually increment?". Any new code path that
>    builds a `Call` with `limiterEntries` MUST preserve the flag on
>    each entry, and any new termination-effect builder MUST filter on
>    `incrementSucceeded !== false` before emitting `decrement-limiter`.
> 2. Any new error path inside `applyRoute` is automatically covered by
>    the outer `Effect.onExit` — but only as long as
>    `successfulIncrements` is populated synchronously with each
>    successful `INCR`.
> 3. The cap-honoring target is the sipp-observable `concurrentCalls`
>    count, not the Redis-counter view. Diagnostic overshoot inside the
>    reconcile bound is not a regression.

## References

- [src/redis/LimiterRedisClient.ts](../../src/redis/LimiterRedisClient.ts) — ioredis options
- [src/call/CallLimiter.ts](../../src/call/CallLimiter.ts) — `LimiterDecision` / `LimiterBackendError` / outer timeout / `windowKeysFor`
- [src/decision/apply/applyRoute.ts](../../src/decision/apply/applyRoute.ts) — caller pattern + `eagerDecrement` + `Effect.onExit`
- [src/b2bua/helpers.ts](../../src/b2bua/helpers.ts) — `terminateCallEffects` / `finalCleanupEffects` filter
- [src/b2bua/rules/framework/InvariantEnforcer.ts](../../src/b2bua/rules/framework/InvariantEnforcer.ts) — rule-path filter
- [src/call/CallState.ts](../../src/call/CallState.ts) — force-purge filter
- [src/config/AppConfig.ts](../../src/config/AppConfig.ts) — `LIMITER_WINDOW_SECONDS`, `LIMITER_ACTIVE_WINDOWS`, `KEEPALIVE_INTERVAL_SEC`, `KEEPALIVE_TIMEOUT_SEC`
- [tests/call/limiter-fail-open.test.ts](../../tests/call/limiter-fail-open.test.ts) — T3 (`LimiterTimeout`) + T4 (`RedisError`)
- [tests/call/forcepurge-skips-decr-on-fail-open.test.ts](../../tests/call/forcepurge-skips-decr-on-fail-open.test.ts) — fail-open entries skipped on terminate
- [tests/decision/apply-route-incr-decr-invariant.test.ts](../../tests/decision/apply-route-incr-decr-invariant.test.ts) — Paths 2a, 2b, 3 of the strong invariant
- [tests/k8s/endurance/analyze-endurance.ts](../../tests/k8s/endurance/analyze-endurance.ts) — `LimiterStability` (diagnostic) vs the ExpectedImpact rules (target)
- The plan: [docs/plan/to-review-and-properly-swift-moler.md](../plan/to-review-and-properly-swift-moler.md)
- Related: [ADR-0003 — Must-run effects under interruption](./0003-must-run-effects-under-interruption.md)
  (Trap 4 of ADR-0003 already noted the `INCR` ≠ `DECR` design asymmetry;
  this ADR makes the iff invariant structural rather than convention.)
