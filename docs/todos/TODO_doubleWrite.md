# Plan: Resilient call-context layer for K8s node failure

## Implementation status (as of session 2026-04-27)

**Shipped: Slices 1, 2, 3, 4, 5, 6** — 6 of 11 done. All 776 fake-stack tests pass. Typecheck clean.

| Slice | Commits | Summary |
|-------|---------|---------|
| 1 | `f09f710` (rolled into) | Cookie format v2 (`w_pri`, `w_bak`); proxy `forwardBackup` fallback for dead `w_pri` |
| 2 | `f09f710` | `_topology` schema field on Call (optional `{pri, bak, gen}`) |
| 3 | `f09f710`, plus slice-4 cleanup | `PartitionedRelayStorage` (`{role}:{owner}:` keyspace) + `PeerCachePort` + HTTP relay (`PeerRelay`) + HTTP client (`PeerCacheClient`) + `PeerEndpointResolver` |
| 4 | `e8c6c3e`, `3cc7c99` | callRef encodes primary ordinal (Option C); `CallState` migrated from `CallStateCache` to `PartitionedRelayStorage` with `partitionOf` deriving `(role, primary)` from callRef |
| 5 | `fe952ed`, `8fea919`, `28742c2`, `1383cd4`, `48188ed` | `PeerFabric.simulated` + dual-write fan-out (D3, D16) + `_topology.gen` bump per flush + cookie parsing at INVITE + 4 named tests + `InfraStep`→`PeerFabricControl` |
| 6 | this session | `WorkerReadiness` + `PeerEnumerator` (`staticSet`/`fromFabric`/`headlessStatefulSet`) + `ReclaimRunner` (Flow 1) + `callIndexKeys` extracted to `CallModel.ts` + 6 supporting tests + 4 named reclaim tests |

**Remaining: Slices 7, 8, 9, 10, 11** — see "Implementation slices" section.

## Design decisions added this session
- **D17 — `AppConfig.workerOrdinalLabel`**: new optional config field bridging the integer `workerIndex` to the proxy's string `WorkerId` cookie value. Fallback chain: `workerOrdinalLabel` → `String(workerIndex)` → `"self"`. Production K8s wiring sets this from `HOSTNAME` (StatefulSet pod name). Without this, B2BUA's `selfOrdinal` would not match the cookie's `w_pri` and dual-write/lookup would mismatch.
- **D18 — `PeerFabric.storageLayerOf(ordinal)`**: subagent deviation from the originally-sketched fabric API (which had `getLocal/putLocal/deleteLocal` directly on the fabric). Instead, the fabric exposes a per-peer `Layer<PartitionedRelayStorage>` so each fake worker reuses Slice 4's storage abstraction unchanged. Cleaner layering; same end-to-end semantics.
- **D19 — Stickiness cookie parsing on B2BUA receive path**: `src/cache/StickinessCookie.ts` module parses URI params from inbound Record-Route headers at INVITE time. **No HMAC verification** on the B2BUA side — proxy already validated; B2BUA reads the trusted ordinals only.
- **D20 — InfraStep `partition` deferred**: current scenario DSL `InfraStep` only carries one `target` field. Two-target partition needs a DSL extension; flagged for slice 7/8 where partition scenarios actually matter.
- **D21 — Slice 6 module split (3 services, not 1)**: rather than fold readiness gating + DNS enumeration + reclaim into a single file, slice 6 ships three small services that compose: `WorkerReadiness` (mirrors `DrainingState.Default`'s shape), `PeerEnumerator` (three layers: `staticSet` / `fromFabric` / `headlessStatefulSet`), `ReclaimRunner` (the loop). Keeps each surface unit-testable in isolation and corrects an earlier draft of the plan that wrongly claimed Slice 5's `PeerFabric` already exposed `markReady`/`currentReady` (it does not — fabric `health` is the external view of a peer, distinct from a worker's own readiness).
- **D22 — `callIndexKeys` lives on `CallModel.ts`**: extracted from `CallState` into `CallModel.ts` so `ReclaimRunner` (slice 6) can reuse it when copying entries into local storage on recovery — keeps the index-list shape in lock-step with the write path. Pure over the `Call` shape; safe to call on any decoded snapshot.
- **D23 — Slice 6 single-shot peer enumeration**: ReclaimRunner snapshots `enumerator.currentPeers` once at run start. Periodic re-query during a running reclaim (so peers transitioning Ready mid-scan get picked up) is deferred — the natural insertion point is the `Effect.forEach` loop in `ReclaimRunner.layer`. None of the four named slice-6 tests exercise the dynamic-refresh case.
- **D24 — Reclaim TTL preservation**: when copying an entry into local `pri:{self}:`, `ReclaimRunner` writes with the entry's reported `ttlSec` rather than resetting to a fresh `callContextTtlSec`. Preserves the original expiry; falls back to `callContextTtlSec` only when the peer reports `ttlSec=0` (entry on the verge of expiring) so the recovered worker has time to process the call.

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

Calls live under a `{role}:{owner}:` namespace where:
- `role ∈ {"pri", "bak"}` — whether THIS pod is primary or backup for this entry's call
- `owner` = the cookie's `w_pri` ordinal (the "natural primary" for that call)

Concretely, for a call X with cookie `{w_pri=A, w_bak=B}`:
- On pod A's local Redis: `pri:A:call:{callRef}`
- On pod B's local Redis: `bak:A:call:{callRef}`

**Indexes are flat** (no partition prefix) — `idx:{indexKey}` with value = the call's `callRef`. This pairs with **callRef encoding the primary** (see next section) so the partition path is derivable from the callRef alone, without needing to consult the proxy or scan multiple partitions.

Benefits:
- **Scan trivially partitioned**: `SCAN MATCH bak:A:call:*` filters by role+owner without reading any JSON values.
- **Observability**: `redis-cli --scan --pattern 'pri:*:call:*' | wc -l` answers "calls I am primary for" instantly; per-peer breakdown for "as backup, for whom and how many" is one CLI command.
- **No collisions**: a single sidecar can hold many `(role, owner)` partitions concurrently.
- **Single-lookup receive path**: `idx:{leg} → callRef → derive partition path → read call`. No need for cookie info on the receive path.

### CallRef encodes the natural primary (Option C — chosen during Slice 4 design review)

`deriveCallRef` is changed from `{aLegCallId}|{aLegFromTag}` to **`{primaryOrdinal}|{aLegCallId}|{aLegFromTag}`** so the callRef is self-describing. Any worker holding a callRef can:
1. Parse the primary ordinal (everything before the first `|`).
2. Compare to `self.ordinal` → know whether self is `pri` or `bak`.
3. Build the partition path `{role}:{primary}:call:{callRef}` deterministically.

This eliminates the need for proxy header injection of cookie info on the receive path. The cookie still drives PROXY-side routing (slice 1, D8); it does not need to leak into the B2BUA's request handling.

**`_topology.bak`** inside the JSON value carries the cookie's `w_bak` so the dual-write fan-out path (Slice 4) knows where to send the remote write.

### Lookup precedence on B2BUA in-dialog receive path

When a worker receives an in-dialog request and must look up the call state:
1. Build `legKey = "leg:{Call-ID}|{From-tag}"` from the request.
2. Read local `idx:{legKey}` → returns `callRef` (or null on cold miss).
3. Parse `primary` out of callRef (segment before first `|`).
4. Determine `role`: `primary === self.ordinal ? "pri" : "bak"`.
5. Read `{role}:{primary}:call:{callRef}` → JSON state.
6. Miss → return 481 (after reclaim is complete) or 503-temp (during reclaim).

The receive path is **fully self-describing** — no cookie info or proxy headers needed beyond what slice 1 already provides at the proxy.

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
- **D15 — Receive-path lookup precedence (Option C — callRef encodes primary)**: callRef format is `{primaryOrdinal}|{aLegCallId}|{aLegFromTag}`. Lookup is `idx:{legKey} → callRef → parse primary → role = (primary == self) ? "pri" : "bak" → read {role}:{primary}:call:{callRef}`. Single index lookup, single call read, no proxy headers, no cookie info needed on receive path.
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

**Slices 1-5 shipped**; Slices 6-11 remain. The dual-write work originally planned for Slice 4 phase 3 was folded into Slice 5 because the four named dual-write tests (`multi-peer-write`, `backup-write-fails`, `gen-monotonicity`, `recovery-write-back-to-bak`) need `PeerFabric.simulated` to exist — combining avoids the chicken-and-egg.

### Slice 1 — Cookie format v2 + proxy fallback to `w_bak` ✅ SHIPPED (`f09f710`)
- [LoadBalancer.ts](src/sip-front-proxy/strategies/LoadBalancer.ts):
  - `encodeStickiness` emits `{w_pri, w_bak, v: "2", kid, sig}`. `w_bak` chosen via second-best HRW excluding `w_pri`.
  - `decodeStickiness` parses both ordinals. Rejects `v != "2"`.
  - On dead/draining-post-grace `w_pri`, internal `tryBackup(wBakRaw)` returns `DecodeResult.forwardBackup(backupAddr)` if `w_bak` resolves to an alive entry.
- [RoutingStrategy.ts](src/sip-front-proxy/RoutingStrategy.ts) — added `DecodeResult.forwardBackup` variant.
- [ProxyCore.ts](src/sip-front-proxy/ProxyCore.ts) — handles `forwardBackup` like `forward` but counts a distinct `decode_forward_backup` decision class.
- [Metrics.ts](src/sip-front-proxy/observability/Metrics.ts) — new `decode_forward_backup` decision kind.
- Tests shipped: [cookie-route-fallback.test.ts](tests/sip-front-proxy/load-balancer/cookie-route-fallback.test.ts) — 2 tests (D8 verification + ACK exemption per RFC 3261 §13.2.2.4); [hmac-tampering-rejected.test.ts](tests/sip-front-proxy/load-balancer/hmac-tampering-rejected.test.ts), [route-set-propagation.ts](tests/scenarios/route-set-propagation.ts), [happy-call.test.ts](tests/sip-front-proxy/transparency/happy-call.test.ts) — updated for v2 cookie shape.

### Slice 2 — Storage value extension (`_topology` field) ✅ SHIPPED (`f09f710`)
- [CallModel.ts](src/call/CallModel.ts) — added `CallTopology = Schema.Struct({ pri: Schema.String, bak: Schema.String, gen: Schema.Int })` and optional `_topology` field on `Call`.
- `pri`/`bak` use `Schema.String` (matches `WorkerId` opaque-string brand), not `Schema.Number` as the original sketch suggested — keeps the cookie's worker-ordinal type space consistent across the codebase.
- Slice 5 phase A (commit `fe952ed`) wires the gen-bump-per-flush logic.

### Slice 3 — Relay service + peer client (HTTP, no auth, partitioned keyspace) ✅ SHIPPED (`f09f710`, flat-index cleanup in `e8c6c3e`)

**Modules shipped:**
- [PartitionedRelayStorage.ts](src/cache/PartitionedRelayStorage.ts) — service with `redisLayer` + `memoryLayer`. Surface: `getCall`, `getIndex`, `putCall`, `refreshCall`, `deleteCall`, `scanCalls`. `redisLayer` uses cursor-walked SCAN with `Effect.yieldNow` between batches (existing `redis.scanKeys` does NOT yield — see [RedisClient.ts:152-168](src/redis/RedisClient.ts#L152-L168)). `memoryLayer` mirrors semantics deterministically under TestClock.
- [PeerCachePort.ts](src/cache/PeerCachePort.ts) — abstract contract: `putCall({peer, role, owner, callRef, state, indexes, ttlSec})`, `refreshCall(...)`, `deleteCall(...)`, `scan({peer, role, owner})` returning `Stream<ScanEntry, PeerScanError>`.
- [PeerRelay.ts](src/cache/PeerRelay.ts) — HTTP routes:
  - `PUT /cache/:role/:owner/calls/:callRef` body `{state, indexes[], ttlSec}` → `storage.putCall`
  - `POST /cache/:role/:owner/calls/:callRef/refresh` body `{indexes[], ttlSec}` → `storage.refreshCall`
  - `POST /cache/:role/:owner/calls/:callRef/delete` body `{indexes[]}` → `storage.deleteCall`
  - `GET /cache/:role/:owner/scan` → `Stream.runCollect(storage.scanCalls)` rendered as `{items: [...]}`
- [PeerCacheClient.ts](src/cache/PeerCacheClient.ts) — HTTP client implementing `PeerCachePort` via `effect/unstable/http` `HttpClient`. Maps `HttpClientError.reason._tag` to `PeerWriteError`/`PeerScanError` reason classes.
- [PeerEndpointResolver.ts](src/cache/PeerEndpointResolver.ts) — `WorkerOrdinal → URL`. `headlessStatefulSet({serviceName, namespace, relayPort, clusterSuffix?})` for production, `staticMap(Map)` for tests.

**Key design property**: indexes are **flat** (`idx:{key} → callRef`), NOT partitioned. The callRef value itself encodes the primary ordinal (D15 / Option C, finalized in Slice 4 phase 1). A reader picks up the callRef from a flat index hop and derives `(role, primary)` deterministically — single index hop, single call read, no proxy headers.

**Storage key namespaces** (no collision):
- `pri:{ordinal}:call:{callRef}` — primary partition
- `bak:{ordinal}:call:{callRef}` — backup partition
- `idx:{indexKey}` — flat index, value = callRef

**Tests shipped:**
- [partitioned-relay-storage.test.ts](tests/cache/partitioned-relay-storage.test.ts) — 7 tests: round-trip, partition isolation, owner isolation, delete, TTL expiry, refresh-extends-or-no-op, multi-entry scan
- [peer-relay-roundtrip.test.ts](tests/cache/peer-relay-roundtrip.test.ts) — 2 real-HTTP tests against a Node http server on ephemeral port (PUT+scan and refresh+delete)

### Slice 4 — Partition-aware lookup (callRef + CallState migration) ✅ SHIPPED (phases 1+2)

**Phase 1** — `e8c6c3e` — callRef encodes primary, flat indexes:
- `deriveCallRef(primaryOrdinal, callId, fromTag)` returns `{primary}|{callId}|{fromTag}`.
- `parseCallRef(ref)` splits into `{primary, callId, fromTag}` or returns `null` for malformed/legacy two-segment refs.
- [SipRouter.ts](src/sip/SipRouter.ts) feeds `String(workerIndex)` (or `"self"` when unset) at INVITE time.
- `PartitionedRelayStorage.indexKey` simplified from `{role}:{owner}:idx:{key}` to flat `idx:{key}`.

**Phase 2** — `3cc7c99` — CallState fully migrated:
- `CallState.layer` swapped from `CallStateCache` to `PartitionedRelayStorage`.
- New `partitionOf(callRef)` helper: parses callRef, sets `role = primary === selfOrdinal ? "pri" : "bak"`, returns `{role, primary}`.
- New `callIndexKeys(call)` helper: collapses what was `writeCacheIndexes` / `refreshIndexTtl` into a single index-key array.
- All 6 cache ops (`putCall`/`putIndex`/`expireCall`/`expireIndex`/`deleteCall`/`deleteIndex`) collapse to 3 storage ops (`putCall(role, primary, callRef, json, indexes, ttl)` / `refreshCall(...)` / `deleteCall(...)`).
- `loadOwnedCalls` now calls `storage.scanCalls("pri", selfOrdinal)` — partition prefix already enforces "owned by self", so the redundant `decoded.workerIndex !== workerIndex` filter is gone.
- `StorageError → RedisError` wrapper preserves `CallState`'s declared error type for downstream `Effect.catchTag("RedisError", ...)` consumers.
- Test fixtures ([networkLeaves.ts](tests/support/networkLeaves.ts), [liveStack.ts](tests/support/liveStack.ts), [cache-and-limiter.test.ts](tests/support/cache-and-limiter.test.ts)) and [main.ts](src/main.ts) swap to `PartitionedRelayStorage`. All 746 fake tests pass.

**Phase 3 work folded into Slice 5** (dual-write fan-out, gen-bump, cookie parsing, named tests).

### Slice 5 — `PeerFabric.simulated` + dual-write fan-out + cookie parsing ✅ SHIPPED (5 phases)

Combined the originally-deferred Slice 4 phase 3 (dual-write, gen-bump, cookie parsing, 4 named tests) with the fabric infrastructure to break the chicken-and-egg dependency.

**Phase A** — `fe952ed` — Cookie parse + `_topology` populate + gen bump:
- New [`StickinessCookie.ts`](src/cache/StickinessCookie.ts) — parses `w_pri`/`w_bak` URI params from the inbound INVITE's Record-Route header. **No HMAC verify** on the B2BUA side (proxy already validated; B2BUA reads trusted ordinals only — D19).
- [`SipRouter.ts`](src/sip/SipRouter.ts) at INVITE time: reads cookie, sets `Call._topology = { pri, bak, gen: 0 }`. Falls back to `(self, "")` when no cookie present (single-worker / dev / direct UA→B2BUA).
- [`CallState.flushToRedis`](src/call/CallState.ts) increments `_topology.gen` BEFORE encoding JSON, so the persisted value carries the bumped gen. Same in `flushAllCalls`.

**Phase B** — `8fea919` — `PeerFabric.simulated` + `PeerCachePort` fabric impl:
- New [`PeerFabric.ts`](src/cache/PeerFabric.ts) — fabric service modeling N fake peers. Each peer gets its own `MutableHashMap` "fake sidecar Redis".
- [`PartitionedRelayStorage.ts`](src/cache/PartitionedRelayStorage.ts) refactored to expose `makeMemoryApi()` factory — both the existing `memoryLayer` and the fabric reuse this so semantics stay identical.
- **Subagent deviation from the plan's sketched interface (D18)**: instead of `getLocal/putLocal/deleteLocal` on the fabric directly, the fabric exposes `storageLayerOf(ordinal): Layer<PartitionedRelayStorage>` for each peer. Cleaner reuse of Slice 4's storage abstraction.
- `PeerFabric.simulatedBuilt` companion exposes the unboxed handle so multi-worker SUTs get fabric API at layer-construction time (before `Effect.run`).
- 6 fabric smoke tests.

**Phase C** — `28742c2` — Fabric wired into `sipproxyHA` SUT:
- [`proxyB2bFakeStack.ts`](tests/support/proxyB2bFakeStack.ts) `sipproxyHA` SUT — each of the two workers wired to a fabric peer slot via `storageLayerOf`. Per-worker `b2buaWorkerStackLayer` now accepts an optional `storageLayer` override (defaults to `PartitionedRelayStorage.memoryLayer` for single-worker tests; multi-peer SUTs pass the fabric's per-peer layer).
- New `AppConfig.workerOrdinalLabel` (D17) bridges integer `workerIndex` to the proxy's string `WorkerId` so `selfOrdinal` matches the cookie. Fallback chain `workerOrdinalLabel` → `String(workerIndex)` → `"self"`.

**Phase D** — `1383cd4` — Dual-write fan-out + the 4 named tests:
- [`CallState.ts`](src/call/CallState.ts): `PeerCachePort` consumed via `Effect.serviceOption` (optional dep). New helpers: `backupTarget(call)` (returns `Some` only when `_topology.bak` is set, non-empty, and not equal to self), `fanOutPut(call)`, `fanOutDelete(call)`. Fan-out is fire-and-forget after every successful local write — failures logged + metric'd, NEVER block the local op (D3 throw-away).
- D16 write-back semantics: when self ≠ primary (recovery worker), writes stay in `bak:{primary}:` partition, NOT `pri:self:`. Driven purely by `partitionOf` parsing the callRef.
- Tests shipped: `multi-peer-write.test.ts`, `backup-write-fails.test.ts`, `gen-monotonicity.test.ts`, `recovery-write-back-to-bak.test.ts`.

**Phase E** — `48188ed` — `InfraStep` → `PeerFabricControl`:
- [`interpreter.ts`](tests/fullcall/framework/interpreter.ts) `InfraStep` `crash`/`restart` cases now dispatch to `PeerFabricControl.killWorker` / `rebootWorker`.
- `partition` deferred (D20) — current single-target `InfraStep` shape can't carry two ordinals; DSL extension needed when partition scenarios actually land in slice 7/8.


### Slice 6 — Reclaim-on-startup + K8s readiness gating + DNS-based peer enumeration ✅ SHIPPED (this session)

**Modules shipped:**
- [WorkerReadiness.ts](../../src/cache/WorkerReadiness.ts) — `MutableRef<boolean>`-backed service mirroring `DrainingState.Default`'s shape. Defaults to `false` (D9). API: `currentReady` / `markReady`. Two layers: `Default` (production initial-false) and `test(initialReady?)` (tests can pre-flip for happy-path scenarios).
- [PeerEnumerator.ts](../../src/cache/PeerEnumerator.ts) — `currentPeers: Effect<ReadonlyArray<WorkerOrdinal>>`. Three layers:
  - `headlessStatefulSet({serviceName, namespace, portName, clusterSuffix?, refreshIntervalMs?, self?})` — production. Lazy-imports `node:dns/promises`, polls `resolveSrv("_${portName}._tcp.${serviceName}.${namespace}.${suffix}")` every `refreshIntervalMs` (default 10s), extracts the first DNS label of each SRV target as the pod ordinal. `ENOTFOUND`/`NXDOMAIN` resets the cached set; other DNS errors keep the prior snapshot and log a warning. Filters `self` if provided. Background fiber forked into the layer scope (`Layer.effect` → `Effect.forkScoped`).
  - `staticSet(peers)` — fixed list captured at build time. For unit tests.
  - `fromFabric(handle, self?)` — derives the live set from a `PeerFabric.simulatedBuilt` handle. Includes peers whose `health ∈ {alive, draining}`; excludes `dead`/`rebooting` (the latter matches K8s "not-Ready while reclaim runs" — D9). Filters `self` if provided.
- [ReclaimRunner.ts](../../src/cache/ReclaimRunner.ts) — the main loop. `run: Effect<ReclaimResult>` with `{recoveredCalls, skippedByGen, peersScanned, peersFailed, timedOut, durationMs}`. Algorithm:
  1. `markReady(false)`, snapshot start time.
  2. `enumerator.currentPeers` → filter out self → `Effect.forEach(peers, reclaimPeer, {concurrency: peerConcurrency, discard: true})` racing against `Effect.timeoutOption(maxDuration)`.
  3. Each `reclaimPeer` runs `Stream.runForEach` over `port.scan({peer, role: "bak", owner: self})`, decoding each entry, comparing `_topology.gen` against the local `pri:{self}:` entry (skip on equal-or-newer-local per D7), and writing recovered entries via `storage.putCall("pri", self, callRef, json, callIndexKeys, writeTtl)` so call + flat indexes both land. `writeTtl` preserves the peer's `entry.ttlSec` (D24); falls back to `callContextTtlSec` when `ttlSec=0`.
  4. Pacing: `Effect.yieldNow` + `Effect.sleep(scanPacingMs)` between entries.
  5. `markReady(true)` — even on timeout (D14). Errors per-peer (PeerScanError) increment `peersFailed` rather than aborting the whole run.
- [CallModel.ts:callIndexKeys](../../src/call/CallModel.ts) — extracted from `CallState` so ReclaimRunner can reuse it (D22).

**Tests shipped (20 new tests, total 756 → 776):**
- [worker-readiness.test.ts](../../tests/cache/worker-readiness.test.ts) — 4 tests (default not-ready, mark transitions, idempotency, test-layer override).
- [peer-enumerator.test.ts](../../tests/cache/peer-enumerator.test.ts) — 7 tests (`staticSet` round-trip + capture-at-build-time, `fromFabric` with/without self filter, kill drops then reboot restores, dead/rebooting excluded, draining included).
- [reclaim-on-restart.test.ts](../../tests/cache/reclaim-on-restart.test.ts) — 3 tests (single-entry recovery + index landing + readiness flip; `_topology.gen` skip; no-peers no-op).
- [reclaim-under-lan-stress.test.ts](../../tests/cache/reclaim-under-lan-stress.test.ts) — 2 tests (per-peer dispatch latency under TestClock; `scanPacingMs` advances virtual time).
- [reclaim-peer-down-mid-scan.test.ts](../../tests/cache/reclaim-peer-down-mid-scan.test.ts) — 2 tests (dead peer counted as `peersFailed`, healthy peers still recover; `errorRate=1` peer same outcome).
- [reclaim-timeout-481.test.ts](../../tests/cache/reclaim-timeout-481.test.ts) — 2 tests (`maxDuration` fires → `timedOut=true` + ready flipped + no recovery; `CallState.checkout` falls through to undefined for an unrecovered call — the existing 481 path).

**Out of scope, still deferred to later slices:**
- Production HTTP `/ready` endpoint wiring (StatusServer must AND `WorkerReadiness.currentReady` with `!DrainingState.isDraining`) — lands with Slice 9 alongside the StatefulSet manifest.
- StatefulSet port-naming requirement for SRV records — flag in Slice 9 task list.
- Periodic peer-refresh during a running reclaim (D23).
- Flow 2 (reclaim my backup duties) — relies on the dual-write path repopulating `bak:` partitions naturally; accepted small TTL-window loss class.

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
