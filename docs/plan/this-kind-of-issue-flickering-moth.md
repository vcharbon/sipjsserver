# Plan — Structural "must-run" guarantees: typed-category effect interpreter + buffered IO

## Context

On 2026-05-15 we saw `[UNEXPECTED]` BYEs in
`test-results/real-clock/registrarFrontProxy-kind/k8s-register-call-reroute.html`
on a re-run. A previous test left calls stuck in `terminating` on
`b2bua-worker-1` for up to 347 s; only the 60-s `[CallState] Orphan
sweep` eventually emitted recovery BYEs, and they leaked into the
current test's recorder.

Root mechanism in
[src/sip/SipRouter.ts](../../src/sip/SipRouter.ts) `processResult`:
state mutation → slow outbound → schedule-timer (safety) was ordered
such that `Effect.timeoutOrElse(timerHandlerTimeoutMs)` could
interrupt *between* mutation and the safety arm. A first patch
reordered effects — works but is brittle (depends on developer
discipline at every call-site).

Intended outcome: lift the guarantee from "ordered effect
interpreter + reviewer discipline" to a **typed-category contract**
that forces the interpreter to wrap each effect kind in its safe
primitive, route blocking IO through buffered non-blocking layers,
and make any future regression a compile error rather than a silent
production incident.

## The five traps the ADR must spell out

These were the misconceptions that drove the bug. The ADR records
them verbatim so every future contributor reads them.

### Trap 1 — `ensuring` / `onExit` are NOT safer than `uninterruptibleMask`

[repos/effect/packages/effect/src/internal/effect.ts:3850-3854](../../repos/effect/packages/effect/src/internal/effect.ts#L3850-L3854)
shows `onExitPrimitive` sets `fiber.interruptible = false` before
running the finalizer body unless the third arg is explicitly
`true`. `Effect.ensuring` / user-facing `Effect.onExit` both pass
only 2 args. Finalizers run uninterruptibly. A slow-IO finalizer
hangs the fiber identically to a slow-IO masked region.

### Trap 2 — The real invariant is "non-blocking body"

[Semaphore.withPermits](../../repos/effect/packages/effect/src/Semaphore.ts#L205-L221)
release body is synchronous JS (`updateTakenUnsafe` — no `yield*`,
no IO). Cannot block. This is the codebase's true must-run pattern:
**body is sync JS or a non-blocking submit**; the wrapper (mask /
ensuring / withPermits / scope finalizer) decides control flow but
not safety.

### Trap 3 — `Effect.ensuring` vs `Effect.onExit`

Both compile to `onExitPrimitive`. Same guarantee. Difference is
ergonomic: `ensuring(finalizer)` doesn't see the exit reason;
`onExit((exit) => …)` does. Use `ensuring` for outcome-agnostic
cleanup; `onExit` to branch on success/failure/interrupt.

### Trap 4 — Limiter `INCR` ≠ limiter `DECR`

Same Redis primitive, different design contracts:

- **`INCR`** (admission, on call create): MUST have explicit short
  timeout + fail-open. Redis hang → calls let through. Lives in
  [CallLimiter.tryAcquire](../../src/call/CallLimiter.ts).
- **`DECR`** (release, on terminate): self-repairing (window
  rotation). Missed decrement leaks at most one window. Soft
  `catchTag` + explicit short timer is correct. Putting it in
  `ensuring` would convert a slow leak into a worker stall.

### Trap 5 — Blocking IO in any uninterruptible position is the actual hazard

CDR write (NDJSON append to disk), `storage.deleteCall` /
`storage.putCall` (Redis on terminate) can stall under load.
Anywhere they sit inside an uninterruptible region creates an
un-killable fiber. Mitigation: non-blocking submit to a bounded
queue, owned by a fixed-size drainer pool — mirror the existing
[BufferedUdpEndpoint](../../src/sip/UdpTransport.ts) pattern.

## Design decisions (locked)

### D1 — `HandlerResult.effects` becomes a typed object with per-category slots — SIP outbound is one of the categories

```ts
// src/b2bua/rules/framework/RuleDefinition.ts

type CriticalStateEffect =
  | { type: "schedule-timer", timer: TimerEntry }
  | { type: "cancel-timer", id: string }
  | { type: "cancel-all-timers" }
  | { type: "flush-redis" }      // body routes to BufferedStorageLayer (D3)
  | { type: "remove-call" }      // body routes to BufferedStorageLayer

type OutboundSipEffect =
  | {
      type: "send-sip"
      message: SipRequest | SipResponse
      destination: { host: string; port: number }
      label: string              // for logs and tracing
      legId?: string
      // dispatched via TransactionLayer.send / sendRaw — already
      // buffered in production via BufferedUdpEndpoint when
      // `bufferedSendPerPeerQueueMax > 0`. Stays interruptible
      // inside the interpreter.
    }

type BufferedObservabilityEffect =
  | { type: "write-cdr" }        // routes to BufferedCdrLayer (D2)

type SoftBoundedEffect =
  | { type: "decrement-limiter", limiterId: string, window: number }

type FireAndForgetEffect =
  | { type: "refer-async-http", request: ReferRequest, callRef: string }

type HandlerResult = {
  call: Call
  effects: {
    critical: CriticalStateEffect[]
    outbound: OutboundSipEffect[]
    soft: SoftBoundedEffect[]
    buffered: BufferedObservabilityEffect[]
    fireAndForget: FireAndForgetEffect[]
  }
  state: ...
  spanEvents: ...
}
```

The previous separate `outbound: SipOutbound[]` field is folded
into `effects.outbound`. One uniform shape, one place to discover
all category contracts, no special-case "outbound is different."

**Rules don't change.** They emit `RuleAction[]` (high-level
intent). ActionExecutor maps actions to effects — that's where the
slot decisions live, in ONE file.

The interpreter receives effects already partitioned and wraps each
group with its category's safe pattern. Mismatched categorisation is
a TypeScript error, not a runtime bug.

Interpreter processing order:
1. `callState.update(result.call)` — state mutation (Phase 5 makes
   this atomically install the safety timer when entering
   `terminating`).
2. `effects.critical` — wrapped in a small `uninterruptibleMask`.
   Bodies are sync JS or non-blocking submits via D2 / D3.
3. `effects.outbound` — interruptible; dispatched via
   `TransactionLayer.send`, which is already buffered in production.
4. `effects.soft` — explicit short timeout + `catchTag` per item.
5. `effects.buffered` — non-blocking submit to the drainer pool.
6. `effects.fireAndForget` — `Effect.forkIn(layerScope)`.

### D2 — `BufferedCdrLayer` (Step 3 below)

Generic single-fiber drainer wrapping
[CdrWriter](../../src/observability/CdrWriter.ts).

- API: `submit(call: Call): Effect<void>` — pushes to bounded queue;
  returns immediately.
- Drainer fiber drains queue → calls underlying `cdr.write`.
- Queue full → bump `cdrSubmitDroppedTotal`, log first drop, return
  success. CDR is observability — drop a CDR rather than stall a
  call termination.
- Bound: `cdrBufferQueueMax` (default `10_000`).
- Drainer pool size: 1 (NDJSON append; profile later if needed).
- Layer shape: `Layer<CdrWriter, never, CdrWriter>` — buffered
  variant *replaces* the direct one in the production stack;
  fake-clock tests can opt out via a config sentinel.

### D3 — `BufferedStorageLayer` (Step 4 below)

Wraps [PartitionedRelayStorage](../../src/redis/PartitionedRelayStorage.ts).
**Only** the terminate-path `deleteCall` / `putCall` calls go
through the buffer; admission / hot-dialog `putCall` stays direct
(back-pressure on admission is desirable; back-pressure on
terminate is the bug we're fixing).

- API: `submitDelete(role, primary, callRef, indexes, opts):
  Effect<void>`; `submitTerminatePut(role, primary, callRef, json,
  indexes, ttl, opts): Effect<void>`.
- Drainer pool: N=4 fibers (configurable).
- Queue full: **NOT acceptable to drop** for state writes. Fall
  through to a direct call inside `Effect.timeout(STORAGE_DROP_FALLBACK_MS)`
  with `catchTag(StorageError, log)`. Worst case = stale Redis entry
  recovered by orphan-sweep / TTL.

### D4 — Safety net auto-armed at `CallState.update` (Step 5)

Every transition into `terminating` flows through
`callState.update`. Detect there. Body is two `MutableHashMap.set` +
one `Effect.forkIn` — all sync from the caller's POV. Wrap in a
small `uninterruptibleMask` (microseconds; Trap 2 satisfied).
Safety handler calls `forcePurge(callRef, "safety_timer")`
directly. Rehydration: `loadOwnedCalls` already deletes terminating
calls outright on boot — non-issue.

### D5 — `RuleEffect` categorisation is locked by a property test

Every concrete effect emitted by every rule in the registry is
asserted to land in exactly one category at the type level. Adding a
new effect kind without categorising it is a compile error AND a
test failure.

## Implementation phases

Each phase is independently committable and reversible. Each ends
with `npm run typecheck` clean and its own targeted regression test
green. Step 5 alone closes the production incident; Steps 1-2 + 3-4
+ 6-7 lock the contract structurally.

---

### Phase 1 — Categorise `RuleEffect` ADT (types only, no behavior change)

**Goal**: introduce the typed-object shape; migrate all
`state.effects.push(...)` sites to the new slots; verify compiler
catches misuse.

**Files**:

- [src/b2bua/rules/framework/RuleDefinition.ts](../../src/b2bua/rules/framework/RuleDefinition.ts)
  — define `CriticalStateEffect`, `BufferedObservabilityEffect`,
  `SoftBoundedEffect`, `FireAndForgetEffect`. Replace the existing
  flat `RuleEffect` union's *consumers* with a typed object on
  `HandlerResult.effects`. Keep the flat `RuleEffect` alias for
  internal helpers that don't care about category.

- [src/b2bua/rules/framework/ActionExecutor.ts](../../src/b2bua/rules/framework/ActionExecutor.ts)
  — `ExecutionState.effects` becomes the typed object. Every
  `state.effects.push(...)` call site (search: `state.effects.push`)
  moves into `state.effects.critical.push(...)` /
  `.outbound.push(...)` / `.soft.push(...)` /
  `.buffered.push(...)` / `.fireAndForget.push(...)`. Every
  `state.outbound.push(...)` site (search: `state.outbound.push`)
  moves into `state.effects.outbound.push(...)`. Audit:
    - `cancel-all-timers`, `schedule-timer`, `cancel-timer` → critical
    - `flush-redis`, `remove-call` → critical
    - existing `state.outbound.push({ message, destination, label,
      legId })` → `state.effects.outbound.push({ type: "send-sip",
      message, destination, label, legId })`
    - `write-cdr` → buffered
    - `decrement-limiter` → soft
    - `refer-async-http` → fireAndForget

- [src/b2bua/rules/framework/RuleExecutor.ts](../../src/b2bua/rules/framework/RuleExecutor.ts)
  — `appendAutoFlush` and the framework auto-flush logic update to
  push into `effects.critical` instead of the flat array. (`flush-redis`
  is critical because state must hit cache before next inbound event
  can read stale.)

- [src/sip/SipRouter.ts](../../src/sip/SipRouter.ts) `processResult`
  — temporary: continue treating the four slots as one big switch,
  iterating each slot in turn. **No new behavior yet.** Sets up
  Phase 2.

**Type-level invariant**: ActionExecutor cannot emit a
`write-cdr` into `.critical` — it's a TypeScript error. ditto for
every category.

**Tests added**:

- `tests/b2bua/rules-framework/rule-effect-categories.test.ts`:
  for every concrete `RuleEffect` discriminant value, assert which
  slot it lives in via the type system (compile-time) + a
  `expect(typed[x]).toEqual(...)` shape check.

**Definition of done**:
- `npm run typecheck` clean
- `npm run test:fake` passes (1217+ tests today)
- The new categorisation test exists and locks each effect's slot.

---

### Phase 2 — Interpreter partitions and wraps each category

**Goal**: replace the hand-tuned pre-pass/post-pass with structural
category-based wrapping.

**Files**:

- [src/sip/SipRouter.ts:387-525](../../src/sip/SipRouter.ts#L387-L525)
  `processResult` — rewrite the effect processing as:

```
yield* callState.update(callRef, () => result.call)

// CRITICAL: small uninterruptibleMask; bodies are sync or
// non-blocking submit (Phase 3+4 route flush-redis / remove-call
// through buffered IO).
yield* Effect.uninterruptibleMask((_restore) =>
  Effect.forEach(result.effects.critical, applyCritical, { discard: true })
)

// OUTBOUND: interruptible; transport already buffered in prod
yield* Effect.forEach(result.effects.outbound, applyOutbound, { discard: true })

// SOFT: explicit short timer + catchTag per item
yield* Effect.forEach(result.effects.soft, applySoftBounded, { discard: true })

// BUFFERED: enqueue and continue (non-blocking by construction)
yield* Effect.forEach(result.effects.buffered, applyBuffered, { discard: true })

// FIRE-AND-FORGET: forkIn(layerScope); never blocks the handler
yield* Effect.forEach(result.effects.fireAndForget, applyFork, { discard: true })
```

Note: the `uninterruptibleMask` around `critical` is safe **only**
because Phase 3 + 4 route `flush-redis` and `remove-call` bodies
through the buffered layers. Until Phase 3-4 lands, the
`uninterruptibleMask` here would be unsafe. Phase 2 thus lands
*after* Phase 3+4 in the merge order — see Phasing table at end.

Helper functions `applyCritical`, `applyOutbound`,
`applySoftBounded`, `applyBuffered`, `applyFork` live in the same
file as private closures over the layer services.
`applyOutbound` reuses the existing send branching
(ACK/CANCEL → `txnLayer.sendRaw`; everything else → `txnLayer.send`
with the txn-type discriminator already in
[src/sip/SipRouter.ts:428-435](../../src/sip/SipRouter.ts#L428-L435)).

- [src/b2bua/rules/framework/RuleExecutor.ts](../../src/b2bua/rules/framework/RuleExecutor.ts)
  — `finalizeTermination`'s auto-`flush-redis` injection now pushes
  into `.critical`. Already done in Phase 1 mechanically; verify
  here.

**Tests added**:

- `tests/sip/processResult-category-wrapping.test.ts`: synthetic
  HandlerResult with one effect of each of the five categories
  (critical, outbound, soft, buffered, fireAndForget); mock services
  to observe wrapping. Assert: critical body runs uninterruptibly
  (probe via a stalled mock that the surrounding `timeoutOrElse`
  cannot interrupt during the critical step); outbound is
  interruptible and reaches `txnLayer.send`/`sendRaw`; soft body
  times out at the explicit budget; buffered enqueues and returns
  immediately; fireAndForget forks into the layer scope.

**Definition of done**:
- The existing `tests/sip/terminating-safety-timer-armed-before-outbound.test.ts`
  still passes (becomes a perimeter guard).
- New `processResult-category-wrapping.test.ts` passes.
- `npm run test:fake` clean.

---

### Phase 3 — `BufferedCdrLayer`

**Goal**: CDR writes never block call termination. Drop-on-overload
acceptable.

**Files**:

- New: `src/observability/BufferedCdrLayer.ts`.
  - Layer signature: `Layer<CdrWriter, never, CdrWriter>` (wraps
    the existing one).
  - Internals: `Queue.bounded<Call>(cdrBufferQueueMax)` (default
    `10_000`); single drainer fiber forked in layer scope:
    ```
    Effect.forever(Effect.gen(function* () {
      const call = yield* Queue.take(queue)
      yield* underlying.write(call).pipe(
        Effect.catchCause(c => Effect.logError("buffered CDR write failed", c))
      )
    }))
    ```
  - `submit(call)` uses `Queue.offerUnsafe`; on `false` (queue
    full), bump metric, log first drop, return `Effect.void`.
  - Expose `write(call)` as an alias for `submit(call)` so callers
    using the `CdrWriter` interface get the buffered behavior
    transparently.

- [src/config/AppConfig.ts](../../src/config/AppConfig.ts) — add
  `cdrBufferQueueMax: number` (default 10000). `cdrBufferQueueMax: 0`
  selects the direct (un-buffered) writer for fake-clock tests, mirroring
  the existing `bufferedSendPerPeerQueueMax: 0` opt-out pattern.

- [src/observability/MetricsRegistry.ts](../../src/observability/MetricsRegistry.ts)
  — add `cdrSubmitDroppedTotal`, `cdrBufferQueueDepth`.

- [tests/support/networkLeaves.ts](../../tests/support/networkLeaves.ts)
  `b2buaWorkerStackLayer` — wire `BufferedCdrLayer` when
  `cdrBufferQueueMax > 0`; direct otherwise (matching the
  production-vs-fake convention).

- [src/test-harness/config-defaults.ts](../../src/test-harness/config-defaults.ts)
  — set `cdrBufferQueueMax: 0` for fake-clock determinism.

**Tests added**:

- `tests/observability/buffered-cdr-drop-on-overload.test.ts`:
  saturate queue with sync mock writer that sleeps; assert
  `cdrSubmitDroppedTotal > 0`, that subsequent submits still return
  void (don't block), and that no CDRs are lost when the writer
  catches up.

**Definition of done**:
- New tests pass.
- Existing CDR test
  ([tests/observability/cdr-rotation.test.ts](../../tests/observability/) or similar)
  still passes against the unbuffered layer.

---

### Phase 4 — `BufferedStorageLayer` (terminate paths only)

**Goal**: Redis `deleteCall` / `putCall` on terminate paths never
hang fibers. Drop NOT acceptable — fall through to bounded direct
call with logged error.

**Files**:

- New: `src/redis/BufferedStorageLayer.ts`.
  - Layer signature: `Layer<PartitionedRelayStorage, never,
    PartitionedRelayStorage>`.
  - Adds two methods to the existing service interface:
    `submitTerminateDelete(...)`, `submitTerminatePut(...)`.
    Admission `putCall` stays on the direct interface.
  - Internals: bounded queue + N-fiber drainer pool (default 4).
    Drainer calls underlying `deleteCall`/`putCall` with the
    existing `mapError(toStorageError)` path.
  - Queue full: don't drop; in the submit Effect, fall back to a
    direct `underlying.deleteCall(...).pipe(Effect.timeout(STORAGE_DROP_FALLBACK_MS), Effect.catchTag(StorageError, log))`.
    Log the fallback; bump
    `storageBufferFallthroughTotal`.

- [src/config/AppConfig.ts](../../src/config/AppConfig.ts) — add
  `storageBufferQueueMax`, `storageBufferDrainers`,
  `storageDropFallbackMs`.

- [src/call/CallState.ts](../../src/call/CallState.ts) — change
  `forcePurgeOne` and `remove` to call
  `storage.submitTerminateDelete(...)` instead of `storage.deleteCall(...)`.
  Same for the terminate-path `flushToRedis` (audit which call
  sites are terminate-path; non-terminate stays direct).

- [tests/support/networkLeaves.ts](../../tests/support/networkLeaves.ts)
  — wire `BufferedStorageLayer` when `storageBufferQueueMax > 0`.

- [src/test-harness/config-defaults.ts](../../src/test-harness/config-defaults.ts)
  — `storageBufferQueueMax: 0` for fake-clock.

**Tests added**:

- `tests/redis/buffered-storage-fallthrough.test.ts`: saturate
  queue; assert queue-full triggers direct fallback within
  `storageDropFallbackMs`; assert `storageBufferFallthroughTotal`
  increments; assert no data loss.

**Definition of done**:
- New test passes.
- Existing storage tests
  ([tests/redis/PartitionedRelayStorage.test.ts](../../tests/redis/) or similar)
  pass against the unbuffered layer.

---

### Phase 5 — CallState.update auto-arms safety on transition  ✅ DONE (2026-05-15)

**Status**: landed. Production incident closed structurally — every
`callState.update(... → terminating)` now installs the safety timer
atomically with the state mutation, inside an
`Effect.uninterruptibleMask` whose body is two `MutableHashMap.set`
calls + one `Effect.forkIn` (sync from caller's POV). Handler order
no longer matters: even if a slow outbound yield is interrupted
before the rule chain's explicit `schedule-timer` effect runs,
CallState has already armed the safety. Verified by:

- `tests/call/callstate-arms-safety-on-terminating.test.ts` — 3
  cases (auto-install on transition, idempotent on repeated calls,
  safety fires at +64 s and force-purges).
- `tests/sip/terminating-safety-timer-armed-before-outbound.test.ts`
  — updated to assert the new structural invariant (the synthetic
  "pre-fix handler order" case now passes BECAUSE the safety is
  armed by `update`, regardless of what the handler does next).
- `npm run typecheck` clean.
- `npm run test:fake` — 1221 passed / 8 skipped (was 1217 before; +3
  new from the auto-arm test, +1 from the updated perimeter test).

**Goal**: any `prev.state !== "terminating" && next.state === "terminating"`
transition automatically arms the safety timer. Structural; rule
chain no longer needed for this guarantee.

**Files**:

- [src/call/CallState.ts:449-459](../../src/call/CallState.ts#L449-L459)
  `update`:

```
const update = Effect.fnUntraced(function* (callRef, fn) {
  yield* Effect.uninterruptibleMask((_restore) =>
    Effect.gen(function* () {
      const opt = MutableHashMap.get(callsMap, callRef)
      if (Option.isNone(opt)) return
      const prev = opt.value
      const next = fn(prev)

      const enteringTerminating =
        prev.state !== "terminating" && next.state === "terminating"

      if (!enteringTerminating) {
        MutableHashMap.set(callsMap, callRef, next)
        return
      }

      const now = yield* Clock.currentTimeMillis
      const safetyEntry: TimerEntry = {
        id: `terminating-timeout-${callRef}`,
        type: "terminating_timeout",
        fireAt: now + TERMINATING_TIMEOUT_MS,
      }
      const withTimer = {
        ...next,
        timers: replaceTimerById(next.timers, safetyEntry),
      }
      MutableHashMap.set(callsMap, callRef, withTimer)
      yield* timers.schedule(callRef, safetyEntry, () =>
        forcePurge(callRef, "safety_timer"),
      )
    }),
  )
})
```

- `TERMINATING_TIMEOUT_MS` lifted to a module-level constant (same
  64000 as today).
- `replaceTimerById` already exists in
  [ActionExecutor.ts](../../src/b2bua/rules/framework/ActionExecutor.ts);
  move to a shared util module (`src/call/timer-helpers.ts`) so
  both files can import it.

**Tests added**:

- `tests/call/callstate-arms-safety-on-terminating.test.ts`:
  programmatically `callState.create(active call)` then
  `callState.update(... → terminating)` directly (no rule chain).
  Assert: safety entry in `fibersMap`. Advance TestClock past
  `TERMINATING_TIMEOUT_MS` — call is removed via `forcePurge`.

**Definition of done**:
- New test passes.
- Existing `tests/sip/terminating-safety-timer-armed-before-outbound.test.ts`
  still passes.
- `npm run test:fake` clean.

---

### Phase 6 — Retire duplicate safety-timer emission + demote rule

**Goal**: single source of truth for the safety net (CallState).
Rule path stops emitting it.

**Files**:

- [src/b2bua/rules/framework/ActionExecutor.ts:1860-1959](../../src/b2bua/rules/framework/ActionExecutor.ts#L1860-L1959)
  `executeBeginTermination`:
  - Drop the `schedule-timer(terminating_timeout)` emission at
    lines 1944-1950.
  - Drop the idempotency guard at lines 1870-1876 (no longer
    needed; CallState handles via `replaceTimerById`).
  - Keep the `cancel-all-timers` emission (different concern: kills
    keepalive etc. on entry to terminating).

- [src/b2bua/rules/defaults/TerminatingRules.ts:99-128](../../src/b2bua/rules/defaults/TerminatingRules.ts#L99-L128)
  `terminating-safety-timeout` rule: replace handler body with
  `Effect.logWarning("structural safety net missed; rule-chain fell
  through")` + `actions: []`. Canary: if it ever fires, alerting
  picks it up. Schedule removal in a follow-up PR (note in
  CHANGELOG).

**Tests added**:

- `tests/b2bua/begin-termination-no-longer-emits-safety.test.ts`:
  run `executeBeginTermination` against a confirmed-leg call; assert
  the returned effects list contains NO
  `schedule-timer(terminating_timeout)` entry.

**Definition of done**:
- Existing `bye-disposition-regression.test.ts` and
  `actions-reach.test.ts` still pass.
- Full fake suite clean.

---

### Phase 7 — Soft-bound limiter `DECR` with explicit short timer

**Goal**: formalise Trap 4. Limiter decrement on terminate paths is
soft, bounded, self-repairing.

**Files**:

- [src/config/AppConfig.ts](../../src/config/AppConfig.ts) —
  `limiterDecrementTimeoutMs` (default `1000`).

- [src/call/CallState.ts:801-812](../../src/call/CallState.ts#L801-L812)
  in `forcePurgeOne`: wrap each `limiter.decrement(...)` in
  `Effect.timeout(Duration.millis(config.limiterDecrementTimeoutMs))`
  before the existing `catchTag`. Add a second `catchTag("TimeoutException", log)`.

- [src/sip/SipRouter.ts:applySoftBounded](../../src/sip/SipRouter.ts)
  (added in Phase 2): same bounded-timeout wrapping for the
  category's `decrement-limiter` handler.

**Tests added**:

- `tests/call/forcepurge-limiter-decrement-bounded.test.ts`:
  inject a hanging mock limiter; assert `forcePurgeOne` returns
  within `limiterDecrementTimeoutMs + ε`; assert
  `Force-purge limiter decrement failed` log emitted.

**Definition of done**:
- New test passes.
- Existing limiter tests pass.

---

### Phase 8 — ADR + CLAUDE.md hook + cheat-sheet entry

**Files**:

- New: `docs/adr/0003-must-run-effects-under-interruption.md`.
  Sections:
    1. Status: Accepted (date)
    2. Context: 2026-05-15 incident, link to trace.
    3. The five traps (copy §"The five traps" above verbatim).
    4. The rule:
       > Any code that runs uninterruptibly (`uninterruptibleMask`,
       > `ensuring`, `onExit`, `Semaphore.withPermits` release,
       > `Scope` finalizer) MUST be either synchronous JS or a
       > non-blocking submit to a buffered drainer pool. Blocking
       > IO in any of these positions creates an un-killable fiber.
    5. The interpreter contract: each `RuleEffect` carries its
       safety category at the type level. `processResult` wraps
       each category in its prescribed primitive. Mismatches are
       compile errors.
    6. Reading guide: when changing rules / interpreter /
       call-lifecycle code, you MUST start here.
    7. References: `tests/sip/terminating-safety-timer-armed-before-outbound.test.ts`,
       this plan, the original incident trace.

- [CLAUDE.md](../../CLAUDE.md) — add under "Planning discipline":

  > When modifying any of
  > `src/b2bua/rules/framework/RuleExecutor.ts`, `ActionExecutor.ts`,
  > `RuleDefinition.ts`, `src/sip/SipRouter.ts:processResult`, or
  > `src/call/CallState.ts:update`/`forcePurge*`, read
  > [docs/adr/0003-must-run-effects-under-interruption.md](docs/adr/0003-must-run-effects-under-interruption.md)
  > FIRST. The interpreter's safety contract is load-bearing and
  > easy to break silently.

- [docs/typescript-effect.md](../typescript-effect.md) — add
  "Must-run patterns" section with the rule-of-thumb table and a
  pointer to ADR 0003.

**Definition of done**:
- All three files exist / are updated.
- Manual review confirms the ADR is precise and concise.

---

## Phasing (merge order)

| # | Step | Depends on | Status | Merges value |
|---|---|---|---|---|
| 1 | Phase 1 — Categorise ADT | – | TODO | Type infrastructure |
| 2 | Phase 5 — CallState auto-arm | – | ✅ DONE (2026-05-15) | **Closes the production incident** |
| 3 | Phase 3 — BufferedCdrLayer | – | TODO | CDR cannot block termination |
| 4 | Phase 4 — BufferedStorageLayer | – | TODO | Storage cannot block termination |
| 5 | Phase 2 — Interpreter wrapping | 1, 3, 4 | TODO | Locks the structural contract |
| 6 | Phase 6 — Retire duplicate safety | 5 | TODO | Cleanup |
| 7 | Phase 7 — Soft-bound limiter DECR | 5 | TODO | Cleanup |
| 8 | Phase 8 — ADR + docs | 1-7 | TODO | Future-proofing |

Steps 1-4 are independent and can land in parallel. Step 5 is the
keystone. Steps 6-8 follow.

Phase 5 alone closes the production incident even if 1-4 haven't
landed yet — the CallState-level guarantee doesn't depend on the
ADT refactor. So in practice the merge order can be **Phase 5
first** (incident closed in days), then 1+3+4+2 in parallel
(structural lock-in over the next 1-2 weeks), then 6-8 (cleanup +
docs).

## Verification (end-to-end)

1. **`npm run typecheck`** — clean after each phase.
2. **`npm run test:fake`** — clean after each phase (today: 1217+
   tests).
3. **New unit/integration tests** listed per phase above.
4. **Property test** locking RuleEffect categorisation (Phase 1).
5. **Live k8s trace**: re-run
   `tests/fullcall/e2e-register-fakeExt-realCore.test.ts` twice on
   the same fresh kind cluster. Second run's
   `k8s-register-call-reroute.html` must have ZERO `[UNEXPECTED]`
   events.

## Critical files to modify

Type infrastructure:
- [src/b2bua/rules/framework/RuleDefinition.ts](../../src/b2bua/rules/framework/RuleDefinition.ts) — Phase 1
- [src/b2bua/rules/framework/ActionExecutor.ts](../../src/b2bua/rules/framework/ActionExecutor.ts) — Phases 1, 6
- [src/b2bua/rules/framework/RuleExecutor.ts](../../src/b2bua/rules/framework/RuleExecutor.ts) — Phase 1

Interpreter:
- [src/sip/SipRouter.ts](../../src/sip/SipRouter.ts) — Phase 2

Buffered IO layers:
- New: `src/observability/BufferedCdrLayer.ts` — Phase 3
- New: `src/redis/BufferedStorageLayer.ts` — Phase 4

Call-lifecycle structural guarantee:
- [src/call/CallState.ts](../../src/call/CallState.ts) — Phases 4, 5, 7
- New (helper extraction): `src/call/timer-helpers.ts` — Phase 5

Rule cleanup:
- [src/b2bua/rules/defaults/TerminatingRules.ts](../../src/b2bua/rules/defaults/TerminatingRules.ts) — Phase 6

Config + stack wiring:
- [src/config/AppConfig.ts](../../src/config/AppConfig.ts) — Phases 3, 4, 7
- [tests/support/networkLeaves.ts](../../tests/support/networkLeaves.ts) — Phases 3, 4
- [src/test-harness/config-defaults.ts](../../src/test-harness/config-defaults.ts) — Phases 3, 4

Observability:
- [src/observability/MetricsRegistry.ts](../../src/observability/MetricsRegistry.ts) — Phases 3, 4

Tests:
- New: `tests/b2bua/rules-framework/rule-effect-categories.test.ts` — Phase 1
- New: `tests/sip/processResult-category-wrapping.test.ts` — Phase 2
- New: `tests/observability/buffered-cdr-drop-on-overload.test.ts` — Phase 3
- New: `tests/redis/buffered-storage-fallthrough.test.ts` — Phase 4
- New: `tests/call/callstate-arms-safety-on-terminating.test.ts` — Phase 5
- New: `tests/b2bua/begin-termination-no-longer-emits-safety.test.ts` — Phase 6
- New: `tests/call/forcepurge-limiter-decrement-bounded.test.ts` — Phase 7
- Existing: `tests/sip/terminating-safety-timer-armed-before-outbound.test.ts` — must stay green through all phases.

Docs:
- New: `docs/adr/0003-must-run-effects-under-interruption.md` — Phase 8
- Edit: [CLAUDE.md](../../CLAUDE.md) — Phase 8
- Edit: [docs/typescript-effect.md](../typescript-effect.md) — Phase 8

## Existing utilities to reuse

- [BufferedUdpEndpoint](../../src/sip/UdpTransport.ts) (look for
  `bufferedSendPerPeerQueueMax`) — pattern reference for
  BufferedCdrLayer (Phase 3) and BufferedStorageLayer (Phase 4):
  bounded queue, drainer fiber, metrics, fake-clock opt-out via
  config sentinel.
- [CallState.forcePurge](../../src/call/CallState.ts#L854) /
  [forcePurgeOne](../../src/call/CallState.ts#L771) — already
  promotes legs to `bye_timeout`, writes CDR, decrements limiter,
  deletes from storage. The new safety handler in Phase 5 calls
  `forcePurge` directly.
- [TimerService.schedule](../../src/call/TimerService.ts#L67) —
  id-collision (`replaceTimerById`) makes Phase-5 auto-arm
  idempotent under repeated updates.
- `replaceTimerById` (in
  [ActionExecutor.ts](../../src/b2bua/rules/framework/ActionExecutor.ts))
  — extract to shared `src/call/timer-helpers.ts` so CallState and
  ActionExecutor can both import it.
- [Semaphore.withPermits](../../repos/effect/packages/effect/src/Semaphore.ts#L205-L221)
  — reference implementation cited in the ADR as the canonical
  "uninterruptible region with sync body" pattern.

## Out of scope (named so they're not assumed in)

- Limiter `INCR` admission path — already correct (explicit short
  timer + fail-open). Not touched.
- Non-terminate `flushToRedis` — stays on the direct storage path
  (back-pressure on the rule path is the right behavior during
  normal call processing).
- Tracing exporter and metrics push — separate concern; existing
  backpressure patterns handle them.
- SIP outbound transport-layer buffering — already implemented in
  [BufferedUdpEndpoint](../../src/sip/UdpTransport.ts) in
  production. The plan folds the *categorisation* of outbound into
  the effect ADT (one shape; same wrapping discipline as everything
  else) but does not add a second buffering layer above the
  transport. Outbound stays interruptible inside the interpreter —
  the safety net runs first (Phase 5).
