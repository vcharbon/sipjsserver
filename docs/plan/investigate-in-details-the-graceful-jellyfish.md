# Plan: race-proof the timeout-event dispatch pipeline (zombie-timer fix)

## Context

`SipRouter` emits an `ERROR` whenever a `"timeout"` event reaches the
per-call consumer for a `callRef` that no longer resolves to a call
([src/sip/SipRouter.ts:830-835](../../src/sip/SipRouter.ts#L830-L835)):

```
ERROR Call <callRef> not found on checkout for timeout leg=b-N — zombie timer fired (eviction-path bug)
```

A 2026-05-15 endurance run produced ~50 such lines over 5 h, clustered
within ~1 min of peer-worker chaos events. The killed worker's prefix
appeared in callRefs that fired on the surviving worker. The existing
plan [2026-05-16-zombie-timer-eviction-path-fix.md](2026-05-16-zombie-timer-eviction-path-fix.md)
proposed three hypotheses; this plan completes the investigation and
recommends a fix. **Net result**: the error is not an "eviction-path
bug" — the comment at SipRouter.ts:831-833 makes a load-bearing
assumption (that `cancelTxnsForCall` is enough) that no async
dispatch pipeline can actually honour. The fix is a tombstone.

## Investigation conclusion

### The actual mechanism — in-flight event race

A timeout event traverses **three** async stages between emission and
the missing-call check:

1. **TransactionLayer's `eventQueue`** (bounded
   `Queue<TransactionEvent>`, capacity ≥ `max(64, udpQueueMax × 4)`,
   [TransactionLayer.ts:294-295](../../src/sip/TransactionLayer.ts#L294-L295)).
   `emit` is `Queue.offerUnsafe` —
   [TransactionLayer.ts:348-362](../../src/sip/TransactionLayer.ts#L348-L362).
2. **SipRouter's main consumer fiber** consumes the eventQueue via
   `Stream.fromQueue(eventQueue)` and forwards to PerCallDispatcher
   ([TransactionLayer.ts:907](../../src/sip/TransactionLayer.ts#L907)).
3. **PerCallDispatcher's per-call queue + worker fiber**
   ([PerCallDispatcher.ts:252-311](../../src/sip/PerCallDispatcher.ts#L252-L311)).
   The worker calls `withCall(callRef, ...)` which runs `loadCall`
   ([CallState.ts:431-467](../../src/call/CallState.ts#L431-L467)).

There is no way to retract an event already in stage 1. A call can
legitimately be torn down by an **unrelated path** while a timeout
event is in flight through stages 1-3:

- 200 OK / 487 from the peer completes a *different* transaction →
  rule path emits `remove-call` → `CallState.remove`
  ([CallState.ts:622-694](../../src/call/CallState.ts#L622-L694))
  evicts the call.
- Force-purge from the orphan sweep
  ([CallState.ts:1043-1050](../../src/call/CallState.ts#L1043-L1050))
  or safety-timer ([CallState.ts:553-554](../../src/call/CallState.ts#L553-L554))
  fires and runs `forcePurgeOne`.
- A BYE on the other leg terminates the call first.

When the in-flight timeout event is finally dequeued in stage 3,
`loadCall` finds nothing in `callsMap` (eviction completed) and
nothing in storage (delete propagated) → returns `undefined` → ERROR.
**No bug in any eviction path. Just queue latency vs concurrent
eviction.**

### Why chaos amplifies it

During peer kill, the survivor takes over the peer's traffic surge:
many outbound transactions are created (Timer B/F armed on each),
many calls terminate within seconds of each other (BYE flood + force-
purge sweeps), and the eventQueue + per-call queues are deeper than
in steady state. The per-event probability of "timer fires while
another path evicts" is small but cumulative over thousands of calls.
The clustering and the survivor-fires-killer's-callRef pattern are
both explained.

### Why the original hypothesis 2/3 was on the right track, but the framing was wrong

The original plan framed this as a `Fiber.interrupt`-vs-`emit` race
*inside* the timer fiber. In Effect v4, every `yield*` is an
interrupt boundary, so the interrupt should normally catch the fiber
before its next sync operation — `cancelTxnsForCall` running before
`emit` *does* prevent emit in the common case. The hard case is
hypothesis 2 in its full form: **the timer fires before any cancel
is even scheduled**, the event lands legitimately in the eventQueue,
and then a different path takes the call down while the event is
mid-pipeline. No fiber-interrupt timing assumption is required.

### Why hypothesis 1 (EchoApply not cancelling timers) is not the cause

[EchoApply.ts:149-177](../../src/replication/EchoApply.ts#L149-L177)
deletes a backup-side call's body + indexes from storage only. It
never touches the in-memory `callsMap`. But:

- If `callsMap` *has* the call (worker loaded it on a SIP message),
  `loadCall` returns the cached entry on the next lookup
  ([CallState.ts:432-433](../../src/call/CallState.ts#L432-L433))
  before ever consulting storage. So a Timer B/F firing in this
  worker for that callRef would resolve to a live call — no zombie.
- If `callsMap` does *not* have the call, there is no Timer B/F to
  fire (transactions are only created when the worker actually sends
  outbound on the call), so no zombie either.

EchoApply *does* have a separate (real) hygiene gap: a backup that
lazy-loaded a call into `callsMap` and is then told by the primary
"I deleted this call" should also tear down its in-memory copy. That
is **a real bug** but it presents as "orphaned in-memory calls leak
on the backup," **not** as zombie timeout errors. See "Out of scope".

### What the cancel sites already do (and why)

All five cancel sites in CallState —
[L458](../../src/call/CallState.ts#L458) (loadCall-recovery),
[L634](../../src/call/CallState.ts#L634) (remove pre-delete),
[L684](../../src/call/CallState.ts#L684) (remove cancel-txns),
[L820](../../src/call/CallState.ts#L820) (loadOwnedCalls-recovery),
[L957-958](../../src/call/CallState.ts#L957-L958) (forcePurgeOne) —
already invoke `timers.cancelAll` + `cancelTxnsForCallRef`. The pre-
delete ordering at [L679-684](../../src/call/CallState.ts#L679-L684)
exists to shrink the race window, not close it. **There is nothing
to add to the cancel sites themselves.**

## Recommended fix — sliding-window tombstone in CallState

Cheapest narrow fix that closes the race for any current or future
timeout-producing path.

### 1. Tombstone state

Add to CallState (alongside `callsMap`, `sipIndex`, `semaphores`):

```ts
// callRef → wall-clock fireAt when the tombstone expires.
// TTL set to 65s — comfortably above TIMER_B/F (32s), TIMER_H/J (32s),
// TXN_MAX_AGE (35s, TransactionLayer.ts:170) and any per-call dispatch
// queue latency. Sized so that an in-flight event from any layer that
// could plausibly still be queued at eviction time is guaranteed to
// see the tombstone.
const TOMBSTONE_TTL_MS = 65_000
const recentlyDeleted = MutableHashMap.empty<string, number>()
```

### 2. Population (must-run; immediately after delete)

In **`remove()`**, after the in-memory cleanup + `cancelTxnsForCallRef`
([CallState.ts:684](../../src/call/CallState.ts#L684)), before
returning:

```ts
recentlyDeleted.set(callRef, nowMs + TOMBSTONE_TTL_MS)
```

Same in **`forcePurgeOne()`** after
[CallState.ts:957-960](../../src/call/CallState.ts#L957-L960). Both
sites are already inside the must-run regions (per ADR-0003), so
the tombstone write inherits the must-run guarantee for free —
nothing new uninterruptible is introduced.

### 3. Synchronous read API

```ts
const wasRecentlyDeleted = (callRef: string): boolean => {
  const opt = MutableHashMap.get(recentlyDeleted, callRef)
  if (Option.isNone(opt)) return false
  if (Date.now() >= opt.value) {
    MutableHashMap.remove(recentlyDeleted, callRef)
    return false
  }
  return true
}
```

Plain sync JS. O(1). Exposed on the CallState service surface.

### 4. Periodic sweep (bounded growth)

The orphan-sweep daemon already runs every 60 s
([CallState.ts:1011-1067](../../src/call/CallState.ts#L1011-L1067)).
Add one pass over `recentlyDeleted` inside `sweepOnce`:

```ts
const tombstoneNow = Date.now()
for (const [cr, deadline] of recentlyDeleted) {
  if (tombstoneNow >= deadline) MutableHashMap.remove(recentlyDeleted, cr)
}
```

Bound: terminations within the last `TOMBSTONE_TTL_MS`. At 100 cps
that is ~6.5 k entries — trivial.

### 5. SipRouter dispatch — two-tier classification

Modify the timeout branch
([src/sip/SipRouter.ts:830-835](../../src/sip/SipRouter.ts#L830-L835)):

```ts
if (event.type === "timeout") {
  if (callState.wasRecentlyDeleted(callRef)) {
    lateTimeoutDroppedTotal++
    yield* Effect.logDebug(`Late timeout for deleted call ${callRef}${legInfo} — dropped (event in flight at eviction)`)
  } else {
    // No tombstone — the call vanished by some path that did NOT
    // go through remove()/forcePurgeOne(). Keep the loud signal.
    zombieTimeoutTotal++
    yield* Effect.logError(`Call ${callRef} not found on checkout for ${summary}${legInfo} — zombie timer fired (eviction-path bug)`)
  }
  return
}
```

Two counters, two semantics:

- `b2bua_late_timeout_dropped_total` — *expected* drops absorbed by
  the tombstone. Allowed to be non-zero; useful as a saturation /
  chaos-volume signal.
- `b2bua_zombie_timeout_total` — eviction-path *bug* alarm. MUST
  stay at 0 in healthy systems. If it ever ticks, some path is
  evicting calls without going through `remove`/`forcePurgeOne`,
  and we want to find it.

Also replace the misleading comment block at SipRouter.ts:831-833
with one line referencing the tombstone behaviour.

## Why this is the right fix

- **Closes the race universally.** The fix is at the dispatch
  boundary, downstream of every async stage that can carry a stale
  event. Adding new timer types or new eviction paths cannot reopen
  the gap.
- **Preserves the bug signal.** Splitting into two counters
  guarantees a future eviction-path bug (a real "callsMap removed
  outside of remove/forcePurgeOne") still raises ERROR. Today's
  blanket-ERROR pattern would lose that distinction if we just
  silenced the log.
- **Plain sync data.** No new Effect-runtime gymnastics, no
  uninterruptible widening, no per-timer payload changes. The
  tombstone is a `MutableHashMap` lookup at one place.
- **Respects ADR-0003.** Writes happen inside the existing must-run
  regions; no new blocking IO in uninterruptible scope.

## Why not the alternatives

- **Tombstone in TimerService.** Wrong layer — Timer B/F is not
  scheduled through TimerService at all, it's a custom fiber pair
  in TransactionLayer. The CallState-level tombstone catches both.
- **Generation-tag the timer event.** More invasive (timer payload
  + every txn + every cancel-and-reschedule). Same outcome.
- **Make `cancelTxnsForCall` synchronous-safe** by widening
  uninterruptible regions inside the timer fiber. Doesn't help —
  the dominant race is "timer fires legitimately, then another
  path evicts," which has no cancel involvement.
- **Hook EchoApply into CallState.remove on the backup.** Solves a
  different problem (in-memory shadow leak on backup) and carries
  real risk of mis-purging just-taken-over calls. See "Out of
  scope".

## Files to modify

| File | Change |
|------|--------|
| [src/call/CallState.ts](../../src/call/CallState.ts) | Add `TOMBSTONE_TTL_MS`, `recentlyDeleted` MutableHashMap, `wasRecentlyDeleted` sync function. Populate in `remove()` (around L687, after dispatcherPoison) and `forcePurgeOne()` (around L985). Add tombstone sweep pass inside `sweepOnce` (L1013-1051). Export `wasRecentlyDeleted` on the service surface (L122-180 — the readonly API record). |
| [src/sip/SipRouter.ts](../../src/sip/SipRouter.ts#L830-L835) | Split the timeout branch into tombstoned-drop (Debug + new counter) vs untombstoned-ERROR (kept). Replace the misleading comment at L831-833. |
| [src/observability/MetricsRegistry.ts](../../src/observability/MetricsRegistry.ts#L220-L243) | Add `lateTimeoutDroppedTotal: () => number` to `SipRouterMetrics`. Update the doc comment on `zombieTimeoutTotal` to reflect its tightened meaning. |
| [src/main.ts](../../src/main.ts) (or wherever the Prom registry is built) | Register `b2bua_late_timeout_dropped_total`. Grep `zombie_timeout_total` for the existing exposition site to find the conventional pattern. |

## Verification

### Unit test — fake-stack regression

Add `tests/sip/zombie-timer-race.test.ts` using the fake stack
([tests/support/fakeStack.ts](../../tests/support/fakeStack.ts)) +
TestClock:

1. Bring up CallState + SipRouter + TransactionLayer.
2. Create a call and trigger an outbound INVITE so a client
   transaction is armed with Timer B (32s).
3. **Stage the in-flight event**: advance the clock to TIMER_B so the
   timer fiber wakes and calls `emit`; pause yielding before
   SipRouter has consumed the event (use the [PumpableClock](../../tests/support/PumpableClock.ts)
   `pendingSleeps`/`yieldNow` primitives — there are existing
   examples in `tests/replication/*` that interleave queue-take and
   eviction).
4. Call `callState.remove(callRef)` from the test fiber. The
   tombstone is now in place; the timeout event is still in the
   eventQueue.
5. Resume yielding to drain the SipRouter → PerCallDispatcher →
   worker chain.
6. **Assert**: `zombieTimeoutTotal === 0`, `lateTimeoutDroppedTotal
   === 1`, no ERROR-level log line, exactly one DEBUG line matching
   "Late timeout for deleted call".

Add a second case that *does* trigger the ERROR path: directly
`MutableHashMap.remove(callsMap, callRef)` without going through
`remove()` (simulates a future eviction-path bug). Assert
`zombieTimeoutTotal === 1` and the ERROR line fires.

### Chaos endurance re-run

Existing reproduction from
[2026-05-16-zombie-timer-eviction-path-fix.md](2026-05-16-zombie-timer-eviction-path-fix.md):
`npm run test:k8s:endurance` with `worker-pod-graceful`,
`worker-pod-kill9`, `node-shutdown-app`.

Acceptance:
- `b2bua_zombie_timeout_total` = 0 across the 5-h run.
- `b2bua_late_timeout_dropped_total` may be non-zero (the absorbed
  race). Order of magnitude expected: similar to the pre-fix ERROR
  count (~50 / 5 h).
- Zero `zombie timer fired (eviction-path bug)` ERROR lines.

### Typecheck

`npm run typecheck` — zero TS errors, zero Effect-plugin warnings
(see CLAUDE.md "Never ignore a warning").

## Out of scope (with rationale)

### EchoApply backup-side in-memory cleanup

When a backup worker lazy-loaded a call into `callsMap` and the
primary later propagates a delete, EchoApply purges storage but
leaves the in-memory copy + its timers. Two real consequences:

- The in-memory call leaks (orphan sweep only handles `terminating`/
  `terminated`, not `active`).
- Armed rule-path timers keep firing on a call whose authoritative
  state says "gone."

**But this does not produce zombie-timeout errors** (the in-memory
copy still satisfies `loadCall`). Fixing it requires distinguishing
"still backup → delete is authoritative, purge" from "just promoted
to primary → delete is from a dying primary, *do not* purge", which
needs partition-role state we don't currently expose to EchoApply.
That is a separate, larger plan. Track in a new file
`backup-loaded-call-eol-on-replicated-delete.md`.

### Rule-path interpreter / ADR-0003 categorisation

Cancellation is already a must-run effect. No re-categorisation
needed.

### Generalising tombstones to non-timeout events

Late `"sip"` events already have a 481 path at
[SipRouter.ts:843-856](../../src/sip/SipRouter.ts#L843-L856).
`"cancelled"` events resolve through `resolveFromSipKey` (which
already returns `undefined` cleanly for vanished calls). No
spillover surface.

## Open question for review

The tombstone TTL of 65 s is a conservative choice. It must exceed:

- TIMER_B / TIMER_F (32 s — the longest a Timer B/F fiber can sleep
  before firing on a transaction whose call gets evicted right
  before).
- TIMER_H / TIMER_J (32 s — completed server-txn retention).
- TXN_MAX_AGE (35 s — TransactionLayer's safety sweep).
- The PerCallDispatcher per-call queue depth × handler latency
  worst case (bounded; sub-second in practice).

65 s is `max(32, 32, 35) + headroom`. If endurance shows tail-latency
events past 65 s we extend it; this should be visible as
`zombieTimeoutTotal` ticking while operators investigate.
