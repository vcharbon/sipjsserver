# 0003 — Must-run effects under interruption: typed-category interpreter + buffered IO

**Status:** accepted (2026-05-15)

## Context

On 2026-05-15 we observed `[UNEXPECTED]` BYEs leaking across runs of the
k8s-register-call-reroute scenario. Root cause: a previous test left
calls stuck in `terminating` on `b2bua-worker-1` for up to 347 s; only
the 60-s `[CallState] Orphan sweep` eventually emitted recovery BYEs,
which leaked into the current test's recorder.

Mechanism in `src/sip/SipRouter.ts:processResult`: state mutation →
slow outbound → schedule-timer (safety) was ordered such that
`Effect.timeoutOrElse(timerHandlerTimeoutMs)` could interrupt *between*
mutation and the safety arm. A first patch reordered effects — works
but is brittle (depends on developer discipline at every call-site).

This ADR records the structural fix that lifts the guarantee from
"ordered effect interpreter + reviewer discipline" to a typed-category
contract that forces the interpreter to wrap each effect kind in its
safe primitive, route blocking IO through buffered non-blocking
layers, and make any future regression a compile error rather than a
silent production incident.

## The five traps

These are the misconceptions that drove the bug. Read them before
modifying any of the rule framework, the SipRouter consumer loop, or
the call-lifecycle code.

### Trap 1 — `ensuring` / `onExit` are NOT safer than `uninterruptibleMask`

`repos/effect/packages/effect/src/internal/effect.ts` (`onExitPrimitive`)
sets `fiber.interruptible = false` before running the finalizer body
unless the third arg is explicitly `true`. `Effect.ensuring` /
user-facing `Effect.onExit` both pass only 2 args. Finalizers run
uninterruptibly. A slow-IO finalizer hangs the fiber identically to a
slow-IO masked region.

### Trap 2 — The real invariant is "non-blocking body"

`Semaphore.withPermits` release body is synchronous JS
(`updateTakenUnsafe` — no `yield*`, no IO). Cannot block. This is the
codebase's true must-run pattern: **body is sync JS or a non-blocking
submit**; the wrapper (mask / ensuring / withPermits / scope finalizer)
decides control flow but not safety.

### Trap 3 — `Effect.ensuring` vs `Effect.onExit`

Both compile to `onExitPrimitive`. Same guarantee. Difference is
ergonomic: `ensuring(finalizer)` doesn't see the exit reason;
`onExit((exit) => …)` does. Use `ensuring` for outcome-agnostic
cleanup; `onExit` to branch on success/failure/interrupt.

### Trap 4 — Limiter `INCR` ≠ limiter `DECR`

Same Redis primitive, different design contracts:

- **`INCR`** (admission, on call create): MUST have explicit short
  timeout + fail-open. Redis hang → calls let through. Lives in
  `CallLimiter.tryAcquire`.
- **`DECR`** (release, on terminate): self-repairing (window
  rotation). Missed decrement leaks at most one window. Soft
  `catchTag` + explicit short timer is correct (Phase 7). Putting it
  in `ensuring` would convert a slow leak into a worker stall.

### Trap 5 — Blocking IO in any uninterruptible position is the actual hazard

CDR write (NDJSON append to disk), `storage.deleteCall` /
`storage.putCall` (Redis on terminate) can stall under load.
Anywhere they sit inside an uninterruptible region creates an
un-killable fiber. Mitigation: non-blocking submit to a bounded
queue, owned by a fixed-size drainer pool — mirror the existing
`BufferedUdpEndpoint` pattern.

## Decision: typed-category interpreter

Every `RuleEffect` carries its safety category at the type level on
`HandlerResult.effects`:

```ts
interface HandlerEffects {
  readonly critical: ReadonlyArray<CriticalStateEffect>
  readonly outbound: ReadonlyArray<OutboundSipEffect>
  readonly soft: ReadonlyArray<SoftBoundedEffect>
  readonly buffered: ReadonlyArray<BufferedObservabilityEffect>
  readonly fireAndForget: ReadonlyArray<FireAndForgetEffect>
}
```

`processResult` wraps each slot with its category's prescribed
primitive:

| Slot           | Primitive                                       | Body contract                                          |
|----------------|-------------------------------------------------|--------------------------------------------------------|
| critical       | `Effect.uninterruptibleMask`                    | sync JS or non-blocking submit (Phase 3 + Phase 4)     |
| outbound       | interruptible                                   | `TransactionLayer.send/sendRaw` (already buffered)     |
| soft           | per-item `Effect.timeoutOrElse` + `catchTag`    | self-repairing, missed call leaks at most one window   |
| buffered       | non-blocking submit                             | `BufferedCdrLayer` (drop-on-overload acceptable)       |
| fireAndForget  | `Effect.forkIn(layerScope)`                     | never blocks the handler                               |

Mismatched categorisation is a TypeScript error. The categorisation
test (`tests/b2bua/rule-effect-categories.test.ts`) locks each
discriminant to exactly one slot at compile time and at runtime.

## Decision: buffered IO for blocking persistence

- **`BufferedCdrLayer`** wraps `CdrWriter.layer` so `write` is pure
  enqueue (`Queue.offerUnsafe`). A single drainer fiber consumes the
  queue and calls the underlying file writer. Drop-on-overload is
  acceptable for CDR: losing a billing line is preferable to stalling
  call termination. Saturation surfaces via
  `cdrBuffer.submitDroppedTotal`.

- **`BufferedTerminateWriter`** wraps `PartitionedRelayStorage` so
  `deleteCall` and `putCall` (terminate path AND `flushToRedis`)
  return immediately. A pool of N drainer fibers consumes the queue.
  Drop-on-overload is **not** acceptable for state writes; the
  fallthrough path runs the underlying call directly under
  `Effect.timeoutOrElse(storageDropFallbackMs)` and counts the result.

Both layers have a config sentinel (`cdrBufferQueueMax: 0`,
`storageBufferQueueMax: 0`) that selects the direct passthrough — used
by fake-clock tests to keep IO in the same fiber as the call.

## Decision: structural safety net at the call-state edge

`CallState.update` detects the `prev.state !== "terminating" &&
next.state === "terminating"` transition and atomically installs the
safety timer (`replaceTimerById` + `timers.schedule`) inside an
`Effect.uninterruptibleMask`. The body is two `MutableHashMap.set`
calls + one `Effect.forkIn` — sync from the caller's POV.

The safety handler calls `forcePurge(callRef, "safety_timer")`
directly. Rehydration is a non-issue: `loadOwnedCalls` deletes
terminating calls outright on boot.

The rule path's previous explicit `schedule-timer(terminating_timeout)`
emission is retired (Phase 6). The
`terminating-safety-timeout` rule remains as a canary: a single firing
in production proves the structural invariant is broken (auto-arm
bypassed, or the timer's handler crashed without reaching forcePurge).

## The rule (operator-facing)

> Any code that runs uninterruptibly (`uninterruptibleMask`,
> `ensuring`, `onExit`, `Semaphore.withPermits` release, `Scope`
> finalizer) MUST be either synchronous JS or a non-blocking submit
> to a buffered drainer pool. Blocking IO in any of these positions
> creates an un-killable fiber.

## References

- `tests/sip/terminating-safety-timer-armed-before-outbound.test.ts`
- `tests/call/callstate-arms-safety-on-terminating.test.ts` (Phase 5)
- `tests/observability/buffered-cdr-drop-on-overload.test.ts` (Phase 3)
- `tests/cache/buffered-storage-fallthrough.test.ts` (Phase 4)
- `tests/b2bua/begin-termination-no-longer-emits-safety.test.ts` (Phase 6)
- `tests/call/forcepurge-limiter-decrement-bounded.test.ts` (Phase 7)
- `tests/b2bua/rule-effect-categories.test.ts` (Phase 1)
- The plan: `docs/plan/2026-05-15-StructuralEffectGuarantees-moth.md`
