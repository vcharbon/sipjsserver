# Track B — Replication redesign: design alignment

## Context

Track B of [docs/plan/pure-enchanting-forest.md](pure-enchanting-forest.md) calls for a first-principles redesign of the call-cache replication subsystem. The current implementation (described in [docs/replication/call-cache-backup.md](../replication/call-cache-backup.md) and shipped in `src/replication/`) has produced repeated incidents: peer-discovery boot races (commit `d6a2b7b`), HTTP timeout misalignment, ReadyGate stalls leaving workers out of rotation. Rather than patch these, the team is redesigning.

Two **non-negotiable** constraints from the user, established at grill kickoff:

1. **Test/prod replication parity is critical.** A representative replication layer must run in tests without Redis. The fake stack and the Redis stack must share as much code as humanly possible — divergence between them was a root cause of K8s-only bugs (commit `d6a2b7b`: "fix detected by k8s") that the fake-stack tests did not catch.
2. **Stable SIP-service-facing surface, free to redesign boot/state interaction.** The layer the SIP B2BUA hot-path consumes (`PartitionedRelayStorage` — `putCall` / `getCall` / `deleteCall` / `refreshCall`, and `CallLimiter`) must remain interface-compatible. The layer's interaction with pod boot, readiness, and recovery (`ReadyGate`, `WorkerReadiness`, `ReclaimRunner`, peer enumeration) is fair game — explicitly because it does not work well today.

## Current-state map (for grounding)

**SIP-service-facing surface (must stay stable):**
- `PartitionedRelayStorage` — `putCall` / `getCall` / `deleteCall` / `refreshCall`. Consumed by `CallState`, which is what handlers call.
- `CallLimiter` — `checkAndIncrement` / `refresh`. Consumed by decision engine + framework rule.
- `WorkerReadiness.currentReady` — read by OPTIONS handler only (NOT a request-admission gate).

**Replication internals (free to redesign):**
- `AtomicWriter` — Lua-backed dual-key write (`pri:{self}:` + `propagate:{peer}` ZADD).
- `PropagateStream` / `ReplLog` — server side: HTTP NDJSON long-poll over `propagate:{peer}` ZSET.
- `ReplPuller` — client side: drains peer's `/replog`, applies to `bak:{peer}:` (forward) or `pri:{self}:` (reverse).
- `EpochCounter` — worker incarnation, bumped once per boot.
- `WriteNotifier` — in-process pubsub fan-out into `ReplLog`.
- `ReadyGate` — drains every peer's `propagate:{self}` to `head_at_open` before flipping `WorkerReadiness`.
- `ReclaimRunner` — SCAN-based safety net.

Two parallel impls per module today (`redisLayer` + `memoryLayer*`), tested separately. The memory variant is what every fake-clock test exercises; the Redis variant runs only in production and the single `e2e-real-clock` live test.

---

## Open design decisions (resolved during grill)

_Filled in as questions are answered._

### D1. Test/prod parity strategy — RESOLVED

**Decision: Option A — thin storage primitive, fat shared logic.**

Define one `KvBackend` port. All replication modules (AtomicWriter, PropagateStream, ReplLog, ReplPuller, EpochCounter, etc.) become a single implementation that consumes the port. Two backends satisfy the port: production Redis (Lua + sockets) and an in-memory `MutableHashMap`-backed implementation (single mutex, single-fiber-safe under TestClock).

**Scope of the port (initial):** treat Redis as a hashmap. KV ops + whatever data structure is required to answer "what changed since gen N for partition P" (resolved in D2/D3). Notification primitives (pubsub, blocking-pop, long-poll wakeup) are explicitly deferred — correctness must not depend on them; they may later be added as a latency optimization.

**Why Option A and not B/C:** the bug in commit `d6a2b7b` was a peer-enumeration orchestration bug, not a Lua/atomicity bug. Option C (in-process Redis emulator) would not have caught it. Option B (status-quo + parity tests) is what we already do de-facto, and it produced the current pain. Pushing the parity boundary to the narrowest point (the storage primitive) means every higher-level test exercises the prod orchestration code.

**Cost accepted:** ~1 week refactor. Lua-atomic compound writes need an in-memory transactional analogue (single mutex around the hashmap is sufficient — fake tests are single-fiber-per-pod under TestClock).

**Design-doc section:** §Architecture / Storage primitive port.

### D2. Storage layout per worker — RESOLVED

Each worker holds, per partition (`pri:{self}` and `bak:{peer}` for each peer it backs up):

- **Body store** — `pri:{self}:call:{callRef}` and `bak:{peer}:call:{callRef}`. Each body stamps a `gen` field (the counter value at write time) used for idempotent apply.
- **Per-channel propagate index** — one sorted-set-shaped structure per **(self → targetPeer)** channel: `propagate:{self}->{peer}`. Member = `callRef`, score = monotonic per-channel counter. Re-writing same callRef bumps its score (sorted-set semantics; same member, latest score wins).
- **Per-channel counter** — `seq:{self}->{peer}`. Incremented atomically inside every write that targets that channel.
- **Secondary signaling-key indexes** — `idx:{indexKey} → callRef`. Replicated implicitly: the call body carries its `indexes: string[]`, and apply on the backup recreates them locally.

**Per-call peer stability (HARD INVARIANT).** Each call has exactly one backup peer for its lifetime. The (primary, backup) pair is chosen at INVITE-time and is locked in by the LB-proxy's **Record-Route HMAC cookie** ([src/sip-front-proxy/strategies/LoadBalancer.ts:108-155](../../src/sip-front-proxy/strategies/LoadBalancer.ts#L108-L155); doctrine in [docs/lb-proxy-ha.md:169-173](../lb-proxy-ha.md)) — every routed call has its primary + backup worker IDs encoded into a signed URI param of the Record-Route header. Both proxy instances share the signing key, so a master/standby failover preserves the routing decision. All in-dialog messages for a given call land on the same primary worker, hence on the same primary→backup channel.

The design doc MUST quote this invariant verbatim with the file/line citation, because: (a) it justifies why the propagate index can be keyed by `(self, peer)` without re-routing logic, and (b) any future change to the cookie scheme or proxy failover behavior immediately threatens the replication design — the link makes the dependency explicit so reviewers see it.

**Tombstones (REVERSED from earlier draft).** Deletes are explicit, idempotent, and live in the **same** propagate index as puts/updates with a distinct entry type:

- On call termination, primary writes a tombstone body (`{type: "tombstone", gen}`) with **Redis TTL ≈ 3 min** (auto-cleared) and bumps the channel counter / updates the index member's score. The index member encodes the type, e.g. members are `U:{callRef}` for put/update and `D:{callRef}` for delete (or equivalent — a single-byte prefix to a callRef key).
- Backup's apply path:
  - `U:{callRef}` → fetch body, write to `bak:{primary}:call:{callRef}` if `incoming.gen > local.gen`, recreate indexes.
  - `D:{callRef}` → fetch body (tombstone), DEL the local body + secondary indexes if `incoming.gen > local.gen`.
- Both apply paths are idempotent on `gen`; replay is harmless.
- After 3 min the tombstone body is TTL'd by Redis. Any backup partitioned > 3 min that has not yet pulled the tombstone falls into a degraded path: it pulls the index entry, fetches body=null, and treats null-body-on-D-entry as "tombstone already expired, apply DEL anyway". Backup's stale local body would also have expired by its own TTL by then. **Net effect:** healthy backups get explicit deletion notification; long-partitioned backups still converge via the body-TTL fallback.
- Cleanup of the index entry whose tombstone-body has TTL'd: settled in the design doc — candidate is "next-write-on-channel sweeps any orphan-D entries it encounters" but we may simply leave them and tolerate ~30K stale members worst-case.

**Bounding (INV1).** No hard ring-cap. The propagate index is naturally bounded by the maximum active-call count per partition (~30K primary + ~30K backup per pod, enforced by `CallLimiter`) plus at most a 3-min window of tombstones. Backup unreachable arbitrarily long imposes O(active-calls + tombstones-in-3-min-window) memory — bounded, no SCAN fallback needed in steady-state.

### D3. Steady-state propagation primitive — RESOLVED

**Pull, not push.** Backup polls primary's `/replog?since=<lastSeen>&limit=500..1000`. Primary answers via a single atomic per-batch primitive:

```
ZRANGEBYSCORE propagate:{self}->{peer} (lastSeen +inf LIMIT 0 <batch>
  + MGET pri:{self}:call:{ref1} pri:{self}:call:{ref2} ...
```

In Redis: one Lua script (`pull_batch.lua`) returning `[{member, score, body}]` (member encodes `U:`/`D:` type prefix) in one round-trip. The script provides a consistent snapshot for the batch — no read-skew between index and bodies *within* a batch.

In-memory: same shape, single-mutex protected; same return type.

**Per-batch atomic, cross-batch may re-deliver.** Across batch boundaries the same callRef may reappear (if the primary re-bumps it between two pulls). This is harmless: idempotent apply by `gen` collapses re-delivery.

**Idempotent apply by `gen`.** Backup compares `incoming.body.gen > local.body.gen` per call before writing or deleting. Out-of-order delivery and re-delivery are both harmless.

**Watermark.** `lastSeen` is per-(puller, source-peer, channel). In-memory on the puller. Lost on puller restart → boot SCAN bootstrap path (D5) is the recovery.

**Latency wakeup (deferred).** Correctness does not depend on push notifications. Sub-second propagation (G3) is met by polling at ~250–500 ms cadence. A pubsub-or-equivalent low-latency wakeup may be added later as an optimization on top of this primitive — never replacing it.

### D4. Watermark tracking — RESOLVED

**Watermark = `(gen, counter)` pair, per (puller, source-peer) pair.**

- **`counter`** — the per-channel monotonic value (D3) that scores entries in `propagate:{source}->{self}`.
- **`gen`** — the source peer's *incarnation*. The source bumps `gen` once at boot when its sidecar Redis is fresh (counter resets to 0 in lockstep). This is the existing `EpochCounter` mechanism preserved into the redesign.

**Pull request** carries `(gen, counter)`. Source's response:
- If `request.gen == source.current_gen`: normal index range query starting after `request.counter`.
- If `request.gen < source.current_gen`: source responds `{error: "gen_mismatch", current_gen: G}`. Puller resets watermark to `(G, 0)` and continues — effectively a `since=0` of the new incarnation. No human intervention; idempotent apply by per-call `gen` field still collapses any state already present.
- `request.gen > source.current_gen` cannot happen in a healthy system; treat as a hard error and log.

**Watermark is held in the puller's process memory, not persisted to disk.** A puller restart loses watermarks → next bootstrap is `since=(gen=current, counter=0)` for every alive peer. This is fine because puller restart = sidecar Redis usually wiped too = full re-bootstrap is what we wanted.

**Watermark survival across peer disappearance.** When a peer transitions to `Disappeared` (removed from `PeerEnumerator.peerSet`) but not because of our own restart, **the watermark is preserved for `T_disappeared_linger` (5 min)**. Rationale: the peer disappearance may be a transient enumeration glitch; the peer may be the same incarnation when it returns. If it returns within linger:
- Same `gen` → resume `PullingSteady` from saved `(gen, counter)`. No re-bootstrap.
- Bumped `gen` → naturally falls into the gen-mismatch path on next pull → bootstraps via `since=0` of new gen.

After linger expires, watermark is dropped; if peer ever reappears later, full bootstrap.

**The user-cited reason for the (gen, counter) shape:** without `gen`, a peer-reboot scenario silently corrupts: peer's counter resets to 0, but our watermark says `lastSeen=50`. Asking "since 50" returns nothing → we miss everything peer wrote post-reboot. With `gen`, the mismatch is detected on the very first post-reboot pull and we recover.

### D5. Boot recovery path — RESOLVED in shape, sub-decision OPEN

**Direction: option (iii) — single unified mechanism, no separate "bootstrap" mode.** Boot is just `since=0` against the same per-channel index used in steady-state. Rationale: backup may take traffic on the primary's behalf during temporary primary unavailability (see new G7 below), so the steady-state mechanism MUST already handle "peer made changes to data we own". Bifurcating boot from steady-state would replicate that machinery twice and let them drift.

**Sub-decision: locked on (iii-A) — echo-everything.** Every write to any partition (active local OR passive mirror) bumps the local outgoing channel for the corresponding peer. The user's mental model — "on recovery with `since=0` I receive a bunch of elements, store as pri or bak, get a new last index, continue" — implicitly requires the index to contain everything peer holds, including passive mirrors. Without echoing passive mirrors, `since=0` would return an incomplete set and a separate SCAN endpoint would be needed (option iii-B), contradicting the "single mechanism" rationale.

The echo overhead (~2× steady-state bandwidth) is bounded and always collapses to a no-op on the receiving side via `gen`-equality. This is structural idempotence, not semantic.

### G7 (NEW HARD GOAL — added per user grill turn 5)

**Reverse-direction propagation is a first-class steady-state concern, not a recovery-only concern.**

When the primary is *temporarily* unavailable (ms-to-seconds — e.g. brief overload, GC pause, OPTIONS-failed-but-recovered, network glitch), the LB-proxy may route an in-dialog request to the backup. The backup will apply state changes to its `bak:{primary}:call:{ref}`. When the primary recovers, those changes MUST flow back to `pri:{primary}:call:{ref}` and overwrite stale state — without waiting for the primary's full restart. Reverse-direction is part of the steady-state propagation contract, not a bootstrap-only path.

**Implication for design:** the propagate index is **per outgoing direction**, and a worker's outgoing channel to peer P carries everything the worker has changed that P needs to know about — both:
- writes to `pri:{self}:` (where P backs up self), AND
- writes to `bak:{P}:` (where self handled traffic on P's behalf during P's brief unavailability).

Entries are partition-tagged so the puller routes the apply correctly: incoming entries tagged "the writer's pri:" → apply to my `bak:{writer}:`; tagged "the writer's bak-of-me" → apply to my `pri:{self}:`.

This generalizes the current Slice-2.4 `f:`/`r:` direction tag into a per-partition tag with delete variant.

### D6. Catch-up vs SCAN fallback boundary — RESOLVED

**No SCAN fallback in the steady-state path.** Because the propagate index is naturally bounded by `~30K active calls + ~3 min tombstones` and never evicts (D2), a peer that falls behind by *any* amount can resume via index-based catch-up. The only SCAN is implicit in `since=0` on a fresh boot (the index *is* the full set of active calls).

The historical "out-of-window SCAN" path is removed entirely. This was needed only when the index had a hard ring-cap; we no longer have one.

**Adaptive readiness threshold.** Expressed in entries-applied-per-second (not bytes — easier to track in the puller). Initial values for the design doc, to be tuned with measurement:
- `T_min` = 3 s (minimum bootstrapping wait — don't flap-ready instantly).
- `T_max` = 120 s (hard ceiling, alert if hit).
- `throughput_floor` = 50 entries/s (sustained over 1 s window).
- Ready when: all alive peers caught-up-to-head OR (`elapsed > T_min` AND `entries-per-sec < floor` AND not all caught-up → enter `Degraded`-but-Ready).

### D7. Failure-handling matrix — RESOLVED

The state-machine in §D5 covers the matrix. Key clarifications added during grill:

- **Peer disappears mid-bootstrap (initial sync):** drop the peer from the readiness-blocking set immediately. Worker continues toward `Ready` based on the remaining alive peers. The disappeared peer's fiber transitions to `Disappeared` with watermark preserved for `T_disappeared_linger`. ⚠ The state machine MUST handle this transition out of `PullingBootstrap` directly (not only out of `PullingSteady`).
- **Peer becomes degraded post-Ready:** "If peer becomes unready, I don't do anything; it is the peer's problem to catch up; this should not impact my own state. Just have a way to log the fact we see a degraded peer." (Direct user quote.) Worker stays `Ready`. Surface a log/metric per peer state, but no SIP-path side effect.
- **Brand-new peer appears post-Ready:** stay `Ready`. New peer's `pri:` is empty until it takes traffic; only then does our `bak:{newPeer}:` need population, which the new peer's *own* outgoing channel will deliver as it writes.
- **Peer never returns:** after `T_disappeared_linger`, watermark is dropped. If peer ever reappears, full bootstrap.
- **Primary's own restart while backup unreachable:** primary writes are local; index is rebuilt from current calls (which is empty after restart), so no immediate concern. Backup, when it returns, sees gen-mismatch on its watermark and bootstraps from primary's new gen.
- **Backup's own restart while primary unreachable:** backup loses watermark, has nothing to pull from (primary is down), waits. When primary returns, backup pulls `since=(new_gen, 0)`.
- **Both restart simultaneously:** both bump `gen`, both bootstrap each other from `since=0` — converges naturally.

### D5 state-machine refinements (added per user feedback)

- **`Disappeared` is reachable from any per-peer state**, not just `PullingSteady`. A peer can vanish mid-bootstrap, and the worker readiness criterion must immediately recompute over the now-smaller alive set.
- **Brand-new peer behavior post-`Ready`:** worker stays `Ready`; the new peer's fiber bootstraps in the background.
- **Watermark preserved on `Disappeared`** for `T_disappeared_linger` (5 min). Restored on reappearance if `gen` matches.
- **Worker readiness recomputes every tick over the *current* alive set** — not over the set we knew at boot. The criterion is dynamic.

### D8. Observability

_Pending._

### D9. Test taxonomy — RESOLVED

**Default execution mode for every replication test: in-memory `KvBackend` (hashmap-backed).** Fake-clock, deterministic, runs in the standard `npm run test` loop.

**Opt-in execution mode for the same tests: real Redis backend, distinct namespace per run, hybrid clock pump.** Gated by an env var (`KV_BACKEND=redis`) and distinct keyspace prefix (e.g. `test-{run-id}:`). Because Redis I/O takes real time, the harness's clock pump is adapted: instead of pure `TestClock.adjust(delta)`, the pump interleaves `TestClock.adjust(delta)` with short real-clock yields (`Effect.sleep("1 millis", "real")` repeated several times) so Redis socket round-trips can complete between TestClock advances. This keeps the test logic identical between modes — same scenario DSL, same assertions — only the clock-pump implementation switches.

**Tests that benefit most from the dual-mode capability:**
- **T12 (port parity)** — the explicit parity gate. Property-based: same operation sequence, both backends, identical observable state.
- **T1, T3, T9** — pure protocol/storage logic. Dual-mode is "free" verification.
- **T2, T7, T10** — TestClock-heavy. Dual-mode possible but the hybrid pump tax may make them slow; flag as nightly-only against Redis.
- **T8** — k8s-only (real bandwidth + apply throughput); not run via `KV_BACKEND=redis` mode but via the existing live/k8s harness.

**T8 boot recovery budget:** 30K calls primary + 30K backup per pod, **P99 ≤ 30 s** wall-clock from pod start to `WorkerReadiness.markReady(true)`. Matches INV4 verbatim.

**PeerFabric extension:** **extend `PeerFabric.simulated` with `.addPeer(id)` and `.removePeer(id)` methods.** No fork into a new mode. Existing static-membership tests keep working; new tests opt into dynamic membership by calling these methods at scenario time. This unblocks T11 (mid-bootstrap disappearance) and the d6a2b7b-class regression test (peer arrives after worker first checked PeerEnumerator).

**Test→invariant matrix is the design-doc-of-record for sign-off (B0.5 gate).** The design doc must list each Goal/Invariant/HARD-INV and the test that proves it; sign-off cannot land if any row is missing.

### D10. Cutover sequencing

_Pending._

---

## Plan structure

This file is the **alignment record** with the user. The actual design document lives at `docs/replication/redesign-call-cache-backup.md` (NEW, to be written in B0). This plan file:

1. Captures every decision that was grilled out, with rationale.
2. Names the design doc sections that will encode each decision.
3. Lists the verification tests that prove each invariant holds.

The implementation slices (B1) and cutover (B2) are out of scope here — they are emitted **after** the design doc is signed off.
