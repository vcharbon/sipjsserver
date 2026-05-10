# Peer-scan-bootstrap (rework) — replacement for the original plan

## Context

Two suites are skipped after the echo-removal slice
([docs/plan/lets-plan-a-proper-crystalline-emerson.md](lets-plan-a-proper-crystalline-emerson.md)):
[tests/replication-ns/ns05-sidecar-wipe-recovery.test.ts](../../tests/replication-ns/ns05-sidecar-wipe-recovery.test.ts)
and
[tests/sip-front-proxy/failover/replication-gap-mini.test.ts](../../tests/sip-front-proxy/failover/replication-gap-mini.test.ts).
Both relied on the same broken pattern: a respawned worker cold-pulled
the peer's reverse channel from `(0,0)` and reconstructed `pri:{self}:*`
from gen=0 mirror echoes. Echo was removed because update/delete
crossings could resurrect deleted calls, so that recovery is gone — and
nothing replaces it for "quiet calls" (calls the peer never modified
during the worker's outage).

A first plan ([docs/plan/peer-scan-bootstrap.md](peer-scan-bootstrap.md))
correctly diagnosed the gap (the diagnostic table and the test list are
kept verbatim below) but its implementation steps reinvent existing
plumbing, under-specify the boot ordering, and ignore readiness and
documentation. This plan reworks the implementation, keeping only what
is correct.

**Intended outcome.** On worker boot, the sidecar's empty `pri:{self}:*`
is filled from each currently-alive peer's `bak:{self}:*` partition via
a new streaming HTTP endpoint, before SIP traffic is accepted and
before the puller starts pulling deltas. The two skipped suites pass;
no echo path returns; no live cache slot ever holds a tombstone JSON.

## What stays from the original plan

The diagnostic and the test list — both correct.

### Diagnostic: passing-vs-failing tests after echo removal

| Test | Recovery direction | What's on the channel | Status today |
|---|---|---|---|
| **NS7 — backup re-bootstrap** | B wiped, pulls `propagate:{A}->{B}` | A's originating writes | ✅ passes |
| **NS8 — primary recovery via reverse** | A wiped, pulls `propagate:{B}->{A}` | B's originating writes from A's outage | ✅ passes |
| **NS14 — symmetric tombstone from backup** | A wiped, pulls `propagate:{B}->{A}` | B's originating tombstones | ✅ passes |
| **NS5 — sidecar wipe recovery** | A wiped, pulls `propagate:{B}->{A}` | gen=0 mirrors of A's pre-wipe writes that B had echoed | ❌ skipped |
| **replication-gap-mini phase 7** (quiet subset) | b2b-1 wiped, pulls from b2b-2 | gen=0 mirrors of b2b-1's pre-kill writes | ❌ skipped |

Passing tests recover from entries the peer **originated** (still on the
channel). Failing tests recovered from entries the peer **echoed**
(channel no longer carries them). The data still exists at
`bak:{me}:call:*` in the peer's KvBackend — it is just not reachable via
the channel anymore.

### Tests to re-activate

1. [tests/replication-ns/ns05-sidecar-wipe-recovery.test.ts](../../tests/replication-ns/ns05-sidecar-wipe-recovery.test.ts)
   — `describe.skip → describe`. Update the docstring to reference the
   bootstrap path. Assertions unchanged.
2. [tests/sip-front-proxy/failover/replication-gap-mini.test.ts](../../tests/sip-front-proxy/failover/replication-gap-mini.test.ts)
   — `describe.skip → describe`. No content change.

## What changes from the original plan

| Original plan | Rework |
|---|---|
| Add `GET /bak/scan` to `ReplLogServer` and `scanBak(...)` to `PullerHttpTransport`. | A scan endpoint already exists at `/cache/:role/:owner/scan` in [src/cache/PeerRelay.ts:189-209](../../src/cache/PeerRelay.ts#L189-L209), already wrapped client-side by `PeerCacheClient.scan`. It buffers the entire partition into a single JSON response — fine for hundreds of calls, OOM-grade for thousands. Add a **new** streaming endpoint `GET /bootstrap` to `ReplLogServer`, mirroring `/replog`'s NDJSON pattern, leaving the existing endpoint alone for its other consumers. |
| "Wire bootstrap into worker boot — call before puller fiber starts." | Bootstrap is a one-shot phase inside `runReplicationConsumer` ([src/main.ts:362-450](../../src/main.ts#L362-L450)) **before** `makeReplicationSupervisor.run` is forked. Subsequent peer (re)appearance events do **not** re-run bootstrap; only the puller's normal delta pull handles those. |
| Readiness gating not addressed. | `WorkerReadiness` is held false during bootstrap. Bootstrap completes when every peer in the boot snapshot finishes OR the configurable boot timeout fires (default 30s). Per-peer scan errors retry once after a short backoff; the per-peer attempt is capped by the overall budget. |
| Doc updates absent. | Update [docs/replication/call-cache-backup.md](../replication/call-cache-backup.md) and the footer of [docs/plan/lets-plan-a-proper-crystalline-emerson.md](lets-plan-a-proper-crystalline-emerson.md). |
| Verification cites stale numbers (`1128 → 1130`). | Verification states "the two re-activated suites turn green and the new lock-in/timeout/streaming tests pass; skipped count drops by 2." |

## Design

### 1 — New endpoint `GET /bootstrap` (server side)

**File:** [src/replication/ReplLogServer.ts](../../src/replication/ReplLogServer.ts)
— add a route alongside the existing `/replog` handler.

- **Path & query.** `GET /bootstrap?caller={self}` — same shape as
  `/replog`'s `caller` query param. The server derives `owner = caller`
  and `role = "bak"` (a peer can only ever bootstrap its own backup
  partition on the source). The caller is mandatory; missing or empty
  → `400 Bad Request`. Cross-owner requests (`caller != owner`) are
  not exposed by the URL — the only knob the client has is its own
  identity.
- **Wire format — identical to `/replog`.** NDJSON, line-delimited,
  using the existing `PullFrame` schema from
  [src/replication/ReplicationProtocol.ts](../../src/replication/ReplicationProtocol.ts)
  with `encodeFrame` / `decodeFrame` reused unchanged:
  ```
  {"type":"data","gen":0,"counter":0,"op":"create","partition":"pri",
   "callRef":"abc","body":{...},"body_ttl_remaining_sec":N,"latency_ms":0}
  {"type":"noop","gen":0,"counter":0,"latency_ms":0}
  ```
  Every bootstrap frame is a `Data` frame with `op="create"` and
  `partition="pri"` — the receiver's apply path treats this as
  "write into `pri:{self}:call:{callRef}` with TTL", which is exactly
  what bootstrap needs. `gen` and `counter` are fixed at `0` (sentinel:
  bootstrap is outside the channel watermark space; see §3 for how the
  receiver bypasses the watermark gate on this endpoint). `Noop`
  frames are emitted between SCAN batches identically to `/replog`,
  carrying the same heartbeat semantics.
- **Underlying read.** Reuse
  [src/cache/PartitionedRelayStorageKvBacked.ts:500-510](../../src/cache/PartitionedRelayStorageKvBacked.ts#L500-L510)
  `scanCalls(role="bak", owner=caller)` unchanged. The route maps each
  `ScanEntry` into a `DataFrame` via a small adapter (mirrors
  [buildDataFrame](../../src/replication/ReplicationProtocol.ts#L270-L290)
  but for scan results rather than `PulledEntry`), then encodes with
  `encodeFrame` and emits a `Noop` between scan batches. Response
  served via `HttpServerResponse.stream(body, { contentType: "application/x-ndjson" })`.
- **Bound on Redis cost.** Already provided by `scanCalls` (cursor walk
  + per-batch `Effect.yieldNow` + COUNT cap, see
  [PartitionedRelayStorageKvBacked.ts:609-627](../../src/cache/PartitionedRelayStorageKvBacked.ts#L609-L627)).
  The new endpoint adds no further bounding parameter; one streaming
  request walks the partition once. The streaming wins are peer
  **memory** (no whole-partition buffer in node before responding)
  and client TTFB (entries can be applied while later batches stream).

### 2 — New client `makeBootstrapStream` (client side)

**File:** [src/replication/PullerHttpTransport.ts](../../src/replication/PullerHttpTransport.ts)
— add a sibling factory next to `makePullerOpenStream`.

- **Signature.** `(config: { self, peer, client, resolver }) => Stream<DataFrame, BootstrapTransportError>`
  — emits `PullFrame.Data` frames (Noops are consumed internally for
  heartbeat tracking but not surfaced to the caller, since the only
  use case for bootstrap Noops on the client side is logging).
- **Implementation.** Mirror `makePullerOpenStream`:
  resolve the peer base URL via `PeerEndpointResolver`, GET
  `${baseUrl}/bootstrap?caller=${self}`, consume via
  `HttpClientResponse.stream`, decode line-buffered NDJSON using the
  existing `decodeFrame` from `ReplicationProtocol.ts`. The line-buffer
  logic is identical to the puller's `consumeStream`
  ([src/replication/PullerFiber.ts:272-305](../../src/replication/PullerFiber.ts#L272-L305))
  — extract it to a reusable helper `streamNdjsonLines(bytes) → Stream<PullFrame>`
  and reuse in both `/replog` and `/bootstrap` consumers. Decode errors
  surface as `ProtocolError` exactly as today.

**Do NOT** reuse `PeerCacheClient.scan` — that wrapper buffers the
whole `{ items: [...] }` JSON, which is exactly what we are moving
away from for the bootstrap path. The existing `/cache/:role/:owner/scan`
route stays in place for its current consumers.

### 3 — Boot phase in `runReplicationConsumer`

**File:** [src/main.ts:362-450](../../src/main.ts#L362-L450) — extend
the `Effect.gen` body, inserting the bootstrap phase between
dependency resolution and supervisor fork.

```
yield* enumerator                            // already there
yield* kv, readiness, httpClient, resolver   // already there

// NEW — bootstrap phase
const peersAtBoot = yield* enumerator.currentPeers
yield* runPeerScanBootstrap({
  self, peers: peersAtBoot, kv, httpClient, resolver,
  overallTimeoutMs: config.replication.bootstrapTimeoutMs,  // default 30_000
  perPeerRetryDelayMs: 1_000,
  onProgress: (event) => Effect.log…,
})
// at this point readiness is still false; controller has not started

const supervisor = makeReplicationSupervisor({...})
yield* Effect.forkDetach(supervisor.run)
yield* Effect.forkDetach(controller.run)
yield* afterGate
return yield* Effect.never
```

The `runPeerScanBootstrap` function — new, in
`src/replication/PeerScanBootstrap.ts`:

1. Snapshot `peersAtBoot` (already given). For each peer, fork an
   inner effect:
   - **Step 1 — Record head.** `ChannelIndex(self=peer, peer=self).pullBatch({gen:0,counter:0}, 0)`,
     keep `head_p`. This bookmarks where the puller will resume after
     bootstrap.
   - **Step 2 — Stream and apply.** Open `makeBootstrapStream(peer)`,
     `Stream.runForEach` over each `Data` frame. Each frame carries
     `op="create"`, `partition="pri"`, `callRef`, `body` (parsed JSON
     object), `body_ttl_remaining_sec`. Bootstrap bypasses the
     watermark gate (frames are not pulled from a channel, gen/counter
     are sentinel `0`/`0`) and calls
     `kv.applyReplicaUpdate({ bodyKey: "pri:{self}:call:{callRef}", bodyValue: JSON.stringify(frame.body), bodyTtlSec: frame.body_ttl_remaining_sec, indexes: callIndexKeysFromUnknown(frame.body) })`
     directly. This is the same primitive `makeReplicationApply` uses
     for steady-state apply; bootstrap differs only in the gate-bypass.
   - **Step 3 — Persist head_p** into the supervisor's per-peer
     `viewRef` so the puller starts at `head_p` on first connect, not
     `(0,0)`. The supervisor exposes `seedWatermark(peer, head)` for
     this purpose (new method).
2. Race the parallel fan-out against `Effect.sleep(overallTimeoutMs)`.
   On overall timeout, log WARN with the unfinished peers and proceed
   regardless.
3. Per-peer error policy: catch transport-class errors (5xx, parse
   failure, network drop), wait `perPeerRetryDelayMs`, retry once.
   On second failure or any time the overall budget is exhausted,
   that peer's scan is abandoned, a counter increments, and the worker
   proceeds.
4. The bootstrap phase MUST NOT produce uncaught defects. Per-peer
   failures are surfaced via a `BootstrapResult[]` returned to the
   caller and logged; the caller never fails the boot effect on
   bootstrap errors. (Empty cluster → empty `peersAtBoot` → trivial
   no-op.)

`WorkerReadiness` is held false implicitly: the existing
`makeReadinessController` is forked AFTER bootstrap returns, so it
cannot flip readiness during the scan phase.

**Boot snapshot semantics.** Per the grill answer: the peer set is
frozen at `peersAtBoot`. Peers that go alive AFTER the snapshot are
not bootstrapped from; the puller (started at `head_p` for known peers
or at `(0,0)` for newly-arriving peers — same as today) handles
post-boot peer changes. Peers that go dead DURING bootstrap fall
through the timeout/retry path.

### 4 — Apply semantics (idempotency)

Bootstrap entries are written via `kv.applyReplicaUpdate` unconditionally
— body and indexes are atomically swapped in. At boot, the worker has
no concurrent writers (SIP traffic is gated behind readiness), so
unconditional overwrite is safe. If two peers' `bak:{self}:*` partitions
overlap (both have a copy of the same call from before the worker's
outage), the last write wins; both copies are byte-identical because
each entry is the originator's own body, so this is a no-op overwrite.

### 5 — Failure handling and metrics

New counters in [src/observability/MetricsRegistry.ts](../../src/observability/MetricsRegistry.ts),
following the `SipRouterMetrics` shape:

```
b2bua_replication_bootstrap_started_total
b2bua_replication_bootstrap_completed_total{peer, outcome}   // outcome ∈ {ok, timeout, error}
b2bua_replication_bootstrap_entries_imported_total{peer}
b2bua_replication_bootstrap_duration_ms{peer}                // histogram
```

New AppConfig entry: `replication.bootstrapTimeoutMs` (default 30_000).

### 6 — Test-stack wiring

The fake stacks need the same boot phase. Same insertion semantics — a
one-shot bootstrap before the supervisor/puller forks, against the
peers alive at boot snapshot.

- [tests/support/k8sFakeStack.ts](../../tests/support/k8sFakeStack.ts)
  — the per-worker `buildWorker` and the `rebuild` callback (~line 493)
  must call `runPeerScanBootstrap` before forking the puller. Reuse
  the production `runPeerScanBootstrap` directly; the in-process HTTP
  fabric (`FakeHttpFabric`) routes the `/bootstrap` calls.
- [tests/support/proxyB2bFakeStack.ts](../../tests/support/proxyB2bFakeStack.ts)
  — same insertion in `makeHaPullerLayer` (~line 492). Bootstrap each
  worker against its peer, then fork the steady-state pullers.
- [src/test-harness/framework/](../../src/test-harness/framework/) — no
  changes; the harness invokes the wired fake stacks unchanged.

### 7 — Lock-in tests (new)

In `tests/replication/peer-scan-bootstrap.test.ts`:

1. **Happy path.** Two workers a, b. a writes calls 0..N to `pri:a:*`
   (b's puller catches up to `bak:a:*`). a's sidecar is wiped. a's new
   incarnation runs bootstrap. Assert: every call 0..N present in a's
   `pri:a:*` after bootstrap, body + indexes intact. Assert: zero
   entries written to a's outgoing `propagate:{a}->{b}` channel during
   bootstrap (one-way read).
2. **Bootstrap timeout.** One peer that never responds (delayed
   `FakeHttpFabric` route). Worker becomes ready after the configured
   timeout; counter `…_completed_total{outcome=timeout}` increments by
   one.
3. **Bootstrap retry-then-fail.** Peer responds 500 on the first scan
   request, 500 again on the retry. Per-peer outcome `error`; worker
   becomes ready; counter increments.
4. **Bootstrap retry-then-succeed.** Peer responds 500 first, OK
   second. Per-peer outcome `ok`; entries imported equal to the peer's
   `bak:{self}:*` size.
5. **Streaming bound.** Peer with a partition of 5_000 calls. Bootstrap
   completes inside the 30s budget; intermediate `Effect.yieldNow` is
   observable in the trace; no node memory spike (asserted indirectly
   by setting a low `--max-old-space-size` on the test runner — or by a
   smoke check that the response body is consumed incrementally).
6. **Bootstrap idempotency.** Trigger bootstrap twice in sequence
   against the same peer state; assert second run is a no-op (no
   spurious channel writes, body bytes unchanged).
7. **Boot snapshot freeze.** Peer flaps alive→dead AFTER the boot
   snapshot but before bootstrap reads the stream; the per-peer scan
   times out, that peer's outcome is `timeout`; bootstrap does NOT
   re-attempt when the peer flaps back alive (only the puller does, on
   its own delta-pull schedule).

### 8 — Documentation

- [docs/replication/call-cache-backup.md](../replication/call-cache-backup.md)
  — add a "Boot phase" subsection describing peer-scan-bootstrap as a
  precondition for steady-state replication, document the boot
  ordering (snapshot peers → scan in parallel with timeout → seed
  per-peer watermark → start supervisor → mark ready), and explain
  why echo was removed (cross-reference the previous plan).
- [docs/plan/lets-plan-a-proper-crystalline-emerson.md](lets-plan-a-proper-crystalline-emerson.md)
  — update the implementation-note footer: replace "Deferred:
  peer-scan-bootstrap for respawn recovery of quiet calls" with a
  pointer to this plan as the deferred follow-up that landed.

### 9 — Critical files

| File | Change |
|---|---|
| [src/replication/ReplLogServer.ts](../../src/replication/ReplLogServer.ts) | New `/bootstrap` route; reuses `PartitionedRelayStorage.scanCalls`; NDJSON streaming via `HttpServerResponse.stream`. |
| [src/replication/PullerHttpTransport.ts](../../src/replication/PullerHttpTransport.ts) | New `makeBootstrapStream` factory. Extract shared `streamNdjsonLines` helper used by both `/replog` and `/bootstrap` consumers. |
| [src/replication/PeerScanBootstrap.ts](../../src/replication/) | **New file.** `runPeerScanBootstrap({ self, peers, kv, httpClient, resolver, overallTimeoutMs, perPeerRetryDelayMs })` — orchestrates parallel per-peer scans, head recording, and apply. |
| [src/replication/ReplicationSupervisor.ts](../../src/replication/ReplicationSupervisor.ts) | New `seedWatermark(peer, { gen, counter })` method on the supervisor handle so bootstrap can plant the post-bootstrap head before the puller forks. |
| [src/main.ts:362-450](../../src/main.ts#L362-L450) | Insert the bootstrap phase between dependency resolution and `Effect.forkDetach(supervisor.run)`. |
| [src/observability/MetricsRegistry.ts](../../src/observability/MetricsRegistry.ts) | Add the four bootstrap counters to a new `ReplicationBootstrapMetrics` surface. |
| [src/config/AppConfig.ts](../../src/config/AppConfig.ts) | New `replication.bootstrapTimeoutMs` (default 30_000). |
| [tests/support/k8sFakeStack.ts](../../tests/support/k8sFakeStack.ts) | Wire `runPeerScanBootstrap` into worker boot and the `rebuild` (respawn) path. |
| [tests/support/proxyB2bFakeStack.ts](../../tests/support/proxyB2bFakeStack.ts) | Same. |
| [tests/replication-ns/ns05-sidecar-wipe-recovery.test.ts](../../tests/replication-ns/ns05-sidecar-wipe-recovery.test.ts) | `describe.skip → describe`; update docstring. |
| [tests/sip-front-proxy/failover/replication-gap-mini.test.ts](../../tests/sip-front-proxy/failover/replication-gap-mini.test.ts) | `describe.skip → describe`. |
| [tests/replication/peer-scan-bootstrap.test.ts](../../tests/replication/) | **New file.** Seven lock-in tests (happy path, timeout, retry-fail, retry-succeed, streaming bound, idempotency, snapshot freeze). |
| [docs/replication/call-cache-backup.md](../replication/call-cache-backup.md) | Add boot-phase subsection. |
| [docs/plan/lets-plan-a-proper-crystalline-emerson.md](lets-plan-a-proper-crystalline-emerson.md) | Footer update. |

Existing functions/utilities to reuse:

- [src/cache/PartitionedRelayStorageKvBacked.ts:500-510](../../src/cache/PartitionedRelayStorageKvBacked.ts#L500-L510)
  `scanCalls(role, owner)` — server side of `/bootstrap`.
- [src/storage/KvBackend.ts:186-191](../../src/storage/KvBackend.ts#L186-L191)
  `applyReplicaUpdate({ bodyKey, bodyValue, bodyTtlSec, indexes })` —
  atomic apply, same primitive used by `EchoApply`/`makeReplicationApply`.
- [src/replication/PullerFiber.ts:272-305](../../src/replication/PullerFiber.ts#L272-L305)
  `consumeStream` line-buffer logic — to extract into `streamNdjsonLines`.
- [src/cache/PeerEndpointResolver.ts](../../src/cache/PeerEndpointResolver.ts)
  `resolve(peer)` — peer base URL resolution; same as the puller.
- [src/cache/PeerEnumerator.ts](../../src/cache/PeerEnumerator.ts)
  `currentPeers` — boot snapshot.
- [src/replication/ChannelIndex.ts:96-99](../../src/replication/ChannelIndex.ts#L96-L99)
  `pullBatch({0,0}, 0)` — head bookmark.
- [src/call/CallState.ts](../../src/call/CallState.ts) `callIndexKeysFromUnknown(body)`
  — same index derivation the puller uses on apply.

### 10 — Risks called out

- **Bootstrap before supervisor — assumption.** Bootstrap relies on
  having the http client, resolver and KvBackend ready; all three are
  resolved from the same layer stack the supervisor uses, and resolution
  is synchronous, so this is structurally fine.
- **TTL preservation.** Imported entries inherit the peer's remaining
  TTL, not a fresh one. Correct behaviour (a call that was about to
  expire still expires shortly after restore), but a sanity-test entry
  in the lock-in suite verifies the TTL value round-trips.
- **`seedWatermark` race.** The supervisor must accept watermark seeding
  BEFORE its first `forkPullerFiber` call — this is straightforward
  because `supervisor.run` is forked AFTER bootstrap returns, but the
  supervisor's API contract for seed-vs-start ordering must be made
  explicit in the type.
- **Endpoint security.** `/bootstrap` is on the same trusted port as
  `/replog`; no auth (matches existing pattern). The route handler
  must reject any `owner` that is not the caller's own ordinal — peers
  should only ever bootstrap their own partition. Add a 403 for the
  cross-owner case and a metric.
- **Multi-peer scan concurrency.** N parallel scans for an N-peer
  cluster. For HA-pair (N=2) this is trivial. The plan does not
  generalise — if a future deployment grows to 4+ peers, revisit.

## Verification

1. **Type-clean build.** `npm run typecheck` — zero errors, zero
   Effect-plugin warnings.
2. **Fake-stack regression.** `npm run test:fake` — both NS5 and
   replication-gap-mini suites turn green; the seven new lock-in
   tests pass; skipped count drops by 2.
3. **Live regression.** `npm run test:ci` (medium tier) passes.
4. **Endurance smoke.** `npm run test:k8s:endurance` with the
   `post-fix-validation-6` configuration:
   - Each worker boot emits one
     `b2bua_replication_bootstrap_started_total` and a matching
     `…_completed_total{outcome=ok}` per alive peer.
   - `b2bua_stale_response_dropped_total` stays at zero (no regression
     on the prior fix).
   - STEADY OK ≥ 95%.
   - No 481 storm in the post-respawn settling window.
5. **Replication doc spot-check.** Re-read
   [docs/replication/call-cache-backup.md](../replication/call-cache-backup.md)
   end-to-end and confirm the boot sequence subsection accurately
   reflects the implementation.
