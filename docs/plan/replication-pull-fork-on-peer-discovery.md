# Reactive ReplPuller fork loop — fix worker-0's empty bak partition

## Status: PROPOSAL — awaiting user direction

## Context

Slice C re-run with the PeerRelay route fix produced new evidence:

- `MID_DIALOG_DURING_CHAOS: 0` ✓ (still fixed)
- ReclaimRunner now reaches the scan endpoint (no `peersFailed`)
- **But ReclaimRunner still recovers ZERO calls every respawn** (`recovered=0 skipped=0 peers=1`)
- 481 storm around `worker-pod-graceful` events persists (~1100/event)

Drilling in: **worker-0 never pulled from worker-1.** The
`pod-logs/b2bua-worker-0.log` shows exactly one replication line at boot:

```
21:14:44.480  replication: no peers enumerated (single-replica StatefulSet?),
              no steady-state pull fibers forked
```

Worker-0 booted at 21:14:44. Worker-1 booted ~8 s later at 21:14:52. K8s
StatefulSet bootstrapping is ordinal-sequential — at the moment worker-0
read `PeerEnumerator.currentPeers`, worker-1 was not yet in the
headless-service DNS roster. The pull-loop fork code in
[src/main.ts:412-489](../../src/main.ts#L412-L489) reads `currentPeers` exactly once
and forks a fiber per peer. If the read returns empty, **no fiber is ever
forked**, even though `PeerEnumerator`'s background refresh loop (line 145)
will re-poll DNS every `refreshMs` and pick up the peer later.

Net effect: **worker-0's `bak:b2bua-worker-1:` is permanently empty.** It
never receives forward propagate entries from worker-1. When worker-1
dies and respawns, ReclaimRunner scans worker-0's `bak:b2bua-worker-1:`,
finds nothing, recovers nothing. Every BYE post-respawn for a primary=worker-1
call returns 481.

This race is structural in K8s StatefulSet ordinal-sequenced startup. It
was masked in the fake stack because the in-process `PeerFabric` registers
all peers synchronously before any worker boots. Slice B′ couldn't have
caught it.

## Secondary signal (lower priority)

Worker-1's puller is in place but every cycle ends via the **client-side 35 s
timeout safety net** instead of the **server-side 25 s `max-open` natural
close**:

```
21:15:26  replication: applyStream(b2bua-worker-0) timed out — reconnecting
21:16:00  replication: applyStream(b2bua-worker-0) timed out — reconnecting
```

The cycle is exactly 34–35 s, never 25 s. Server-side 58 `repl: server-close`
events were logged but client-side `client-close` never fires. So the long-poll
isn't reaching its natural end; the client is force-cutting it. Replication
still works because the apply path is cumulative across cycles, but the
behaviour is wrong and wastes 10 s per cycle.

This is a separate fix — log it, **defer to a follow-up**, not blocking
event-5's resolution.

## Fix proposal (primary issue)

Two main approaches.

### Approach — Reactive re-fork on peer additions

Replace the one-shot `for (const peer of peers)` loop with a watcher loop
that:
1. Maintains a `MutableHashMap<peer, Fiber>` of currently-running pull
   loops.
2. Periodically (every `peerWatchMs`, default ~5 s) re-reads
   `enumerator.currentPeers`.
3. Forks a new pull loop for any peer not yet in the map.
4. Optionally: cancels pull loops for peers that disappeared.

Pros: handles the bootstrap race AND any future scale-out. Aligns with the
existing `PeerEnumerator.headlessStatefulSet` background refresh.

Cons: more state to manage. Need to think about idempotency on rapid
peer-flap.


## Test coverage

The bug is structural: it requires StatefulSet pod ordering with a real
DNS resolver. Hard to reproduce in fake-stack. Two options:

- **(i)** A small targeted unit test that drives `PeerEnumerator.fixed`
  through the sequence `[] → [peer-1]` and verifies the fork loop forks
  a fiber for `peer-1` on the second snapshot.
- **(ii)** Rely on the K8s endurance run as the regression gate.

Recommendation: **(i) + (ii).** A unit test against the new fork-loop
helper is cheap and pins the contract; the K8s run is the end-to-end
proof.

## Verification

- `npm run typecheck` — zero errors / zero warnings.
- `npm run test:fake` — 1005 passing (no regression).
- The new unit test passes.
- Re-run `npm run test:k8s:endurance -- --proxy-chaos-disabled --duration 30m`
  and confirm `recovered>0` on worker-1 respawn AND the post-graceful
  481 spike drops materially.

## Risks

- Cancelling a pull loop on peer-disappear could create resume-position
  drift if the peer reappears with the same epoch but a different
  `lastSeq`. Idempotency on `replpos:{peer}` should make this safe; verify.
- Watchdog interval needs to be lower than the cluster's pod-startup
  delay budget so the pull loop is forked in time for the first BYE
  after worker-1 boots. 5 s is conservative; 1–2 s would be safer.



