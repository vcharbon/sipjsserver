# Replace manual `Semaphore.take` / `release` with a scoped `withCall` helper

## Context

A long debug session exposed a real-world bug shape: `Semaphore.take(sem, 1)`
followed later by `Semaphore.release(sem, 1)`. If anything between the two —
an error, a `defect`, a fiber interrupt — escapes the explicit release path,
the permit leaks forever and the next `Semaphore.take` for that callRef
deadlocks. The very recent uncommitted patch on
[src/call/CallState.ts:431-436](src/call/CallState.ts#L431-L436) plugged one
such leak (`Effect.orDie` on `SchemaError` was being converted to a defect
that bypassed the release call), but the underlying *pattern* — manual
`take`/`release` pairs with branch-by-branch cleanup — is still in the code
and remains a footgun for any future change.

This plan removes the dangerous pattern entirely. After it, the semaphore is
held inside a single scoped block (`Semaphore.withPermits(1)(...)`) which
releases on success, error, *and* fiber interrupt — the same guarantee
already in use in [src/storage/KvBackend.ts:655](src/storage/KvBackend.ts#L655)
and [tests/support/PumpableClock.ts:154](tests/support/PumpableClock.ts#L154).

## What is the "SipRouter try/finally" hazard?

[src/sip/SipRouter.ts:696-773](src/sip/SipRouter.ts#L696-L773) currently looks like:

```ts
const call = yield* callState.checkout(callRef)   // <-- takes the permit
if (call === undefined) { /* respond 481 */ return }

try {
  // …leg/dialog resolve, tracing span, handler dispatch (rule chain)…
  yield* tracing.withProcessingSpan({ … effect: inner })
} finally {
  yield* callState.release(callRef)               // <-- releases the permit
}
```

That `try { … } finally { yield* … }` is **JavaScript** `try/finally`,
written inside an `Effect.gen` generator. It is *not* the same primitive as
`Effect.ensuring` / `Effect.acquireRelease` / `withPermits`. Two ways it can
fail to release:

1. **Fiber interruption.** When Effect interrupts a fiber, it does not
   reliably re-enter the JS generator's `finally` *and* drive the
   `yield* callState.release(callRef)` to completion. The Effect-level
   guarantee that finalizers run on interrupt is provided only by
   uninterruptible-finalizer APIs (`ensuring`, `acquireRelease`,
   `withPermits`). A `yield*` inside a JS `finally` can be skipped under
   the right interleaving — exactly the scenario the user just spent a
   long debug session on.
2. **Defects.** The pre-fix `Effect.orDie` at the old line 437 of
   `CallState.ts` is the canonical example: it converted a `SchemaError`
   to a defect that escaped the typed error channel and was caught only
   by an outer `Effect.catchCause` — bypassing the JS `finally` cleanly,
   leaking the permit, and dead-locking every future `checkout` of the
   same callRef. The recent uncommitted patch fixed that one defect, but
   the *shape* (`take` here, `release` over there, with arbitrary
   user code in between) keeps the door open for the next one.

Replacing both halves with one scoped `withPermits(1)(...)` block closes
this entire class of bug: `withPermits` releases in an uninterruptible
finalizer, on success, error, *and* interrupt.

## Audit results — what is and isn't dangerous

Three Explore passes covered semaphores, Redis lifecycle, sockets, refs,
file watchers, timers, HTTP servers, and pub/sub. Findings:

| Area | Site | Pattern | Verdict |
|---|---|---|---|
| Per-call semaphore | [src/call/CallState.ts:383,409,452,484](src/call/CallState.ts#L383) | manual `Semaphore.take` / `Semaphore.release` | **Dangerous — fix in this plan** |
| SipRouter critical section | [src/sip/SipRouter.ts:716-773](src/sip/SipRouter.ts#L716-L773) | JS `try { … } finally { yield* callState.release(callRef) }` inside `Effect.gen` | **Dangerous — fix in this plan.** JS `finally` is not guaranteed to run on Effect interrupt; `Effect.ensuring` / `withPermits` is. |
| KvBackend mutex | [src/storage/KvBackend.ts:655-656](src/storage/KvBackend.ts#L655-L656) | `mutex.withPermits(1)` | Safe |
| Test clock mutex | [tests/support/PumpableClock.ts:107,154](tests/support/PumpableClock.ts#L107) | `runSemaphore.withPermits(1)` | Safe |
| Redis client | [src/redis/RedisClient.ts:72-83](src/redis/RedisClient.ts#L72-L83) | `Effect.acquireRelease` (connect/disconnect) | Safe |
| Redis pipeline / SCAN / Lua locks | [src/redis/RedisClient.ts:198-228](src/redis/RedisClient.ts#L198-L228), CallLimiter, KvBackend | Atomic `Effect.tryPromise` around server-side EVAL — no client-held resource | Safe |
| Redis pub/sub | n/a | Not used in the codebase | Safe |
| UDP sockets | [src/sip/SignalingNetwork.ts:551-636](src/sip/SignalingNetwork.ts#L551-L636) | nested `Effect.acquireRelease` for socket + listeners | Safe |
| File watchers / intervals / HTTP servers | HmacKeyProvider, OverloadController, MetricsServer, WorkerConnectivity | `Effect.addFinalizer` / `acquireRelease` | Safe |
| Inflight counters | [src/sip/SignalingNetwork.ts:424,461](src/sip/SignalingNetwork.ts#L424) | `Effect.ensuring(... inFlightCount--)` | Safe |

So the scope of this plan is narrow: **one helper in `CallState` + the one
caller in `SipRouter`**. Nothing else in the audit warranted a change.

## Recommended fix

### Design intent

`checkout` and `release` are **rewritten** — not deprecated, not kept
alongside — into a single scoped continuation that uses
`Semaphore.withPermits(1)(...)` internally. The split-call shape (`take`
here, `release` over there) is the dangerous one, so it has to go; what
replaces it is one function that takes the body as a continuation and
*cannot* be called in a way that leaks a permit.

This matches the pattern already in use in
[src/storage/KvBackend.ts:655-656](src/storage/KvBackend.ts#L655-L656)
(`mutex.withPermits(1)(...)` wrapping every channel mutation) and
[tests/support/PumpableClock.ts:154](tests/support/PumpableClock.ts#L154)
(`.pipe(runSemaphore.withPermits(1))`).

### 1. New public API: `CallState.withCall`

Replace the `checkout` / `release` pair with a single scoped continuation:

```ts
readonly withCall: <A, E, R>(
  callRef: string,
  body: (call: Call | undefined) => Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | RedisError, R>
```

Implementation in [src/call/CallState.ts](src/call/CallState.ts):

- Resolve the per-callRef semaphore via the existing
  [`getSemaphore`](src/call/CallState.ts#L317-L323).
- Run the *entire* critical section under
  `sem.withPermits(1)(...)` — this is the same API already in use elsewhere
  in the project; it is interrupt-safe (releases in an uninterruptible
  finalizer).
- Inside the scoped block:
  1. Resolve the call from `callsMap` or storage (the existing
     [load logic at lines 385-462](src/call/CallState.ts#L385-L462)).
     Tombstone / decode failure / cache miss / terminated-state branches
     return `undefined` like today, **but no longer issue manual
     `Semaphore.release`** — `withPermits` owns the release.
  2. Invoke `body(call)`. The handler runs while the permit is held, so
     concurrent events for the same callRef remain serialised (the original
     correctness property of the semaphore).
  3. After `body` returns, if `call === undefined`, drop the entry from
     the `semaphores` `MutableHashMap` so the map cannot grow unboundedly
     for never-existed callRefs (same memory-hygiene goal that motivated
     `releaseAndDropSlot` today). This is benign even under races — see
     "Race notes" below.

Remove `checkout` and `release` from the `CallState` service interface and
its live implementation — they have one caller (see step 2) and no
external API surface, so a clean rewrite is preferable to keeping the
unsafe primitives next to the safe one.

### 2. Migrate the single caller in `SipRouter`

[src/sip/SipRouter.ts:696-773](src/sip/SipRouter.ts#L696-L773) becomes:

```ts
yield* callState.withCall(callRef, (call) =>
  Effect.gen(function* () {
    if (call === undefined) {
      // existing 481 reject path (lines 697-714) moves here verbatim
      return
    }
    // existing leg/dialog resolve + tracing span + handler dispatch
    // (lines 717-770) moves here verbatim — no try/finally needed
  }),
)
```

The outer `.pipe(Effect.catchTag("RedisError", …))` wrapper at
[src/sip/SipRouter.ts:774-778](src/sip/SipRouter.ts#L774-L778) stays as-is
and now also covers the `RedisError` introduced into `withCall`'s error
channel by the storage read.

### 3. Internal cleanup

- The helper local `releaseAndDropSlot` and the `Semaphore.release` calls at
  [lines 408-411, 452, 484](src/call/CallState.ts#L408) all disappear —
  release is the responsibility of `withPermits` and the slot drop is a
  one-liner inside `withCall`.
- The recently-added schema-error diagnostics
  ([lines 33-56](src/call/CallState.ts#L33-L56),
  [431-435](src/call/CallState.ts#L431-L435)) are unaffected and stay.

### Race notes

The "drop the slot when `call === undefined`" step is racy in the same
benign way the current code is: a concurrent `getSemaphore` could re-create
a fresh sem after the drop. That is fine because *for a callRef with no
live call, there is no shared state to protect* — the only purpose of the
sem on the no-call path is to serialise the storage-load and the
cache-miss reply, both of which are idempotent under SIP retransmits. For
a callRef with a live call, `body` does not return `undefined`, the slot is
not dropped, and the existing mutex semantics are preserved.

## Files to modify

- [src/call/CallState.ts](src/call/CallState.ts) — service interface
  (`Service<…>` extends declaration), live-impl `Effect.fnUntraced` body,
  and the closing return record. Add `withCall`, remove `checkout` and
  `release`.
- [src/sip/SipRouter.ts](src/sip/SipRouter.ts) — replace the
  `checkout` / `try` / `finally release` block with the `withCall`
  continuation form.

No other production file references `checkout` or `release`; verified via
`grep -rn "callState\.checkout\|callState\.release"`.

## Verification

1. **Type gates:** `npm run typecheck` — both `tsc` and the Effect plugin
   must be clean (per `CLAUDE.md`'s "never ignore a warning" rule).
2. **Fake-stack regression:** `npm run test:fake` — the in-memory
   `CallStateCache` variant exercises `withCall` under TestClock, including
   the existing tombstone, decode-error, and terminating-state branches.
3. **Live short tier:** `npm run test` — covers a real INVITE/200/ACK/BYE
   round-trip through SipRouter.
4. **Endurance smoke:** if the local kind harness is up
   (`tests/k8s/endurance/`), run a 5-minute sippperftest at the same cps
   the 2026-05-02 leak measurement used (~100 cps, 2 workers). The
   semaphore-leak rate (~2 sems/call) referenced in the comment at
   [CallState.ts:402-407](src/call/CallState.ts#L402-L407) should remain
   zero.
