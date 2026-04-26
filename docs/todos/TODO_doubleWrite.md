# Plan: Resilient call-context layer for K8s node failure

## Context
The B2BUA today writes call state to a single external Redis via [`CallStateCache.redisLayer`](src/call/CallStateCache.ts#L56-L126). When the K8s node hosting a B2BUA worker dies, calls owned by that worker are lost — the proxy will re-route via Rendezvous Hashing to a surviving worker that has no state, and `loadOwnedCalls()` only runs at startup of the original owner.

User-stated goal: **established calls must survive node failure**. User-proposed design: dual-write to a co-located primary Redis and a topology-distinct backup Redis chosen by the proxy on Call-ID, with backup writes being best-effort. Test infra must simulate latency + faults on the in-memory cache.

## Codebase facts established (Phase 1)
- Proxy already uses HRW on Call-ID — [RendezvousHash.ts:55-71](src/sip-front-proxy/strategies/RendezvousHash.ts#L55-L71)
- Proxy already does K8s Pod-watch topology — [registry/kubernetes.ts:1-77](src/sip-front-proxy/registry/kubernetes.ts#L1-L77)
- Proxy already stamps an HMAC stickiness cookie into Record-Route — [LoadBalancer.ts:229-249](src/sip-front-proxy/strategies/LoadBalancer.ts#L229-L249)
- Single-Redis `CallStateCache` with two stores (call + index) — [CallStateCache.ts:25-275](src/call/CallStateCache.ts#L25-L275)
- In-memory `memoryLayer` uses `MutableHashMap` + Effect `Clock` — [CallStateCache.ts:140-274](src/call/CallStateCache.ts#L140-L274)
- Crash-recovery scan is `loadOwnedCalls()` — [CallState.ts:309-340](src/call/CallState.ts#L309-L340)
- No existing chaos/fault-injection layer; only `PreIngressHook` for accept/drop on signaling — [SignalingNetwork.ts:137-141](src/sip/SignalingNetwork.ts#L137-L141)
- Tests have no node-failure / failover scenarios; `failover-reroute.ts` only tests 503 retargeting
- **Existing 2-worker test SUT to extend, not replace** — [proxyB2bFakeStack.ts:112-301](tests/fullcall/framework/proxyB2bFakeStack.ts#L112-L301) (the `sipproxyHA` SUT) already materializes two B2BUA workers (`b2b-1` at 10.20.0.1:5060, `b2b-2` at 10.20.0.2:5060) each with own `CallStateCache.memoryLayer` and own scope via `Layer.fresh()`.
- **Existing infra-step hook ready for crash/reboot** — [interpreter.ts:347-355](tests/fullcall/framework/interpreter.ts#L347-L355) has an `InfraStep` case stubbed "not yet implemented" — natural mount point for `step.fabric.kill/reboot/sigterm`.
- **Test transport entry point** — [simulated-backend.ts:118-441](tests/fullcall/framework/simulated-backend.ts#L118-L441) (`createSimulatedTransport`) wires `SignalingNetwork.simulated()` to per-agent endpoints; current extension points at lines 208, 226, 236-237, 253-265.

## Design clarifications (added per follow-up)

### Backup cardinality per node
- **Per-call**, not per-node. For each call, `w_bak = HRW2(callId, alive_excluding_w_pri)` — second-best Rendezvous-Hashing pick. Different calls land on different backups.
- **Each node maintains relay connections to potentially every other alive node**: as primary it writes to whichever node was HRW2 for each given call; as backup it receives writes from any node whose calls picked it as HRW2.
- Connection pool is dimensioned for `N-1` peers (where `N` is current cluster size), but only nodes participating in active dual-writes hold open connections.
- Topology change (peer added/removed) takes effect for **new** dialogs only; existing dialogs keep their original `w_bak` per cookie immutability (D4).

### Local-cache key partitioning by role + owner (added during Slice 3 design review)

Every entry in a sidecar Redis lives under a `{role}:{owner}:` namespace where:
- `role ∈ {"pri", "bak"}` — whether THIS pod is primary or backup for this entry's call
- `owner` = the cookie's `w_pri` ordinal (the "natural primary" for that call)

Concretely, for a call X with cookie `{w_pri=A, w_bak=B}`:
- On pod A's local Redis: `pri:A:call:X` and `pri:A:idx:{indexKey}` for each identifier
- On pod B's local Redis: `bak:A:call:X` and `bak:A:idx:{indexKey}`

Benefits:
- **Scan trivially partitioned**: `SCAN MATCH bak:A:call:*` filters by role+owner without reading any JSON values.
- **Observability**: `redis-cli --scan --pattern 'pri:*:call:*' | wc -l` answers "calls I am primary for" instantly; per-peer breakdown for "as backup, for whom and how many" is one CLI command.
- **No collisions**: a single sidecar can hold many `(role, owner)` partitions concurrently.

### Lookup precedence on B2BUA in-dialog receive path

When a worker receives an in-dialog request and must look up the call state, it tries (in order):
1. **`pri:self:call:{callRef}`** — am I the natural primary for this call?
2. **`bak:{cookie.w_pri}:call:{callRef}`** — am I the cookie's `w_bak` taking over because the primary is dead/draining?
3. Miss → return 481 (after reclaim is complete) or 503-temp (during reclaim).

The cookie's `w_pri` value is the authoritative source for the second lookup: it tells the recovery worker exactly which `bak:` partition holds the data.

### Recovery write-back stays in `bak:{cookie.w_pri}` partition

When the recovery worker (=cookie's `w_bak`) takes over and processes in-dialog requests, all subsequent state writes go BACK to **`bak:{cookie.w_pri}:`**, NOT to `pri:self:`. Rationale:
- The cookie is immutable; `w_pri` permanently names this call's primary even when that primary is dead.
- When the original primary returns and reclaims (Slice 6), it scans peers for `bak:{self}:*` data. Writes that landed in `pri:recovery_worker:*` would be invisible to that reclaim path.
- Keeping writes in `bak:{w_pri}:` ensures the original primary (after restart) finds the most-recent state under the key it expects.

The recovery worker's `pri:self:*` partition is reserved for calls where IT is the cookie-named primary (i.e., new calls created during/after its rejoin).

### Reclaim timeout + K8s-aware peer skipping (D14)
- `ReclaimRunner.maxDuration` (default **10 minutes**) is a hard ceiling.
- Peer enumeration uses **DNS-based readiness filtering**: querying the headless StatefulSet service returns ONLY ready endpoints (default K8s behavior with `publishNotReadyAddresses: false`). Peers that K8s reports as not-Ready are not returned and not scanned.
- During reclaim, ReclaimRunner **periodically re-queries DNS** (every `reclaim.peerRefreshSec`, default 10s) so peers transitioning to Ready mid-scan get picked up.
- Peers in **Failed** or **deletionTimestamp ≠ null** state are reported by K8s as gone — DNS will not return them; reclaim treats their data as permanently lost.
- At `maxDuration`: ReclaimRunner logs a warning, marks the worker K8s-ready anyway. For in-dialog requests landing on this worker for calls it never recovered, the worker responds with **481 Call/Transaction Does Not Exist**, which causes UAs to clean up the dialog. This is the documented degradation behavior.
- New INVITEs are handled normally regardless of reclaim state — they are independent of unrecovered dialogs.

## Scope (confirmed)
- Signaling-only resilience. RTP path is out of scope.
- Protected state: **post-ACK confirmed dialogs only**. Mid-establishment (pre-200-OK) calls may drop.
- Resilience target: next in-dialog request (re-INVITE, BYE, UPDATE, in-dialog OPTIONS) routes to a survivor and is handled correctly.
- HA doc must enumerate every remaining call-loss scenario. Test plan must cover each.

## Design decisions confirmed so far
- **D1 — Sidecar Redis**: each B2BUA pod has a sidecar Redis instance, ephemeral, **bound to 127.0.0.1 only** (no cross-pod TCP exposure). Co-location guaranteed by Pod boundary.
- **D2 — Worker resolution**: cookie carries opaque worker ordinals; B2BUA resolves peer endpoints via existing headless StatefulSet DNS (`b2bua-worker-N.<svc>.<ns>.svc.cluster.local`). No IPs leak in SIP traffic. (Note: not direct Redis address — the DNS resolves to the worker's reclaim/relay endpoint.)
- **D3 — Replication factor 2**: cookie carries `w_pri, w_bak`. Primary writes to its own sidecar + backup peer's Redis. F4/F11 ("double failure within recovery window") is an accepted loss class.
- **D4 — Cookie immutability**: Record-Route stamped once at INVITE per [ProxyCore.ts:597-613](src/sip-front-proxy/ProxyCore.ts#L597-L613); no mid-dialog updates.
- **D5 — Drain protocol**: pod SIGTERM handler does a final flush to `w_bak` (best-effort), then exits. No complex migration — `w_bak` already has the recent state.
- **D6 — Self-fencing on partition**: B2BUA stops processing if it can't reach proxy AND `w_bak` for `T_fence` (default 2 × keepalive).
- **D7 — Stored value carries `gen` for conflict resolution**: `_topology.gen` (monotonic per-flush) lives inside the JSON value. Newest-`gen` wins on conflict (e.g. partition heal). `_topology.pri` and `_topology.bak` are also carried in the JSON for diagnostics, but the AUTHORITATIVE role/owner is encoded in the **key namespace prefix** (`{role}:{owner}:`) — see "Local-cache key partitioning" above.
- **D8 — Required proxy logic change**: dead/unknown `w_pri` must route to cookie's `w_bak`, not fallback HRW. Update [LoadBalancer.ts:349-377](src/sip-front-proxy/strategies/LoadBalancer.ts#L349-L377).
- **D9 — Reclaim gating via K8s readiness (Option β)**: pod returning from restart stays not-ready (kubelet probe answers 503) while reclaim runs. K8s removes from Service → proxy registry sees `unknown` → routing falls to `w_bak` via D8. Pod marks ready when reclaim completes. **No new proxy retry code required.**
- **D10 — All cross-pod cache I/O via per-worker HTTP relay (no auth — trusted LAN)**: each worker exposes a small HTTP service backing the call-as-a-whole semantics. Three mutating endpoints + scan, all addressed by `(role, owner, callRef)`:
  - `PUT /cache/{role}/{owner}/calls/{callRef}` — body `{ state, indexes[], ttlSec }` — full create/overwrite. Receiver writes call + every index entry, all under the `{role}:{owner}:` partition prefix on its local Redis.
  - `POST /cache/{role}/{owner}/calls/{callRef}/refresh` — body `{ indexes[], ttlSec }` — keepalive. Bumps TTL on call + every named index, no value rewrite.
  - `POST /cache/{role}/{owner}/calls/{callRef}/delete` — body `{ indexes[] }` — termination. Removes call + every named index entry.
  - `GET /cache/{role}/{owner}/scan` — streams `(callRef, json, ttlSec)` rows from the partition; server walks `SCAN MATCH {role}:{owner}:call:*` with batched `Effect.yieldNow` between iterations so concurrent local Redis ops are not starved.
  Relay reads/writes its OWN sidecar Redis only (localhost). **Cross-pod Redis exposure forbidden** (D1: Redis binds to 127.0.0.1). HTTP request body uses POST for delete-with-body (DELETE-with-body is fragile through HTTP intermediaries). No HMAC auth — runs on the trusted intra-cluster LAN.
- **D11 — Pod pinning**: StatefulSet with `nodeAffinity` on per-ordinal label (`b2bua-pin=N`). Accepted consequence: K8s node death → pod stays Pending until node returns. Affected calls run on `w_bak` indefinitely.
- **D12 — `PeerFabric.simulated` test infrastructure**: new component analogous to `SignalingNetwork.simulated`. Models N fake peers (each with own MutableHashMap as fake sidecar Redis + fake relay). `RedisFabricWire` simulates inter-peer LAN with per-peer configurable latency, error rate, partition state. All cross-pod operations pass through fabric; single fault-injection seam.
- **D13 — Scenario DSL extensions**: `step.advanceTime`, `step.fabric.kill`, `step.fabric.reboot`, `step.fabric.sigterm` (graceful: triggers worker drain handler), `step.fabric.partition/heal`, `step.fabric.setLatency`, `step.fabric.setErrorRate`, plus `step.assertCallState(peer, …)` for cross-peer state assertions.
- **D14 — Reclaim hard timeout + K8s-aware peer skipping**: `reclaim.maxDuration=10min`, peer enumeration via DNS on the headless StatefulSet service (which excludes not-Ready endpoints), DNS re-queried every `reclaim.peerRefreshSec=10s`. Past `maxDuration`: worker marks K8s-ready anyway and answers 481 to in-dialog requests for unrecovered calls.
- **D15 — Receive-path lookup precedence**: on every in-dialog request, the B2BUA tries `pri:self:call:{callRef}` first (am I primary?), then on miss `bak:{cookie.w_pri}:call:{callRef}` (am I the backup taking over?). The cookie's `w_pri` value drives the second key — no scan or registry consult required.
- **D16 — Recovery write-back stays in `bak:{cookie.w_pri}` partition**: when serving as recovery worker, all subsequent writes for that call go to `bak:{cookie.w_pri}:`, not to `pri:self:`. This preserves the invariant that the cookie's `w_pri` ordinal permanently names "where this call's primary copy lives" — when the original primary returns, its reclaim scan against peers' `bak:{self}:*` finds the most-recent state. Writing to `pri:self:` on a recovery worker would orphan the data from the original primary's reclaim path.

## Failure-mode enumeration (HA doc seed)

### Surviving classes
| ID | Scenario | Recovery mechanism |
|----|----------|-------------------|
| F1 | Single primary worker death | Proxy routes via cookie `w_bak` per D8; recovery worker looks up `bak:{cookie.w_pri}:call:{ref}` (D15) on its own sidecar Redis (populated by dual-write) and takes over; subsequent writes stay in same `bak:{w_pri}:` partition (D16) so the original primary can reclaim from peers' `bak:{self}:*` after restart |
| F2 | Single Redis transient failure (backup-side) | Backup relay write fails → primary continues with local copy; nothing held (per "throw away" semantics); reclaim repairs on primary's next restart by pulling from `bak:{self}:*` on peers |
| F7 | Topology rebalance mid-dialog | Cookie frozen by RFC 3261 §12; recovery still works on original cookie's `w_bak` and `bak:{w_pri}:` partition |
| F9 | Rolling update with long-lived calls | Drained pod stops accepting new + final flush to backup; restart pulls primary calls via Flow 1 reclaim (`GET /cache/bak/{self}/scan` against peers); no peer overload due to scan pacing |
| F10 | Primary crashes mid-flush to backup | Backup has near-current state (last-flushed gen); at most one in-flight state event lost |
| F12 | DNS lookup failure for backup peer's relay | Same as F2 |
| F13 | Cookie tamper | Existing HMAC verify on cookie rejects (proxy-side, unchanged from slice 1) |

### Documented loss classes (HA doc must list these explicitly)
| ID | Scenario | Why no recovery |
|----|----------|----------------|
| F3 | Backup dies before any state was written | Window <1-2s of call lifetime; user accepted as low-probability |
| F4 / F11 | `w_pri` dies, then `w_bak` dies before re-replication completes ("double failure") | Rep factor 2 has no third copy; explicitly accepted |
| F5 | Both `w_pri` and `w_bak` die simultaneously | Same as F4 |
| F6 | Network partition + crash on either side ("semi split-brain followed by crash") | State diverged or fenced; user explicitly accepted |
| F8 | Cold cluster restart (all pods down concurrently) | Redis is ephemeral by D1 |

### Deferred-but-addressable
- Reconciliation algorithm when two recovered workers race to claim the same call (gen-number max-wins covers the common case; specify edge cases when first observed in test)
- HMAC `kid` rotation tooling (partial today, not load-bearing for this design)

## Implementation slices (in dependency order)

**Reordering note**: `PeerFabric.simulated` is built **after** the relay + dual-write to learn from the real implementation. Slices 4-5 ship with mock-based unit tests; multi-peer scenario coverage lands in Slice 6 onward.

### Slice 1 — Cookie format v2 + proxy fallback to `w_bak`
- Modify [LoadBalancer.ts](src/sip-front-proxy/strategies/LoadBalancer.ts):
  - `encodeStickiness` (line 229+): emit `{w_pri, w_bak, v: "2", kid, sig}`. `w_bak` chosen via second-best HRW excluding `w_pri`.
  - `decodeStickiness` (line 250+): parse `w_pri`, `w_bak`. Reject `v != 2` (no production usage of v1 yet).
- Modify proxy routing in [LoadBalancer.ts:349-377](src/sip-front-proxy/strategies/LoadBalancer.ts#L349-L377): on `decode_unknown` (was: HRW fallback) → first try `w_bak` if alive, otherwise current HRW path. New `DecodeResult.forwardBackup(addr)` return variant.
- Modify [ProxyCore.ts:597-613](src/sip-front-proxy/ProxyCore.ts#L597-L613): no-op (cookie payload changes are inside `encodeStickiness`'s return value).
- Tests: `cookie-route-fallback.test.ts` (fake) — extends the existing `sipproxyHA` SUT in [proxyB2bFakeStack.ts](tests/fullcall/framework/proxyB2bFakeStack.ts); unit tests for HRW second-best selection.

### Slice 2 — Storage value extension (`_topology` field)
- Extend Call schema in [CallModel.ts:501-600](src/call/CallModel.ts#L501-L600) with `_topology: { pri: number, bak: number, gen: number }`.
- `gen` increments on every state event flush. On conflict (concurrent writers, e.g. during partition heal), max-gen wins.
- Migration: not needed, no production data.

### Slice 3 — Relay service + peer client (HTTP, no auth, partitioned keyspace)
- New file `src/cache/PeerCachePort.ts` — port interface (already in tree from initial slice-3 work). Surface:
  - `putCall(role, owner, callRef, json, indexes, ttlSec)`
  - `refreshCall(role, owner, callRef, indexes, ttlSec)`
  - `deleteCall(role, owner, callRef, indexes)`
  - `scan(role, owner)` returning `Stream<{callRef, json, ttlSec}, PeerScanError>`
- New `src/cache/PeerRelay.ts` — Effect HTTP route layer (alongside StatusServer pattern at [src/http/StatusServer.ts](src/http/StatusServer.ts)). Routes per D10. Handlers:
  - `PUT /cache/{role}/{owner}/calls/{callRef}` — parse body `{ state, indexes[], ttlSec }`; for each index in the list call `cache.putIndex("{role}:{owner}:idx:" + indexKey, callRef, ttlSec)`; then `cache.putCall("{role}:{owner}:call:" + callRef, state, ttlSec)`. Writes are issued sequentially through the existing `CallStateCache`, no MULTI — per F10 we accept lost-update on mid-write crash.
  - `POST /cache/{role}/{owner}/calls/{callRef}/refresh` — issues `expireCall` on the partitioned call key + `expireIndex` on each named index key.
  - `POST /cache/{role}/{owner}/calls/{callRef}/delete` — issues `deleteCall` + `deleteIndex × N` on partitioned keys.
  - `GET /cache/{role}/{owner}/scan` — chunked-encoded stream. Server walks `SCAN cursor=0 MATCH {role}:{owner}:call:* COUNT={relayScanBatch}`. After each batch, `Effect.yieldNow` so other Redis ops on the local sidecar can interleave (existing `redis.scanKeys` does NOT yield — see [RedisClient.ts:152-168](src/redis/RedisClient.ts#L152-L168)). For each key in the batch, GET its value, emit `{callRef, json, ttlSec}` line. Continue until cursor==0.
- New `src/cache/PeerCacheClient.ts` — `PeerCachePort` impl using `effect/unstable/http` HttpClient. Calls relay endpoints with the (role, owner) URL paths. Configurable per-request timeout (`AppConfig.peerRelayRequestTimeoutMs`, default 2000ms).
- New `src/cache/PeerEndpointResolver.ts` — small Service that maps `WorkerOrdinal → URL`. Production layer reads `AppConfig.peerServiceName`, `AppConfig.peerNamespace`, `AppConfig.peerRelayPort` and builds `http://{ordinal}.{svc}.{ns}.svc.cluster.local:{port}`. Test layer takes a static map.
- **Slice 3 does NOT migrate B2BUA local writes** — existing `call:{callRef}` keys keep working for legacy paths. Relay's keyspace `{role}:{owner}:*` is additive; zero collision with legacy.
- Tests (in-process round-trip via @effect/platform-node test HTTP):
  - `peer-relay-roundtrip.test.ts` — PUT then scan returns the inserted entry; refresh extends TTL; delete removes call + indexes.
  - `peer-relay-scan-yields.test.ts` — assert that during a long scan, concurrent local `putCall` ops complete (no head-of-line blocking).
  - `peer-relay-partition-isolation.test.ts` — assert `pri:A:` and `bak:A:` writes do not interfere; scan of one partition doesn't return entries from the other.

### Slice 4 — Dual-write logic in B2BUA + cutover to partitioned local writes
- **Migrate B2BUA local writes from legacy `call:*` keys to `pri:self:` partition** (or `bak:{cookie.w_pri}:` when serving as recovery worker per D16). Touch [CallState.ts:113-154,224-278](src/call/CallState.ts#L113-L278) — every `cache.putCall` / `cache.putIndex` / `cache.expireCall` / `cache.expireIndex` / `cache.deleteCall` / `cache.deleteIndex` call gets a partition prefix derived from the call's effective `(role, owner)`.
- **Lookup precedence (D15)**: `checkout` and `resolveFromSipKey` paths try `pri:self:` first, then `bak:{cookie.w_pri}:` on miss. Cookie's `w_pri` comes from the request that triggered the lookup (decoded by SipRouter from the Route header) and is threaded through to CallState.
- **Dual-write fan-out**: alongside every local write, fire-and-forget a parallel relay call to the cookie's `w_bak` peer (via `PeerCachePort`). Best-effort — failures are logged + metric'd, NEVER block the local write. Per D3 "throw away" semantics.
- Increment `_topology.gen` on each flush; embed `_topology` (pri, bak, gen) in the JSON so reclaim's gen-comparison and post-mortem diagnostics can see it.
- Tests (use `PeerFabric.simulated` from Slice 5 — Slice 4 ships with mocked `PeerCachePort` for unit-level coverage; full multi-peer scenarios land in Slice 5):
  - `multi-peer-write.test.ts` — local write + remote write both observed
  - `backup-write-fails.test.ts` — remote write fails, local write succeeds, call event proceeds
  - `gen-monotonicity.test.ts` — `_topology.gen` strictly increases per call across flushes
  - `recovery-write-back-to-bak.test.ts` — recovery worker writing for a cookie-pinned call lands in `bak:{w_pri}:`, not `pri:self:` (D16)

### Slice 5 — `PeerFabric.simulated` test infrastructure
**Built now, informed by the real shape from Slices 3-4.** Located at `src/cache/PeerFabric.ts`. Replaces the per-worker isolated `CallStateCache.memoryLayer` in [proxyB2bFakeStack.ts:136](tests/fullcall/framework/proxyB2bFakeStack.ts#L136) with a fabric-backed cache + simulated relay.

**Public interface** (the contract — write this in code as the PR's first concrete artifact):

```typescript
// src/cache/PeerFabric.ts

export type WorkerOrdinal = number

export interface CacheKey {
  readonly store: "calls" | "indexes"
  readonly key: string
}

export interface CacheValue {
  readonly raw: string             // JSON-encoded Call (or index value)
  readonly topology: { pri: WorkerOrdinal; bak: WorkerOrdinal; gen: number }
  readonly expiresAtMs: number
}

export class PeerWriteError extends Schema.TaggedError<PeerWriteError>("PeerWriteError")({
  peer: Schema.Number,
  reason: Schema.Literal("timeout", "connection_refused", "http_error", "auth_failed", "fabric_partitioned"),
}) {}

export class PeerScanError extends Schema.TaggedError<PeerScanError>("PeerScanError")({
  peer: Schema.Number,
  reason: Schema.Literal("timeout", "connection_refused", "stream_aborted"),
}) {}

// Service used by B2BUA application code
export interface PeerFabric {
  readonly self: WorkerOrdinal
  // Local-only ops (always go to own sidecar Redis or its fake)
  readonly getLocal: (key: CacheKey) => Effect.Effect<Option<CacheValue>>
  readonly putLocal: (key: CacheKey, value: CacheValue) => Effect.Effect<void>
  readonly deleteLocal: (key: CacheKey) => Effect.Effect<void>
  // Cross-peer ops (go through relay or simulated fabric wire)
  readonly putRemote: (peer: WorkerOrdinal, key: CacheKey, value: CacheValue) => Effect.Effect<void, PeerWriteError>
  readonly deleteRemote: (peer: WorkerOrdinal, key: CacheKey) => Effect.Effect<void, PeerWriteError>
  readonly scanRemote: (peer: WorkerOrdinal, filter: { role: "primary" | "backup"; worker: WorkerOrdinal }) => Stream.Stream<CacheValue, PeerScanError>
  // K8s-readiness signal (consumed by the kubelet probe handler)
  readonly markReady: (ready: boolean) => Effect.Effect<void>
  readonly currentReady: Effect.Effect<boolean>
}

// Test-only control API (separate Service so production code cannot reach it)
export interface PeerFabricControl {
  // Lifecycle injection — implements the "fake SIGTERM" requirement
  readonly killWorker: (peer: WorkerOrdinal) => Effect.Effect<void>      // hard kill: drops all conns, fake sidecar Redis cleared
  readonly sigtermWorker: (peer: WorkerOrdinal) => Effect.Effect<void>   // graceful: invokes the worker's drain handler (Slice 7), then like killWorker
  readonly rebootWorker: (peer: WorkerOrdinal) => Effect.Effect<void>    // sigterm + boot fresh layer (rerun reclaim)
  // Topology faults
  readonly partition: (a: WorkerOrdinal, b: WorkerOrdinal) => Effect.Effect<void>
  readonly heal: (a: WorkerOrdinal, b: WorkerOrdinal) => Effect.Effect<void>
  // Per-peer fault tuning
  readonly setLatency: (peer: WorkerOrdinal, ms: number) => Effect.Effect<void>
  readonly setErrorRate: (peer: WorkerOrdinal, rate: number) => Effect.Effect<void>     // 0..1, applies to all relay ops to this peer
  readonly setThroughputCap: (peer: WorkerOrdinal, bytesPerSec: number) => Effect.Effect<void>
  // Inspection / assertions
  readonly snapshotPeer: (peer: WorkerOrdinal) => Effect.Effect<PeerSnapshot>
}

export interface PeerSnapshot {
  readonly health: "alive" | "draining" | "dead" | "rebooting"
  readonly ready: boolean
  readonly calls: ReadonlyMap<string, CacheValue>
  readonly indexes: ReadonlyMap<string, CacheValue>
  readonly inboundConnectionCount: number
}

export namespace PeerFabric {
  // Production: localRedisLayer + httpRelayClient
  export const productionLayer: Layer.Layer<PeerFabric, never, RedisClient | HttpClient>
  // Test: in-memory simulation with N fake peers (PeerFabricControl also exposed)
  export const simulated: (workers: ReadonlyArray<WorkerOrdinal>) => Layer.Layer<PeerFabric | PeerFabricControl, never, never>
}
```

- `CallStateCache` is rewritten as a thin adapter over `PeerFabric` (writes go to `putLocal` + `putRemote(bak)`; reads are local).
- Existing single-peer `CallStateCache.memoryLayer` becomes `PeerFabric.simulated([self]).provideMerge(CallStateCache.peerLayer)` — backward-compatible for existing unit tests.
- Wires into [proxyB2bFakeStack.ts:217-301](tests/fullcall/framework/proxyB2bFakeStack.ts#L217-L301) so the existing `sipproxyHA` SUT becomes fabric-backed.
- Implements `InfraStep` in [interpreter.ts:347-355](tests/fullcall/framework/interpreter.ts#L347-L355) by dispatching to `PeerFabricControl`.
- Tests: `multi-peer-write.test.ts`, `backup-write-fails.test.ts`, `peer-fabric-control.test.ts` (asserts that `sigtermWorker` triggers the worker's drain handler).

### Slice 6 — Reclaim-on-startup + K8s readiness gating + DNS-based peer enumeration
- New module: `src/cache/ReclaimRunner.ts`.
- On B2BUA start: K8s readiness probe answers 503 until reclaim completes (via `PeerFabric.markReady(false)` initially).
- Peer enumeration: DNS query against headless StatefulSet service yields only currently-Ready peers. Re-queried every `reclaim.peerRefreshSec` (default 10s) so peers transitioning Ready mid-scan get scanned.
- Reclaim algorithm: parallel-across-peers (`reclaim.peerConcurrency=8`), rate-limited within each peer (`reclaim.scanBatch=50`, `reclaim.scanPacingMs=50`).
- **Two reclaim flows leveraging the partitioned keyspace**:
  - **Flow 1 — Reclaim my primary calls**: ask each peer P → `GET /cache/bak/{self}/scan` → P walks `bak:{self}:call:*` and streams entries (calls where I was primary, P was backup). Copy each into local `pri:{self}:call:*`. Direct prefix scan, zero JSON-read on the peer side.
  - **Flow 2 — Reclaim my backup duties**: harder problem (which peers' `pri:{P}:*` entries have me named as the backup?). Slice 6 ships a defensive implementation: skip reclaiming backup data on startup. Rationale: as soon as primaries resume their dual-write, my `bak:` partition repopulates naturally from new state events. If a primary doesn't write any new state for the full TTL after my restart, the backup data times out — accepted small loss class. A future optimization can add a server-side `bak-of:{worker}` secondary index to make Flow 2 cheap.
- `gen`-comparison on copy-in: skip writes where the local entry already has higher `_topology.gen` (avoid clobbering newer values that the dual-write path may have backfilled mid-reclaim).
- **Hard timeout**: `reclaim.maxDuration` (default 10min). At timeout: log warning, `markReady(true)`, accept that any unrecovered in-dialog requests will be answered with **481 Call/Transaction Does Not Exist** (UAs interpret this as call-ended).
- Tests: `reclaim-on-restart.test.ts`, `reclaim-under-lan-stress.test.ts`, `reclaim-peer-down-mid-scan.test.ts`, `reclaim-timeout-481.test.ts`.

### Slice 7 — Drain protocol on SIGTERM
- Hook into existing shutdown path. On SIGTERM (real or fabric-injected):
  1. Stop accepting new INVITEs (signal proxy via health probe → marks worker `draining`).
  2. Wait for in-flight transactions to settle (bounded by `drain.timeoutSec`, default 30s).
  3. Final flush of every active call to `w_bak` via relay (best-effort).
  4. Exit.
- No complex migration — `w_bak` already has near-current state from the dual-write invariant.
- Tests: `drain-flush.test.ts`, `rolling-upgrade-long-call.test.ts` (uses `step.advanceTime` to fast-forward an 8-hour call across rolling restarts).

### Slice 8 — Self-fencing on partition
- Track timestamp of last successful contact with proxy + last successful contact with `w_bak`.
- If both unreachable for `T_fence` (default 60s = 2 × keepalive of 30s), enter fenced state:
  - Stop processing in-dialog requests
  - Drop in-flight transactions
  - Mark local cache as suspect; on rejoin, drop in-memory state in favor of cluster state.
- Tests: `partition-self-fence.test.ts`.

### Slice 9 — Pod pinning manifests
- Update [tests/k8s/cluster.yaml](tests/k8s/cluster.yaml) and the StatefulSet manifest:
  - Per-ordinal `nodeAffinity: requiredDuringSchedulingIgnoredDuringExecution: b2bua-pin=N`.
  - Each K8s worker node labeled `b2bua-pin=N`.

### Slice 10 — Real-cluster end-to-end test
- New file in [tests/k8s/](tests/k8s/) (live config): one scenario that uses `kubectl drain` / node delete on a worker mid-call and asserts the BYE arrives at backup.
- Gate behind `TEST_TIER=long` (real-clock test).

### Slice 11 — HA documentation (part of implementation, not deferred)
- New file: `docs/HA-resilience.md`.
- Sections required:
  1. **Architecture summary** — sidecar Redis, relay service, cookie format v2, replication factor.
  2. **Failure modes** — paste the surviving-classes + loss-classes tables from this plan, with each entry linking to the corresponding `*.test.ts` proving the behavior.
  3. **Operational constraints** — cluster cold restart loses all state (F8); pod-pinning means K8s node loss = pod Pending until node returns.
  4. **Tunables** — every config value introduced (`replicationFactor`, `T_fence`, `drain.timeoutSec`, all `reclaim.*` values) with rationale.
  5. **Observability** — list of metrics/logs that must be in place (backup-write-failure rate, reclaim duration histogram, fence events, gen-conflict counter).
  6. **Runbook entries** — what to check when calls are dropping, when reclaim is timing out, when gen-conflicts are observed.
- This doc must be updated incrementally as each slice lands; final state asserted complete before merging Slice 11.

## Verification

```bash
# Inner loop after each slice
npm run typecheck    # zero errors, zero warnings (per CLAUDE.md)
npm run test:fake    # all fake-stack scenarios pass

# Pre-merge for resilience-related slices
npm run test:ci      # fake + medium-tier live

# Pre-release for the K8s slice
npm run test:nightly # full live tier including k8s/
```

End-to-end manual verification (after Slice 10):
1. `npm run dev` against the kind cluster scaffolded under [tests/k8s/](tests/k8s/) (`kind create cluster --config tests/k8s/cluster.yaml`).
2. Establish a long call between two synthetic UAs.
3. `kubectl delete pod b2bua-worker-1 --grace-period=0 --force` (mid-call).
4. Send BYE; verify arrival at `b2bua-worker-3` (cookie's `w_bak`) and clean teardown.
5. Bring `b2bua-worker-1` back; verify it stays not-ready until reclaim finishes; verify subsequent new INVITEs land on it correctly.

## Defaults locked in (push back if any are wrong)
- `replicationFactor: 2` (cookie has `w_pri`, `w_bak`)
- `T_fence: 60s` (= 2 × keepalive)
- Drain timeout: 30s
- Reclaim pacing: `scanBatch=50`, `scanPacingMs=50`, `peerConcurrency=8`, `maxDuration=10min`
- Redis sidecar config: `bind 127.0.0.1 ::1`, `client-output-buffer-limit normal 64mb 32mb 60`, `maxmemory-policy noeviction` (writes fail rather than silent eviction), no persistence (`save ""`, `appendonly no`)

## Deferred (HA doc must list, but out of scope for this implementation)
- Pre-200-OK call resilience (mid-establishment) — separate, larger problem; user wants this prioritized over F3 hardening.
- HMAC `kid` rotation tooling — partial today, not load-bearing for this design.
- Cold cluster restart recovery (F8) — fundamental property of ephemeral Redis; out of scope by design.
- Reconciliation algorithm when two recovered workers race to claim the same call — gen-number max-wins covers the common path; specify formal arbitration when first observed.
