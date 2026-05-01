# Management of K8s reliability tests — fake-clock failover harness

## Progress tracking (multi-session)

This work spans multiple sessions. Update this section when finishing a slice or when a session ends mid-slice.

| Slice | Status | Notes |
|-------|--------|-------|
| Slice 0 — Documentation + invariant audit | ✅ **Complete (2026-05-01)** | §0 Single-owner invariant landed in [docs/replication/call-cache-backup.md](../replication/call-cache-backup.md); existing §10.2/10.3/§4/§8.5/§11/§L9 prose tightened; comment audit done in [LoadBalancer.ts](../../src/sip-front-proxy/strategies/LoadBalancer.ts), [ReclaimRunner.ts](../../src/cache/ReclaimRunner.ts), [ReplLog.ts](../../src/replication/ReplLog.ts), [ReadyGate.ts](../../src/replication/ReadyGate.ts) (`Replaces ReclaimRunner` claim corrected — they coexist). `npm run typecheck` clean. No code behaviour changed. |
| Slice 1.1 — Random Effect service | ✅ **Complete (2026-05-01)** | `MessageHelpers` `newTag`/`newBranch`/`newCallId` and `CallModel.randomInitialCSeq` now read from the current fiber's Effect `Random` reference via a shared `currentRng()` helper backed by `Fiber.getCurrent`. Sync signatures preserved — no caller refactors needed. Production keeps the default Math.random-backed RNG; tests pin a deterministic stream by wrapping the program with `Random.withSeed(seed)`. `jitteredRetryAfter` left sync (overload-protection path, OOS per slice 1 scope). New unit suite [tests/sip/MessageHelpers-random.test.ts](../../tests/sip/MessageHelpers-random.test.ts) (6 tests) asserts same-seed reproducibility, different-seed divergence, value-range invariants, and the bare-fiber Math.random fallback. Per-worker seed wiring deferred to slice 3's multi-worker harness. `npm run typecheck` clean; `npm run test:fake` 850/850 passing. |
| Slice 1.2 — FakeHttpFabric | ✅ **Complete (2026-05-01)** | New [tests/support/FakeHttpFabric.ts](../../tests/support/FakeHttpFabric.ts) — single `FakeHttpFabric` service exposes `register(host, port, router)` (scope-aware finalizer), `lookup(host, port)`, and an internal `executeRequest` used by the sibling `FakeHttpClientLayer` to satisfy `HttpClient.HttpClient`. Round-trip path: HttpClientRequest → `HttpServerRequest.fromClientRequest` → `router.asHttpEffect()` (with provisioned HttpServerRequest + per-request Closeable Scope) → `HttpServerResponse.toClientResponse`. Per-request scopes are leaked so streaming response bodies (ReplLog NDJSON long-poll) outlive `execute()`; the fabric's layer-scope finalizer closes them at test teardown. URL hostname lowercased (matches WHATWG URL parsing) so register/lookup are case-insensitive. Connectivity-gate consultation deferred to slice 1.3. New [tests/support/FakeHttpFabric.test.ts](../../tests/support/FakeHttpFabric.test.ts) (6 tests): GET / POST round-trip with JSON body, unknown-host TransportError, scope-close auto-deregister, re-register override, and a real `ReplLog` behind the fabric verifying hello + caught_up + 2 heartbeat frames pipe through `resp.stream` under TestClock. `npm run typecheck` clean; `npm run test:fake` 856/856 passing. |
| Slice 1.3 — SignalingNetwork connectivity gate | ✅ **Complete (2026-05-01)** | Two-tier design: minimal [src/sip/ConnectivityGate.ts](../../src/sip/ConnectivityGate.ts) — `ServiceMap.Reference<ConnectivityGateApi>` with `canDeliver(src, dst): boolean` and a default always-allow value, so all existing tests stay green without explicit wiring; rich [tests/support/WorkerConnectivity.ts](../../tests/support/WorkerConnectivity.ts) — service exposing `bind` (scope-aware, returns `Effect<void, never, Scope>`), `disconnect` / `reconnect` (per-worker outbound/inbound flag flips), `partition({from, to, direction})` / `heal`, and `resolveAddress`. The `WorkerConnectivityLayer` provides both the rich service AND the `ConnectivityGate` Reference value backed by the same closure state via `Layer.unwrap` + `Layer.mergeAll`. [src/sip/SignalingNetwork.ts](../../src/sip/SignalingNetwork.ts) `simulated()` reads the gate at deliver time via `Fiber.getCurrent().getRef(ConnectivityGate)` and drops with a `Debug` log when blocked (no undeliverable record — distinct from "no endpoint bound"). [tests/support/FakeHttpFabric.ts](../../tests/support/FakeHttpFabric.ts) does the same; gate denial surfaces as `HttpClientError(TransportError)` (mirrors connection-refused on a partitioned link). New `fakeHttpClientLayerForSelf({ip, port})` builds a per-worker HttpClient that reports its own address as the gate's `src` so partition rules in both directions apply; the existing anonymous `FakeHttpClientLayer` only triggers dst-side gating. New [tests/support/WorkerConnectivity.test.ts](../../tests/support/WorkerConnectivity.test.ts) (10 tests): UDP — default-allow, disconnect-recipient, disconnect-sender (outbound flag), asymmetric A→B partition with B→A still flowing, `reconnect` doesn't clear partitions but `heal` does, scope-close auto-unbinds and falls back to default-allow; HTTP — same matrix using `httpStackForSelf` for the partition direction case. `npm run typecheck` clean; `npm run test:fake` 866/866 passing. |
| Slice 2 — Call context API redesign | ✅ **Complete (2026-05-01)** | Slice landed as a focused direction-tag rework, not the full API refactor the plan originally described — slices 4/5/6 had already implemented the partition-routing goal via callRef encoding (`parseCallRef` + `partitionOf` in [CallState.ts](../../src/call/CallState.ts:119-130)), so the remaining work was the reverse-propagate channel: tagging propagate entries with direction so the receiver routes the apply correctly. New [src/cache/PartitionRef.ts](../../src/cache/PartitionRef.ts) formalises the `{wPri, wBak, self}` bundle (`roleOf`, `ownerOf`, `replicaPeerOf`, `directionOf`) for future call-site use. [AtomicWriter.ts](../../src/replication/AtomicWriter.ts) gains `PropagateDirection` and `PeerWriteOptions.direction`; the propagate-set member becomes `f:{callRef}` / `r:{callRef}` (compaction preserved per (direction, callRef)); Lua `PUT/REFRESH/DELETE_WITH_PEER` accept a 5th/4th/3rd ARGV with the encoded member; the in-memory mirror does the same. [WriteNotifier.ts](../../src/replication/WriteNotifier.ts) `WriteNotification` carries `direction`. [PartitionedRelayStorage.ts](../../src/cache/PartitionedRelayStorage.ts) `PartitionedRelayWriteOptions` adds `direction` (pass-through). [PropagateStream.ts](../../src/replication/PropagateStream.ts) decodes the member prefix and surfaces `direction` on `PropagateEntry`. [ReplLog.ts](../../src/replication/ReplLog.ts) adds `direction` to the entry frame and branches the body lookup: forward → `pri:{ownerOrdinal}`, reverse → `bak:{caller}` (the consumer is the original primary; the local worker holds its authoritative state in the bak partition while it was unreachable). [ReplPuller.ts](../../src/replication/ReplPuller.ts) takes a new `selfOrdinal` arg (memory factory + redis layer reads it from `AppConfig` with the same precedence as CallState) and branches the apply target: forward → `bak:{peer}:` (existing); reverse → `pri:{self}:` so a returning primary recovers state the peer wrote while serving as backup-on-its-behalf — single-owner invariant (spec §0) preserved, the backup never moves the call into its own pri:. [CallState.ts](../../src/call/CallState.ts) `flushToRedis`/`remove`/`flushAllCalls` derive `direction = role === "pri" ? "forward" : "reverse"` and pass it through. Test updates: [propagate-compaction.test.ts](../../tests/replication/propagate-compaction.test.ts) — assertions updated for the new `f:`/`r:` member encoding plus 2 new tests covering forward+reverse coexistence and PropagateStream direction surfacing; [repl-puller.test.ts](../../tests/replication/repl-puller.test.ts) — 2 new tests covering reverse-direction apply lands in `pri:{self}:` and forward+reverse from the same peer route to different partitions. [main.ts](../../src/main.ts) wires `AppConfigLayer` into `ReplPullerLayer` (new redis-layer dep). Out-of-scope deferrals (still appropriate for slice 3+): SipRouter cookie extraction at event ingress (existing callRef-encoding path satisfies the routing requirement); explicit Call.wPri/wBak fields (Call._topology already serves the same purpose); ReclaimRunner rename. `npm run typecheck` clean; `npm run test:fake` 870/870 passing (+4 new, baseline was 866). The 4 pre-existing live-test failures on `main` are unchanged. |
| Slice 3 — Failover harness + first test | Not started | New `tests/support/SimulatedK8sCluster.ts`; new `tests/support/k8sFakeStack.ts`; DSL extensions in [tests/fullcall/framework/](../../tests/fullcall/framework/); first test `tests/sip-front-proxy/failover/basic-call-primary-killed.test.ts`. |

**Resuming a session:** read this table, pick the next "Not started" slice, mark it `In progress (started YYYY-MM-DD)` while working, mark it `Complete (YYYY-MM-DD)` when done with a one-line summary. If a slice gets paused mid-flight, leave it as `In progress` with a brief note on where it stands.

---

## Context

The current k8s reliability/failover suite ([tests/k8s/](tests/k8s/), 7 failover scenarios) runs against a real `kind` cluster with sipp generating load. It is the only place in the test stack that exercises real K8s pod lifecycle, real Redis sidecars, real UDP, and the proxy/HTTP replication transport end-to-end. It has caught bugs that no simulation would have surfaced — kube-proxy conntrack pinning ([commit e6e8a47](https://github.com/_/_/commit/e6e8a47)), sipp scheduling latency, statefulset recovery timing, real Redis tombstone behaviour.

It is also unreliable and slow. `proxy-drain.test.ts` fails ~40% of runs; the full suite takes ~5 min sequentially because the kind cluster forces real wall-clock waits (sipp ramp, OPTIONS detection windows, statefulset recovery, kube-proxy settlement). Reproducing a flake is hard because nondeterministic call/branch IDs, jitter on RFC 3261 retransmit timers, and real clock variance all conspire against bisection.

**Goal:** A new TestClock-driven failover harness that hosts hand-crafted scenarios (alice→bob with primary kill, re-INVITE during failover, partition, multiple successive failovers, etc.) deterministically and quickly. The kind suite stays as the smoke gate — bugs found there get reproduced in the fake harness as regression tests; we do **not** chase 1:1 parity with real k8s in the simulation. New failover scenarios are authored against the fake harness first.

**Critical design point surfaced during planning:** the existing replication model has had repeated bugs precisely because the "backup serves traffic" path was thought of as "backup gets promoted." It is not. **A backup never promotes.** The first slice of this rework is documentation that ratifies the single-owner invariant, before any code lands.

## Single-owner invariant (load-bearing — read first)

A call's primary owner is fixed at INVITE time, encoded into the proxy's `w_pri` cookie ordinal, HMAC-signed, and **immutable for the call's lifetime**. The cookie's `w_bak` ordinal names the backup peer. These two ordinals travel with the call on every in-dialog SIP message regardless of which worker physically processes the message, because re-stamping them would invalidate the MAC (verified at [LoadBalancer.ts:108-133](src/sip-front-proxy/strategies/LoadBalancer.ts#L108-L133)).

When the primary is dead and the proxy `decode_forward_backup`s a request to the backup:

- The backup looks up the call in `bak:{w_pri}:` (its backup partition keyed by the original primary's ordinal).
- It processes the request **as backup** — same logic, no behaviour branch other than logs/metrics carrying a `role=backup` tag.
- Updates the backup makes go **back into `bak:{w_pri}:`**, never into the backup's own `pri:{self}:`. The backup also enqueues a reverse-propagate entry so the original primary, on reboot, can recover the latest state.
- The backup **NEVER** moves the call into its own `pri:`. There is always exactly one primary per call.

When the original primary reboots:

- ReadyGate drains both directions: peers' forward `propagate:{self}` (so primary's `bak:{peer}:` rebuilds — existing flow) AND peers' new reverse-propagate stream (so primary's own `pri:{self}:` rebuilds with whatever updates the backup wrote during the outage).
- Once drained, primary resumes serving its calls from `pri:{self}:` with the latest state.

Stable single-owner semantics make recovery deterministic: the primary always knows where its calls live, no two workers ever simultaneously claim ownership, no merge-conflict logic is needed.

## Slice 0 — Documentation and invariant audit (lands first, no code)

**Deliverable:** [docs/replication/call-cache-backup.md](docs/replication/call-cache-backup.md) updated to ratify the single-owner invariant in normative language, plus an audit pass that fixes invariant-violating phrasing in inline comments and code names.

**Tasks:**

1. Add a leading section to [docs/replication/call-cache-backup.md](docs/replication/call-cache-backup.md) titled "Single-owner invariant" with the text from the section above (verbatim or near-verbatim). State explicitly: backup never promotes; reverse-propagate is the recovery channel; all role decisions derive from the immutable cookie ordinals.
2. Search the codebase for invariant-violating language and rewrite. Targets to audit:
   - [src/sip-front-proxy/strategies/LoadBalancer.ts](src/sip-front-proxy/strategies/LoadBalancer.ts) — comments around `decode_forward_backup` use words like "the survivor holds the bak: copy and can take over" — rephrase as "the backup serves the request from `bak:{w_pri}:`" without "take over."
   - [src/cache/ReclaimRunner.ts](src/cache/ReclaimRunner.ts) — naming. "Reclaim" implies appropriation; the actual behaviour is "scan and forward to legitimate primary on cookie mismatch." Either rename or document the intent precisely.
   - [src/replication/ReplLog.ts:148-153](src/replication/ReplLog.ts#L148-L153) — comments referencing "cross-takeover case." Rewrite as reverse-propagate semantics.
   - [src/replication/ReadyGate.ts](src/replication/ReadyGate.ts) — header docstring. Today documents only the forward-drain direction; add the reverse-drain direction (consumed by primary on reboot to recover its own pri:).
3. Create [docs/plan/decode-forward-respawn-bye-481-fix.md](docs/plan/decode-forward-respawn-bye-481-fix.md)-style design memo for this rework if any open architectural questions remain after the doc update — otherwise not required.

**Verification:** Doc PR reviewed and merged. No code touched. Reviewers must sign off that the invariant statement matches their mental model of the system before slice 2 begins.

## Slice 1 — Plumbing (independent, reusable)

Three pieces of infrastructure useful beyond failover testing. None depends on the others; can land in any order or in one PR.

### 1.1 `Random` Effect service for SIP-relevant nondeterminism

**Files modified:**
- [src/sip/MessageHelpers.ts](src/sip/MessageHelpers.ts) — replace `Math.random()` in branch generation, tag generation, and Timer jitter (RFC 3261 §17.1.2) with `yield* Random.next()` / `yield* Random.nextInt`.
- [src/call/CallModel.ts:42](src/call/CallModel.ts#L42) — `randomInitialCSeq()` uses `Random.nextIntBetween(1, 2000)`.
- Production wires `Random.live` (default).
- Test stacks wire a per-worker `Random.seeded((testSeed << 8) ^ workerOrdinal)` so each B2B has its own deterministic stream and a single test seed reproduces the run bit-exact.

**Out of scope for slice 1:** OverloadController and Tracing's `Math.random()` calls. They have separate test strategies and aren't on the failover path.

**Verification:** Existing tests still pass. New unit test asserts that under a fixed seed, branch/tag/CSeq sequences are reproducible across two `Random.seeded` runs. Type-check + Effect plugin clean.

### 1.2 `FakeHttpFabric` — in-memory `HttpClient`/`HttpServer` Tag fakes

**Why:** Production replication uses Effect's `effect/unstable/http` Tags — `HttpClient.HttpClient` (consumed by [ReadyGate.ts:34-35](src/replication/ReadyGate.ts#L34-L35), [PeerCacheClient.ts:16-18](src/cache/PeerCacheClient.ts#L16-L18)) and `HttpServerRequest`/`HttpServerResponse`/`HttpRouter` (consumed by [ReplLog.ts:41-42](src/replication/ReplLog.ts#L41-L42), [PeerRelay.ts:24-25](src/cache/PeerRelay.ts#L24-L25)). Both sides are already pluggable. A test fabric that satisfies these Tags lets ReplPuller's long-poll loop, heartbeat, retries, and ReadyGate's drain run **unchanged** under TestClock — they live above the transport. We do **not** fake TCP framing inside `SignalingNetwork`.

**Files added:**
- `tests/support/FakeHttpFabric.ts` — service holding a `Map<host:port, HttpRouter>` registry. Exposes:
  - `register(host, port, router): Effect<void, never, Scope>` — finalizer-aware: scope close removes the route. (Per Q2 each worker's HttpRouter is registered in the worker's scope so kill auto-deregisters.)
  - `httpClientLayer: Layer<HttpClient.HttpClient>` — fake client. `execute(request)` parses the URL, looks up the route, invokes the handler, and returns `HttpClientResponse` with a streaming body that pipes the handler's `HttpServerResponse.stream` body back. Honours connectivity-gate flag (see 1.3) — drops with `HttpClientError` if either endpoint is disconnected.
- `tests/support/FakeHttpFabric.test.ts` — unit tests covering: simple POST/GET with JSON body, NDJSON streaming response with TestClock-driven heartbeat, connectivity-gate denial on either side, scope-close auto-deregister.

**Verification:** Unit tests pass under TestClock. Type-check + Effect plugin clean. Compose with a real `ReplPuller` against a real `ReplLog` over the fabric in the unit test to prove end-to-end NDJSON long-poll works under virtual time.

### 1.3 `SignalingNetwork` connectivity gate (per-worker, applies to both fabrics)

**Why:** Q6a — single source of truth for "is this worker network-reachable." Q5/Q6b kill pipeline disconnects network as phase 1, before registry-remove and scope close.

**Files modified:**
- [src/sip/SignalingNetwork.ts](src/sip/SignalingNetwork.ts) — extend `simulated()` to consult a `WorkerConnectivity` service before deliveries. Send-side: drop with logged event if sender's `outbound` flag is false. Receive-side: drop with logged event if recipient's `inbound` flag is false. Default `{inbound: true, outbound: true}`.
- `tests/support/WorkerConnectivity.ts` (new) — `Map<workerId, {inbound, outbound}>` service. Exposes `disconnect(id)`, `reconnect(id)`, `partition({from, to, direction})`. Owned by `SimulatedK8sCluster` in slice 3 but defined here so `SignalingNetwork` and `FakeHttpFabric` can both consume it.

**Files modified:**
- `tests/support/FakeHttpFabric.ts` (added in 1.2) consults `WorkerConnectivity` on `execute`.

**Verification:** Unit tests for both UDP and HTTP paths covering: disconnect drops symmetric, asymmetric partition (one direction only), reconnect restores. Type-check + Effect plugin clean.

## Slice 2 — Call context API redesign (largest slice, depends on Slice 0 doc)

This is the load-bearing refactor. Goal: SipRouter never branches on partition; the storage layer routes reads and writes from the immutable `w_pri`/`w_bak` cookie ordinals on every incoming SIP message; non-SIP events (timer, timeout, internal-event) read the persisted `wPri`/`wBak` from the Call.

### 2.1 New `PartitionRef` type and storage routing

**Files added:**
- `src/cache/PartitionRef.ts` — `PartitionRef` data type carrying `{ wPri: WorkerOrdinal, wBak: WorkerOrdinal | undefined, self: WorkerOrdinal }`. Pure helper:
  - `partitionRef.role`: `"primary" | "backup"` derived from `wPri === self`.
  - `partitionRef.ownerPartition`: `"pri:{self}"` if primary, else `"bak:{wPri}"`.
  - `partitionRef.replicaPartition`: `"bak:{wBak}"` if primary and wBak defined, else `"pri:{wPri}"` if backup (reverse-propagate target).

### 2.2 `CallState` API extension

**Files modified:**
- [src/call/CallState.ts](src/call/CallState.ts) — extend service:
  - `checkout(callRef, partition: PartitionRef): Effect<Call | undefined>` — reads from `partition.ownerPartition`. On miss when `partition.role === "backup"`, returns undefined (no fallback); the proxy's promotion routing is the only legitimate way for a backup-role checkout to occur, and a miss there means the call genuinely doesn't exist.
  - `update(call, partition): Effect<void>` — writes to `partition.ownerPartition`, queues propagate to `partition.replicaPartition`. For backup-role updates this enqueues a **reverse-propagate** entry tagged so the original primary's ReadyGate can distinguish on its eventual reboot.
  - `release(callRef, partition): Effect<void>`
  - `peek(callRef): Effect<{ call, role, peerOwner? } | undefined>` — observability-only; reads either partition; does not return a routable handle.
- The Call schema gains `wPri: WorkerOrdinal` and `wBak: WorkerOrdinal | undefined` fields persisted in the JSON encoding so timer/internal events can rebuild a `PartitionRef` at lookup time.

### 2.3 `SipRouter` cookie extraction at event ingress

**Files modified:**
- [src/sip/SipRouter.ts:500-540](src/sip/SipRouter.ts#L500-L540) — at the point where `callRef` is resolved, also resolve `wPri`/`wBak`:
  - `event.type === "sip"` request: decode the cookie via `decodeStickiness` (already existing in [LoadBalancer.ts](src/sip-front-proxy/strategies/LoadBalancer.ts)) into `{wPri, wBak}`.
  - `event.type === "sip"` response: same — Via params carry `cr`/`lg` and the cookie travels via Record-Route on responses.
  - `event.type === "timer" | "timeout" | "internal-event"`: the event already carries `callRef`. Lookup persisted `{wPri, wBak}` via `callState.peek(callRef)`. Build `PartitionRef`. (For timer events created from a call already in memory, the partition info is on the in-memory Call; cache-only path also works.)
  - `event.type === "cancelled"`: same as `sip` request — fall through to cookie decode if available, else `peek`.
- All `callState.checkout(callRef)` call sites become `callState.checkout(callRef, partitionRef)`. Same for `update` / `release`.
- Logs and traces gain a `role`/`peerOwner` attribute for observability; behaviour does not branch on role.

### 2.4 `PartitionedRelayStorage` write path for reverse-propagate

**Files modified:**
- [src/cache/PartitionedRelayStorage.ts](src/cache/PartitionedRelayStorage.ts) — extend write path so backup-role writes enqueue propagate entries with a `direction: "reverse"` tag. The existing `propagate:{peer}` ZADD score model is preserved; the entry payload widens to carry the direction.
- [src/replication/AtomicWriter.ts](src/replication/AtomicWriter.ts) and the underlying Lua script `atomic_call_write.lua` — extend to accept `direction` and emit it into the propagate entry. Forward (primary→bak) is the existing default; reverse (bak→pri) is new.
- [src/replication/ReplLog.ts](src/replication/ReplLog.ts) — wire format gains a `direction` field per entry. Producer side just passes through what's in the propagate ZADD.

### 2.5 `ReadyGate` reverse-direction drain (for primary reboot recovery)

**Files modified:**
- [src/replication/ReadyGate.ts](src/replication/ReadyGate.ts) — on boot, in addition to the existing forward drain (peer's `propagate:{self}` → `bak:{peer}:`), consume reverse-direction entries in the same stream and apply them to `pri:{self}:`. Spec line: "after drain completes, `pri:{self}:` reflects the latest state any peer wrote while serving as backup-on-our-behalf."
- [src/replication/ReplPuller.ts](src/replication/ReplPuller.ts) — apply path branches on entry direction: forward → `bak:{peer}:`, reverse → `pri:{self}:`.

### 2.6 Verification for slice 2

- **Type-check + Effect plugin clean** (`npm run typecheck`).
- **Unit tests** for `PartitionRef` algebra and `CallState.checkout/update` routing — both partitions covered, reverse-propagate enqueue verified.
- **Integration test (in-process, fake stack)**: write a call as primary, advance clock so propagate flushes, simulate primary disconnect, write an update as backup, observe reverse-propagate ZADD entry, simulate primary reconnect, run ReadyGate, observe `pri:{self}:` rebuilt with the backup's update.
- **Existing test suite** — every passing test continues to pass. The Call schema change requires backwards-compat handling for any cached entries written before the migration; for fake-stack tests that's automatic (in-memory cache, no persistence). For live tests, the schema change is forward-only and Redis sidecars are emptyDir, so a worker bounce after deploy clears any old entries.

## Slice 3 — Failover harness, simulated k8s, and first test

Depends on slices 1+2. Lands as one PR — the harness pieces only have value when composed.

### 3.1 `SimulatedK8sCluster` facade

**File added:** `tests/support/SimulatedK8sCluster.ts`

Owns: per-worker `Scope` handles, the `WorkerRegistrySimulatedControl` reference, the `WorkerConnectivity` service (Slice 1.3), the `FakeHttpFabric` reference (Slice 1.2). Exposes:

```ts
addWorker(id, address, opts?): Effect<WorkerHandle>
kill(id, timing?: KillTiming): Effect<void>
kill9(id): Effect<void>                       // alias: kill with all gaps zero
gracefulKill(id, opts?): Effect<void>          // alias: kill with drainHoldMs default
respawn(id, { sleepMs, killTiming?, address? }): Effect<WorkerHandle>
disconnect(id): Effect<void>                   // network gate flip; scope alive
reconnect(id): Effect<void>
partition({from, to, direction}): Effect<void>
```

`KillTiming` shape (Q6b):
```ts
interface KillTiming {
  drainHoldMs?: number             // 0 = immediate; >0 = registry health="draining" first
  disconnectGapMs?: number         // gap between phase-1 disconnect and phase-3 registry-remove
  registryRemoveDelayMs?: number   // gap between disconnect and registry-remove (phase 3)
  scopeCloseDelayMs?: number       // gap between registry-remove and scope close (phase 4)
}
```

Each phase emits a recorded event into a `Hub<KillEvent>` so tests can assert "phase 3 occurred at virtual t=X" in addition to gross outcomes.

### 3.2 `k8sFakeStack` Layer

**File added:** `tests/support/k8sFakeStack.ts`

Composes:
- `SignalingNetwork.simulated` (UDP fabric)
- `FakeHttpFabric` (HTTP fabric)
- `WorkerConnectivity` service
- `SimulatedK8sCluster`
- `proxyFakeStack` (existing, [tests/support/proxy-fakeStack.ts](tests/support/proxy-fakeStack.ts)) for proxy + LoadBalancer + simulated registry
- N × `b2buaWorkerStackLayer` (existing, [tests/support/networkLeaves.ts](tests/support/networkLeaves.ts)) — each scoped to a child of the cluster scope (Q2)
- `Random.seeded((testSeed, workerOrdinal))` per worker

Returns a `Layer` providing every per-worker handle plus the cluster facade. `firstSeenAtMs` is auto-stamped by the cluster on `addWorker` (gated behind an opt-in flag on the existing `simulated.ts` so other tests stay inert).

### 3.3 Scenario DSL extensions

**Files modified:**
- [tests/fullcall/framework/dsl.ts](tests/fullcall/framework/dsl.ts) — extend the action union with: `kill`, `respawn`, `disconnect`, `reconnect`, `partition`, `expectRoutedTo`, `expectCallStateOn`, `expectReplicatedTo`, `expectKillPhase`. `s.pause` semantics unchanged (Q8).
- [tests/fullcall/framework/recorder.ts](tests/fullcall/framework/recorder.ts) — recorder methods for each new action.
- [tests/fullcall/framework/interpreter.ts](tests/fullcall/framework/interpreter.ts) — interpreter cases dispatching to the cluster facade (`s.cluster.kill(...)`, etc.) and assertions reading the registry/cache/Hub state.
- [tests/fullcall/framework/html-report.ts](tests/fullcall/framework/html-report.ts), [tests/fullcall/framework/svg-sequence-diagram.ts](tests/fullcall/framework/svg-sequence-diagram.ts) — render kill/respawn/partition events on the sequence diagram timeline.

### 3.4 First failover test

**File added:** `tests/sip-front-proxy/failover/basic-call-primary-killed.test.ts`

Scenario:
1. `addWorker("A", addrA)`, `addWorker("B", addrB)`. Wait for HealthProbe to mark both alive.
2. alice INVITE through proxy → routed to A (HRW deterministic under seed). Cookie stamped `w_pri=A, w_bak=B`. Bob receives INVITE; 200 OK; ACK established.
3. `s.pause(replicationFlushMs)` — advance virtual clock so A's propagate flushes to B's `bak:{A}:`.
4. `s.expectReplicatedTo("B", { callRef })` — assert B's `bak:{A}:` has the call.
5. `s.kill("A", { drainHoldMs: 0, disconnectGapMs: 50 })` — phase 1 immediate, phase 3 50ms later. (Tests the conntrack-stale window; proxy sees A in registry briefly after disconnect.)
6. alice BYE → proxy sees A unreachable → `decode_forward_backup` → BYE arrives at B.
7. B looks up call in `bak:{A}:` (cookie `w_pri=A`, self=B, role=backup). Found. Processes BYE, forwards to bob via b-leg, gets 200, sends 200 to alice.
8. Updates the bak: entry to terminated state (or deletes — TBD by `CallState` semantics for terminating calls). Reverse-propagate enqueued (no consumer in this test; A doesn't restart).
9. Assertions:
    - `s.expectRoutedTo("B", { decision: "decode_forward_backup" })` for the BYE
    - `s.expectCallStateOn("B", { partition: "bak:{A}", terminated: true })` (or deleted)
    - `metrics.sipfp_decode_forward_promoted_total{from="dead"}` incremented by 1
    - alice received 200 OK to BYE; bob received BYE
    - **NO** `pri:{B}:call:X` entry — single-owner invariant preserved

### 3.5 Verification for slice 3

- `npm run test -- tests/sip-front-proxy/failover/basic-call-primary-killed.test.ts` passes 50/50 consecutive runs (deterministic).
- Total wall-clock runtime under 1 second.
- Existing test suites unchanged: `npm run test` green; `npm run test:k8s` green for the kept smoke gate (`proxy-drain.test.ts` plus one kill-9 variant per Q1).
- `npm run typecheck` clean (`tsc` and Effect plugin both).

## Out of scope / deferred to later slices

- **Re-INVITE during failover**, INFO/UPDATE/PRACK, complex multi-leg-failure scenarios — the slice 2 redesign supports them by construction (cookie-driven routing works for any in-dialog method) but each gets its own scenario in a follow-up PR with its own assertions.
- **B-leg failover** — bob → A's IP after A dies is currently lost in production (no proxy on b-leg by default, no Record-Route consultation in the scenarios we have). Out of scope for slice 3; revisit when an explicit b-leg-failover scenario is requested.
- **Primary-reboot end-to-end test** — Slice 2.5 implements the reverse-direction ReadyGate drain; a test that kills A, BYEs via B, then reboots A and asserts `pri:{A}:` is rebuilt with B's updates is a slice 4 deliverable.
- **`ReclaimRunner` rename / redesign** — flagged in slice 0 audit. Renaming is mechanical; deeper redesign deferred until a concrete need surfaces.
- **Other `Math.random()` sites** — OverloadController, Tracing. Not on the failover path.
- **Removing the kind suite** — the kept smoke tier (1–2 tests per Q1) stays.

## Critical files at a glance

Slice 0 (docs only):
- [docs/replication/call-cache-backup.md](docs/replication/call-cache-backup.md) — invariant ratification
- Comment audit across [src/sip-front-proxy/strategies/LoadBalancer.ts](src/sip-front-proxy/strategies/LoadBalancer.ts), [src/cache/ReclaimRunner.ts](src/cache/ReclaimRunner.ts), [src/replication/ReplLog.ts](src/replication/ReplLog.ts), [src/replication/ReadyGate.ts](src/replication/ReadyGate.ts)

Slice 1:
- [src/sip/MessageHelpers.ts](src/sip/MessageHelpers.ts), [src/call/CallModel.ts](src/call/CallModel.ts) — Random service refactor
- [src/sip/SignalingNetwork.ts](src/sip/SignalingNetwork.ts) — connectivity gate
- `tests/support/FakeHttpFabric.ts` — new
- `tests/support/WorkerConnectivity.ts` — new

Slice 2:
- `src/cache/PartitionRef.ts` — new
- [src/call/CallState.ts](src/call/CallState.ts) — API extension
- [src/sip/SipRouter.ts](src/sip/SipRouter.ts) — cookie extraction at event ingress
- [src/cache/PartitionedRelayStorage.ts](src/cache/PartitionedRelayStorage.ts) — reverse-propagate write path
- [src/replication/AtomicWriter.ts](src/replication/AtomicWriter.ts), `atomic_call_write.lua` — direction tag
- [src/replication/ReplLog.ts](src/replication/ReplLog.ts), [src/replication/ReplPuller.ts](src/replication/ReplPuller.ts), [src/replication/ReadyGate.ts](src/replication/ReadyGate.ts) — direction-aware

Slice 3:
- `tests/support/SimulatedK8sCluster.ts` — new
- `tests/support/k8sFakeStack.ts` — new
- [tests/fullcall/framework/dsl.ts](tests/fullcall/framework/dsl.ts), [tests/fullcall/framework/recorder.ts](tests/fullcall/framework/recorder.ts), [tests/fullcall/framework/interpreter.ts](tests/fullcall/framework/interpreter.ts) — DSL action additions
- `tests/sip-front-proxy/failover/basic-call-primary-killed.test.ts` — first scenario

## End-to-end verification

After all slices land:

1. `npm run typecheck` — both `tsc` and the Effect TS language-service plugin clean.
2. `npm run test:fake` — entire fake-stack suite green, including the new failover test.
3. `npm run test:k8s` — kept smoke gate (`proxy-drain.test.ts` + one kill-9 variant) green.
4. Reproduce a flake from the kind suite as a fake-clock test: pick the original `proxy-drain.test.ts` regression (the BYE 481 on respawned worker) and write its fake equivalent. Assert it surfaces the bug pre-slice-2 and passes post-slice-2.
5. Run the failover test 100× with the same seed: bit-identical results. Run with different seeds: structurally identical (same routing decisions, same cache state) — only branch/tag/CSeq strings differ.
