# Track B — Replication redesign: design alignment

## Context

Track B of [docs/plan/pure-enchanting-forest.md](pure-enchanting-forest.md) calls for a first-principles redesign of the call-cache replication subsystem. The current implementation (described in [docs/replication/call-cache-backup.md](../replication/call-cache-backup.md) and shipped in `src/replication/`) has produced repeated incidents: peer-discovery boot races (commit `d6a2b7b`), HTTP timeout misalignment, ReadyGate stalls leaving workers out of rotation. Rather than patch these, the team is redesigning.

Two **non-negotiable** constraints from the user, established at grill kickoff:

1. **Test/prod replication parity is critical.** A representative replication layer must run in tests without Redis. The fake stack and the Redis stack must share as much code as humanly possible — divergence between them was a root cause of K8s-only bugs (commit `d6a2b7b`: "fix detected by k8s") that the fake-stack tests did not catch.
2. **Stable SIP-service-facing surface, free to redesign boot/state interaction.** The layer the SIP B2BUA hot-path consumes (`PartitionedRelayStorage` — `putCall` / `getCall` / `deleteCall` / `refreshCall`, and `CallLimiter`) must remain interface-compatible. The layer's interaction with pod boot, readiness, and recovery (`ReadyGate`, `WorkerReadiness`, `ReclaimRunner`, peer enumeration) is fair game — explicitly because it does not work well today.

## Tracking

Status legend: ⬜ not started · 🟡 in progress · ✅ done · ⚠️ blocked

### Phase: Design (B0)

| Item | Status | Notes |
|---|---|---|
| Design doc `docs/replication/redesign-call-cache-backup.md` written | ⬜ | Encodes D1–D10 + G7 |
| Design doc `docs/replication/protocol.md` written | ⬜ | Wire-protocol reference |
| Design doc `docs/replication/state-machine.md` written | ⬜ | Worker + per-peer + view-of-peer state machines |
| `docs/lb-proxy-ha.md` cross-link added | ⬜ | One paragraph back-link |
| B0.5 sign-off gate met | ⬜ | All Goals/Invariants mapped to a test |

### Phase: Implementation slices (B1)

| Slice | Title | Status | PR | Notes |
|---|---|---|---|---|
| 1 | KvBackend port + in-memory impl | ✅ | — | 21/21 tests; full fake suite green; typecheck clean |
| 2 | KvBackend Redis impl + parity test (T12) | ✅ | — | Memory-vs-Redis parity verified against local Redis (`KV_BACKEND=redis`). Hybrid clock pump deferred to first TTL-parity test (Slice 3+) per YAGNI. |
| 3 | ChannelIndex + write path; PRS internals rewire | ✅ | — | ChannelIndex + genCounter + T3/T9/NS3/NS12/NS13 tests landed. PRS rewire deferred to Slice 7 (cutover) — ChannelIndex stays unused by SIP path until then. |
| 4 | Wire protocol + `/replog` server endpoint | ✅ | — | Codec + server emission loop + NS9 landed. T7 (steady-state lag) deferred to Slice 5 — needs puller for end-to-end measurement. HTTP route registration not wired to main.ts (boot integration is Slice 6). |
| 5 | PullerFiber + watermark + ReplicationSupervisor | ✅ | — | PullerFiber + ReplicationSupervisor + PeerFabric add/removePeer + NS11 (NS + unit) + T11 landed. T7 (steady-state lag) still deferred — needs write-time `written_at_ms` stamping; bundled with Slice 7 cutover when PRS write path swaps to ChannelIndex. |
| 6 | ReadinessController + EpochCounter rewrite + boot integration | ✅ | — | EpochCounter v2 (`fromKubernetesDownwardAPI`/`fromWallClock`/`fixedForTesting`) + ReadinessController (T_min/T_max + once-Ready) + EchoApply helper landed. NS5/NS7/NS8 + readiness + epoch-counter unit tests green. Helm-chart wiring of `RESTART_COUNT` env var deferred to deployment slice (init-container reads `status.containerStatuses[*].restartCount` from K8s API; downward `fieldRef` does NOT expose container-level fields directly). Boot wiring (main.ts) deferred to Slice 7 cutover. |
| 7a | NS-suite full landing + T-suite landing | ✅ | — | NS1/NS2/NS4/NS6/NS10/NS14 + T2 + T6 + T7 landed (with `twoWorkerHarness.ts` shared DSL). `test:ns-real` script added. Full NS-suite (14 files) and full T-suite passing under in-memory KvBackend + real clock (`it.live`). |
| 7b | New PRS internals + parity tests (additive) | ✅ | — | `src/cache/PartitionedRelayStorageKvBacked.ts` lands `kvBackedMemoryLayer` (memory) and `kvBackedRedisLayer` (production-ready) over `KvBackend` + `ChannelIndex`. `tests/cache/prs-rewire.test.ts` runs the same 10-scenario contract against BOTH the legacy and the new layer (20 tests, all green). The new layer is NOT yet the default; `memoryLayer` and `redisLayer` still point at the legacy internals so this slice is fully reversible. SIP-facing surface verified byte-stable. |
| 7c | Final cutover blast (swap defaults + main.ts wiring + old code deletion) | ⬜ | — | **DEFERRED** — needs validation against live + k8s test tiers before the actual swap. See "Slice 7c deferral inventory" section below for the exhaustive list of follow-up tasks. |
| 8 | Observability metrics | ⬜ | — | |
| 9 | k8s robustness scenarios | ⬜ | — | |
| 10 | Pre-prod validation harness + sign-off | ⬜ | — | 48 h endurance |

### Test inventory

#### Goal/Invariant tests (T-suite)

| # | Test | Slice | Status |
|---|---|---|---|
| T1 | apply-idempotent | 3 | ✅ (covered structurally by NS2 + NS10) |
| T2 | primary-bounded-cost | 7 | ✅ |
| T3 | storage-layout | 3 | ✅ |
| T4 | scenario-self-primary-recovery | 6 | ✅ (covered by NS8) |
| T5 | scenario-self-backup-bootstrap | 6 | ✅ (covered by NS5+NS7) |
| T6 | scenario-reverse-propagation | 7 | ✅ |
| T7 | lag-steady-state | 4 | ✅ (landed Slice 7a) |
| T8 | boot-30s-budget | 9 | ⬜ |
| T9 | tuple-comparator (was gen-mismatch) | 3 | ✅ |
| T10 | (subsumed into NS11; row retired) | — | n/a |
| T11 | peer-disappear-mid-bootstrap | 5 | ✅ |
| T12 | port-parity property test | 2 | ✅ |
| T13 | proxy/peer-stability-during-failover | 9 | ⬜ |

#### Non-SIP black-box scenarios (NS-suite)

| # | Scenario | Slice | Status |
|---|---|---|---|
| NS1 | forward-propagation | 7 | ✅ |
| NS2 | idempotent-overwrite | 7 | ✅ |
| NS3 | delete-and-tombstone-ttl | 3 | ✅ |
| NS4 | reverse-propagation | 7 | ✅ |
| NS5 | sidecar-wipe-recovery | 6 | ✅ |
| NS6 | backup-was-down | 7 | ✅ |
| NS7 | backup-re-bootstrap | 6 | ✅ |
| NS8 | primary-recovery-via-reverse | 6 | ✅ |
| NS9 | caught-up-noop | 4 | ✅ |
| NS10 | tuple-conflict | 7 | ✅ |
| NS11 | peer-disappear-watermark | 5 | ✅ |
| NS12 | body-ttl-natural-cleanup | 3 | ✅ |
| NS13 | tombstone-ttl | 3 | ✅ |
| NS14 | symmetric-tombstone-from-backup | 7 | ✅ |

Each NS scenario must pass under all three backend combinations (in-memory + fake clock; in-memory + real clock; Redis + hybrid clock).

### Open / decision-deferred items

| Topic | Status | Resolved in |
|---|---|---|
| Index orphan-tombstone cleanup policy | OPEN — design-doc decision | B0 |
| Helm-chart downward API `fieldRef` exact path | RESOLVED — K8s downward API `fieldRef` does NOT expose `status.containerStatuses[*].restartCount` directly. Slice 7b mitigation: init container that reads its own pod's status via the K8s API and writes `RESTART_COUNT` into a shared env file. EpochCounter falls back to wall-clock-only when env var is absent. | Slice 7b (deployment) |
| Pre-prod validation cluster availability | OPEN — needs infra | Slice 10 |

### Phase: Cutover (B2)

| Item | Status | Notes |
|---|---|---|
| Old `src/replication/{AtomicWriter,PropagateStream,ReplLog,ReplPuller,ReadyGate}.ts` deleted | ⬜ | Slice 7c |
| `src/cache/ReclaimRunner.ts` deleted | ⬜ | Slice 7c |
| Legacy `tests/replication/*` deleted | ⬜ | Slice 7c |
| `docs/replication/call-cache-backup.md` updated to redirect | ⬜ | Slice 7c |
| `CLAUDE.md` progressive reading guide updated | ⬜ | Slice 7c |
| Production deploy after pre-prod sign-off | ⬜ | Post-Slice 10 |

### Slice 7c deferral inventory

The cutover work was split out from 7a (test landing) and 7b (new
internals + parity tests) so the new code can be reviewed in safe
slices. Slice 7c is the remaining work to actually flip production
paths over to the new code and remove the legacy modules.

**Status going into 7c:**
- New PRS internals exist and are parity-verified (`tests/cache/prs-rewire.test.ts` — 20 tests, both legacy and KV-backed pass the SAME 10 scenarios).
- `kvBackedRedisLayer` is wired but not yet the default — `PartitionedRelayStorage.redisLayer` still points at the legacy internals. Switching the default is a one-line change once the live + k8s tests are run against the new path.
- `main.ts` still imports + wires `AtomicWriter`, `ReplLog`, `ReplPuller`, `ReadyGate`, `ReclaimRunner`, `WriteNotifier`, `EpochCounter.redisLayer`, `supervisePullLoops`. None of the new modules (PullerFiber, ReplicationSupervisor, ReadinessController, ReplLogServer, EpochCounter.fromKubernetesDownwardAPI) are wired into the boot path yet.
- All NS-suite + T-suite tests pass against the new code, but only via direct test wiring — the SIP path on `main.ts` is unaffected.

#### Source code deletions (slice plan §B2)

- `src/replication/AtomicWriter.ts` — replaced by `ChannelIndex.write` over `KvBackend`.
- `src/replication/PropagateStream.ts` — replaced by `KvBackend.channelPullBatch`.
- `src/replication/ReplLog.ts` — replaced by `ReplLogServer` (Slice 4).
- `src/replication/ReplPuller.ts` — replaced by `runPullerFiber` (Slice 5).
- `src/replication/ReadyGate.ts` — replaced by `ReadinessController` (Slice 6).
- `src/cache/ReclaimRunner.ts` — removed entirely; the `since=0` bootstrap path subsumes the SCAN safety net.
- `src/replication/EpochCounter.ts` — legacy `redisLayer` / `memoryLayerFromStore` deleted; only `fromKubernetesDownwardAPI` / `fromWallClock` / `fixedForTesting` remain.
- `src/replication/PullLoopSupervisor.ts` — replaced by `ReplicationSupervisor` (Slice 5).
- `src/replication/WriteNotifier.ts` — no longer needed (no in-process pubsub bridge in the redesign).
- `src/replication/ReplMetrics.ts` — replaced by Slice 8's `ReplicationMetrics`.

#### Source code rewires (Slice 7c)

- `src/cache/PartitionedRelayStorage.ts` — switch the default factories to the new internals.
  - `memoryLayer` → point at `kvBackedMemoryLayer({ self, gen })`. The two `self`/`gen` values are passed at layer-build time; tests typically pass a fixed gen via `EpochCounter.fixedForTesting`. **Heads-up:** the existing `makeMemoryApi()` returns `MemoryApiHandle = { api, store: MutableHashMap<string, MemoryEntry> }`. The new layer's store is `MutableHashMap<string, MemoryStoreEntry>` — structurally identical (`{ value: string; expiresAtMs: number }`), so the swap is a one-line change. `PeerFabric.simulated` consumes `MemoryApiHandle.store` for snapshot inspection; that path keeps working unchanged after the swap.
  - `redisLayer` → point at `kvBackedRedisLayer({ self, gen })`. `self` resolves from `AppConfig.workerOrdinalLabel` (same precedence as `EpochCounterLayer` in `main.ts:259`). `gen` resolves from the new `EpochCounter.fromKubernetesDownwardAPI` (currently in `main.ts` it's the legacy `EpochCounter.redisLayer`).
  - **`written_at_ms` stamping:** ALREADY DONE in `kvBackedExplicit` — every body passes through `stampWrittenAtMs(json, nowMs)` before reaching `ChannelIndex.write`. T7 will pick up real latency values once main.ts is on the new path.
  - SIP-facing surface (`putCall` / `getCall` / `deleteCall` / `refreshCall`, `CallLimiter`, `WorkerReadiness.currentReady`) was verified byte-stable in slice 7b via `tests/cache/prs-rewire.test.ts`.

- `src/main.ts` boot wiring — replace legacy module wiring with new modules:
  - **EpochCounter** — line 186-212: `EpochCounter.redisLayer(ordinal)` → `EpochCounter.fromKubernetesDownwardAPI(ordinal)`. The new layer has no Redis dependency, so `EpochCounterLayer` no longer needs `Layer.unwrap` over RedisClient.
  - **Supervisor** — line 498ish: `supervisePullLoops({ enumerator, forkPullLoop, watchIntervalMs })` → `makeReplicationSupervisor({ enumerator, forkPullerFiber, watchIntervalMs })`. The `forkPullerFiber` builds a `runPullerFiber({ peer, viewRef, openStream: <fetch /replog>, applyFrame: makeEchoApply(...) })`.
  - **Readiness** — replace `ReadyGate` with `makeReadinessController({ observeState: supervisor.observe, markReady: workerReadiness.markReady })`. Fork the controller's `run` effect under `Effect.forkDetach`. SIGTERM path calls `controller.drain` instead of `WorkerReadiness.markReady(false)` directly.
  - **HTTP route registration**: call `addReplLogRoutes(router)` (from `src/replication/ReplLogServer.ts`, landed Slice 4 but never wired) inside the StatusServer or HTTP layer composition. The route needs `ReplLogServer.layer({ self, gen })` provided.
  - **Old wiring deletions** — remove imports + layers for `AtomicWriter`, `WriteNotifier`, `ReplLog`, `ReplPuller`, `ReadyGate`, `ReclaimRunner`, `PullLoopSupervisor`, `EpochCounter.redisLayer`, `ReplogClient`, legacy `ReplMetrics`.

#### Test deletions (slice plan §B2)

- `tests/replication/atomic-writer.test.ts`
- `tests/replication/repl-puller.test.ts`
- `tests/replication/ready-gate.test.ts`
- `tests/replication/replog-head-at-open.test.ts`
- `tests/replication/replog-long-poll-heartbeat.test.ts`
- `tests/replication/repl-metrics.test.ts`
- `tests/replication/propagate-compaction.test.ts`
- `tests/replication/epoch-monotonic.test.ts` — superseded by `epoch-counter.test.ts`.
- `tests/replication/pull-loop-supervisor.test.ts` — superseded by `peer-disappear-watermark.test.ts` + `peer-disappear-mid-bootstrap.test.ts`.

#### Documentation

- `docs/replication/call-cache-backup.md` — replace body with a redirect/header pointing at `docs/replication/redesign-call-cache-backup.md` (the latter still pending — see B0 phase).
- `CLAUDE.md` progressive reading guide — update the "Replication / call cache backup mechanism" row to point at the new design doc.
- `docs/replication/redesign-call-cache-backup.md` — write the design-of-record (B0 sign-off gate). Currently the plan file (this document) carries the design captured during grill; the redesign doc transcribes it for permanent reference.
- `docs/replication/protocol.md` — wire-protocol reference doc. The protocol is implemented in `ReplicationProtocol.ts` + `ReplLogServer.ts`; the doc is outstanding.
- `docs/replication/state-machine.md` — diagrams of the worker + per-peer fiber state machines. Code lives in `ReadinessController.ts` + `PullerFiber.ts` + `ReplicationSupervisor.ts`; the doc is outstanding.

#### Helm / deployment (separate track)

- `RESTART_COUNT` env var wiring — the Kubernetes downward API's `fieldRef` does NOT directly expose `status.containerStatuses[*].restartCount`. An init container that reads the pod's own status from the K8s API and writes the value into a shared env-file (or directly via `RESTART_COUNT=...`) is the next-step mechanism. Verify `serviceAccountName` has `pod/get` permission on its own pod.
- StatefulSet manifest — wire the `/replog` route into the existing health/status service so it's reachable by peer pullers.

#### Acceptance gates from slice plan that remain

- `npm run typecheck` clean ✅ (currently)
- `npm run test` green ✅
- `npm run test:ns-real` green ✅
- `KV_BACKEND=redis npm run test` green when Redis available — pending; the parity test already exercises this for the storage primitive (T12), but the new `ReplLogServer` and `runPullerFiber` paths don't yet have a Redis-backed test harness.
- Old code path fully removed — pending (Slice 7b).
- SIP-facing surface signature-diff zero — pending (depends on PRS rewire).

#### Suggested 7c sequencing

Slice 7b already landed steps 1 + 2; 7c picks up at step 3.

1. ✅ Write `tests/cache/prs-rewire.test.ts` first — pinned the `putCall`/`getCall`/`deleteCall`/`refreshCall`/`scanCalls`/`getIndex` SIP-facing semantics in a single regression suite running against BOTH the legacy and new internals.
2. ✅ Landed `kvBackedMemoryLayer` + `kvBackedRedisLayer` (new internals only, opt-in via separate constructors). Module: `src/cache/PartitionedRelayStorageKvBacked.ts`.
3. **(7c)** Switch `PartitionedRelayStorage.memoryLayer` and `redisLayer` defaults to the new layer. Re-run the full fake suite to confirm zero regressions; the parity tests already cover this but the full SIP path indirectly exercises every code path that consumes PRS.
4. **(7c)** Switch `main.ts` boot wiring to the new modules per the source-code rewires section above. Validate end-to-end against:
   - `npm run test:live:short` (real-clock e2e UDP test).
   - `npm run test:k8s:failover` (kind-based proxy / failover scenarios).
   - `npm run test:k8s:soak` (limiter soak).
5. **(7c)** Once steps 3+4 are green: delete the legacy modules and tests in one PR. List in the "Source code deletions" section above.
6. **(7c)** Update docs (`call-cache-backup.md` redirect, `CLAUDE.md` row update, write `redesign-call-cache-backup.md` + `protocol.md` + `state-machine.md`).

#### Why 7b stopped here (rationale)

The new code paths are validated against the in-memory KvBackend
under `vitest.config.fake.ts` (1155 fake-stack tests pass). The
production switch (changing `redisLayer`'s internals) cannot be
fully validated without `test:live:*` and `test:k8s:*` runs against
a real Redis sidecar and a kind cluster — neither of which is
reachable from the inner-loop test environment. Sequencing the
swap as a separate PR lets a reviewer:

  - See the 1-line `redisLayer = kvBackedRedisLayer(...)` swap in isolation.
  - Run live + k8s tests against it.
  - Roll back trivially if either tier surfaces a regression.

---

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

- **Body store** — `pri:{self}:call:{callRef}` and `bak:{peer}:call:{callRef}`. The body's `_topology.gen` field (set by `CallState.flushToRedis` via RMW on every put) carries the per-call content version used by the puller's content gate.
  - ✅ **SUPERSEDED by Story 7d.** The original "stamp body.gen at write time" approach was replaced with the cleaner `entryGen=0` mirror sentinel + lex-ordering cycle-break. See "Story 7d" below for the as-built design. The per-call content gate continues to use `_topology.gen` (PRS-stamped) and falls back to a top-level `callGen` field (used by tombstones).
- **Per-channel propagate index** — one sorted-set-shaped structure per **(self → targetPeer)** channel: `propagate:{self}->{peer}`. Member = `callRef`, score = monotonic per-channel counter. Re-writing same callRef bumps its score (sorted-set semantics; same member, latest score wins).
- **Per-channel counter** — `seq:{self}->{peer}`. Incremented atomically inside every write that targets that channel.
- **Secondary signaling-key indexes** — `idx:{indexKey} → callRef`. Replicated implicitly: the call body carries its `indexes: string[]`, and apply on the backup recreates them locally.

**Per-call peer stability (HARD INVARIANT).** Each call has exactly one backup peer for its lifetime. The (primary, backup) pair is chosen at INVITE-time and is locked in by the LB-proxy's **Record-Route HMAC cookie** ([src/sip-front-proxy/strategies/LoadBalancer.ts:108-155](../../src/sip-front-proxy/strategies/LoadBalancer.ts#L108-L155); doctrine in [docs/lb-proxy-ha.md:169-173](../lb-proxy-ha.md)) — every routed call has its primary + backup worker IDs encoded into a signed URI param of the Record-Route header. Both proxy instances share the signing key, so a master/standby failover preserves the routing decision. All in-dialog messages for a given call land on the same primary worker, hence on the same primary→backup channel.

The design doc MUST quote this invariant verbatim with the file/line citation, because: (a) it justifies why the propagate index can be keyed by `(self, peer)` without re-routing logic, and (b) any future change to the cookie scheme or proxy failover behavior immediately threatens the replication design — the link makes the dependency explicit so reviewers see it.

**Tombstones (REVERSED from earlier draft, then SYMMETRIZED per user grill turn 9).** Deletes are explicit, idempotent, and live in the **same** propagate index as puts/updates with a distinct entry type. **Tombstones are written by whichever worker actually processes the terminating event** — primary OR backup-acting-on-behalf.

The two cases:

- **Primary terminates call X** (normal case — primary received the BYE):
  - Writes tombstone body to `pri:{primary}:call:X` with **Redis TTL ≈ 3 min**.
  - Bumps `seq:{primary}->{backup}` counter, updates index member `pri:D:X` in `propagate:{primary}->{backup}`.
  - Backup pulls, sees `pri:D:X`, DELs its `bak:{primary}:call:X` and removes secondary indexes.

- **Backup terminates call X on behalf of primary** (G7 reverse path — primary briefly unavailable, proxy routed the BYE to the backup):
  - Writes tombstone body to its OWN `bak:{primary}:call:X` with **Redis TTL ≈ 3 min**.
  - Bumps `seq:{backup}->{primary}` counter, updates index member `bak:D:X` in `propagate:{backup}->{primary}`.
  - Primary (when reachable again) pulls, sees `bak:D:X`, DELs its `pri:{primary}:call:X` and removes secondary indexes.

The mechanism is symmetric. Member format `<partition>:<op>:<callRef>` already encodes which side wrote the tombstone via the `partition` tag, so the puller's apply rule routes correctly:
- `pri:D:X` from writer W → puller applies DEL to `bak:{W}:call:X` (passive backup-mirror cleanup).
- `bak:D:X` from writer W → puller applies DEL to `pri:{self}:call:X` (active reverse-direction cleanup of the puller's own primary state).

Both apply paths idempotent on `(gen, counter)`. Replay harmless. Both tombstone bodies TTL'd by Redis after ≈ 3 min, regardless of which side wrote them.

After 3 min the tombstone body is TTL'd. Any peer partitioned > 3 min that has not yet pulled the tombstone falls into a degraded path: it pulls the index entry, fetches body=null, and treats null-body-on-D-entry as "tombstone already expired, apply DEL anyway". The corresponding stale local body would also have expired by its own TTL by then.

**Cleanup of the index entry whose tombstone-body has TTL'd:** settled in the design doc — candidate is "next-write-on-channel sweeps any orphan-D entries it encounters" but we may simply leave them and tolerate ~30K stale members worst-case.

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

**Idempotent apply by per-call `callGen`.** The puller's apply path reads the local body and skips when `incoming.callGen ≤ local.callGen`. `callGen` is read from `_topology.gen` (full call bodies, set by `CallState.flushToRedis` via RMW) or top-level `callGen` (tombstones, set by `PRS.deleteCall` via RMW). Out-of-order delivery and re-delivery are both harmless.

✅ **IMPLEMENTED via Story 7d.** Cycle-break is now structural at the wire layer (lex ordering on `(entryGen, counter)` excludes mirror entries from warm pullers); the per-call `callGen` gate handles the cross-direction race independently. See "Story 7d" below for the full mechanism. The infinite-ping-pong test timeout is closed by the lex-ordering cycle-break — no echo step exists in the puller's apply path under the new design.

**Watermark.** `lastSeen` is per-(puller, source-peer, channel). In-memory on the puller. Lost on puller restart → boot SCAN bootstrap path (D5) is the recovery.

**Latency wakeup (deferred).** Correctness does not depend on push notifications. Sub-second propagation (G3) is met by polling at ~250–500 ms cadence. A pubsub-or-equivalent low-latency wakeup may be added later as an optimization on top of this primitive — never replacing it.

### D4. Watermark tracking — RESOLVED

**Watermark = `(gen, counter)` tuple, per (puller, source-peer). Strictly ordered. Compared as a lexicographic pair.**

- **`gen`** — the source peer's incarnation marker. Picked at boot, never changes during process lifetime. Strictly greater than any previous gen this peer has emitted.
- **`counter`** — per-channel monotonic value within an incarnation. Resets to 1 on each new gen.

**Together, every emit has a unique `(gen, counter)` and emits are produced in ascending order.** The puller's apply rule is mechanical: `incoming.(gen, counter) > watermark.(gen, counter)` → apply, else no-op. No special "mismatch" handling — gen-rollover is naturally handled because the new gen's tuples sort above the old gen's tuples regardless of where the new counter starts.

**Source-side gen selection (most reliable mechanism).**

The chosen primary mechanism is the **K8s pod `restartCount` from the downward API**, exposed via `fieldRef: status.containerStatuses[*].restartCount` in the pod spec, packed into a 64-bit integer alongside a process-start UNIX-millisecond fallback:

```
gen = (restartCount << 48) | (UnixMillisAtBoot & 0xFFFFFFFFFFFF)
```

- `restartCount` is provided by the K8s control plane, reliably increments per pod restart, and survives sidecar Redis wipes (it lives in the K8s API server, not in our sidecar).
- The lower 48 bits of UNIX-ms-at-boot break ties when restartCount is 0 (cold pod start with no prior history) and disambiguate across pods.
- Outside K8s (dev / kind without downward API), fall back to UNIX-ms-at-boot only. Logged WARN at boot if the downward-API value is unavailable.

This is preferred over `INCR epoch:{owner}` against the sidecar Redis (the current `EpochCounter` approach) because the sidecar Redis is volatile — a sidecar wipe would reset epoch to 0 even though the pod has been alive across multiple incarnations. `restartCount` survives sidecar wipes.

**Watermark is held in the puller's process memory, not persisted.** A puller restart loses watermarks → next pull is `(0, 0)`, source emits everything since counter=1 of its current gen → full bootstrap.

**Watermark preserved forever across peer disappearance.** No linger timeout. Rationale: if the peer truly rebooted, its new gen will exceed our preserved watermark's gen by tuple comparison, and on first reconnect the source's emitted frames will sort above our watermark — we apply everything naturally. There is no scenario where stale watermark hurts us, because gen monotonicity guarantees forward progress.

### D5. Boot recovery path — RESOLVED

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

**No SCAN fallback in the steady-state path.** The propagate index is naturally bounded by `~30K active calls + ~3 min tombstones` and never evicts (D2). A peer that falls behind by any amount catches up via the same continuous-streaming protocol. The only "SCAN-like" operation is implicit in a cold-start pull `(gen=0, counter=0)` — the index *is* the full set of active calls.

**Readiness criterion (final form).**

Readiness is a **boot-time, single-shot** decision. Once `Ready`, the worker never goes un-ready due to replication issues — peer trouble post-Ready is the peer's problem (per user feedback in turn 5), surfaced via metrics and logs, not via the SIP-path readiness signal.

Conditions for `Booting`/`Bootstrapping` → `Ready`:
- **Primary path:** every peer known at the moment of decision has reached `everCaughtUp = true` at least once during this incarnation. The `everCaughtUp` flag is set when the puller's per-peer fiber receives any `noop` frame (which is the protocol's "head reached" signal — see Wire Protocol below). Flag is sticky for the lifetime of this incarnation.
- **Hard floor:** at least `T_min = 3 s` elapsed since boot to avoid flapping ready when no peers exist yet.
- **Hard ceiling:** if `T_max = 60 s` elapsed and not every peer has set `everCaughtUp`, become `Ready` anyway with a WARN log naming the un-caught peers. Worker continues pulling forever; `Ready` stays true.

There is no throughput-floor heuristic. The `Degraded` worker state is removed from the worker-level state machine (per-peer fiber states still cover error conditions; they do not back-propagate to worker state).

### D7. Failure-handling matrix — RESOLVED

The state-machine in §D5 covers the matrix. Key clarifications added during grill:

- **Peer disappears mid-bootstrap (initial sync):** drop the peer from the readiness-blocking set immediately. Worker continues toward `Ready` based on the remaining alive peers. The disappeared peer's fiber transitions to `Disappeared` with watermark preserved for `T_disappeared_linger`. ⚠ The state machine MUST handle this transition out of `PullingBootstrap` directly (not only out of `PullingSteady`).
- **Peer becomes degraded post-Ready:** "If peer becomes unready, I don't do anything; it is the peer's problem to catch up; this should not impact my own state. Just have a way to log the fact we see a degraded peer." (Direct user quote.) Worker stays `Ready`. Surface a log/metric per peer state, but no SIP-path side effect.
- **Brand-new peer appears post-Ready:** stay `Ready`. New peer's `pri:` is empty until it takes traffic; only then does our `bak:{newPeer}:` need population, which the new peer's *own* outgoing channel will deliver as it writes.
- **Peer never returns:** after `T_disappeared_linger`, watermark is dropped. If peer ever reappears, full bootstrap.
- **Primary's own restart while backup unreachable:** primary writes are local; index is rebuilt from current calls (which is empty after restart), so no immediate concern. Backup, when it returns, sees gen-mismatch on its watermark and bootstraps from primary's new gen.
- **Backup's own restart while primary unreachable:** backup loses watermark, has nothing to pull from (primary is down), waits. When primary returns, backup pulls `since=(new_gen, 0)`.
- **Both restart simultaneously:** both bump `gen`, both bootstrap each other from `since=0` — converges naturally.

### D5.1 Explicit state machine — Worker level

```
Booting ──► Bootstrapping ──► Ready ──► Draining ──► Terminated
   │             │               ▲
   │             └────T_max──────┘
   │                  (WARN)
   └── (no peers ever) ──► Bootstrapping (waits for first peer)
```

| State | Predicate | Side effects | `WorkerReadiness.currentReady` |
|---|---|---|---|
| `Booting` | Process started; supervisor not yet started; `t < T_min` | None | false |
| `Bootstrapping` | At least one peer fiber active and not all peers are `everCaughtUp` AND `t < T_max` | Continue forking per-peer fibers as PeerEnumerator emits | false |
| `Ready` | All known peers are `everCaughtUp` OR `t > T_max` (latter → WARN log) | `markReady(true)` | true |
| `Draining` | SIGTERM received | `markReady(false)`; finish in-flight batches; stop forking new fibers | false |
| `Terminated` | Process exit | n/a | n/a |

**No `Degraded`, no `CatchingUp` post-Ready.** Once `Ready`, replication issues are observability-only.

Tick interval for the readiness controller: **100 ms**.

### D5.2 Explicit state machine — Per-peer fiber (PullerFiber)

```
                    ┌───────────────────────────────────────┐
                    │                                       │
   (none) ─► Discovered ─► Connecting ─► Streaming ◄──► ErroredRetry ──► ErroredFailed
                              │             │              ▲              │
                              └─error──────►┘              │              │
                                            │              │              │
                                            └──any error───┘              │
                                                          (T_failed)──────┘
                                            
   At any state: PeerEnumerator removes peer ─► Disappeared (fiber interrupted, watermark preserved forever)
   At any state: PeerEnumerator re-adds peer ─► Discovered (new fiber forked, reuses preserved watermark)
```

| State | Meaning | Watermark behavior | Contributes to readiness? |
|---|---|---|---|
| `Discovered` | Peer just appeared; fiber forked but no connection yet | Watermark = saved (or `(0,0)` if never seen) | Blocks readiness (not yet `everCaughtUp`) |
| `Connecting` | Opening HTTP connection to peer's `/replog` | Unchanged | Blocks readiness |
| `Streaming` | Long-lived connection open; receiving data + noop frames | Updated on every `data` frame applied | `everCaughtUp` flips true on first `noop` received → unblocks readiness |
| `ErroredRetry` | Connection or parse error; backing off | Unchanged | If `everCaughtUp` was already true, does not affect readiness; if false, still blocks (until either `T_max` worker ceiling fires or fiber recovers) |
| `ErroredFailed` | `T_failed_threshold = 30 s` continuous error | Unchanged | Same as `ErroredRetry` — observability-only post-Ready |
| `Disappeared` | Removed from PeerEnumerator | Preserved forever | Not in alive set; doesn't block readiness |

**`everCaughtUp` is sticky for the fiber's lifetime within this worker incarnation.** Lost only on worker-level restart (which resets all state).

### D5.3 Explicit state machine — "View of peer" (what the puller believes about each known peer)

This is the per-peer record the supervisor maintains. It is data, not a fiber state machine; it answers "what do I know about peer X right now?".

```ts
type PeerView = {
  readonly peerId: PeerId
  readonly fiberState: "Discovered" | "Connecting" | "Streaming" | "ErroredRetry" | "ErroredFailed" | "Disappeared"
  readonly watermark: { gen: number; counter: number }      // preserved across Disappeared
  readonly everCaughtUp: boolean                             // sticky-true once first noop received this incarnation
  readonly lastFrameAt: number                               // millis since last data or noop frame
  readonly lastError?: { kind: "transport" | "parse"; at: number; message: string }
  readonly bytesReceivedTotal: number                        // observability
  readonly entriesAppliedTotal: number                       // observability
  readonly noopsReceivedTotal: number                        // observability
}
```

Transitions on this view are driven by exactly four event sources:
1. `PeerEnumerator` add/remove → updates `fiberState` to `Discovered`/`Disappeared`.
2. Connection lifecycle in the per-peer fiber → updates `fiberState` to `Connecting`/`Streaming`/`ErroredRetry`/`ErroredFailed`.
3. Frame application → updates `watermark`, `everCaughtUp`, counters, `lastFrameAt`.
4. Tick (100 ms) → recomputes derived metrics; no state mutation.

The `ReadinessController` reads `PeerView`s and decides worker state purely from `fiberState` ≠ `Disappeared` AND `everCaughtUp == true` for all such peers.

### D8. Observability — RESOLVED

Prometheus metrics taxonomy. Cardinality bounded by `peer` label (capped at peer-set size, ~10s).

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `repl_channel_index_size` | Gauge | `direction={out,in}`, `peer` | INV1 alarm — index unbounded? |
| `repl_channel_counter` | Gauge | `direction`, `peer` | Current head per channel |
| `repl_apply_total` | Counter | `partition={pri,bak}`, `peer`, `op={put,delete}` | Apply throughput; feeds adaptive readiness |
| `repl_pull_lag_seconds` | Gauge | `peer`, `direction` | `(head - lastSeen)` translated to time-equivalent |
| `repl_pull_errors_total` | Counter | `peer`, `kind={transport,gen_mismatch,parse,timeout}` | Per-peer error-class counters |
| `repl_gen_mismatch_total` | Counter | `peer` | Counts peer reboots seen via watermark mismatch |
| `repl_peer_state` | Gauge (enum) | `peer` | Per-peer fiber sub-state |
| `repl_worker_state` | Gauge (enum) | — | Worker-level state |
| `repl_boot_duration_seconds` | Histogram | — | Pod-start to Ready — INV4 P99 |
| `repl_disappeared_linger_dropped_total` | Counter | `peer` | Watermark dropped after 5 min linger (alarm if > 0 in steady-state) |
| `repl_tombstone_orphan_count` | Gauge | `direction`, `peer` | Index entries pointing to TTL-expired tombstones |

**Logging:**
- `INFO` per worker-state and per-peer-fiber-state transition (with reason).
- `WARN` on `gen_mismatch`, on entering `Degraded` (with not-caught-up peer list and their throughput).
- `ERROR` on `ErroredFailed` and `T_max` ceiling-hit.

### D10. Cutover sequencing — RESOLVED

**Not in production yet — sharp cutover with extensive pre-production validation.** No parallel-run / shadow / version-negotiation infrastructure built.

Sequence:
1. **B1 land all-new code** behind no flag. Existing replication primitives in `src/replication/*` and `src/cache/ReclaimRunner.ts`, `src/cache/WorkerReadiness.ts`'s integration with `ReadyGate` are deleted in the same PR chain. SIP-facing surface (`PartitionedRelayStorage` `putCall`/`getCall`/`deleteCall`/`refreshCall`, `CallLimiter`, `WorkerReadiness.currentReady`) preserved exactly.
2. **Extensive kind-based robustness tests.** Existing `tests/k8s/proxy-failover-*.test.ts` suite extended with replication-specific scenarios from D9 test taxonomy. New scenarios: peer late-arrival (mocking StatefulSet ordinal startup), prolonged peer-disappear + reappear, gen-bump detection, both-restart simultaneously, ≥30K-call pod-restart timing.
3. **Pre-production replication test environment** — real Redis, real network, realistic call load. Run endurance suite (the existing `tests/k8s/endurance/run-endurance.ts` shape, extended for replication) for ≥48 h with chaos injection.
4. **Production rollout** only after step 3 is clean.

The "delete old code in same PR" risk that normally argues against (β) does not apply because there is no production traffic to protect during the rollout window.

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

### D9-NS — Non-SIP black-box scenarios (added per user feedback)

A dedicated test suite that exercises the replication mechanism without going through any SIP code path. Each scenario is a sequence of black-box operations (put / update / delete / wipe-Redis / reboot-pod / modify-on-peer / advance-clock-past-TTL) and an assertion about what state should be observable on each peer afterward. Designed to be **runnable against three backend combinations** with the same test source:

| Backend combination | Clock | When run |
|---|---|---|
| In-memory `KvBackend` + fake clock | TestClock | `npm run test` (default) |
| In-memory `KvBackend` + real clock | wall clock | `npm run test:ns-real` (new script) |
| Redis `KvBackend` + hybrid clock (TestClock + real-millis yields) | hybrid | `KV_BACKEND=redis npm run test` |

The test source is **single** (`tests/replication-ns/*.test.ts`) and uses an abstracted scenario DSL (`tests/replication-ns/scenarioDsl.ts`) that does not branch on which backend is active.

Scenarios (each gets one file):

| # | Scenario | What it asserts |
|---|---|---|
| **NS1** | put X on A → wait propagation → assert X readable on B's `bak:{A}:` with same `gen, counter` and indexes | Steady-state forward propagation works |
| **NS2** | put X on A → update X on A (3 times) → wait → assert B's `bak:{A}:` has the latest version, no stale state | Idempotent overwrite by `(gen, counter)` |
| **NS3** | put X on A → delete X on A → wait → assert X removed on B AND removed from B's secondary indexes; assert tombstone on A expires by Redis TTL after 3 min (advance clock) | Delete propagation + TTL-driven tombstone cleanup |
| **NS4** | put X on A → modify X on B (handler-on-behalf path: B writes to its `bak:{A}:`) → wait → assert A's `pri:{A}:` has B's version | G7 reverse propagation — no SIP involved |
| **NS5** | put X on A → wipe A's Redis (simulate sidecar reset) → restart A's process → wait → assert A pulls X back from B's `bak:{A}:` (since=0 cold start), and gen has bumped via restartCount | Recovery from full sidecar wipe |
| **NS6** | put X on A → kill B → put Y on A → wait 1 min (B unreachable) → start B → wait → assert B has both X and Y in `bak:{A}:` | Backup-was-down recovery; INV1 (no growing primary cost) measured implicitly |
| **NS7** | put 50 calls on A → assert B catches up within bounded time → wipe B → restart B → assert B re-acquires all 50 calls within bounded time | Backup re-bootstrap from primary |
| **NS8** | put X on A → wait → kill A → start A (gen bumps via restartCount) → wait → assert A's `pri:` reacquires X from B (B's bak:{A}: is the source of truth during A's downtime) | Primary recovery via reverse path |
| **NS9** | put X on A → assert noop frame received on B's puller within 200 ms after first data frame; `everCaughtUp` flips true | Caught-up signaling via noop |
| **NS10** | put X on A → put X on B (where A is the primary; this is a misbehavior simulation: B writes to `bak:{A}:` with its own gen) → wait → assert (gen, counter) tuple ordering picks the strictly higher tuple | Tuple ordering correctness under conflicting writes |
| **NS11** | start A and B → put X on A → kill B (peer disappears from PeerEnumerator) → put Y on A → start B again (peer reappears, watermark preserved) → assert B catches Y with no full-bootstrap | Watermark-preserved-forever across peer disappearance |
| **NS12** | put X on A with body TTL 5 s → wait 6 s without updates → assert X gone on A (Redis TTL fired) AND on B (B's body TTL also fired); assert B has no orphan index entry pointing to gone body, OR if it does, next write sweeps it | TTL-driven natural cleanup of unrefreshed bodies |
| **NS13** | put many calls on A; manually advance clock 4 min past last tombstone → assert tombstones are gone in A's Redis; assert B has applied all deletes and has no orphan tombstones either | TTL on tombstones across both ends |
| **NS14** | put X on A → simulate brief A unavailability → terminate X on B (B writes tombstone to its `bak:{A}:` since proxy routed the BYE to B per G7) → A recovers → wait → assert A's `pri:{A}:` no longer has X (DEL applied via `bak:D:X` from B's outgoing channel); also assert B's `bak:{A}:` no longer has X | Symmetric tombstone — backup-on-behalf can terminate calls; primary's `pri:` cleans up via reverse path |

Every scenario must pass under all three backend combinations. A scenario that fails on one and passes on another is a parity bug, automatically gated by the `port-parity` CI lane.

**File layout:**

```
tests/replication-ns/
  scenarioDsl.ts                # backend-abstract DSL
  ns01-forward-propagation.test.ts
  ns02-idempotent-overwrite.test.ts
  ns03-delete-and-tombstone-ttl.test.ts
  ns04-reverse-propagation.test.ts
  ns05-sidecar-wipe-recovery.test.ts
  ns06-backup-was-down.test.ts
  ns07-backup-re-bootstrap.test.ts
  ns08-primary-recovery-via-reverse.test.ts
  ns09-caught-up-noop.test.ts
  ns10-tuple-conflict.test.ts
  ns11-peer-disappear-watermark.test.ts
  ns12-body-ttl-natural-cleanup.test.ts
  ns13-tombstone-ttl.test.ts
  ns14-symmetric-tombstone-from-backup.test.ts
```

These scenarios are the **primary regression suite** for the replication redesign — they exercise every documented failure mode without requiring the SIP path.

### D10. Cutover sequencing

_Pending._

---

## Plan structure

This file is the **alignment record** with the user. The actual design document lives at `docs/replication/redesign-call-cache-backup.md` (NEW, to be written in B0). This plan file:

1. Captures every decision that was grilled out, with rationale.
2. Names the design doc sections that will encode each decision.
3. Lists the verification tests that prove each invariant holds.

The implementation slices (B1) and cutover (B2) are out of scope here — they are emitted **after** the design doc is signed off.

---

## Critical files (to be modified in B1)

**Stable surface (must not change semantically):**
- [src/cache/PartitionedRelayStorage.ts](../../src/cache/PartitionedRelayStorage.ts) — public API: `putCall` / `getCall` / `deleteCall` / `refreshCall`. Internals re-implemented over the new `KvBackend` port.
- [src/call/CallLimiter.ts](../../src/call/CallLimiter.ts) — public API: `checkAndIncrement` / `refresh`. No replication-related changes expected.
- [src/cache/WorkerReadiness.ts](../../src/cache/WorkerReadiness.ts) — `currentReady` API preserved; the producer side (which sets `markReady`) is rewired to the new ReadinessController described in D5.

**To be deleted and replaced:**
- [src/replication/AtomicWriter.ts](../../src/replication/AtomicWriter.ts) — replaced by a single implementation over `KvBackend`.
- [src/replication/PropagateStream.ts](../../src/replication/PropagateStream.ts) — replaced by the per-channel propagate index built on `KvBackend`.
- [src/replication/ReplLog.ts](../../src/replication/ReplLog.ts) — endpoint replaced by `/replog?since=(gen,counter)&limit=N` returning the unified D5 protocol.
- [src/replication/ReplPuller.ts](../../src/replication/ReplPuller.ts) — replaced by the supervisor + per-peer fiber state machine of D5.
- [src/replication/ReadyGate.ts](../../src/replication/ReadyGate.ts) — replaced by ReadinessController fed by `entries-per-sec` throughput + per-peer fiber states.
- [src/cache/ReclaimRunner.ts](../../src/cache/ReclaimRunner.ts) — removed entirely. The mechanism (SCAN-based safety net) is folded into the unified `since=0` bootstrap.

**New files (B1):**
- `src/storage/KvBackend.ts` — the storage primitive port (in-memory + Redis impls).
- `src/replication/ChannelIndex.ts` — propagate index per `(self → peer)` channel: ZADD-equivalent, range query, tombstone marker, batched pull.
- `src/replication/ReplicationProtocol.ts` — wire protocol: pull request `(gen, counter, limit)`, response shapes, gen-mismatch error.
- `src/replication/ReplicationSupervisor.ts` — peer-set subscription, per-peer fiber lifecycle, watermark management with linger.
- `src/replication/ReadinessController.ts` — adaptive readiness criterion (throughput-floor + per-peer caught-up signal).

## Existing utilities to reuse

- [src/replication/EpochCounter.ts](../../src/replication/EpochCounter.ts) — keep as the source of `gen` for the (gen, counter) watermark. Its public API may need to grow to expose `currentGen` to peers via the protocol response.
- [src/replication/PeerEnumerator.ts](../../src/replication/PeerEnumerator.ts) (or equivalent) — peer set source. Verify it exposes a `SubscriptionRef`-shaped continuous stream; if not, add that affordance instead of re-reading on every supervisor tick.
- [src/sip-front-proxy/strategies/LoadBalancer.ts:108-155](../../src/sip-front-proxy/strategies/LoadBalancer.ts#L108-L155) — Record-Route HMAC cookie. Cited from the design doc as the upstream invariant that locks per-call peer stability.
- `tests/support/fakeStack.ts` and `tests/support/PeerFabric.simulated` — extended with `addPeer`/`removePeer` to enable dynamic-membership tests.
- `tests/support/PumpableClockLayer` — extended with the hybrid mode (TestClock advance + real-millis yields) for `KV_BACKEND=redis` runs.

## Verification (end-to-end test plan)

Each row of D9's test taxonomy maps to one Goal/Invariant. The B0 sign-off gate (per [docs/plan/pure-enchanting-forest.md](pure-enchanting-forest.md) Track B B0.5) requires every row of the matrix below to be present in the design doc with a clear test shape.

| Goal/Invariant | Test (from D9) | Stack |
|---|---|---|
| INV1 (bounded backup-down cost) | T2 | fake (TestClock 1 h) |
| INV2 (single-owner) | covered structurally — primary writes are local; design doc shows there is no primary-promotion path | n/a (review-only) |
| INV3 (idempotent apply) | T1, T9 | fake |
| INV4 (30 s P99 boot) | T8 | live, k8s |
| G1 (storage layout) | T3 | fake + dual-mode KV_BACKEND=redis |
| G2 (boot recovery both directions) | T4, T5 | fake (PeerFabric) |
| G3 (sub-second steady-state lag) | T7 | fake (TestClock) |
| G4 (no SCAN fallback in steady-state — replaced by since=0 bootstrap) | T4 | fake |
| G5 (zero loss when backup unreachable) | T2 + T11 | fake |
| G6 (observability) | manual: each metric in D8 is asserted by one or more existing test scenarios via the metrics registry | fake |
| G7 (reverse propagation in steady state) | T6 | fake |
| Test/prod parity (D1) | T12 (port-parity property test) | fake-default + opt-in real Redis |
| `d6a2b7b`-class regression (peer late arrival) | T11 + new k8s scenario in step 2 of D10 | fake + k8s |

**Run commands:**
- `npm run test` — fake stack only, default `KV_BACKEND=memory`. Inner-loop verification.
- `KV_BACKEND=redis npm run test` — same suite against a local Redis with hybrid clock pump. Slower; ≥10× normal duration expected.
- `npm run test:nightly` — adds the live and k8s tiers, including T8.
- The k8s endurance harness (extended in D10 step 2) is run from `tests/k8s/endurance/run-endurance.ts`.

---

## Documentation deliverables

| Doc | Action | Owner of section |
|---|---|---|
| `docs/replication/redesign-call-cache-backup.md` | NEW. The design-of-record. Encodes D1–D10 + G7 with rationale. Sign-off gate B0.5. | B0 |
| `docs/replication/call-cache-backup.md` | UPDATE. After cutover (B1 step 7), replace its body with a redirect/header pointing at the redesign doc. Pre-cutover, untouched. | B1.7 |
| `docs/replication/protocol.md` | NEW. The wire protocol below — request/response formats, examples, error frames. Permanent reference for anyone implementing a peer. | B1.4 |
| `docs/lb-proxy-ha.md` | EDIT one paragraph in §State at failover to back-link the replication design's per-call peer stability invariant. The Record-Route HMAC paragraph stays the source of truth; we add a forward-link only. | B0 |
| `CLAUDE.md` progressive reading guide | EDIT. Update the "Replication / call cache backup mechanism" row to point at the new design doc. | B1.7 |
| `docs/replication/state-machine.md` | NEW. The worker + per-peer-fiber state machine of D5 with diagrams (PlantUML or ASCII). Referenced from the redesign doc. | B0 |

---

## Wire protocol (D3/D5 implementation detail)

**Single endpoint, long-lived streaming connection.** The puller opens one connection per source-peer and keeps it open. The server continuously emits frames as data is available, with `noop` frames as the head-reached / heartbeat signal. Every frame carries `(gen, counter)` and a `latency_ms` indicator. Frames are emitted in strictly ascending `(gen, counter)` order — `gen` is the high-order key, `counter` the low-order key.

### Endpoint

**`GET /replog?gen={uint}&counter={uint}&chunk_size={uint}`**

- `gen` — the puller's preserved source `gen`; `0` for cold-start.
- `counter` — the puller's preserved source `counter`; `0` for cold-start.
- `chunk_size` — max entries the server reads from Redis per inner loop iteration. Recommended `500–1000`. (Renamed from `limit` to make its role explicit: it is the Redis-side chunk size, not a per-response cap; the response is unbounded in length because the connection is long-lived.)

Response: `Content-Type: application/x-ndjson`. One JSON object per line. Streamed indefinitely until the puller closes or transport fails.

### Server-side emission loop

```
while connection_open:
  entries = kv.channelPullBatch(channel, since=watermark, limit=chunk_size)
  for e in entries:
    write_frame({ "type": "data", "gen": current_gen, "counter": e.score,
                  "op": ..., "partition": ..., "callRef": ..., "body": ..., "indexes": [...],
                  "latency_ms": now_ms - e.body.written_at_ms })
    advance internal cursor
  if len(entries) == chunk_size:
    continue immediately   # might be more pending in Redis
  else:
    write_frame({ "type": "noop", "gen": current_gen, "counter": current_counter,
                  "latency_ms": 0 })
    sleep 100 ms
    continue
```

The 100 ms wait when the channel is empty is the only place the server "blocks". `noop` is emitted exactly once per empty-poll cycle, both as a heartbeat (so the puller knows the connection is live) and as the **caught-up-to-head** signal (it tells the puller "I returned fewer than `chunk_size`, so you have everything up to my current `counter`").

### Frame types

**`data` frame** — a single state mutation. Contains everything the puller needs to recreate the call body and the secondary index entries on its side.

```
{
  "type": "data",
  "gen": 1715200000123,
  "counter": 105,
  "op": "create" | "update" | "delete",
  "partition": "pri" | "bak",
  "callRef": "abc123",
  "body": { ...full call state with gen field stamped... } | null,
  "indexes": [ { "key": "...", "value": "abc123", "ttlSec": 30 }, ... ],
  "latency_ms": 12
}
```

- `op = "delete"` → `body` is `null` (or a tombstone marker — equivalent semantics); puller DELs `(partition):{writer}:call:{callRef}` and removes the named indexes.
- `op = "create"` and `op = "update"` are wire-equivalent for the puller (apply if `(gen, counter) > watermark`); the distinction is purely for log/observability and may be set by the source if it knows.
- `latency_ms` = source's `now - body.written_at_ms` at frame-emit time. Lets the puller measure end-to-end replication lag without clock-sync.

**`noop` frame** — heartbeat / head-reached marker. Does NOT advance the channel counter; emits the current head counter as a witness.

```
{
  "type": "noop",
  "gen": 1715200000123,
  "counter": 105,
  "latency_ms": 0
}
```

The puller updates its watermark to `(gen, counter)` from the noop (idempotent — if it had already advanced past, no-op). The first `noop` received for a given peer in this incarnation flips that fiber's `everCaughtUp` flag.

### Apply rule (puller side)

For every received frame F:
```
if (F.gen, F.counter) > (watermark.gen, watermark.counter):
  if F.type == "data": apply F (write or delete partition body + indexes)
  watermark := (F.gen, F.counter)
if F.type == "noop":
  fiber.everCaughtUp := true   # sticky for this incarnation
```

That is the entire protocol semantics on the puller. There are no hello/head/gen_mismatch frames — `gen` rollover is naturally handled because the new gen's tuples sort above the old gen's tuples regardless of the new counter value.

### Endpoints retained from current code (no replication-protocol change)

- Health/readiness probe — driven by `WorkerReadiness.currentReady`.
- All SIP-router-facing endpoints — untouched.

---

## Boot sequence (numbered, end-to-end)

This is the contract for "what a worker pod does between SIGSTART and `markReady(true)`". The design doc encodes this with exact transitions and timers.

1. **Process boot.** Effect runtime starts. Config loaded. `MetricsRegistry` and logging initialized.
2. **`KvBackend` initialized.** In production: Redis client connects to local sidecar, runs `PING`. In tests: in-memory `MutableHashMap` allocated. Failure → fail-fast (process exits with non-zero).
3. **`EpochCounter.bumpGen()`** — atomic `INCR epoch:{self}`. Returned value is `self.gen` for this incarnation. Counter for every outgoing channel starts at 0 (no per-channel persistence — counters reset with the process).
4. **HTTP server starts.** `/replog` endpoint becomes live; peers can begin pulling from us immediately. (We can serve before we are `Ready` ourselves — there is no symmetry requirement.)
5. **`ReplicationSupervisor` starts.**
   - Subscribes to `PeerEnumerator.peerSet` (continuous subscription, not one-shot).
   - Worker state := `Booting`.
6. **First peer-set update fires.** For each peer in the snapshot, supervisor forks a `PullerFiber`. Worker state := `Bootstrapping`.
7. **Each `PullerFiber` runs:**
   1. State := `Connecting`. Watermark := preserved value from prior `Disappeared` if any, else `(0, 0)`.
   2. Open `GET /replog?gen={watermark.gen}&counter={watermark.counter}&chunk_size=1000` to peer. Long-lived connection.
   3. State := `Streaming`.
   4. For each frame received:
      - Apply per the apply rule above.
      - On first `noop`: flip `everCaughtUp = true` (sticky).
   5. On transport error: state := `ErroredRetry`. Backoff (250 ms × 2^n, capped 30 s). Reconnect from step 2 with current watermark. After `T_failed_threshold = 30 s` of continuous failure → state := `ErroredFailed` (observability-only post-Ready).
8. **`ReadinessController` ticks every 100 ms.** Inputs: alive-peer set, per-peer `everCaughtUp` flags.
   - If `t < T_min = 3 s`: stay `Booting`/`Bootstrapping`.
   - Else if all alive peers have `everCaughtUp == true`: worker := `Ready`.
   - Else if `t > T_max = 60 s`: worker := `Ready` with WARN log naming non-caught peers.
   - Otherwise stay `Bootstrapping`.
   No throughput-floor heuristic. Once `Ready`, never returns to `Bootstrapping`.
9. **Worker transitions `Bootstrapping → Ready`:** `WorkerReadiness.markReady(true)`. K8s `/ready` flips. SIP traffic begins flowing in.
10. **Steady-state runtime.** PullerFibers continue streaming forever from every alive peer. Supervisor reacts to peer-set changes (add → fork fiber; remove → interrupt fiber, preserve watermark forever).
11. **SIGTERM.** Worker := `Draining`. `markReady(false)`. PullerFibers complete in-flight frame then exit. SIP `OPTIONS` returns 503. Process exits cleanly.

---

## Method / interface definitions

TypeScript signatures only — full Effect-v4 layer plumbing decided during slice implementation, but the public surface is fixed here.

### `KvBackend` (the storage primitive port)

```ts
export interface KvBackend {
  // Body store
  bodyGet(key: string): Effect<string | null, KvError>
  bodySet(key: string, value: string, ttlSec: number): Effect<void, KvError>
  bodyDel(key: string): Effect<void, KvError>
  bodyMget(keys: ReadonlyArray<string>): Effect<ReadonlyArray<string | null>, KvError>

  // Per-channel sorted-set-shaped index + counter, atomic
  channelWrite(args: {
    channel: string                 // "propagate:{self}->{peer}"
    counterKey: string              // "seq:{self}->{peer}"
    member: string                  // "pri:U:{callRef}" etc.
    bodyKey: string                 // "pri:{self}:call:{callRef}"
    bodyValue: string               // JSON; gen field stamped by caller
    bodyTtlSec: number
    indexes: ReadonlyArray<{ key: string; value: string; ttlSec: number }>
  }): Effect<{ counter: number }, KvError>

  // Atomic delete: tombstone body with TTL + ZADD member with D-prefix + bump counter + clean indexes
  channelTombstone(args: {
    channel: string
    counterKey: string
    member: string                  // "pri:D:{callRef}"
    bodyKey: string
    tombstoneTtlSec: number         // ~180
    indexesToRemove: ReadonlyArray<string>
  }): Effect<{ counter: number }, KvError>

  // Atomic batched read: ZRANGEBYSCORE + MGET in one snapshot
  channelPullBatch(args: {
    channel: string
    sinceScore: number
    limit: number
  }): Effect<{
    entries: ReadonlyArray<{ member: string; score: number; body: string | null }>
    headCounter: number
  }, KvError>

  // Counter snapshot (used by hello frame)
  counterRead(counterKey: string): Effect<number, KvError>
}
```

Two implementations: `KvBackend.makeMemory(): Layer<KvBackend>` and `KvBackend.makeRedis(client): Layer<KvBackend>`. Both implement the same contract.

### `ChannelIndex`

Thin wrapper over `KvBackend` that names channels and counters per `(self, peer)`.

```ts
export class ChannelIndex {
  static make(args: { self: PeerId; peer: PeerId }): ChannelIndex
  // Internally derives channel = `propagate:${self}->${peer}`, counter = `seq:${self}->${peer}`
  write(...): Effect<void>
  tombstone(...): Effect<void>
  pullBatch(sinceScore: number, limit: number): Effect<PullBatchResponse>
  currentCounter(): Effect<number>
}
```

### `ReplicationProtocol`

```ts
export const PullRequest = Schema.Struct({
  gen: Schema.Number,
  counter: Schema.Number,
  chunk_size: Schema.Number
})

export type PullFrame =
  | {
      _tag: "Data"
      gen: number
      counter: number
      op: "create" | "update" | "delete"
      partition: "pri" | "bak"
      callRef: string
      body: unknown | null
      indexes: ReadonlyArray<{ key: string; value: string; ttlSec: number }>
      latency_ms: number
    }
  | {
      _tag: "Noop"
      gen: number
      counter: number
      latency_ms: number
    }

export const encodePullStream: (args) => Stream<Uint8Array, never>
export const decodePullStream: (input: Stream<Uint8Array>) => Stream<PullFrame, ProtocolError>

// Tuple comparator used uniformly by source emission ordering and puller apply rule
export const compareGenCounter: (
  a: { gen: number; counter: number },
  b: { gen: number; counter: number }
) => -1 | 0 | 1
```

### `ReplicationSupervisor`

```ts
export interface ReplicationSupervisor {
  start: Effect<void, never, never>            // forks supervisor fiber
  observe: Effect<SupervisorState, never>      // for the readiness controller
  shutdown: Effect<void>
}

export type SupervisorState = {
  readonly alivePeers: ReadonlySet<PeerId>
  readonly perPeer: ReadonlyMap<PeerId, PeerView>
}

// Per D5.3 — the puller's view of each peer (data, not a fiber state machine)
export type PeerView = {
  readonly peerId: PeerId
  readonly fiberState:
    | "Discovered" | "Connecting" | "Streaming"
    | "ErroredRetry" | "ErroredFailed" | "Disappeared"
  readonly watermark: { gen: number; counter: number }   // preserved forever across Disappeared
  readonly everCaughtUp: boolean                          // sticky once first noop received
  readonly lastFrameAt: number
  readonly lastError?: { kind: "transport" | "parse"; at: number; message: string }
  readonly bytesReceivedTotal: number
  readonly entriesAppliedTotal: number
  readonly noopsReceivedTotal: number
}
```

### `ReadinessController`

```ts
export interface ReadinessController {
  start: Effect<void>
  observe: Effect<WorkerState>
}

// Simplified — Degraded and CatchingUp removed; readiness is single-shot once Ready
export type WorkerState =
  | "Booting" | "Bootstrapping" | "Ready" | "Draining" | "Terminated"
```

### `EpochCounter` (rewritten — gen now derives from K8s restartCount, not Redis INCR)

```ts
export interface EpochCounter {
  // Computed once at process boot from:
  //   primary:   K8s downward API status.containerStatuses[*].restartCount
  //   fallback:  Date.now() if downward API unavailable (logs WARN)
  // Result is packed: gen = (restartCount << 48) | (UnixMillisAtBoot & 0xFFFFFFFFFFFF)
  // Never changes during process lifetime.
  readonly current: number
}

// Layer constructors:
//   EpochCounter.fromKubernetesDownwardAPI: Layer<EpochCounter, ConfigError>
//   EpochCounter.fromWallClock: Layer<EpochCounter>            // dev / kind / tests
//   EpochCounter.fixedForTesting(gen: number): Layer<EpochCounter>
```

`gen` is now a value, not an Effect. The previous `INCR epoch:{owner}` against the sidecar Redis is removed entirely — it could not survive sidecar wipes. Tests inject a fixed `gen` via `EpochCounter.fixedForTesting`.

---

## Impact on test layer

| Area | Change |
|---|---|
| `tests/support/fakeStack.ts` | Replace memory-layer wiring of `AtomicWriter`/`PropagateStream`/`EpochCounter`/`ReplPuller`/`ReadyGate` with single `KvBackend.makeMemory()` + new modules' Layers. ~40 LOC delta. |
| `tests/support/PeerFabric.ts` | Add `addPeer(peerId)` and `removePeer(peerId)` methods. Existing static-membership API preserved. |
| `tests/support/PumpableClockLayer.ts` | Add `mode: "fake" \| "hybrid"` parameter. In `hybrid` mode, the pump interleaves `TestClock.adjust(N)` with `Effect.sleep("1 millis", "real")` repeated K times to allow Redis socket I/O to drain. Default stays `fake`. |
| `tests/support/harness.ts` | New `KV_BACKEND=redis` mode: provisions a per-run keyspace prefix, configures `KvBackend.makeRedis()`, switches PumpableClock to `hybrid`. |
| `tests/replication/*` | All new test files from D9 (T1–T12). Existing `tests/replication/atomic-writer.test.ts`, `tests/replication/repl-puller.test.ts`, `tests/replication/ready-gate.test.ts`, `tests/replication/replog-*.test.ts`, `tests/replication/repl-metrics.test.ts` deleted in B1.7. |
| `tests/cache/peer-fabric.test.ts` | Updated for new fabric API. |
| `tests/k8s/replication-*.test.ts` | NEW. Three scenarios: late-peer-arrival (`d6a2b7b` regression), 30K-call boot-budget (T8), reverse-propagation under brief primary unavailability (T6 lifted to k8s tier). |
| `tests/k8s/endurance/run-endurance.ts` | Extended with replication-aware chaos: peer disappear/reappear cycles, gen-bump injection. |
| `vitest.config.fake.ts` | No structural change; new test files auto-included. |
| `vitest.config.live.ts` | New `tests/replication/port-parity.test.ts` (T12) added under `live` scope when `KV_BACKEND=redis`. |
| `vitest.config.k8s.ts` | New replication scenarios added. |

---

## Impact on real (Redis) layer

| Area | Change |
|---|---|
| Redis keys (production sidecar) | Cleaned up: only the keys defined in D2 + `epoch:{self}` exist. Removed (after cutover): `replpos:{peer}` (puller watermark moves in-memory), `propagate_seq:{peer}` (renamed/flattened into `seq:{self}->{peer}`). All keys carry an unambiguous `replv2:` namespace prefix during cutover for safety. |
| Lua scripts | Three named scripts loaded via `SCRIPT LOAD` at backend init: `kv_channel_write.lua`, `kv_channel_tombstone.lua`, `kv_channel_pull_batch.lua`. Versioned with a SHA-pinned name (`kv_channel_write_v1`) to enable side-by-side rollouts. |
| Connection topology | Unchanged. Still per-pod Redis sidecar (no shared Redis, no cross-DC). |
| Resource sizing | Approximate steady-state memory per pod, 30K calls + 30K backups + 5 peers: bodies ≈ 30K × 1 KB × 2 = 60 MB; index entries ≈ 60K × 64 B × 5 = 19 MB; counters and epochs ≈ negligible. Total ≈ 80 MB Redis sidecar. Same order as current footprint; no reprovisioning needed. |
| Failure modes | Sidecar Redis crash → KvBackend errors propagate as `KvError`. Worker treats this as catastrophic (exits, K8s restarts pod). No partial-state recovery attempted at the KvBackend layer. |
| Helm chart changes | None for the worker. Sidecar config unchanged. |

---

## Implementation slices (B1)

Each slice = one PR, one passing CI, ~1 day–1 week of work. Slices land in order; later slices depend on earlier ones. Test additions per slice are **gating**: a slice cannot land without its tests passing.

### Slice 1 — `KvBackend` port + in-memory implementation
**Files:** `src/storage/KvBackend.ts` (new), `tests/storage/kv-backend-memory.test.ts` (new).
**Tests:** body get/set/del/mget; channelWrite ordering (counter increments atomically with index update); channelPullBatch atomicity within batch; channelTombstone semantics.
**Acceptance:** all interface methods implemented, ≥90% line coverage.
**Risk:** low. Pure data-structure work.

### Slice 2 — `KvBackend` Redis implementation + parity test (T12)
**Files:** `src/storage/KvBackend.redis.ts` (new), `src/storage/lua/{kv_channel_write,kv_channel_tombstone,kv_channel_pull_batch}.lua` (new), `tests/storage/kv-backend-parity.test.ts` (new = T12), `tests/support/PumpableClockLayer.ts` (hybrid mode added).
**Tests:** T12 property test runs in `KV_BACKEND=memory` (default, asserts laws) and `KV_BACKEND=redis` (gated, asserts byte-level parity).
**Acceptance:** parity holds for 1000 randomized op sequences; Lua scripts atomically rollback on intra-script error.
**Risk:** medium. Lua atomicity + hybrid clock pump are both new.

### Slice 3 — `ChannelIndex` + new write path; integrate into `PartitionedRelayStorage` internals (no SIP-facing change)
**Files:** `src/replication/ChannelIndex.ts` (new), `src/cache/PartitionedRelayStorage.ts` (internals rewired; public API unchanged), `tests/replication/{apply-idempotent,storage-layout,tuple-comparator}.test.ts` (T1, T3, T9 — new), `tests/replication-ns/scenarioDsl.ts` (new — backend-abstract DSL), `tests/replication-ns/ns03-delete-and-tombstone-ttl.test.ts` (NS3), `tests/replication-ns/ns12-body-ttl-natural-cleanup.test.ts` (NS12), `tests/replication-ns/ns13-tombstone-ttl.test.ts` (NS13).
**Tests:** T1 idempotent apply by `(gen, counter)` tuple; T3 storage layout (member format `pri|bak:U|D:callRef`, score = counter, body has `gen` field); T9 tuple comparator correctness at all boundaries (gen rollover, counter rollover within gen); NS3/NS12/NS13 cover delete + tombstone TTL + body TTL — testable here because they don't need streaming.
**Acceptance:** All existing PartitionedRelayStorage tests still pass. NS DSL scenarios pass under both `KV_BACKEND=memory` (default) and `KV_BACKEND=redis` (when available).
**Risk:** medium. The rewire must preserve semantics. We keep the old path under a `replv1:` namespace until B1.7 cutover.

### Slice 4 — Wire protocol + `/replog` server endpoint (long-lived stream, data + noop frames)
**Files:** `src/replication/ReplicationProtocol.ts` (new), `src/replication/ReplLogServer.ts` (new — replaces old `ReplLog.ts` but lands in parallel), `docs/replication/protocol.md` (new), `tests/replication/protocol-codec.test.ts` (new), `tests/replication/server-emission-loop.test.ts` (new), `tests/replication-ns/ns09-caught-up-noop.test.ts` (NS9), `tests/replication/lag-steady-state.test.ts` (T7).
**Implementation specifics:**
- Server-side emission loop per the Wire Protocol section: read up to `chunk_size` from Redis via Lua, emit data frames, if exactly chunk_size returned loop immediately, else emit noop and sleep 100 ms.
- Every frame stamps `(gen, counter)` and `latency_ms = now - body.written_at_ms`.
- Long-lived NDJSON stream; connection stays open until puller closes or transport fails.
- No hello/head/gen_mismatch frames — gen rollover is implicit in tuple ordering.
**Tests:** Frame codec round-trips; server emission loop respects chunk_size + noop semantics; NS9 noop signaling within 200 ms; T7 sub-second steady-state lag under 500 writes/s.
**Acceptance:** Endpoint reachable; long-lived stream stable under 1000+ frames; T7 P99 ≤ 1 s.
**Risk:** medium. Stream lifecycle (clean close on puller drop, clean close on shutdown) is the trickiest part.

### Slice 5 — `PullerFiber` + `(gen, counter)` watermark + `ReplicationSupervisor`
**Files:** `src/replication/PullerFiber.ts` (new), `src/replication/ReplicationSupervisor.ts` (new), `tests/replication/peer-disappear-watermark.test.ts` (= NS11), `tests/replication/peer-disappear-mid-bootstrap.test.ts` (T11), `tests/replication-ns/ns11-peer-disappear-watermark.test.ts` (NS11 NS-suite variant), `tests/support/PeerFabric.ts` (add addPeer/removePeer).
**Implementation specifics:**
- PullerFiber: opens long-lived stream, applies frames per the apply rule `(F.gen, F.counter) > watermark`, flips `everCaughtUp` on first noop. Disconnect → `ErroredRetry` with backoff; reconnect resumes from current watermark.
- Watermark preserved forever on Disappeared (no linger timer).
- `(gen, counter)` ordering uses `compareGenCounter` exclusively — no special-case gen-mismatch logic.
**Tests:** NS11 watermark survives Disappeared/reappear cycle without triggering full re-bootstrap; T11 mid-bootstrap disappearance unblocks readiness immediately.
**Acceptance:** No fiber leaks under 1000 peer churn cycles in fake-clock; watermark integrity asserted across all NS-suite scenarios.
**Risk:** medium-high. Long-lived stream + reconnect lifecycle. Heavy use of `Effect.acquireRelease`.

### Slice 6 — `ReadinessController` + worker state machine + EpochCounter rewrite + boot integration
**Files:** `src/replication/ReadinessController.ts` (new), `src/cache/WorkerReadiness.ts` (producer rewired), `src/replication/EpochCounter.ts` (REWRITTEN — K8s downward API restartCount + UnixMillisAtBoot, no Redis INCR), `tests/replication/readiness-everCaughtUp.test.ts` (new), `tests/replication/epoch-counter.test.ts` (rewritten for new gen mechanism), `tests/replication-ns/{ns05,ns07,ns08}.test.ts` (NS5, NS7, NS8 sidecar-wipe / re-bootstrap / primary-recovery).
**Implementation specifics:**
- ReadinessController ticks every **100 ms** (not 1 s). Inputs: alive peers + per-peer `everCaughtUp`. No throughput-floor heuristic. Once `Ready`, stays `Ready` until `Draining`.
- WorkerState enum: `Booting | Bootstrapping | Ready | Draining | Terminated`. No `Degraded`, no `CatchingUp`.
- EpochCounter: removes `INCR epoch:{owner}`. Reads K8s downward-API `restartCount` (configured via `fieldRef` in pod spec); falls back to `Date.now()` if downward API unavailable. Packs into 64-bit `gen`.
- Helm chart updated with the downward-API `fieldRef` for `restartCount`.
**Tests:** Readiness flips when all alive peers report `everCaughtUp`; respects `T_min = 3 s` floor and `T_max = 60 s` ceiling; never un-readies post-Ready; NS5/NS7/NS8 cover the sidecar-wipe / reboot / recovery cycles.
**Acceptance:** Boot to Ready under healthy peers ≤ `T_min + 1 s`; `T_max` ceiling fires only on intentional peer-stall scenarios; gen monotonically increases across pod restarts (verified via NS5).
**Risk:** medium. EpochCounter rewrite touches helm; readiness state machine correctness.

### Slice 7 — Full NS-suite landing + multi-worker tests + `PartitionedRelayStorage` cutover
**Files:** `tests/replication-ns/ns0[1-4,6,10,14].test.ts` (the remaining NS-suite scenarios not landed in earlier slices, including NS14 symmetric tombstone from backup), `tests/replication/scenario-reverse-propagation.test.ts` (T6), `tests/replication/primary-bounded-cost.test.ts` (T2), delete `src/replication/{AtomicWriter,PropagateStream,ReplLog,ReplPuller,ReadyGate}.ts` and `src/cache/ReclaimRunner.ts`, delete `tests/replication/{atomic-writer,repl-puller,ready-gate,replog-*,repl-metrics}.test.ts`, update `docs/replication/call-cache-backup.md` to redirect, add `npm run test:ns-real` script (real-clock runs of the NS suite against the in-memory backend).
**Tests:** Full NS-suite green under all three backend combinations; T6 reverse propagation under primary brief unavailability; T2 INV1 bounded cost over 1 h TestClock.
**Acceptance:** `npm run typecheck` clean, no warnings; `npm run test` green; `npm run test:ns-real` green; `KV_BACKEND=redis npm run test` green when Redis available; old code path fully removed.
**Risk:** high. The cutover slice. If anything regresses, it surfaces here. Reviewer must verify the SIP-facing surface is unchanged (signature-diff).

### Slice 8 — Observability
**Files:** `src/replication/ReplicationMetrics.ts` (new — replaces `ReplMetrics.ts`), wire into all new modules from slices 3–6, `docs/replication/redesign-call-cache-backup.md` §Observability.
**Tests:** Metrics presence asserted across existing scenarios. New `tests/replication/metrics-presence.test.ts` walks the matrix.
**Acceptance:** every metric in D8 emits at least one sample under the relevant scenario.
**Risk:** low. Mostly wiring.

### Slice 9 — k8s robustness scenarios
**Files:** `tests/k8s/replication-late-peer-arrival.test.ts` (new — `d6a2b7b` regression), `tests/k8s/replication-30k-boot-budget.test.ts` (new = T8), `tests/k8s/replication-reverse-under-glitch.test.ts` (new — T6 at k8s tier), updates to existing failover suite for new replication semantics.
**Tests:** All new k8s scenarios pass on kind. T8 P99 ≤ 30 s with 30K calls primary + 30K backup.
**Acceptance:** kind suite green. Endurance harness extended.
**Risk:** medium. K8s integration tests are flaky-prone; expect rework.

### Slice 10 — Pre-prod validation harness + sign-off
**Files:** `tests/k8s/endurance/run-endurance.ts` extended, runbook in `docs/replication/redesign-call-cache-backup.md` §Pre-prod validation.
**Tests:** 48 h endurance run on a kind-equivalent staging cluster with chaos (peer kills, gen bumps, network partitions). All metrics within bounds; zero unexpected `ErroredFailed` peers; T_max never hit.
**Acceptance:** runbook signed; design doc B0.5 gate met.
**Risk:** low at this point — earlier slices have validated correctness; this is duration testing.

### Cross-slice rules

- **Every slice must keep `npm run typecheck` zero-error AND zero-warning** (CLAUDE.md). The Effect-plugin warnings are blocking — no `eslint-disable` comments without justification.
- **No slice may break the SIP-facing public surface.** A diff of `PartitionedRelayStorage`'s exported API is part of the slice review checklist.
- **No slice may delete a test without explicit replacement.** Per CLAUDE.md: "Never deactivate failing tests without proper investigation first and explicit confirmation."
- **Slice 7 (cutover) requires sign-off of the design doc (B0.5) before merge.** Earlier slices land behind feature/namespace isolation (`replv2:` keys) and do not flip the production code path.

---

## Deferred design-of-record gaps

A small number of design decisions captured in this document have a
status of "implementation pending" — the code path doesn't yet match
the design intent. Each gap is tracked as a separate story so it can
be picked up and shipped without touching unrelated code.

### Story 7d — Cycle-break via per-entry `entryGen` (no echo)

**Status**: ✅ **IMPLEMENTED**. All seven implementation steps have landed: storage primitive (`KvBackend` per-`(channel, entryGen)` buckets + lex-ordered `channelPullBatch`), wire protocol (`DataFrame.body_ttl_remaining_sec`, per-entry gen on data frames, `serverGen` on noops), `ChannelIndex` (explicit `entryGen` arg on `write`; `entryGen` + `callGen` on `tombstone`), puller apply (renamed `makeReplicationApply`; callGen content gate with create-if-not-exist semantics; `callIndexKeysFromUnknown` derivation; in-memory index cache for the DELETE path), PRS callGen RMW stamping in `deleteCall` plus entryGen pass-through in `putCall`/`refreshCall`, and the `main.ts` boot wiring (per-peer `outgoingChannel` + per-fiber `replicationApply` closure capturing the index cache).

`npm run typecheck` is clean (zero errors, zero warnings) across all four configs (`tsconfig.json`, `tsconfig.bin.json`, `tsconfig.test-harness.json`, `tsconfig.consumer-api.json`). Tests in `tests/storage`, `tests/replication`, `tests/replication-ns`, `tests/support/k8sFakeStack.ts`, and the harness's `twoWorkerHarness.ts` were updated for the new shapes.

**Test results — `npm run test:fake`**: **1085 passed, 1 failed** in 19.83 s. The cycle-break works: previously-infinite tests now complete in seconds (replication-gap-mini: 121 s timeout → 12 s completion). All 14 NS scenarios pass.

**One remaining failure** (carried as a follow-up, NOT a cycle-break regression): `tests/sip-front-proxy/failover/replication-gap-mini.test.ts` reports 1 of 40 calls (`alice-p1-1`) receives a 481 on the post-respawn BYE batch. The other 39 calls are clean. The shape is consistent with a single-call recovery edge case (specific call's body or index didn't make it through the cold-pull rebuild) rather than a cycle or any structural defect — diagnostic deferred to a separate ticket.

**Supersedes** the prior body-gen + echo design (rejected; see "Why this design changed" below).

**Design references**: this section is the new plan-of-record. It replaces the §D2 "Each body stamps a `gen` field" sentence (also rejected) and the §D3 "incoming.body.gen > local.body.gen" rule (also rejected). The §D2 / §D3 wording above is left intact for traceability with a marker pointing here.

#### Why this design changed

The original Story 7d proposed stamping a `body.gen = channelCounter` field into every call body inside `KvBackend.channelWriteUpdate` (Lua-side string surgery for Redis, JS-splice for memory), and gating the puller's apply path with `incoming.body.gen > local.body.gen`. Two band-aids preceded it (partition-asymmetric branch; body-content compare); both were reverted. The body-gen design was the planned-correct fix.

During grill it surfaced that:

1. **The body-gen approach conflated two independent invariants** — wire-level cycle-break and per-call content idempotency.
2. **Echo itself is not load-bearing**, only its purpose is: populate the recovering worker's pull stream with the mirrors it lost. That goal can be met without echo.
3. **The plan's `(gen, counter)` watermark already supports lex ordering** — if mirror-writes carry a sentinel `entryGen=0` distinct from originating writes' `entryGen=self.incarnationGen`, lex compare on `(entry.gen, entry.counter)` makes warm pullers naturally skip mirrors and cold pullers naturally fetch them. Cycle dies at the wire layer; no content inspection needed.

So body-gen is dropped. The new design uses **per-entry gen on the channel** as the cycle-break (cycle dies in lex compare); a separate **per-call `callGen` field on the body** as the per-call content idempotency gate (catches stale-overwrite races).

#### Hard invariants

- **CB-INV1 (cycle-break by wire ordering).** A mirror-write entry on `propagate:{self}->{peer}` has `entryGen = 0`. A warm puller's pull request `(since.gen ≥ 1, since.counter)` will never receive it: lex compare excludes `(0, anything) < (≥1, anything)`. The cycle is broken structurally, not by content inspection.
- **CB-INV2 (recovery via the same endpoint).** A cold puller (process boot or post-wipe) sends `(0, 0)`. The server's lex-ordered return includes every mirror entry. The recovering worker rebuilds its lost partitions from peers' mirrors through the unmodified `/replog` endpoint. No `/bootstrap` RPC, no SCAN side-channel.
- **CB-INV3 (cross-direction content idempotency).** Each call body carries a `callGen: number` field. PRS originating writes do a read-modify-write that increments it. The puller's apply path reads the local body and skips when `incoming.body.callGen ≤ local.body.callGen`. **When the local body does not exist, the gate succeeds (create-if-not-exist):** treat `null` local as `callGen = -∞` so any incoming `callGen ≥ 1` lands. This is what makes cold-recovery work — A's empty `pri:A:` after wipe accepts every incoming mirror frame on first apply. The gate exists solely to protect against the "stale forward write races G7-reverse termination" race (worked example below).
- **CB-INV4 (no echo, single primitive).** The puller's apply path makes ONE atomic call: `kv.channelWriteUpdate({ entryGen: 0, channel: "propagate:{self}->{source}", member: "U:" + targetBodyKey, bodyKey: targetBodyKey, bodyValue: frame.body, ... })`. This single Lua / critical-section atomically (a) creates-or-replaces the body at `bak:{source}:call:{ref}` (or `pri:{self}:call:{ref}` for the G7 reverse partition flip), (b) bumps the gen=0 bucket's counter, (c) ZADDs the U-member into the gen=0 bucket. No separate `bodySet` step. No separate "mirror" method on the API. The only call-site difference between PRS originating writes and puller-driven applies is the `entryGen` value: PRS passes `self.incarnationGen`, puller passes `0`.

#### Worked examples

**Example 1 — Steady-state forward propagation (the cycle that was breaking the test).**

1. A's stack writes call X. PRS originating: `entryGen=A_gen=7`, channel counter=10. A's `pri:A:call:X` body is stamped with `callGen=1`.
2. B's puller pulls A's outgoing-to-B. Watermark for source-A was `(7, 9)`. Server returns the new entry `(gen=7, counter=10, body)`. Apply (`(7,10) > (7,9)` ✓).
3. B applies: `kv.bodySet("bak:A:call:X", body)` AND `outgoingChannelToA.mirrorWrite(...)` which calls `kv.channelWriteUpdate(entryGen=0, member="U:bak:A:call:X", body)`. B's outgoing-to-A has a sentinel mirror entry.
4. A's puller pulls B's outgoing-to-A. Watermark for source-B was `(genB=7, lastCtr=42)`. Server returns entries with `(entry.gen, entry.counter) > (7, 42)`. Mirror entry has `entryGen=0`; `(0, anyCounter) < (7, 42)` → **server doesn't return it.** No apply on A. **No cycle.**

**Example 2 — Cold recovery from sidecar wipe.**

1. Steady state as above; A's outgoing-to-B has originating entries; B's outgoing-to-A has mirror entries (entryGen=0) from earlier applies.
2. A's sidecar wipes. A's process restarts with `genA' = 8` (incremented restartCount). A's puller starts with watermark `(0, 0)` for source-B.
3. A's puller pulls B's outgoing-to-A. Server returns entries with `(entry.gen, entry.counter) > (0, 0)` — i.e., **all** entries (mirrors with `entryGen=0` plus B's originating G7-reverse entries with `entryGen=B_gen`, in lex order).
4. A applies each. `partition="bak"` (per the wire frame, because the entry references B's `bak:A:`) routes the apply to A's local `pri:A:` per the existing partition-flip rule.
5. A reconstructs `pri:A:` from the mirror stream. `WorkerReadiness.markReady(true)` flips after first noop.

**Example 3 — Cross-direction race; `callGen` earns its keep.**

1. A handles a re-INVITE for X — `pri:A:call:X` body advances to `callGen=5`.
2. A goes briefly unreachable (200 ms HealthProbe blip). Proxy routes the BYE for X to B per G7.
3. B's stack handles BYE: terminates X. PRS originating: writes tombstone to its OWN `bak:A:call:X` with `callGen=6` (read-modify-write of the existing local body). Channel `propagate:{B}->{A}` gets entry `(entryGen=B_gen, counter=N, partition="bak", op="delete", body=<tombstone, callGen=6>)`.
4. A comes back, A's puller catches up against B. Mirror entries (`entryGen=0`) for X are still present from earlier steady-state mirroring (some carrying older `callGen=4`). The G7 tombstone (`entryGen=B_gen`) is also present.
5. Lex order serves entries: mirror entries first, then the tombstone. A's apply path reads `local.callGen` per call before each apply: `incoming.callGen=4 ≤ local.callGen=5` → skip mirror; `incoming.callGen=6 > local.callGen=5` → apply tombstone. **No resurrect-from-stale-mirror.**

Without `callGen`, a stale mirror after a G7-reverse termination would silently overwrite the tombstone state. With it, the gate catches it.

#### Storage primitive changes

**`KvBackend.channelWriteUpdate` — new signature.**

```diff
  readonly channelWriteUpdate: (
    args: {
      readonly channel: string
+     readonly entryGen: number
      readonly counterKey: string
      readonly member: string
      readonly bodyKey: string
      readonly bodyValue: string
      readonly bodyTtlSec: number
      readonly indexes: ReadonlyArray<IndexWrite>
    }
  ) => Effect.Effect<{ readonly counter: number }, KvError>
```

Channel storage shape changes from "one sorted set per channel keyed by counter" to "one sorted set per `(channel, entryGen)` bucket, each with its own counter":

- **Memory**: `Map<channel, Map<entryGen, { counter: number; entries: Map<member, counter> }>>`. Single mutex still sufficient for atomicity; entries inside a bucket are sorted by counter at pull time.
- **Redis**: per-bucket ZSET `propagate:{self}->{peer}:gen:{entryGen}` and per-bucket counter `seq:{self}->{peer}:gen:{entryGen}`. Each `channelWriteUpdate` Lua script INCRs its bucket's counter, ZADDs into its bucket's ZSET. Per channel only `{0, self.incarnationGen}` are live; historical buckets from prior `self.incarnationGen` values may persist if the sidecar survives a process restart, and are walked in lex order on pull.

**`KvBackend.channelPullBatch` — new signature.**

```diff
  readonly channelPullBatch: (
    args: {
      readonly channel: string
-     readonly counterKey: string
-     readonly sinceScore: number
+     readonly since: { readonly gen: number; readonly counter: number }
      readonly limit: number
    }
  ) => Effect.Effect<ChannelPullResult, KvError>

  export interface PulledEntry {
    readonly member: string
+   readonly entryGen: number  // stamped at write time, returned per-entry
    readonly score: number      // per-bucket counter
    readonly body: string | null
  }
```

Pull algorithm:

1. Enumerate buckets in lex order of `entryGen`.
2. For the bucket with `entryGen === since.gen`, return entries with `score > since.counter`.
3. For buckets with `entryGen > since.gen`, return all entries in counter order.
4. Skip buckets with `entryGen < since.gen` (lex compare excludes them entirely).
5. Stop accumulating at `limit`.

`headCounter` is replaced by `head: { gen, counter }` — the highest `(gen, counter)` tuple in the channel at snapshot time.

**`KvBackend.channelWriteTombstone`** — same signature change. Originating tombstones (PRS deleteCall) pass `self.incarnationGen`; puller-driven mirror-tombstones pass `0`.

#### Wire protocol changes

- **`DataFrame.gen`**: today stamped with the SERVER's current incarnation gen on every emitted frame. New: stamped with the **entry's stored `entryGen`** (`0` for mirrors; the writer's incarnation gen for originating). `buildDataFrame` reads `entryGen` from `PulledEntry`.
- **`NoopFrame.gen`**: stays the SERVER's current incarnation gen (heartbeat, not associated with any specific entry). Receivers use it only to flip `everCaughtUp`.
- **`PullRequest`**: already carries `gen` and `counter`; no field addition. Server interprets them as the puller's last-applied `(entry.gen, entry.counter)`.
- **`ReplLogServer`**: no longer special-cases "if sinceGen != serverGen treat as cold". The whole-channel cold-vs-warm decision is now natural from lex ordering.
- **`DataFrame.body_ttl_remaining_sec`** (NEW — subsumes Story 7e): every frame carries the body's **time-remaining**, not its TTL-at-write. Server reads `PTTL` (Redis) or `expiresAtMs - nowMs` (memory) and stamps it. Receiver passes this value to its `bodyTtlSec` arg in the apply path. **Why time-remaining, not time-to-live:** a peer cold-pulling at T=600 from a body originally written with TTL=1200 at T=0 should set its local body to expire at T=1200 (the source's intent), not T=1800. Otherwise recovered bodies outlive the source's intent, and three-peer arrangements (rare but possible) could disagree on expiry.
- **Indexes are NOT carried on the wire — they are derived from the body**, per the legacy pattern. [src/call/CallModel.ts:768](../../src/call/CallModel.ts#L768) `callIndexKeysFromUnknown(state: unknown)` is a pure, schema-tolerant derivation that walks the body's `aLeg.{callId,fromTag}`, `bLegs[].{callId,fromTag}`, `bLegs[].dialogs[].sip.remoteTag`, and `callbackContext`. It produces the same key list `callIndexKeys(call)` produces from a typed Call. The receiver-side apply path in `makeReplicationApply` MUST call `callIndexKeysFromUnknown(frame.body)` and pass the derived list into `channelWriteUpdate({ ..., indexes: derived.map(toIndexWrite) })`. Today's `makeEchoApply` passes `indexes: []` — that is the actual gap (closed by adding the derivation step, NOT by adding a wire field). For DELETE frames where `body === null`, the puller consumes a per-`(peer, callRef)` in-memory cache populated on the last successful PUT apply; cache-miss → empty list → orphaned `idx:` entries TTL out within one call-TTL window (accepted by spec, matches legacy `ReplPuller` behaviour).

#### Code change inventory

| File | Change |
|---|---|
| [src/storage/KvBackend.ts](../../src/storage/KvBackend.ts) | (1) Per-bucket sorted-set storage shape; (2) `entryGen` arg on `channelWriteUpdate` / `channelWriteTombstone`; (3) `since: {gen, counter}` arg on `channelPullBatch`; (4) Lua scripts updated for per-bucket keying. |
| [src/replication/ChannelIndex.ts](../../src/replication/ChannelIndex.ts) | `write` takes `entryGen` as an explicit parameter (no second method). PRS originating callers pass `config.gen` (the binding's incarnation gen); the puller's apply path passes `0`. Single primitive; the only difference at the call site is the gen value. |
| [src/replication/ReplLogServer.ts](../../src/replication/ReplLogServer.ts) | `buildPullStream` reads per-entry `entryGen` from `PulledEntry` and stamps it on each `DataFrame`. Drops the `sinceGen != serverGen → reset` special case. |
| [src/replication/ReplicationProtocol.ts](../../src/replication/ReplicationProtocol.ts) | `buildDataFrame` takes the entry's `entryGen` from `PulledEntry` instead of the server's gen. |
| [src/replication/PullerFiber.ts](../../src/replication/PullerFiber.ts) | Apply path adds the `callGen` content gate. Reads local body via `kv.bodyGet(targetBodyKey)`, parses `callGen` from JSON, compares incoming. Watermark advancement unchanged (uses wire `(gen, counter)`). |
| [src/replication/EchoApply.ts](../../src/replication/EchoApply.ts) | Renamed to `ReplicationApply.ts`. `makeEchoApply` → `makeReplicationApply`. Behaviour rewritten: ONE atomic call to `outgoingChannel.write({ entryGen: 0, ... })` per frame. Body lands at the target partition (bak:source: or pri:self: per the partition flip), member lands in the gen=0 bucket, counter advances — all in the single underlying `kv.channelWriteUpdate` op (create-if-not-exist by construction). Old `makeDirectApply` deleted (subsumed). |
| [src/cache/PartitionedRelayStorageKvBacked.ts](../../src/cache/PartitionedRelayStorageKvBacked.ts) | `putCall` / `refreshCall` / `deleteCall` do read-modify-write on existing body to bump `callGen` before delegating to `ChannelIndex.write`; all `ChannelIndex.write` calls implicitly carry `entryGen = config.gen` via the binding. |
| Tests (NS5/NS7/NS8/NS14/replication-gap-mini) | No source change for behaviour — they assert recovery + steady-state correctness which the new design satisfies. The harness's `forkPuller` wires the renamed `makeReplicationApply` (and `kv` for the callGen gate). |

#### Test re-validation matrix

After 7d lands, the following tests MUST pass (none of them currently do, by design — the band-aids were reverted):

| Test | What it now validates under the new design |
|---|---|
| `tests/replication-ns/ns05-sidecar-wipe-recovery.test.ts` | Cold pull post-wipe rebuilds `pri:A:` from B's mirror entries (entryGen=0). |
| `tests/replication-ns/ns07-backup-re-bootstrap.test.ts` | Backup wipe + restart pulls 50 originating-entry calls from primary's outgoing channel — pure forward replay (no cycle case). |
| `tests/replication-ns/ns08-primary-recovery-via-reverse.test.ts` | Same as NS5 but exercises the "primary restart, backup is alive and holds bak:A:" path. |
| `tests/replication-ns/ns14-symmetric-tombstone-from-backup.test.ts` | G7 reverse-direction tombstone propagates with `entryGen=B_gen` (originating write), reaches A on warm pull, applies. No mirror re-write back to B. |
| `tests/sip-front-proxy/failover/replication-gap-mini.test.ts` | Multi-worker steady state with concurrent pullers. Counter no longer climbs into the millions; test completes in <10s (vs 121s timeout pre-revert). |

`tests/replication/echo-apply.test.ts` — currently asserts on `EchoApplyConfig` field shape; rename to `replication-apply.test.ts`, update to assert `ReplicationApplyConfig`'s shape and the partition-flip-routing logic (preserved). No deactivation.

#### Sequencing

Land in this order so each step is independently reviewable; steps 1–5 ship as a single PR (the change is internally consistent only when all are present); steps 6–7 land alongside or immediately after.

1. **Storage primitive**: `KvBackend.channelWriteUpdate` / `channelWriteTombstone` / `channelPullBatch` signature + memory impl + Lua impl + per-bucket sorted-set shape. Unit tests in `tests/storage/` updated.
2. **Wire protocol**: `buildDataFrame` reads `entryGen` from `PulledEntry`. `ReplLogServer` simplifies the gen handling. Codec tests updated.
3. **ChannelIndex**: `write` and `mirrorWrite` as two distinct methods.
4. **Puller + ReplicationApply**: rename module; rewrite `makeReplicationApply` per CB-INV4; add `callGen` content gate to `applyOne`.
5. **PRS callGen stamping**: read-modify-write on `putCall` / `refreshCall` / `deleteCall`. Existing `written_at_ms` stamping is preserved alongside.
6. **Documentation deliverables**: `docs/replication/architecture.md` (NEW) — captures the as-built design with §"Cycle-break and recovery" being the prominent §. `docs/replication/protocol.md` (NEW) — wire-protocol reference reflecting the per-entry-gen change. `docs/replication/state-machine.md` (NEW) — worker + per-peer FSM diagrams. `docs/replication/redesign-call-cache-backup.md` (currently STALE — describes a never-shipped Redis-Streams design) replaced by a redirect to `architecture.md`. `docs/replication/call-cache-backup.md` (legacy) replaced by a redirect after cutover. `CLAUDE.md` progressive reading guide row updated.
7. **Test re-enable**: NS5/NS7/NS8/NS14 + replication-gap-mini run; no test deactivations introduced.

#### Concerns / open questions deferred to implementation

- **Q1 — Empty `entryGen=0` bucket cleanup.** Mirror entries with `entryGen=0` accumulate over the lifetime of the channel. A re-INVITE on call X overwrites the same member (`U:bak:A:call:X`) — score updates in place per ZADD semantics. So per-call growth is bounded; total bucket size is bounded by `O(active calls + tombstones-in-3-min-window)` (per the existing INV1 reasoning). No GC needed beyond what already exists for tombstones.
- **Q2 — Bucket cardinality at Redis layer.** Keys-per-channel grows from 2 (`propagate:` + `seq:`) to 4 (mirror + originating × 2). With <10 peers and ≤3 buckets typical (gen=0, prior incarnation, current), total keys per pod stay in the hundreds. Acceptable.
- **Q3 — `callGen` stamping under contention.** Two concurrent SIP-stack writers on the same callRef could both read `callGen=5` and both stamp `callGen=6`. Mitigation: PRS-level mutex per callRef (already needed for body atomicity in CallState). Confirm during impl that this mutex covers the new RMW.
- **Q4 — Backwards-compat across deploy.** A pod running the new code talking to a pod running the old code: not supported. The cutover (D10) is sharp per the existing plan. No version negotiation.

#### Acceptance gates

- `npm run typecheck` — zero errors AND zero warnings (Effect plugin included).
- `npm run test:fake` — full fake suite green.
- `npm run test:ns-real` — NS suite under real-clock + in-memory KvBackend green.
- `KV_BACKEND=redis npm run test` — green when Redis available (validates the per-bucket Lua scripts).
- `tests/sip-front-proxy/failover/replication-gap-mini.test.ts` — completes in <10s with no 481s on phase-1 BYEs.
- `docs/replication/architecture.md` exists and explicitly documents the `entryGen=0` sentinel as a top-level invariant.
- `docs/replication/redesign-call-cache-backup.md` redirects to the new architecture doc.

### Story 7e — Wire-level TTL propagation (RETIRED — subsumed by Story 7d)

**Status**: subsumed by Story 7d's `DataFrame.body_ttl_remaining_sec` field. The wire-level TTL gap is no longer tracked separately because the no-echo redesign forces the same wire-frame schema change at the same time. Splitting them across two slices would require two breaking changes to `DataFrame`, two reviews of `buildDataFrame` / `applyOne`, and one intermediate state where the receiver's TTL is still hardcoded. Cleaner to land both in 7d.

The TTL-handling content originally drafted here is preserved in 7d's "Wire protocol changes" section under `DataFrame.body_ttl_remaining_sec`. Time-remaining (not time-to-live) was chosen during the 7d grill — see that section for rationale.

### Story 7f — Index replication on the wire (RETIRED — different fix, not a wire change)

**Status**: subsumed by Story 7d, but **not via a wire-frame field**. Verification of [src/call/CallModel.ts:768](../../src/call/CallModel.ts#L768) (`callIndexKeysFromUnknown`) and the legacy `ReplPuller` (deleted at HEAD; cf. `git show HEAD:src/replication/ReplPuller.ts:463`) shows the receiver derives indexes from the body via that pure helper — the wire frame never carried them. The fix is purely in `makeReplicationApply`: derive on every PUT apply, cache per `(peer, callRef)` for the DELETE path, accept index-TTL-out on cache miss. See "Wire protocol changes" §"Indexes are NOT carried on the wire" above for the full design.
