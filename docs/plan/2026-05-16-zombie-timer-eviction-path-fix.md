# Plan: eliminate "zombie timer fired (eviction-path bug)" log lines

## Problem statement

`SipRouter` emits this `ERROR` whenever a `"timeout"` event reaches the
per-call consumer fiber for a `callRef` that no longer exists in
`callsMap` nor the cache:

```
ERROR Call <callRef> not found on checkout for timeout leg=b-N
  — zombie timer fired (eviction-path bug)
```

The string lives at
[src/sip/SipRouter.ts:822](../../src/sip/SipRouter.ts#L822). The
companion comment at lines 818–821 explicitly admits the bug:

> After `TransactionLayer.cancelTxnsForCall` is wired into every
> call-eviction path this is unreachable — Timer B/F for an evicted
> call's transaction should never fire.

A `zombieTimeoutTotal` counter is already exposed in
[MetricsRegistry.ts:233-237](../../src/observability/MetricsRegistry.ts#L233-L237).

## Finding — 2026-05-15 endurance run

Run id: `endurance-5h-40caps-2026-05-15t22-13-47`. **25 zombie-timer
errors on worker-0** (similar count on worker-1, total ≈ 50 in 5 h),
clustered immediately after peer-worker chaos events
(graceful/SIGKILL/node-shutdown of the *other* worker). Sample on
worker-0 at `2026-05-16T00:11:02Z`, ~1 minute after chaos[21]
(`worker-pod-graceful` on worker-1):

```
ERROR Call b2bua-worker-1|endurance-short-…-442306@…11SIPpTag00442306
      not found on checkout for timeout leg=b-1 — zombie timer fired (eviction-path bug)
```

The callRef prefix is `b2bua-worker-1` — i.e. **calls owned by the
just-killed peer, for which worker-0 was the backup**. So the bug
isn't on the primary eviction path (worker owns the call, runs
`remove()`/`forcePurgeOne`, both of which call `timers.cancelAll` +
`cancelTxnsForCallRef` — see CallState.ts:601, 651, 905-906); it's on
some takeover / backup eviction path that *doesn't*.

## Root-cause hypotheses (verify in order)

1. **Peer-mirror delete on backup** — when the primary writes a
   terminate-delete to its mirror partition, the backup pulls the
   propagation event and drops the call from its in-memory map. If
   that drop path doesn't call `cancelTxnsForCallRef` + `timers.cancelAll`
   for the callRef, any leg-level timers the backup had scheduled
   while shadowing the call (e.g. peer-keepalive watchdog) will fire
   later as zombies. The 5 confirmed cancel sites in CallState.ts
   are 436, 651, 773, 906 — all on the natural-primary side. Need to
   check the backup-side handler (likely in
   [src/cache/PeerRelay.ts](../../src/cache/PeerRelay.ts) or
   [src/cache/PartitionedRelayStorageKvBacked.ts](../../src/cache/PartitionedRelayStorageKvBacked.ts)).

2. **Already-emitted timer event racing eviction** — `timers.cancelAll`
   only kills the *fiber*. If the fiber had already emitted its
   timeout to the SipRouter consumer channel *before* the cancel ran,
   the event is now in flight and will be dequeued against a missing
   call. This is a structural race that can happen on any eviction
   path. Possible signature: the zombie fires within the same ~ms as
   the eviction (not minutes later).

3. **TransactionLayer's own Timer B/F** — `TransactionLayer` keeps
   completed transactions for 65 s for retransmission replay
   (CallState.ts:631). If a Timer B/F for an in-flight transaction
   was scheduled but `cancelTxnsForCall` came in *after* the fiber
   committed to firing, same race as (2) at a different layer.

The clustering around peer-worker chaos points to (1) as the highest
probability.

## Reproduction (deterministic)

Fastest path is the inner-loop chaos sub-command:

```
npm run test:k8s:chaos -- --type worker-pod-graceful
```

with the endurance sipp streams already running (`npm run
test:k8s:endurance -- --no-chaos` as the baseline, or
`test:k8s:endurance` partway through). After ~30 s, grep the surviving
worker:

```
kubectl -n sip-test logs b2bua-worker-X -c worker | grep "zombie timer fired"
```

Pre-fix expectation: ≥ 1 line per gracefully-killed peer. Post-fix:
zero.

A fake-stack repro is also worth writing — once we know which path is
guilty we should be able to step a call through `loadCall →
takeover-mirror → primary delete propagation → timer fires`
deterministically under TestClock without kind/k8s. That test belongs
in `tests/replication/` alongside the existing
`main-puller-transport-wiring.test.ts`.

## Fix plan (staged — land in order)

### Stage 1 — instrument & confirm the path

Add a `tCancelled` / `tEmitted` pair to the timer event payload (or
log a structured `cancelMissedBy` reason) so when a zombie fires we
know whether it was racing the cancel (hypothesis 2/3) or evicted-
without-cancel (hypothesis 1). One run is enough to discriminate.

Acceptance: a single zombie line carries enough metadata to assign it
to a hypothesis.

### Stage 2 — fix the missing-cancel path (hypothesis 1, if confirmed)

Walk the backup eviction path:
1. Find where `propagate:{primary}` delete events are consumed on the
   backup side.
2. Confirm the consumer drops the call from `callsMap`, `sipIndex`,
   `semaphores`.
3. If yes but `timers.cancelAll(callRef)` + `cancelTxnsForCallRef(
   callRef)` are *not* called there, add them — same primitives the
   primary uses at CallState.ts:601 + 651. See ADR-0003 must-run
   contract; cancellation is a must-run effect on every eviction.

Acceptance: replay the reproduction; zombie count drops to whatever
hypothesis 2/3 still emits (could be 0).

### Stage 3 — race-proof the cancel→event-drop boundary (hypothesis 2/3, if still firing)

Two options:

- **Tombstone in the timer service.** `timers.cancelAll(callRef)`
  also records the callRef in a short-lived "cancelled" set. The
  SipRouter dispatcher checks the set when a `"timeout"` arrives;
  if present, drop silently and bump `zombieTimeoutTotal`.
  Cheapest, narrow.
- **Generation-tag the timer event.** Each call has a monotonic
  generation; timers carry the generation they were scheduled
  against. On dispatch, if `event.gen !== call.gen` (or call is
  None and `event.gen < lastCancelledGen`), drop. More general but
  more invasive.

Either way the `zombieTimeoutTotal` counter stays — flip the
`ERROR` log to `Debug` once we've classified it as expected.

Acceptance: 0 `ERROR` lines from this code path in a 5 h endurance
run. The counter (under a benign name) can still tick to track the
race rate.

## Out of scope

- Touching the rule-path interpreter or ADR-0003 categorisation —
  cancellation is already a must-run effect, so we only need to add
  it to the missed path, not rewrite the contract.
- Generalising "tombstone for late events" to non-timeout event
  types — late `"sip"` events on a vanished call already have their
  own `WARN`/`481` path at SipRouter.ts:824-843.

## Acceptance for the whole plan

1. `zombie timer fired (eviction-path bug)` log count = 0 across a
   5 h endurance run with peer-worker chaos (`worker-pod-graceful`,
   `worker-pod-kill9`, `node-shutdown-app`).
2. A regression test in `tests/replication/` reproduces the exact
   path that produced the bug and pins the cancel-on-eviction
   behaviour.
3. The misleading comment at SipRouter.ts:818-820 either disappears
   (because Stage 2 closed the gap) or is updated to describe the
   tombstone behaviour (Stage 3 outcome).
