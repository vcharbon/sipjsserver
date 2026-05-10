# Peer-scan-bootstrap — re-activate the two skipped recovery tests

## Context

Two tests were marked `.skip` during the echo-removal slice
(docs/plan/lets-plan-a-proper-crystalline-emerson.md). Both exercised
the **same broken recovery pattern**: a respawned worker (sidecar
wiped) cold-pulled its peer's outgoing channel from `(0,0)` and
expected to rebuild its primary-partition state from the gen=0
**mirror echoes** the peer had previously written. Echo has been
killed (it was both wire noise and a correctness bug — the
update/delete crossing scenario could resurrect deleted calls), so
that recovery path no longer exists.

The legitimate replacement is a **peer-scan-bootstrap**: on respawn,
the worker reads its peer's `bak:{self}:*` partition directly via
`PeerRelay.scanCalls(role="bak", owner=self)`, and replays each
entry into its local `pri:{self}:*` partition. This avoids:

- Mixing legitimate originating-gen entries with stale mirrors on
  the channel.
- Re-walking the channel's full history (mirrors were
  unbounded-historical; scan reads only the current live set).
- Re-introducing any echo path or gen=0 bucket consumption.

**Intended outcome.** Both skipped tests pass again on the back of
the new bootstrap path. Recovery semantics match the description in
the test docstrings without depending on echo.

## What separates the broken tests from the still-passing ones

This is the most important diagnostic from the slice. Several
"recovery after wipe" tests survived echo removal; only two broke.
The shape of the difference tells you exactly what the
peer-scan-bootstrap has to cover.

| Test | Recovery direction | What's on the channel that's pulled | Status today |
|---|---|---|---|
| **NS7 — backup re-bootstrap** | B wiped; B re-pulls from `propagate:{A}->{B}` | A's **originating-gen** writes (entryGen = A.gen). These are A's own primary writes from steady state. | ✅ passes |
| **NS8 — primary recovery via reverse** | A wiped; A pulls from `propagate:{B}->{A}` | B's **originating-gen** writes that B emitted while A was down (B handled a BYE on A's behalf and called `storage.deleteCall(role="bak", peer=A)` or wrote an update via `channelBtoA.write(entryGen=B.gen, partition="bak", …)`). | ✅ passes |
| **NS14 — symmetric tombstone from backup** | A wiped; A pulls from `propagate:{B}->{A}` | B's **originating-gen** tombstone written on A's behalf during A's outage. | ✅ passes |
| **NS5 — sidecar wipe recovery** | A wiped; A pulls from `propagate:{B}->{A}` | **gen=0 mirror** of A's own pre-wipe write that B's puller previously echoed. | ❌ skipped |
| **replication-gap-mini phase 7** (quiet-call subset) | b2b-1 wiped; b2b-1 pulls from `propagate:{b2b-2}->{b2b-1}` | **gen=0 mirror** of b2b-1's pre-kill writes that b2b-2's puller previously echoed. The "quiet" subset is the calls b2b-2 never modified during b2b-1's outage. | ❌ skipped |

The pattern is sharp: **passing tests recover from entries the peer
originated; failing tests recovered from entries the peer echoed.**
Echo removal eliminated the gen=0 bucket entirely; the channel now
carries only the peer's own originating writes. That is exactly
right for the "peer actively did work on my behalf" scenarios
(NS7/NS8/NS14), and exactly wrong for "peer passively held my
quiet data" scenarios (NS5 + the quiet-call subset of
replication-gap-mini).

The quiet-call data **does** exist on the peer — at
`bak:{me}:call:*` in the peer's KvBackend. It just isn't reachable
via the channel anymore. Peer-scan-bootstrap reads it where it
lives:

```
respawn(self)
  for each peer:
    head = peer.channelPullBatch(propagate:{peer}->{self}, since=(0,0), limit=0).head
    for entry in peer.scanCalls("bak", owner=self):
      kv.applyReplicaUpdate(bodyKey=pri:{self}:{ref}, body=entry.json, indexes=…)
    start puller against propagate:{peer}->{self} since=head
```

This recovers exactly the data NS5 / replication-gap-mini's quiet
calls need, without re-introducing echo and without altering the
passing tests' recovery flow (they recover from
`propagate:{peer}->{self}` deltas, which the puller still pulls
the normal way after bootstrap).

## Exact tests to re-activate

These are the **only two** suites marked `.skip` in the
echo-removal slice. Other replication tests (NS1, NS3, NS7, NS8,
NS13, NS14, echo-apply, channel-index, kv-backend-{memory,parity},
prs-rewire, cold-recovery-without-mirror) were updated in-place to
match the no-echo / hard-DEL semantics and pass today.

1. **[tests/replication-ns/ns05-sidecar-wipe-recovery.test.ts](../../tests/replication-ns/ns05-sidecar-wipe-recovery.test.ts)**
   — currently `describe.skip("NS5 — sidecar wipe recovery (broken
   pattern, awaits peer-scan-bootstrap slice)", …)`.
   Scenario: A writes a call, B's puller catches up to `bak:{A}:X`,
   A's sidecar is wiped, A respawns with a higher `gen`, A must
   reacquire `pri:{A}:X` from B's backup.

2. **[tests/sip-front-proxy/failover/replication-gap-mini.test.ts](../../tests/sip-front-proxy/failover/replication-gap-mini.test.ts)**
   — currently `describe.skip("sip-front-proxy/failover —
   replication-gap-mini (awaits peer-scan-bootstrap)", …)`.
   Scenario: 40 calls × kill b2b-1 + respawn — zero 481 on BYE. The
   broken sub-scenario is phase 7's "quiet-call recovery": phase-1
   calls 10..19 that b2b-2 never modified during b2b-1's outage
   must still be present in b2b-1's `pri:b2b-1:*` after respawn so
   BYEs from Alice are forwarded to Bob rather than 481'd.

## Implementation

### Step 1 — Add `PartitionedRelayStorage.scanPartition`

Confirm `PeerRelay.scanCalls(role, owner)` already returns a stream
of `(callRef, json, ttlSec)` for entries under `${role}:${owner}:call:*`.
If the puller's transport (in production this is the HTTP
`/replog` server, in fake-stack the in-memory `PeerFabric`) already
exposes a way to scan the peer's storage, reuse it. If not, add a
thin RPC `GET /bak/scan?owner={self}` on `ReplLogServer` that
streams the peer's `bak:{self}:*` entries as JSON lines.

**Critical files:**
- [src/cache/PeerRelay.ts](../../src/cache/PeerRelay.ts) — already
  has `scanCalls`; verify the wire shape.
- [src/replication/ReplLogServer.ts](../../src/replication/ReplLogServer.ts)
  — extend with a scan endpoint if not present.
- [src/replication/PullerHttpTransport.ts](../../src/replication/PullerHttpTransport.ts)
  — add a `scanBak(peer, owner)` client method that streams the
  peer's bak partition.

### Step 2 — Wire bootstrap into worker boot

After the worker's KvBackend is constructed but BEFORE the puller
fiber starts pulling `propagate:{peer}->{self}`:

1. For each peer, call `scanBak(peer, self)` and replay each entry
   via `kv.applyReplicaUpdate(...)` into local `pri:{self}:*`.
   Reuse `callIndexKeysFromUnknown(body)` for index derivation, the
   same as the puller's apply path.
2. Record the peer's current `(gen, counter)` head **before**
   starting the scan, so the puller starts the long-poll from that
   head (everything older is now in local storage; pull deltas
   only).

**Critical files:**
- [src/main.ts](../../src/main.ts) — `forkPullerFiber` body.
  Currently calls `runPullerFiber(...)` directly; gate that behind
  a one-shot `bootstrapFromPeer(peerKv, self)` Effect first.
- [tests/support/k8sFakeStack.ts](../../tests/support/k8sFakeStack.ts)
  — same wiring for the simulated-cluster respawn path.

Reuse `kv.applyReplicaUpdate` (the atomic primitive added in
[src/storage/KvBackend.ts](../../src/storage/KvBackend.ts) during
the echo-removal slice) so bootstrap writes have the same body↔
indexes atomicity as steady-state apply.

### Step 3 — De-skip the two suites

Mechanical, once Step 2 is in place:

- `tests/replication-ns/ns05-sidecar-wipe-recovery.test.ts`:
  `describe.skip(...)` → `describe(...)`. Update the docstring to
  describe the scan-bootstrap path (rather than the deleted
  reverse-direction-echo path). The assertions stay the same.

- `tests/sip-front-proxy/failover/replication-gap-mini.test.ts`:
  `describe.skip(...)` → `describe(...)`. No content change.

### Step 4 — Lock the invariant

Add one focused test in
`tests/replication/peer-scan-bootstrap.test.ts`:

- Set up two workers, a and b.
- a writes calls 0..N to `pri:a:*` (propagates to b via the
  originating channel; b's puller applies to `bak:a:*`).
- a's sidecar is wiped.
- a's new incarnation runs `bootstrapFromPeer(bKv, "a")`.
- Assert: every call 0..N is present in a's local `pri:a:*` after
  bootstrap, with body + idx entries intact.
- Assert: no entry was written to a's outgoing `propagate:{a}->{b}`
  channel during bootstrap (bootstrap is a one-way read; it must
  not re-emit).

## Verification

1. `npm run typecheck` — zero errors, zero Effect-plugin warnings.
2. `npm run test:fake` — `1128 → 1130` passed; the two
   re-activated suites turn green, plus the new lock-in test.
   The other skipped tests (5 pre-existing + 1 unrelated `it.skip`)
   stay skipped.
3. The skipped count drops from 9 to 6 in the fake suite.
4. `npm run test:ci` — medium-tier live tests still pass.
5. Optional sanity: re-run the K8s endurance smoke and confirm
   `b2bua_stale_response_dropped_total` stays at zero for OPTIONS
   200 (the prior storm came through the tombstone-on-deleted-body
   path, which is now structurally impossible).

## Risks / things to watch

- **Bootstrap reads must complete before the puller starts.**
  Otherwise the puller could apply a delete frame to a call the
  bootstrap is about to install — race window. Sequence
  `bootstrap → record head → start puller-at-head`.
- **Index uniqueness.** Re-applying scanned entries via
  `applyReplicaUpdate` recomputes indexes from the body. If two
  scanned bodies derive overlapping index keys (shouldn't happen —
  callIds are unique — but worth a sanity assertion), the last
  write wins. Verify via the new lock-in test by scanning N>1
  calls and checking each's idx is resolvable.
- **Partial peer reachability.** If only one peer of two is up at
  respawn time, bootstrap from the reachable peer only and accept
  that calls primary-replicated to the unreachable peer stay
  missing until it returns. (Failure mode: the same 481 those
  calls would get today; no regression.)
