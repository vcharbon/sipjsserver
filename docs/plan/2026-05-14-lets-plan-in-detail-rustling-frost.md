# Plan — non-blocking outbound send + parallel ingress

## Context

On 2026-05-14 a single test run of `tests/fullcall/e2e-register-fakeExt-realCore.test.ts`
wedged the entire kind cluster's `sip-front-proxy` until manual recovery.
Full incident write-up at [docs/past-issues/2026-05-14-kindlab-dns-dos.md](../past-issues/2026-05-14-kindlab-dns-dos.md).

Reading the incident narrowly ("DNS bug, fix DNS") misses the underlying
defect: **any** blocking operation in the per-packet send path can wedge a
sequential ingress consumer. Today that was `dns.lookup` blocking the libuv
threadpool for 5 s per `EAI_AGAIN`. Tomorrow it's a saturated kernel send
buffer (`EAGAIN`), a slow rule chain, or a GC pause. The same chokepoint
amplifies any of them.

Reframed: the send path should be **non-blocking at the caller**, period.
We achieve that by buffering outbound packets per destination, with a
fixed-capacity queue and a dedicated drainer fiber per peer. Slow / dead
destinations isolate to their own fiber; healthy ones keep flowing. The
ingress consumer is also parallelised so a slow handler can't wedge the
endpoint behind it.

The four root contributors from the incident still get fixed; the difference
is **how**:

1. Test scenarios target `sip:bob@kindlab` — fixed by fixture rewrite.
2. `UdpEndpoint.send(buf, port, host)` blocks on `dns.lookup` for hostnames — addressed by per-peer buffering; the wrapper does not resolve DNS, it only contains the blocking to one fiber.
3. Proxy ingress consumer is strictly sequential — addressed by parallel `mapEffect` on the ingress stream.
4. No admission gate at the worker rejects bogus hostnames before they leave call-control — addressed by a worker-side admission check.

---

## Final design

### `BufferedUdpEndpoint` — encapsulating layer

A wrapper around `UdpEndpoint` that exposes the **same** `UdpEndpoint`
surface and works against any underlying impl (real `dgram` in production,
simulated in-memory fabric in tests). The wrapper is unaware of DNS,
sockets, or anything below the `UdpEndpoint` interface.

```
                                inner.send(buf, port, host)  ──►  dgram or simulated
                                       ▲
caller.send(buf,port,host)  ──┐        │
  (returns Effect.void,        │   per-peer
   never blocks,               │   drainer fiber
   never fails)                │       │
                               ▼       │
                      ┌───────────────┴────────────────┐
                      │  peerMap: Map<"host:port",     │
                      │      { queue: Queue.bounded(N),│
                      │        fiber: Fiber,           │
                      │        lastProgressMs }>       │
                      └────────────────────────────────┘
```

**Contract**:

- `send(buf, port, host): Effect<void>` — pure enqueue keyed on `${host}:${port}`. Lazily creates a peer entry on first send. **Never blocks. Never fails. Never propagates inner SendError to the caller.** Overflow ⇒ drop newest, bump counter.
- `messages`, `poll`, `take`, `localAddress`, `counters`, `queueDepth`, `queueMax` — pass-through to inner.
- The wrapper's drainer fiber for each peer reads its queue, calls `inner.send(buf, port, host)`, swallows `SendError` (counter + log), updates `lastProgressMs`. The inner send may take 5 s on DNS or block on EAGAIN — only **that** peer's drainer waits; everyone else continues.

**Why no DNS handling in the wrapper**: this is the user-confirmed design point. The wrapper does not call `dns.resolve4`, does not cache resolutions, does not implement a circuit breaker per host. Its job is *isolation*, not *avoidance*. The same `(host, port)` the caller supplied flows to the inner `send`. Node's resolver behaves exactly as before — but the blocking is now quarantined to one fiber per peer. The wrapper is the simpler version of the original Phase 2/3 design.

**Why this also solves kernel-buffer-full**: when `dgram.send` returns `EAGAIN` (the kernel's send buffer is full), the inner `send` returns `SendError`. In the old world that's a per-call failure visible to the caller. In the new world the drainer fiber observes it, increments a counter, and re-takes from the queue. The caller never sees it. SIP's UDP retransmits absorb the loss.

### Peer lifecycle — bounded memory under wide fan-out

Concern: a million distinct destination IPs each receiving one packet would create a million peer entries. Mitigation in three layers:

1. **Idle reclamation (default)**. A background sweeper checks `lastProgressMs` every second. Any peer with `now - lastProgressMs > idleTtlMs` (default **5 s**) is reclaimed: drainer fiber is interrupted, queue dropped (counter increments by queue depth), entry removed. This handles both "no traffic" idle and "stuck drainer" cases — a peer wedged on DNS makes no progress, so it's reclaimed in 5 s and the next packet to the same host creates fresh state.

2. **Max-peers cap (defense in depth)**. `maxPeers` (default e.g. **10_000**) bounds total entries. On the new-peer path: if at cap, the configured `PeerEvictionStrategy.selectVictim` picks one to evict before inserting. Default strategy: oldest `lastProgressMs` (idle-LRU). Strategy is a single-function interface so operators can plug in alternatives (e.g. drop-largest-queue) without touching the wrapper.

3. **Per-peer queue cap**. `perPeerQueueMax` (default e.g. **32**) bounds memory per peer. Overflow drops *newest* (incoming) — matches kernel UDP receive-queue behavior; the UAC's own retransmit replaces it. Drop counter is per-peer-but-aggregated for metrics.

### Configurable knobs

| Knob | Default | Why |
|---|---|---|
| `bufferedSendPerPeerQueueMax` | 32 | Small — SIP retransmits absorb drops |
| `bufferedSendIdleTtlMs` | 5_000 | Long enough that healthy slow links survive; short enough to cap stuck-DNS memory |
| `bufferedSendMaxPeers` | 10_000 | Hard ceiling on entries; well above any expected fan-out |
| `bufferedSendSweepIntervalMs` | 1_000 | How often idle reclamation runs |
| `proxyIngressConcurrency` | 16 | Cross-call parallelism on the ingress stream |
| `workerAllowedTargetSuffixes` | `[".svc.cluster.local"]` | Worker admission filter |

### Worker admission (Phase A unchanged from original plan)

Still valuable independent of buffering: reject obvious nonsense at `/call/new` time before allocating any state (per-peer entry, b-leg, timers). Cheaper than letting it reach the wire and rely on idle reclamation. Two env vars:

| Role | Env var | Default |
|---|---|---|
| `b2bua-worker` | `WORKER_ALLOWED_TARGET_SUFFIXES` | `.svc.cluster.local` (strict) |
| `sip-front-proxy` | `PROXY_ALLOWED_TARGET_SUFFIXES` | `*` (any — supports external SIP carriers) |

`*` is a literal sentinel: if the suffix list contains `*`, every host passes (used for rollback / external-peering deployments). IP literals (v4/v6) always pass regardless of suffix list.

---

## Phases

Each is independently shippable and revertable via env flag.

### Phase A — `BufferedUdpEndpoint` wrapper

**New file**: `src/sip/BufferedUdpEndpoint.ts`. Exports `wrapEndpoint(inner: UdpEndpoint, opts): UdpEndpoint` plus the `PeerEvictionStrategy` interface and its default impl.

Key shape (Effect v4 idioms):

```ts
export interface BufferedUdpEndpointOpts {
  readonly perPeerQueueMax: number
  readonly idleTtlMs: number
  readonly maxPeers: number
  readonly sweepIntervalMs: number
  readonly evictionStrategy: PeerEvictionStrategy
  readonly clock: Clock.Clock
  readonly counters?: BufferedSendCounters  // exposed for metrics
}

export interface PeerEvictionStrategy {
  readonly name: string
  readonly selectVictim: (
    peers: Iterable<readonly [string, PeerMetadata]>,
    now: number,
  ) => string | null
}

export interface PeerMetadata {
  readonly lastProgressMs: number
  readonly queueDepth: number
  readonly droppedCount: number
}

export const idleLruStrategy: PeerEvictionStrategy = {
  name: "idle-lru",
  selectVictim: (peers, _now) => {
    let oldestKey: string | null = null
    let oldestMs = Infinity
    for (const [k, m] of peers) {
      if (m.lastProgressMs < oldestMs) { oldestMs = m.lastProgressMs; oldestKey = k }
    }
    return oldestKey
  },
}
```

Internals: `MutableHashMap<string, PeerState>` for the peer table. Each peer's drainer is a forked fiber `Effect.forkIn(scope)` so the wrapper's scope owns lifetime. Sweep runs on a `Effect.repeat` schedule with `Schedule.fixed(sweepIntervalMs)`. Eviction interrupts the drainer fiber via `Fiber.interrupt` — the in-flight inner-send (if any) is orphaned; the libuv threadpool call completes in the background unobserved.

**Counters exposed**:
- `bufferedSendEnqueued{net}`
- `bufferedSendDropped{reason="peer_queue_full"|"peer_evicted_with_queue"}`
- `bufferedSendInnerErrors{reason="SendError"}` (logged by drainer)
- `bufferedSendActivePeers` (gauge)
- `bufferedSendReclamations{reason="idle"|"cap"}`

**Tests** (`tests/sip/BufferedUdpEndpoint/`):
- `enqueue-non-blocking.test.ts` — wrap a fake inner that hangs on send; verify `send()` returns immediately, queue depth grows.
- `per-peer-isolation.test.ts` — two peers, one inner-hang, one fast; assert fast peer keeps draining while slow one queues.
- `per-peer-queue-cap.test.ts` — enqueue beyond `perPeerQueueMax`; assert newest dropped, counter increments.
- `idle-reclamation.test.ts` — TestClock-drive past `idleTtlMs`; assert peer entry gone, drainer fiber interrupted, future enqueue creates fresh state.
- `idle-reclamation-drops-pending-queue.test.ts` — peer has queued packets when reclaimed; assert drop counter bumps by queue depth.
- `max-peers-eviction.test.ts` — pre-fill to `maxPeers`; new peer triggers victim selection (idle-LRU picks oldest); evicted peer is gone.
- `inner-send-error-swallowed.test.ts` — inner emits `SendError`; caller never sees it; counter increments; drainer continues.
- `fiber-interrupt-while-mid-send.test.ts` — drainer mid-send when eviction fires; in-flight effect interrupted cleanly, no defects.

**LOC**: ~250 + ~200 tests.

**Rollback**: don't wire the wrapper into `ProxyCore` / worker — they use the raw `UdpEndpoint` directly. Wrapper exists, just isn't used.

### Phase B — worker admission

**Goal**: reject any b-leg target whose host is neither an IP literal nor matches `WORKER_ALLOWED_TARGET_SUFFIXES` at `applyRoute` time. Emit `503 Service Unavailable` to the upstream UAS + `terminateCallEffects`. Prevents allocating call state and per-peer entries for nonsense destinations.

**Files modified**:
- New `src/b2bua/TargetAdmission.ts` — pure helpers:
  - `isIpLiteral(host)`: bracket-strip then `node:net.isIP()` (returns 4 or 6 for valid, 0 for invalid).
  - `isAllowedSuffix(host, suffixes)`: case-insensitive suffix match; `*` in the list ⇒ always true.
  - `classifyAdmission(host, suffixes): "ip-literal" | "allow-listed" | "reject"`.
- [src/decision/apply/applyRoute.ts:169](../../src/decision/apply/applyRoute.ts#L169) (failover) and [:232](../../src/decision/apply/applyRoute.ts#L232) (main route) — insert `classifyAdmission` check before each `createBLegFromRoute`. On reject, mirror the 503-envelope pattern from [src/b2bua/InitialInviteHandler.ts:104-115](../../src/b2bua/InitialInviteHandler.ts#L104-L115) + `terminateCallEffects(call)`.
- [src/b2bua/rules/framework/ActionExecutor.ts:1572](../../src/b2bua/rules/framework/ActionExecutor.ts#L1572) (`executeCreateLeg`) — same admission shim before `createBLegFromRoute`.
- [src/config/AppConfig.ts](../../src/config/AppConfig.ts) — add `workerAllowedTargetSuffixes: Schema.Array(Schema.String)` (env: `WORKER_ALLOWED_TARGET_SUFFIXES`, comma-list).

**Counter**: `b2bua_admission_rejected_total` increments per reject. Log line `[admission] reject host=<x> reason=non-ip-non-suffixed`.

**Tests** (`tests/b2bua/`):
- `target-admission.test.ts` — unit table over `isIpLiteral` (v4, v6, bracketed, garbage) / `classifyAdmission` (`*` wildcard, exact suffix, miss).
- `apply-route-admission-reject.test.ts` — feed bad host, assert 503 + terminate effect, no `createBLegFromRoute` call.
- `apply-route-admission-failover-reject.test.ts` — same for the failover branch.
- `action-executor-create-leg-admission.test.ts` — same for the rule-engine path.

**LOC**: ~120 + ~120 tests.

**Rollback**: `WORKER_ALLOWED_TARGET_SUFFIXES=*` restores pre-change behavior with no redeploy.

### Phase C — wire `BufferedUdpEndpoint` into ProxyCore + worker

**Goal**: every wire-level `send` in production paths goes through the wrapper. The `sendOn`-returns-`false`-then-503 path is **removed** — sends are fire-and-forget UDP again (RFC 3261 §16 stateless proxy model), so the synthetic 503 disappears and SIP transaction timers handle retry. This is the user-confirmed simplification.

**Files modified**:
- [src/sip-front-proxy/ProxyCore.ts](../../src/sip-front-proxy/ProxyCore.ts):
  - Wrap `extEndpoint` and (if present) `coreEndpoint` via `BufferedUdpEndpoint.wrap` inside the scope.
  - Change `sendOn(ep, buf, dst): Effect<boolean>` → `sendOn(ep, buf, dst): Effect<void>`. All call sites that branched on the boolean (lines 959-979, 1447-1470, and any others) collapse to the success path. The 503-synthesis-on-`false` blocks at [:967-978](../../src/sip-front-proxy/ProxyCore.ts#L967-L978) and [:1455-1470](../../src/sip-front-proxy/ProxyCore.ts#L1455-L1470) are deleted. Result label is always `forwarded` (the log line lies less now — the proxy genuinely forwarded into the queue).
- [src/sip/transport/UdpTransport.ts](../../src/sip/transport/UdpTransport.ts) (or wherever the worker's outbound socket is wrapped) — same wrap.
- [src/config/AppConfig.ts](../../src/config/AppConfig.ts) — add the five `bufferedSend*` knobs above.
- [src/sip-front-proxy/observability/MetricsServer.ts](../../src/sip-front-proxy/observability/MetricsServer.ts) — surface the new counters.

**Behavior change worth being explicit about**:

| Old | New |
|---|---|
| `sendOn` returns `false` on DNS / EAGAIN / kernel error | Wrapper enqueues, returns immediately. Inner failures swallowed in drainer. |
| Caller observes `sentOk=false`, synthesizes 503 with `Retry-After: 5` to UAC | No synthesis. UAC retransmits per RFC 3261 §17.1.1 (T1=500 ms, T2, …, Timer B at ~32 s). |
| Bad destination ⇒ one 503 per attempt, UAC stops at ~5 s | Bad destination ⇒ packets enqueue, drainer fails repeatedly, peer reclaimed at +5 s idle. UAC sees Timer B (~32 s) instead of 503. |

The trade-off is operator-visible: misconfigured calls take Timer B (~32 s) to resolve client-side instead of a snappy 503. Mitigation: Phase B's worker admission catches the common case (bogus call-control payload) inline. Genuinely-unreachable-but-allow-listed destinations get the slower UDP-retransmit behavior, which is the spec-correct outcome anyway.

**Tests** (`tests/sip-front-proxy/`):
- `send-non-blocking-end-to-end.test.ts` — set up fake inner where one peer hangs; send 100 packets to slow peer + 100 to fast peer; verify all 200 caller calls complete within a tight virtual budget, fast peer's packets all delivered.
- `send-dead-destination-no-503.test.ts` — fake inner always fails for `192.0.2.1`; send INVITE; assert NO 503 generated, peer reclaimed after `idleTtlMs`, log shows inner errors counter bumped.
- `send-kernel-buffer-full.test.ts` — fake inner returns `EAGAIN` for 100 ms then succeeds; assert drainer retries (queue drains after kernel recovers), no caller-visible failure.

**LOC**: ~80 (mostly deletions of the 503 paths) + ~120 tests.

**Rollback**: env `bufferedSendPerPeerQueueMax=0` (or a sentinel `bufferedSendDisabled=true`) — wrapper passes every send through synchronously to the inner. Same behavior as today, minus the 503 synthesis (the synthesis stays deleted; rollback isn't about that).

### Phase D — parallel ingress consumer

**Goal**: a slow handler (parse, rule chain, GC) on one packet doesn't HOL-block subsequent packets on the same endpoint.

**Change**: two-line swap at [src/sip-front-proxy/ProxyCore.ts:501-507](../../src/sip-front-proxy/ProxyCore.ts#L501-L507):

```ts
yield* Effect.forkScoped(
  extEndpoint.messages.pipe(
    Stream.mapEffect((p) => processPacket(p, "ext"), { concurrency: proxyIngressConcurrency }),
    Stream.runDrain,
  ),
)
```

**Concurrency hazard analysis** (revised from prior version):

The prior plan dismissed concurrency hazards too broadly. The honest list:

- `CancelBranchLru` INVITE-then-CANCEL race: in **registrar mode** ([ProxyCore.ts:1316](../../src/sip-front-proxy/ProxyCore.ts#L1316)), a CANCEL processed before its INVITE's `cancelLru.remember` results in `cancelUnmatched++` and synthesizes **481 Call/Transaction Does Not Exist**, not a fallback. In LB mode ([:805](../../src/sip-front-proxy/ProxyCore.ts#L805)) the miss falls back to `selectForNewDialog`, which is fine.

  **Mitigation**: use `Stream.groupedBy` keyed on `Call-ID` so same-call packets run serially; different-call packets run in parallel up to `proxyIngressConcurrency`. This preserves CANCEL ordering and is what stateless proxies expect.

  Concrete shape:
  ```ts
  extEndpoint.messages.pipe(
    Stream.groupByKey((p) => extractCallId(p) ?? "_no_call_id"),
    GroupBy.evaluate((_callId, stream) =>
      stream.pipe(Stream.mapEffect((p) => processPacket(p, "ext"))),
      { bufferSize: 1 },
    ),
    Stream.runDrain,
  )
  ```
  Different call-ids fan out into separate per-key streams (parallel); within one key, sequential. Failed parse (no call-id) falls into a single shared `_no_call_id` group — slightly more serial than ideal but the parse failure is the bug, not the concurrency.

- `LoadBalancerStrategy.selectForNewDialog` — pure: snapshot + rendezvous hash. Safe under any ordering.
- Via / Record-Route stamping — pure header construction with fresh `newBranch()`. Safe.
- `WorkerRegistry.lookupByAddress` — `Ref.get` + HashMap read. Safe.
- Counter increments — single-threaded V8, atomic at bytecode level.
- `metrics.setActiveDialogsEstimate(cancelLru.size())` — already documented as "best-effort"; reading a stale size during interleave is fine.

**Files modified**:
- [src/sip-front-proxy/ProxyCore.ts:501-507](../../src/sip-front-proxy/ProxyCore.ts#L501-L507) — the swap, including `groupByKey`.
- [src/config/AppConfig.ts](../../src/config/AppConfig.ts) — `proxyIngressConcurrency: Schema.Number` (default 16).

**Tests** (`tests/sip-front-proxy/`):
- `ingress-no-hol-blocking.test.ts` — fake `processPacket` that for `host=slow.local` does `Effect.sleep(2 seconds)` and for `fastpkt` returns immediately. Enqueue 1 slow + 4 fast on **different call-ids**. TestClock-drive. Assert 4 fast complete at virtual t=0, slow at t=2 s. **Pre-Phase-D this test would fail.**
- `ingress-same-callid-serial.test.ts` — enqueue INVITE then CANCEL on same call-id, with INVITE handler artificially slow. Assert CANCEL processed AFTER INVITE's `cancelLru.remember`, no spurious 481.
- `ingress-concurrency-bound.test.ts` — enqueue 32 slow packets on 32 distinct call-ids, assert in-flight depth peaks at `proxyIngressConcurrency`.

**LOC**: ~30 (the swap is small; `groupByKey` is one extra pipe) + ~120 tests.

**Rollback**: env `proxyIngressConcurrency=1` collapses to current sequential shape.

### Phase E — fixture rewrite

**Goal**: remove `kindlab` from test fixtures so they're independent of cluster DNS state. Independent of all other phases.

**Files modified**:
- [tests/scenarios/registrar/k8s-register-call-bye.ts](../../tests/scenarios/registrar/k8s-register-call-bye.ts) — replace `kindlab` in agent URIs and in the `sip:bob@kindlab` invite target with `${proxyCoreAdvertised.host}:${proxyCoreAdvertised.port}`.
- [tests/scenarios/registrar/k8s-register-call-reroute.ts](../../tests/scenarios/registrar/k8s-register-call-reroute.ts) — same for `bob1`, `bob2`. Also rewrite the `new_ruri: "sip:bob2@kindlab"` inside the `on_failure` JSON.
- [tests/scenarios/registrar/k8s-register-smoke.ts](../../tests/scenarios/registrar/k8s-register-smoke.ts) — same for alice's URI.

Each scenario gains an `expect(callTargetHost).not.toBe("kindlab")` assertion to lock the regression.

**LOC**: ~40 of fixture edits, no new tests.

---

## Verification (end-to-end)

After all phases land:

1. `npm run typecheck` — clean, including the Effect plugin.
2. `npm run test:fake` — unit + fake-stack coverage of wrapper, admission, parallel ingress.
3. Reset cluster: `bash tests/k8s/scripts/reset.sh`.
4. Sanity: `sipp -s uac 172.20.255.250:5060` → `100 / 180 / 200 / 200` ✓.
5. **Regression of original incident**: `E2E_KIND=1 E2E_KIND_PROXY_HOST=172.20.255.250 npx vitest run -c vitest.config.live.ts tests/fullcall/e2e-register-fakeExt-realCore.test.ts`. All 3 scenarios pass.
6. **The cluster-doesn't-wedge test**: immediately after the e2e run, `sipp -s uac 172.20.255.250:5060` × 3 — all return `100 Trying` within 1 s, exit 0.
7. **Admission test**: temporarily revert one fixture to `sip:bob@kindlab`, re-run the e2e. Expected: scenario fails with a 503 + the worker log shows `[admission] reject host=kindlab reason=non-ip-non-suffixed`. Counter `b2bua_admission_rejected_total` non-zero. **No per-peer state ever created on the proxy** (admission caught it on the worker).
8. **Quarantine test (the actual point of this plan)**: in a controlled live run, configure one worker's call-control to return an unreachable allow-listed host (e.g. `b2bua-worker-99.b2bua-worker.svc.cluster.local` — passes admission, fails DNS). Drive 10 cps of bogus + 10 cps of healthy calls. Assert healthy calls all complete; bogus calls Timer-B-out at ~32 s; proxy `bufferedSendActivePeers` stays bounded; `bufferedSendReclamations{reason=idle}` ticks at ~the bogus rate; **no impact on healthy-call latency p95**.

---

## Rollout order

Each phase is one PR. Ship in order:

1. **Phase A** — `BufferedUdpEndpoint`. Scaffolding, not yet wired. Pure addition.
2. **Phase B** — worker admission. Smallest blast radius; lands the regression test for the original incident.
3. **Phase E** — fixture rewrite. Same PR as B or immediately after, otherwise existing tests fail.
4. **Phase C** — wire the wrapper into ProxyCore + worker. The behavior change (no more synthetic 503) is the bulk of operator-visible diff; ships alone for easy revert.
5. **Phase D** — parallel ingress. Smallest diff, ship last so it's the only variable changing in the final cutover.

Total: ~480 LOC of production code + ~560 LOC of tests across 5 PRs.

---

## Risks

- **Removing the synthetic 503-on-send-failure changes operator-visible behavior**: bad destinations now take Timer B (~32 s) UAC-side to resolve instead of an immediate 503. Mitigation: Phase B catches the common-misconfig case inline. The remaining cases (transiently unreachable peer) are arguably better served by RFC retransmit semantics than by a synthetic 503-with-Retry-After.
- **Fiber interrupt during in-flight `dns.lookup`**: the libuv getaddrinfo call cannot be cancelled. Interrupting the drainer fiber orphans the lookup; the c-callback fires ~5 s later and resumes a finished fiber (no-op). No leak per se, but `top` will show 4 libuv threads briefly occupied. Acceptable.
- **`groupByKey` in Phase D adds a per-stream allocation per Call-ID**: high call-rate workloads create transient per-key streams. Stream's groupBy is designed for this; impact should be <1% overhead. Verify under load.
- **Per-peer queue cap of 32 may be too small for legitimately high-rate destinations**: e.g. a single trunk peer at 200 cps with one-second hiccups. Tunable via env; default may need to rise after production observation.
- **Idle reclamation of 5 s may evict legitimately-slow links**: a peer that genuinely takes 6 s to respond (rare in SIP UDP) gets reclaimed mid-transaction. Acceptable: SIP UDP is sub-second; anything taking 6 s is broken.
