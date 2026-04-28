# Data Replication Layer Refactor — Plan

## Slice tracking

| Slice | Description                                                    | Status        | Artifacts                                                                                  |
|-------|----------------------------------------------------------------|---------------|--------------------------------------------------------------------------------------------|
| 0     | Spec doc: full mechanism + signaling walk-throughs + recovery flows + loss classes | **DONE (v1)** | [docs/replication/call-cache-backup.md](../replication/call-cache-backup.md) — awaiting review |
| 1     | AtomicWriter + Lua script for call+indexes (no propagate yet); memory-layer mutex parity | **DONE**      | [src/replication/AtomicWriter.ts](../../src/replication/AtomicWriter.ts), [tests/replication/atomic-writer.test.ts](../../tests/replication/atomic-writer.test.ts), `PartitionedRelayStorage` delegates writes |
| 2     | PropagateStream + extend Lua to ZADD propagate:{peer} + EpochCounter | not started   |                                                                                            |
| 3     | `/replog` long-poll HTTP service + ReplLog + Prometheus `/metrics` endpoint | not started   |                                                                                            |
| 4     | ReplPuller client + steady-state replication (alongside legacy push for one slice) | not started   |                                                                                            |
| 5     | ReadyGate replaces ReclaimRunner; head-at-open handshake; 30 s ceiling | not started   |                                                                                            |
| 6     | Delete PeerCacheClient/PeerRelay/PeerCachePort/dual-write fork; tidy CallState | not started   |                                                                                            |

This table mirrors §15 of [the spec](../replication/call-cache-backup.md). Every PR updates both rows in lock-step.

## Context

The user reports three problems with the current Redis-backed HA replication
model:

1. **Lifecycle complexity** — worker boot/ready/drain interactions are tangled
   with the cache layer (ReclaimRunner directly flips WorkerReadiness; no
   explicit peer handshake before OPTIONS-OK).
2. **Call-model complexity** — `_topology` lives inside the call JSON,
   primary/backup roles are encoded in the key namespace, and dual-write
   logic is baked into `CallState.ts` rather than encapsulated in a
   replication coordinator.
3. **Not properly atomic** — `putCall` writes the call body and N index
   keys sequentially (no MULTI/EXEC, no Lua). F10 (mid-flush crash loses
   indexes) is an accepted loss class today. Dual-write is fire-and-forget
   per D3.

New requirement the user wants on top of these fixes:

- On reboot, the worker must **verify with all backup-buddy peers that it
  is in sync** before returning 200 OK to OPTIONS / before joining the
  K8s Service. This is stronger than the current "best-effort reclaim
  then mark ready" behaviour.

## Current implementation snapshot (from exploration)

- Per-call partitioned key: `{pri|bak}:{ownerOrdinal}:call:{callRef}`
  ([PartitionedRelayStorage.ts](../../src/cache/PartitionedRelayStorage.ts)).
- Dual-write fan-out is fire-and-forget, forked child fiber, errors
  swallowed ([CallState.ts:172-200](../../src/call/CallState.ts#L172-L200)).
- Conflict resolution: monotonic `_topology.gen` per call; newest-gen wins
  ([TODO_doubleWrite.md D7](../../docs/todos/TODO_doubleWrite.md)).
- Recovery: pull on boot via [ReclaimRunner.ts](../../src/cache/ReclaimRunner.ts);
  scans every live peer's `bak:{self}:` partition, gen-compares, writes
  back locally; flips `WorkerReadiness` true on completion or timeout.
- Peer-to-peer cache writes go over HTTP via
  [PeerCacheClient.ts](../../src/cache/PeerCacheClient.ts) /
  [PeerRelay.ts](../../src/cache/PeerRelay.ts).
- SIP timer constraint: K8s `terminationGracePeriodSeconds = 200s`
  (RFC 3261 Timer C 180s + 20s safety) per
  [resilience-model.md:66](../../docs/sip-front-proxy/resilience-model.md#L66).
- Memory note: dual-Redis (one sidecar per worker) was deliberately chosen
  *over* Redis replication because Redis async replication's latency
  profile is incompatible with SIP timer windows.

## Existing test coverage (pure-cache, no SIP)

- `tests/cache/dual-write.test.ts` — dual-write fan-out, gen monotonicity, recovery write-back.
- `tests/cache/reclaim-on-restart.test.ts` — single-peer reboot recovery.
- `tests/cache/reclaim-peer-down-mid-scan.test.ts` — graceful degradation on peer failure.
- `tests/cache/reclaim-under-lan-stress.test.ts` — latency injection.
- `tests/cache/reclaim-timeout-481.test.ts` — reclaim timeout → ready anyway.
- `tests/cache/partitioned-relay-storage.test.ts` — TTL/scan in memory layer.
- `tests/cache/peer-fabric.test.ts` — kill/reboot/partition/heal control surface.
- `tests/cache/worker-readiness.test.ts` — readiness flag state machine.
- `tests/cache/peer-enumerator.test.ts` — peer membership tracking.
- `tests/cache/peer-relay-roundtrip.test.ts` — HTTP wire format.

### Known gaps in existing tests

- No test for **per-call atomicity** (call body + indexes interleaving under
  concurrent writes / mid-flush crash).
- No **multi-peer concurrent recovery** (two workers reboot at once).
- No **split-brain across the two Redis sidecars** (workers diverge, then heal).
- No **concurrent writes to same call from primary + recovered worker**
  (gen-comparison correctness under race).
- No **pre-OPTIONS handshake test** — because the handshake doesn't exist yet.
- No **peer-redis outage** combined with worker restart.

## Agreed design shape (from grilling)

### Storage layout — each worker N's local Redis sidecar holds

| Key                              | Value           | Notes                                                |
|----------------------------------|-----------------|------------------------------------------------------|
| `pri:N:call:{callRef}`           | call JSON       | Same as today; primary owns                          |
| `bak:P:call:{callRef}`           | call JSON       | Same as today; N is acting as backup for primary P   |
| `idx:{indexKey}`                 | callRef         | Same as today; flat index namespace                  |
| `propagate:{peer}`               | sorted set      | NEW: members = callRefs, score = monotonic seq       |
| `propagate_seq:{peer}`           | counter         | NEW: monotonic seq generator per peer direction      |
| `epoch:N`                        | sentinel string | NEW: bumped on Redis sidecar restart                 |

### Propagate stream semantics

- **One sorted set per peer direction.** When worker N is primary for callRef X with backup B → N writes `ZADD propagate:B {seq} X`. When N is acting as backup for primary P's call X and updates it → N writes `ZADD propagate:P {seq} X` (so P can recover on its restart).
- **Backup assignment is per-call** (carried in `_topology.bak`, set at call creation by the cookie / LB hash). A single worker N may simultaneously have `propagate:B`, `propagate:C`, `propagate:D`, … one sorted set per peer with which N currently has at least one call in either direction. Each set lives as long as any call is active between the two workers; sliding TTL on the set drops it when the relationship goes idle.
- **Compacted by callRef.** ZADD on existing member updates score; one entry per callRef per peer.
- **No tombstones.** Deletes are not announced. Backup's `bak:` copy carries identical TTL to primary's `pri:` copy; when primary stops refreshing (call ends), backup's copy expires within one TTL window.
- **Stale propagate entries (call gone)** are GC'd lazily by a periodic sweep that removes entries whose `call:{ref}` is null AND whose seq is below the lowest backup ack.
- **Long downtime**: peer comes back, asks `propagate:{me}` from its primary, gets only currently-alive callRefs (others are TTL-expired), pulls their state. No replay of dead history.

### Atomic write boundary (Lua)

A single Lua script per logical write, all-or-nothing in one Redis round-trip:

```
local seq = INCR propagate_seq:{peer}
SETEX pri:N:call:{ref} ttl json
SETEX idx:{key1} ttl ref ; SETEX idx:{key2} ttl ref ; ...
ZADD propagate:{peer} seq ref
EXPIRE propagate:{peer} long_ttl   -- sliding TTL on the whole set
```

This closes:
- F10 (mid-flush index loss).
- "Backup misses callRef create" (the propagate ZADD is part of the same atomic step; the backup's pull will dereference and find current state).

### Pull protocol (peer ↔ peer over HTTP, long-poll)

- `GET /replog?caller={N}&epoch=E&since=Y` on the primary's Node worker.
- Server response opens with `{"head_at_open": <currentMaxSeq>, "epoch": <E_local>}`, then streams entries `(seq, callRef, currentState | null)` for every member of `propagate:N` with score > Y in seq order.
- Once the pre-existing backlog is drained, the response remains open (long-poll). New writes the primary makes are pushed on the same connection. Server sends a heartbeat every ~10 s; max-wait timeout ~25 s, after which client reconnects.
- Re-entrant: client tracks `(epoch, lastSeq)`. On reconnect or timeout, it resumes with the same since=lastSeq. Idempotent because each entry resolves to current state of callRef.
- **Epoch mismatch** (server's `epoch` ≠ client's stored epoch for that peer) ⇒ client resets `lastSeq=0` and does a fresh full sweep against the new epoch.
- **`currentState=null`** in a streamed entry means "callRef referenced by propagate but call key is gone (TTL or deletion)" — client deletes its `bak:{primary}:call:{ref}` copy and any indexes pointing at it. (Optional path; in practice TTL alignment makes explicit deletes rare.)

### Lifecycle invariant (the new ready gate)

A worker N must NOT respond `200 OK` to OPTIONS / must NOT be marked ready in the K8s readinessProbe until:

1. **Enumerate peers via DNS SRV** (existing `PeerEnumerator`). DNS only returns K8s-Ready peers (default `publishNotReadyAddresses: false`).
2. **For each enumerated peer P**: open `/replog?caller=N&epoch=<N_epoch>&since=<lastSeq_P>`. Read `HEAD_AT_OPEN_P` from server. Drain entries until `lastSeq_P ≥ HEAD_AT_OPEN_P`. Mark P as `synced`.
3. Hard ceiling **30 s** on the whole operation. Peers not `synced` by then are recorded as `unreconciled[]`. Calls whose `_topology.bak === unreconciled` peer become 481 fall-through if hit (existing D14 contract).
4. **Then** flip `WorkerReadiness` true. Long-poll connections opened during the gate stay open and continue to deliver steady-state freshness.

## Recommended approach

### Module layout (new + changed files)

| Path                                                    | Status   | Role                                                                 |
|---------------------------------------------------------|----------|----------------------------------------------------------------------|
| `docs/replication/call-cache-backup.md`                 | NEW      | Slice 0 deliverable: full mechanism + signaling walk-throughs        |
| `src/replication/ReplMetrics.ts`                        | NEW      | Per-peer delay metrics + Prometheus `/metrics` endpoint              |
| `src/replication/PropagateStream.ts`                    | NEW      | Encapsulates `propagate:{peer}` sorted set + seq counter + epoch     |
| `src/replication/AtomicWriter.ts`                       | NEW      | Owns the Lua script; sole entry point for writes that touch call+idx+propagate |
| `src/replication/ReplLog.ts`                            | NEW      | HTTP service `/replog?caller&epoch&since` (long-poll), Effect Hub-driven |
| `src/replication/ReplPuller.ts`                         | NEW      | Per-peer long-poll client; tracks (epoch, lastSeq); applies pulled entries |
| `src/replication/ReadyGate.ts`                          | NEW      | Drives the boot handshake; flips `WorkerReadiness` after sync-or-30s |
| `src/replication/EpochCounter.ts`                       | NEW      | INCRs `epoch:N` on worker process boot; exposes the current epoch    |
| `src/cache/PartitionedRelayStorage.ts`                  | CHANGED  | `putCall` / `refreshCall` / `deleteCall` delegate to `AtomicWriter` for the Lua path. Memory-layer simulates same atomicity via mutex |
| `src/call/CallState.ts`                                 | CHANGED  | Removes `fanOutPut` / `fanOutDelete` and the `Effect.forkChild` HTTP call. Writes go through the storage layer; replication is implicit |
| `src/cache/PeerCacheClient.ts`                          | DELETED  | Replaced by `ReplPuller` long-poll                                   |
| `src/cache/PeerRelay.ts`                                | DELETED  | Replaced by `ReplLog`                                                 |
| `src/cache/PeerCachePort.ts`                            | DELETED  | No more push-side port                                                 |
| `src/cache/ReclaimRunner.ts`                            | REPLACED | Replaced by `ReadyGate` (different protocol)                         |
| `src/cache/WorkerReadiness.ts`                          | UNCHANGED | Same flag interface; flipped by `ReadyGate` instead of `ReclaimRunner` |
| `src/cache/PeerEnumerator.ts`                           | UNCHANGED | Reused as-is for DNS enumeration                                     |

### Why the call model gets simpler

- `_topology.bak` stays in the call JSON (it's the per-call buddy assignment from the cookie, set at INVITE time by the LB hash) — but `_topology.gen` and the dual-write fork disappear from `CallState.ts`. The Lua-side seq counter replaces the call-level gen for replication ordering. The call body keeps a small `_repl: { writerEpoch, writerSeq }` field for cross-write reconciliation.
- The split between "call store" and "index store" inside `CallStateCache.ts` becomes a single atomic write; the in-memory variant simulates this with a mutex around the same write set.

### Slicing (each slice independently shippable + tested)

0. **Slice 0 — Documentation: call cache backup mechanism (deliverable before any code)**. Author `docs/replication/call-cache-backup.md` with:
   - End-to-end overview: storage layout, propagate stream, epoch, pull protocol, ready gate, TTL alignment.
   - **Primary-side signaling walk-through**: when a SIP request lands on a worker that is the call's primary — how the call is read from `pri:N:call:{ref}` (or hydrated from index lookup `idx:{indexKey}` → callRef), how a write triggers the atomic Lua, how `propagate:{bak}` is bumped, how the long-poll consumer at the backup observes the change. Walk through INVITE / re-INVITE / refresh-timer / BYE.
   - **Backup-side signaling walk-through**: when a SIP request lands on a worker that is the call's backup (only happens after takeover or sticky-cookie loss) — how the call is read from `bak:P:call:{ref}`, how the worker decides whether to take over (writer-epoch comparison vs primary's epoch + reachability of the original primary), how a takeover write goes back through the same atomic Lua but ZADDs `propagate:P` (the original primary), how the original primary picks the takeover-side updates back up on its restart.
   - **Recovery walk-throughs**: 
     - Worker process restart, Redis sidecar persists.
     - Worker pod restart, Redis sidecar wiped (epoch advance, full resync).
     - Long downtime (hours, most calls TTL-expired).
     - Bidirectional restart (both sides of a buddy pair down concurrently).
   - Diagrams (ASCII or PlantUML) of the propagate-set lifecycle and the ready-gate handshake.
   - Cross-references to RFC 3261 timer constraints (Timer C 180s, dialog timeouts) and to the existing `docs/sip-front-proxy/resilience-model.md`.
   - Explicit "loss class" enumeration: list every accepted-loss scenario and the magnitude (e.g. "primary crash within long-poll round-trip window — at most one un-ack'd write may be lost on a callRef being concurrently updated").
   This document is reviewed and merged before Slice 1 starts and serves as the spec the implementation slices reference.

1. **Slice 1 — Lua atomic writer**. Introduce `AtomicWriter` + Lua script. Replace the sequential `SETEX` loop in `PartitionedRelayStorage.putCall` with the Lua call (no propagate yet). Mirror in memory layer with a mutex. Tests: assert no half-state ever observed under concurrent writers.
2. **Slice 2 — Propagate sorted set + seq counter + epoch**. Add `PropagateStream` and extend the Lua to ZADD `propagate:{peer}`. CallState still uses the existing `PeerCacheClient` HTTP push path; the propagate set is written but no consumer yet. Tests: ZADD compaction, sliding-TTL, epoch monotonicity.
3. **Slice 3 — `/replog` HTTP service (long-poll) + ReplLog**. Stand up the server endpoint. No client yet. Tests: head-at-open framing, drain-then-block, epoch in response, heartbeat cadence, server-side trim of stale entries.
4. **Slice 4 — `ReplPuller` client + steady-state replication**. Run alongside `PeerCacheClient` push for one slice (both write paths active, idempotent at backup). Tests: convergence under faults, re-entrant resume.
5. **Slice 5 — Cut over: `ReadyGate` replaces `ReclaimRunner`**. Replace boot-time scan with the head-at-open handshake. Tests: ready-gate correctness, 30 s ceiling, unreconciled accounting.
6. **Slice 6 — Remove push side**. Delete `PeerCacheClient`, `PeerRelay`, `PeerCachePort`, the dual-write fork in `CallState`. Update fullcall e2e tests to confirm the new path keeps the existing scenarios green.

Each slice runs `npm run typecheck` clean and ships with its own tests under `tests/replication/`. Slice 5 is the only one with a behavioural cut; slices 1-4 add new code in parallel to the existing path.

### Reused existing functions / utilities

- `src/cache/PeerEnumerator.ts` — DNS SRV enumeration for the ready-gate peer list.
- `src/cache/WorkerReadiness.ts` — same flag interface, different driver.
- `src/redis/RedisClient.ts` — `eval()` for Lua, `pipeline()` for batched reads in the periodic propagate-set GC.
- `src/call/CallModel.ts` — `callIndexKeys()` derivation stays.
- `tests/support/fakeStack.ts` / `tests/cache/peer-fabric.test.ts` — fault-injection fabric pattern (kill/reboot/partition/heal/latency) is exactly what the new `tests/replication/` suite needs; reuse the simulator and add a `propagate:` map to it.

## Verification plan

### New test suite: `tests/replication/`

All tests are fake-stack (`it.effect` + TestClock) except the live-Redis Lua smoke test.

#### Scenario tests (hand-written, deterministic)

| File                                                         | Asserts                                                                                |
|--------------------------------------------------------------|-----------------------------------------------------------------------------------------|
| `tests/replication/atomic-writer.test.ts`                    | Lua + memory-layer mutex: no observer ever sees call w/o indexes; concurrent writers serialize |
| `tests/replication/propagate-compaction.test.ts`             | 50 writes to same callRef → 1 entry per peer; sliding TTL extends on each write        |
| `tests/replication/propagate-zadd-replaces-score.test.ts`    | ZADD semantics: same member updates score (not duplicate)                              |
| `tests/replication/replog-head-at-open.test.ts`              | Server emits HEAD_AT_OPEN; drain stops at that seq; new writes after open keep streaming |
| `tests/replication/replog-long-poll-heartbeat.test.ts`       | Connection held during idle; heartbeat at 10 s; reconnect after 25 s; resumes from lastSeq |
| `tests/replication/repl-puller-resume.test.ts`               | Client persists (epoch, lastSeq); restart resumes; idempotent over duplicate entries   |
| `tests/replication/epoch-mismatch-resync.test.ts`            | Primary boot bumps epoch → client detects mismatch → resets lastSeq=0 → full sweep     |
| `tests/replication/long-downtime.test.ts`                    | Backup down for "hours"; most calls TTL out; backup comes back, only live calls pulled |
| `tests/replication/ready-gate-happy.test.ts`                 | All peers reachable; ready flips after every peer drained to its head_at_open          |
| `tests/replication/ready-gate-30s-ceiling.test.ts`           | One peer unresponsive; ready flips at 30 s; unreconciled list contains that peer       |
| `tests/replication/ready-gate-no-peers.test.ts`              | Brand-new pod, empty cluster; ready flips immediately                                  |
| `tests/replication/concurrent-write-recovery.test.ts`        | Backup acted as primary during downtime; original primary returns; gen reconciles      |
| `tests/replication/bidirectional-propagate.test.ts`          | A↔B both have calls in either direction; both `propagate` sets converge                |
| `tests/replication/network-partition-heal.test.ts`           | Partition for window; both sides write; heal; sets converge w/o duplicate entries      |
| `tests/replication/redis-sidecar-restart.test.ts`            | N's Redis wiped; epoch advances; backups detect; re-replicate live calls into fresh sidecar |

#### Property-based tests (fast-check)

`tests/replication/properties.test.ts` — generators produce random op sequences (write/refresh/delete) and random fault injections (peer kill/reboot/partition/latency). Run for a bounded simulation horizon, then drop all faults and let the system quiesce. Assert at quiescence:

- **Eventual convergence**: ∀ alive peer P, ∀ alive callRef X where P is a destination, P's `bak:{owner}:call:X` matches the owner's `pri:{owner}:call:X`.
- **Monotonic generation**: across all observed reads at any peer, gen for callRef X never decreases without epoch advance.
- **Ready-gate correctness**: no worker ever flipped ready while a reachable peer's `propagate:self` had unconsumed entries below that peer's head_at_open captured at gate-open time, before the 30 s ceiling.

#### Live-Redis Lua smoke test

`tests/replication/live-lua.test.ts` (`it.live`, real ioredis against a local Redis spun up by the test). Asserts:
- Lua script executes; sequence counter monotonic across script invocations.
- ZADD-replaces-score under concurrent invocation.
- `EVALSHA` cache hit after first call.

This is the only live test added; everything else runs in the fake-stack inner loop.

### Failure modes to monitor in production

#### Primary-side metrics (server view of every consumer peer)

The primary (any worker emitting `propagate:{Y}` entries) MUST expose per-consumer replication-delay metrics so an operator can answer "is peer Y keeping up with my writes?" without involving Y. These are scraped from the primary's `/metrics` endpoint (Prometheus exposition format).

| Metric                                                | Type    | Labels                          | Meaning                                                                                                |
|-------------------------------------------------------|---------|---------------------------------|--------------------------------------------------------------------------------------------------------|
| `sipjsserver_repl_head_seq`                           | gauge   | `{peer}`                        | Current `propagate_seq:{peer}` head on the primary. Increases monotonically within an epoch.           |
| `sipjsserver_repl_delivered_seq`                      | gauge   | `{peer}`                        | Highest seq the primary has streamed to peer Y on the active long-poll connection (server bookkeeping). |
| `sipjsserver_repl_delay_seq`                          | gauge   | `{peer}`                        | `head_seq − delivered_seq`. The "how many seqs we haven't forwarded to Y yet" number.                  |
| `sipjsserver_repl_delay_callrefs`                     | gauge   | `{peer}`                        | Distinct callRef count in `propagate:{peer}` with score > delivered_seq (compaction-aware delay).      |
| `sipjsserver_repl_consumer_epoch`                     | gauge   | `{peer}`                        | Epoch the active consumer connected with. Diverges from local epoch ⇒ peer is on stale epoch.          |
| `sipjsserver_repl_consumer_connected`                 | gauge   | `{peer}`                        | 1 if a long-poll is currently open from peer Y, else 0.                                                |
| `sipjsserver_repl_consumer_disconnected_seconds`      | gauge   | `{peer}`                        | Seconds since peer Y last had an open long-poll. 0 while connected.                                    |
| `sipjsserver_repl_oldest_unforwarded_seconds`         | gauge   | `{peer}`                        | Wall-clock age of the oldest entry in `propagate:{peer}` with score > delivered_seq. Catches "stuck".  |
| `sipjsserver_repl_lua_eval_total`                     | counter | `{outcome="ok\|err"}`           | Lua script invocations and failures.                                                                   |
| `sipjsserver_repl_propagate_zcard`                    | gauge   | `{peer}`                        | Total members in the propagate sorted set. Memory bound check.                                         |
| `sipjsserver_repl_propagate_gc_removed_total`         | counter | `{peer}`                        | Members trimmed by the periodic GC sweep (call gone + below low-water).                                |
| `sipjsserver_repl_epoch_advance_total`                | counter | (no peer label)                 | Bumps of local `epoch:N` since process start. > 1 on a single boot indicates a bug.                    |

The combination `repl_delay_seq` + `repl_consumer_disconnected_seconds` is the primary alerting signal: small + connected = healthy; growing + disconnected = peer Y is behind and not catching up.

#### Consumer-side metrics (puller view)

| Metric                                                | Type    | Labels                          | Meaning                                                                              |
|-------------------------------------------------------|---------|---------------------------------|--------------------------------------------------------------------------------------|
| `sipjsserver_repl_puller_connected`                   | gauge   | `{peer}`                        | 1 if our long-poll is open to peer; 0 else.                                          |
| `sipjsserver_repl_puller_last_seq`                    | gauge   | `{peer}`                        | The lastSeq we have for peer (matches their `delivered_seq` in steady state).        |
| `sipjsserver_repl_puller_epoch`                       | gauge   | `{peer}`                        | Epoch we are tracking for peer.                                                       |
| `sipjsserver_repl_puller_apply_total`                 | counter | `{peer, outcome}`               | Successful / failed entry applications (apply = upsert into our `bak:{peer}:`).       |
| `sipjsserver_repl_puller_resync_total`                | counter | `{peer, reason="epoch\|gap"}`   | Times we reset lastSeq=0 because of epoch advance or detected gap.                   |
| `sipjsserver_ready_gate_duration_seconds`             | histogram | (no labels)                   | Boot-to-ready latency. P95/P99 alarms.                                               |
| `sipjsserver_ready_gate_unreconciled_count`           | gauge   | (no labels)                     | Peers we couldn't drain within the 30 s ceiling. > 0 ⇒ degraded recovery.            |

#### Operational invariants surfaced by these metrics

| Failure mode                                              | Detection signal                                                              | Severity                |
|-----------------------------------------------------------|-------------------------------------------------------------------------------|-------------------------|
| Long-poll consumer can't connect                          | `repl_consumer_connected{peer}=0` for > 30 s while peer is K8s-Ready          | High (data freshness)   |
| Backup falls behind primary's head                        | `repl_delay_seq{peer}` > threshold AND `repl_oldest_unforwarded_seconds` rising | Medium → High          |
| Stale epoch on consumer                                   | `repl_consumer_epoch{peer} != local_epoch` for > 30 s                         | Medium                  |
| Epoch advance more often than expected                    | `repl_epoch_advance_total` rate exceeds expected restart rate                 | Diagnostic              |
| Ready-gate ceiling hit                                    | `ready_gate_unreconciled_count > 0`                                           | Medium                  |
| Propagate set unbounded                                   | `repl_propagate_zcard{peer}` growing without GC trim activity                 | High (memory leak)      |
| Lua script failures                                       | `repl_lua_eval_total{outcome="err"}` > 0                                      | High                    |
| Backup's `bak:` set diverges from `pri:`                  | Periodic scrub: callRefs in bak: not in pri: (post-grace) > 0                | High (data loss class)  |
| TTL-driven ghost calls                                    | bak: entries that expired while still in primary's pri: (count)               | Medium                  |
| Concurrent write detected                                 | Two writers bumping seq for same callRef within race window                   | High (split-brain)      |

All metrics are exposed via the existing OTel pipeline (`docs/tracing-design.md`) AND via a Prometheus `/metrics` endpoint on the worker. The metrics module is added in Slice 3 alongside the `/replog` HTTP service so the server bookkeeping is colocated with the long-poll state.

### Acceptance for the refactor

- All slices land with `npm run typecheck` clean (no warnings).
- `npm run test:fake` and `npm run test:ci` both pass with the new `tests/replication/` suite.
- The existing `tests/cache/*` files are removed (post-Slice-6) once their concerns are subsumed by the new suite. `tests/fullcall/e2e-fake-clock.test.ts` and `tests/fullcall/e2e-real-clock.test.ts` continue to pass without modification — replication is invisible to SIP scenarios.
- The new ready-gate semantics are exercised in `tests/fullcall/e2e-fake-clock.test.ts` for at least one scenario where a worker reboots mid-call.

### Out of scope for this refactor

- Multi-Redis-instance per worker (the design uses a single sidecar per worker; "dual-Redis" in the memory note refers to two sidecars across the cluster).
- Cross-region replication / WAN sync.
- Adaptive backup-buddy reassignment (still per-call from cookie).
- Quorum or consensus-based ownership election.
- Persisting Redis to disk (still pure in-memory; design is engineered around that).
