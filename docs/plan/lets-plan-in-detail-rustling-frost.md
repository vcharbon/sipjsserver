# Plan — DNS-DoS hardening (sip-front-proxy + b2bua-worker)

## Context

On 2026-05-14 a single test run of `tests/fullcall/e2e-register-fakeExt-realCore.test.ts`
wedged the entire kind cluster's `sip-front-proxy` until manual recovery. Full
incident write-up at [docs/past-issues/2026-05-14-kindlab-dns-dos.md](../past-issues/2026-05-14-kindlab-dns-dos.md).

The cascade compounded **four** independent defects, all still latent today:

1. Test scenarios target `sip:bob@kindlab` — `kindlab` is unresolvable from inside the cluster.
2. `UdpEndpoint.send(buf, port, host)` ([src/sip/SignalingNetwork.ts:92](../../src/sip/SignalingNetwork.ts#L92)) accepts hostnames and delegates to `dgram.send`, which calls `dns.lookup` ⇒ libuv `getaddrinfo` blocking the threadpool for ~5 s per `EAI_AGAIN`.
3. Proxy ingress consumer at [src/sip-front-proxy/ProxyCore.ts:501-507](../../src/sip-front-proxy/ProxyCore.ts#L501-L507) is `Stream.runForEach` — strictly sequential per endpoint. One slow DNS lookup blocks every subsequent packet.
4. No admission gate at the worker rejects bogus hostnames before they ever reach the proxy.

This plan closes all four in four shippable phases. Each is independently revertable via an env flag.

---

## Final design (after grilling, per-role configurable)

Per-role policy matrix:

| Role | Allow-list env var | Default | Send-path treatment |
|---|---|---|---|
| `b2bua-worker` | `WORKER_ALLOWED_TARGET_SUFFIXES` | `.svc.cluster.local` (strict) | Admission rejects at `applyRoute` |
| `sip-front-proxy` LB mode | `PROXY_ALLOWED_TARGET_SUFFIXES` | `.svc.cluster.local` (strict) | classify → cache → slow-pool → circuit-breaker |
| `sip-front-proxy` registrar mode | `PROXY_ALLOWED_TARGET_SUFFIXES` | `*` (any — supports external SIP carrier peering) | Same classify pipeline; broader default but same defences |

Two env vars, two threat models. Worker is the strictest because it accepts whatever call-control returns and that path was the actual exploit vector.

Defaults for the smaller numeric knobs (user did not constrain — use these):

| Knob | Default | Why |
|---|---|---|
| `dnsCacheSuccessTtlMs` | 60_000 | Bounded staleness window after a service rolls a pod |
| `dnsCacheFailureTtlMs` | 5_000 | Re-probe quickly after CoreDNS flap recovery |
| `slowSendPoolMax` | 16 | Matches `proxyIngressConcurrency`; bounds concurrent libuv DNS work |
| `slowSendDnsTimeoutMs` | 250 | Long enough for healthy CoreDNS, short enough to break sub-second SLO |
| `circuitFailThreshold` | 3 | Tight; cascades fail fast |
| `circuitFailWindowMs` | 5_000 | Failures outside the window decay |
| `circuitOpenDurationMs` | 30_000 | Long enough for CoreDNS recovery; short enough for human attention |
| `proxyIngressConcurrency` | 16 | One slow packet can occupy 1/16 capacity, not 100% |

---

## Phase 1 — Worker admission validation

**Goal**: reject any b-leg target whose host is neither an IP literal nor matches `WORKER_ALLOWED_TARGET_SUFFIXES`. Emit `503 Service Unavailable` to the upstream UAS + `terminateCallEffects`, before any socket send.

**Files modified**:
- New `src/b2bua/TargetAdmission.ts` — pure helpers `isIpLiteral(host)` (uses `node:net` `isIP` + bracket-stripping for IPv6), `isAllowedSuffix(host, suffixes)`, `classifyAdmission(host, suffixes): "ip-literal" | "allow-listed" | "reject"`.
- [src/decision/apply/applyRoute.ts:169](../../src/decision/apply/applyRoute.ts#L169) (failover) and [:232](../../src/decision/apply/applyRoute.ts#L232) (main route) — insert `classifyAdmission` check before each `createBLegFromRoute`. On reject, mirror the 503 envelope pattern from [src/b2bua/InitialInviteHandler.ts:104-115](../../src/b2bua/InitialInviteHandler.ts#L104-L115) + `terminateCallEffects(call)`.
- [src/b2bua/rules/framework/ActionExecutor.ts:1572](../../src/b2bua/rules/framework/ActionExecutor.ts#L1572) (`executeCreateLeg`) — same admission shim.
- [src/config/AppConfig.ts](../../src/config/AppConfig.ts) — add `workerAllowedTargetSuffixes: Schema.Array(Schema.String)` (env: `WORKER_ALLOWED_TARGET_SUFFIXES`, comma-list).

**Counter**: `b2bua_send_errors_total{reason="ADMISSION_REJECT"}` increments per reject. Log line `[admission] reject host=<x> reason=non-ip-non-suffixed`.

**Tests** (`tests/b2bua/`):
- `target-admission.test.ts` — unit table over `isIpLiteral`/`classifyAdmission`.
- `apply-route-admission-reject.test.ts` — feed bad host, assert 503 + terminate effect emitted, no `createBLegFromRoute` call.
- `action-executor-create-leg-admission.test.ts` — same for the rule-engine path.

**LOC**: ~120 across 4 files + ~80 of tests.

**Rollback**: set `WORKER_ALLOWED_TARGET_SUFFIXES=*` (sentinel meaning "match anything") restores pre-change behaviour without a redeploy.

---

## Phase 2 — Proxy send-path classify + DNS cache + slow-send pool

**Goal**: replace `sendOn` at [src/sip-front-proxy/ProxyCore.ts:339-354](../../src/sip-front-proxy/ProxyCore.ts#L339-L354) with a dispatch that never blocks the ingress fiber on DNS.

```
classify(target.host):
  ip-literal           → FAST: inline ep.send(buf, port, host)
  allow-listed + cache → CACHED: inline ep.send(buf, port, cachedIp)
  allow-listed, miss   → SLOW: forkIn(slowSendPool) { resolve4(host, 250ms) → cache → send }
                                 sendOn returns Effect.succeed(false) immediately
  off-allow-list       → REJECT: counter + log, return false (defence in depth — admission upstream should catch)
```

The SLOW path returning `false` synchronously is load-bearing: the caller's existing 503-on-`false` path at [ProxyCore.ts:946-976](../../src/sip-front-proxy/ProxyCore.ts#L946-L976) (LB mode) and [:1442-1480](../../src/sip-front-proxy/ProxyCore.ts#L1442-L1480) (registrar mode) fires inline, so the upstream UAC gets a definitive answer instead of timing out. Its next retransmit (typically T1=500 ms later) hits a warm cache and takes the FAST path.

**Files modified**:
- New `src/sip-front-proxy/DnsCache.ts` — LRU (`Map<host, { ip, expiresAtMs, negative }>`), max 1024, success TTL 60 s, failure TTL 5 s, exposes `get(host)`, `setSuccess(host, ip)`, `setFailure(host)`, `hitCount`/`missCount` for metrics.
- New `src/sip-front-proxy/SlowSendPool.ts` — Effect `Semaphore` (default permits = 16). Entry point `tryResolveAndSend(host, port, buf, ep, breaker): Effect<void>` — uses `dns.resolve4` (NOT `dns.lookup`; `resolve4` is event-loop-based, doesn't consume the libuv threadpool), wrapped in `Effect.timeout(slowSendDnsTimeoutMs)`. Records outcome to circuit breaker (Phase 3).
- [src/sip-front-proxy/ProxyCore.ts](../../src/sip-front-proxy/ProxyCore.ts) — replace `sendOn` body with `classify` dispatch. Add `dnsCache` and `slowSendPool` to scope. `sendOn` still returns `Effect<boolean>` — contract unchanged.
- [src/config/AppConfig.ts](../../src/config/AppConfig.ts) — add `proxyAllowedTargetSuffixes`, `dnsCacheSuccessTtlMs`, `dnsCacheFailureTtlMs`, `slowSendPoolMax`, `slowSendDnsTimeoutMs`.
- [src/sip-front-proxy/observability/MetricsServer.ts](../../src/sip-front-proxy/observability/MetricsServer.ts) — wire new gauges: `b2bua_proxy_dns_cache_hit_ratio`, `b2bua_proxy_slow_send_pool_depth`, `b2bua_proxy_slow_send_pool_max`.

**Tests** (`tests/sip-front-proxy/`):
- `dns-cache.test.ts` — TTL expiry, negative-cache, LRU eviction, hit/miss counters.
- `send-classify.test.ts` — table of `classify(target)` outcomes given a fake `DnsCache` state.
- `send-slow-pool-timeout.test.ts` — stub `dns.resolve4` to hang, drive `TestClock` past 250 ms, assert `sendOn` resolves `false` BEFORE the pool fiber resolves, `b2bua_send_errors_total{reason="TIMEOUT"}=1`, 503 synthesized to source.
- `send-cache-hit.test.ts` — pre-warm cache, assert `dgram.send` (mocked) receives the cached IP without any DNS call.

**LOC**: ~280 (~90 cache + ~120 pool + ~40 ProxyCore wiring + ~30 metrics/config) + ~150 of tests.

**Rollback**: env `slowSendPoolMax=0` collapses the dispatch to the inline `ep.send` (the FAST and CACHED paths still work; SLOW path errors out immediately so off-allow-list targets fail fast).

### Known vs. unknown: what the upstream UAC actually sees

The user-visible behaviour around the cache hinges on **how SIP retransmit interacts with our SLOW-returns-`false`-synchronously contract**. The flow for a target whose host has never been resolved before:

```
  UAC                proxy                      slowSendPool fiber           DNS
   │                  │                                │                       │
   │  INVITE (T=0) ─► │                                │                       │
   │                  │ classify(target):              │                       │
   │                  │   host is allow-listed,        │                       │
   │                  │   DnsCache.miss                │                       │
   │                  │ ─►SLOW: forkIn(slowSendPool)  ─►                       │
   │                  │                                │ ─► dns.resolve4 ──►  │
   │                  │ sendOn returns false           │   (250 ms budget)    │
   │  503 ◄────────── │ (synchronous, inline)          │                       │
   │                  │                                │                       │
   │ T1=500 ms later  │                                │ ◄── 10.244.x.x ──    │
   │                  │                                │ DnsCache.set(host, IP)│
   │                  │                                │ ep.send → dest        │
   │                  │       (fire-and-forget;        │ (dropped on the floor │
   │                  │        UAC already retransmits)│  for ordering safety) │
   │                  │                                │                       │
   │  INVITE (T1)  ─► │                                │                       │
   │                  │ classify(target):              │                       │
   │                  │   DnsCache.hit (warm)          │                       │
   │                  │ ─►CACHED: inline ep.send       │                       │
   │                  │       to resolved IP           │                       │
   │  100 Trying ◄─── │                                │                       │
   │  …               │                                │                       │
```

Two consequences worth being explicit about:

- **The first INVITE to any unknown host pays one 503 + one RFC-mandated retransmit cycle** (typically 500 ms latency cost). This is bounded, deterministic, and visible in `b2bua_send_errors_total{reason="TIMEOUT"|"DNS_MISS"}`. SIP's idempotent-retransmit model absorbs it.
- **The slow-pool fiber's eventual `ep.send` is intentionally discarded** (it could fire after the UAC has already retransmitted and got a real response — that'd be a duplicate INVITE that violates RFC 3261 §17 transaction semantics). Only the cache population is kept.

### Pre-warming options (optional, Phase 2 extension)

To eliminate the one-time 503 for predictable destinations, two cheap hooks:

1. **WorkerRegistry hook** — `WorkerRegistry` already learns about workers via its HTTP control plane. Wire its `onWorkerAdded` listener to call `dnsCache.preWarm(worker.host)` so every known worker is resolved at registration time, before the first INVITE can target it. Zero ops burden.
2. **Static config list** — `proxyDnsPreWarmHosts: Schema.Array(Schema.String)` env var. Useful for external SIP carrier peerings where the operator already knows the names. Resolved at proxy startup, then refreshed on TTL expiry (60 s).

Both keep the **runtime** path unchanged — they just populate the cache earlier. Sensible default: enable hook (1), leave hook (2) empty by default.

---

## Phase 3 — Per-destination circuit breaker

**Goal**: short-circuit the SLOW path when one destination cascades, so a single rotting upstream can't tie up `slowSendPoolMax` fibers indefinitely.

**State machine** keyed by `${host}:${port}`:
- `CLOSED` → 3 failures within 5 s → `OPEN`
- `OPEN` → 30 s elapsed → `HALF_OPEN`
- `HALF_OPEN` → 1 probe → success: `CLOSED`; failure: `OPEN` (reset 30 s)

While `OPEN`, `SlowSendPool` short-circuits the resolve attempt and returns `false`. Counter `b2bua_send_errors_total{reason="CIRCUIT_OPEN"}` bumps.

**Files modified**:
- New `src/sip-front-proxy/SendCircuitBreaker.ts` — single map, single `tryAcquire(key) → "allow"|"deny"` + `recordOutcome(key, "success"|"failure")` entry points.
- [src/sip-front-proxy/SlowSendPool.ts](../../src/sip-front-proxy/SlowSendPool.ts) — gate on breaker before acquiring a semaphore permit.
- [src/config/AppConfig.ts](../../src/config/AppConfig.ts) — `circuitFailThreshold`, `circuitFailWindowMs`, `circuitOpenDurationMs`.
- Metrics — `b2bua_proxy_circuit_open_count{host,port}` (low-cardinality because admission gates upstream).

**Tests**:
- `circuit-breaker.test.ts` — TestClock-driven state machine table.
- `send-circuit-open-fastpath.test.ts` — pre-OPEN a destination, assert `sendOn` returns `false` without touching DNS or socket, counter bumps.

**LOC**: ~150 + ~80 tests.

**Rollback**: env `circuitFailThreshold=0` (or sentinel) disables breaker; SLOW path always attempts resolve.

---

## Phase 4 — Parallel ingress consumer

**Goal**: a slow packet (any reason — GC, big rule chain, DNS slip-through) cannot block subsequent packets on the same endpoint.

**Change**: two-line swap at [src/sip-front-proxy/ProxyCore.ts:501-507](../../src/sip-front-proxy/ProxyCore.ts#L501-L507):

```ts
yield* Effect.forkScoped(
  extEndpoint.messages.pipe(
    Stream.mapEffect((p) => processPacket(p, "ext"), { concurrency: 16 }),
    Stream.runDrain
  )
)
// same for coreEndpoint
```

**Phase-1 explorer confirmed no concurrency hazards**:
- `CancelBranchLru` (`MutableHashMap`) — correctness depends on key match, not order. Late `remember` racing a `lookup` returns `None` → falls back to `selectForNewDialog` (conservative routing, not failure).
- `LoadBalancerStrategy.selectForNewDialog` — pure: snapshot read + rendezvous hash. No per-call mutable state.
- Via/Record-Route stamping — pure header construction with fresh `newBranch()`.
- `WorkerRegistry.lookupByAddress` — `Ref.get` + HashMap read.
- Counter increments (`counters.routedRequests++`) — single-threaded V8, atomic at bytecode level.
- `metrics.setActiveDialogsEstimate(cancelLru.size())` — already documented as "best-effort"; interleaving observes a stale value at worst.

**Files modified**:
- [src/sip-front-proxy/ProxyCore.ts:501-507](../../src/sip-front-proxy/ProxyCore.ts#L501-L507) — the swap.
- [src/config/AppConfig.ts](../../src/config/AppConfig.ts) — `proxyIngressConcurrency: Schema.Number` (default 16).

**Tests** (`tests/sip-front-proxy/`):
- `ingress-no-hol-blocking.test.ts` — inject a fake `processPacket` that for `host=slow.local` does `Effect.sleep(2 seconds)`, for `fastpkt` returns immediately. Enqueue 1 slow + 4 fast. TestClock-drive. Assert all 4 fast complete at virtual t=0, slow at t=2s. **Pre-Phase-4 this test would fail** — that's the proof.
- `ingress-concurrency-bound.test.ts` — enqueue 32 slow packets, assert depth peaks at 16.

**LOC**: ~30 + ~70 tests.

**Rollback**: env `proxyIngressConcurrency=1` collapses to current sequential shape — true zero-code revert.

---

## Fixture rewrite — kindlab → real proxy core

User decision: `kindlab` is removed entirely; fixtures route to the in-process hybrid test proxy's loopback (the `proxyCoreAdvertised` parameter scenarios already accept).

**Files modified**:
- [tests/scenarios/registrar/k8s-register-call-bye.ts](../../tests/scenarios/registrar/k8s-register-call-bye.ts) — replace literal `kindlab` in `bob.uri` with `${proxyCoreAdvertised.host}:${proxyCoreAdvertised.port}`. Same for `alice.uri` if it routes egress.
- [tests/scenarios/registrar/k8s-register-call-reroute.ts](../../tests/scenarios/registrar/k8s-register-call-reroute.ts) — same for `bob1`, `bob2`.
- [tests/scenarios/registrar/k8s-register-smoke.ts](../../tests/scenarios/registrar/k8s-register-smoke.ts) — same for `alice.uri`.

**LOC**: ~30 of fixture edits.

**No new tests** — these scenarios are themselves tests; if they pass against the new wiring, the rewrite is validated. Add an explicit `expect(call.target.host).not.toBe("kindlab")` assertion in each to lock the regression.

---

## Critical files (consolidated)

- New: `src/b2bua/TargetAdmission.ts`, `src/sip-front-proxy/DnsCache.ts`, `src/sip-front-proxy/SlowSendPool.ts`, `src/sip-front-proxy/SendCircuitBreaker.ts`
- Modified: `src/decision/apply/applyRoute.ts`, `src/b2bua/rules/framework/ActionExecutor.ts`, `src/sip-front-proxy/ProxyCore.ts`, `src/config/AppConfig.ts`, `src/sip-front-proxy/observability/MetricsServer.ts`
- Modified fixtures: `tests/scenarios/registrar/*.ts`
- New tests under: `tests/b2bua/`, `tests/sip-front-proxy/`

Existing utilities to reuse (don't reimplement):
- `node:net` `isIP()` for the IPv4/IPv6 literal check
- `generateResponse(req, 503, …)` + `terminateCallEffects(call)` from [src/b2bua/InitialInviteHandler.ts:104-115](../../src/b2bua/InitialInviteHandler.ts#L104-L115) — copy the 503-envelope shape
- `Effect.timeout` + `Effect.fork`/`Effect.forkIn` for the slow path
- `MutableHashMap` (already used by CancelBranchLru) for DnsCache backing storage
- `Effect.Semaphore` for the slow-send pool
- `Schema.Array(Schema.String)` for the env-var config shape, mirroring how other comma-list configs land in `AppConfig.ts`

---

## Verification (end-to-end)

After all 4 phases land:

1. `npm run typecheck` — must be clean, including the Effect plugin.
2. `npm run test:fake` — unit + fake-stack coverage of all new modules (admission, DnsCache, SlowSendPool, CircuitBreaker, parallel ingress).
3. Reset cluster: `bash tests/k8s/scripts/reset.sh`.
4. Sanity: `sipp -s uac 172.20.255.250:5060` → `100 / 180 / 200 / 200` ✓.
5. **The regression test**: run the formerly-toxic e2e:
   `E2E_KIND=1 E2E_KIND_PROXY_HOST=172.20.255.250 npx vitest run -c vitest.config.live.ts tests/fullcall/e2e-register-fakeExt-realCore.test.ts`
   Expected: all 3 scenarios pass (rewritten fixtures route to `proxyCoreAdvertised`, no `kindlab` anywhere).
6. **The cluster-doesn't-wedge test**: immediately after the e2e run finishes, `sipp -s uac 172.20.255.250:5060` × 3 — all must return `100 Trying` within 1 s, exit 0.
7. **The admission test**: temporarily revert one fixture to `sip:bob@kindlab`, re-run the e2e. Expected: scenario fails with a 503 + the worker log shows `[admission] reject host=kindlab reason=non-ip-non-suffixed`. Counter `b2bua_send_errors_total{reason="ADMISSION_REJECT"}` non-zero. **No DNS work**, no proxy log of any kind for that call (admission cut it before any send).
8. Inspect `b2bua_proxy_dns_cache_hit_ratio` post-run — should be >0.9 (all worker-target lookups are cluster-local and stable).
9. Inspect `b2bua_proxy_ingress_lag_p95_ms` (if surfaced) — should stay <5 ms throughout.

---

## Rollout order

Each phase is one PR. Ship in order:

1. **Phase 1** — admission. Eliminates today's class on day one. Smallest blast radius.
2. **Fixture rewrite** — same PR or sequenced immediately after Phase 1, otherwise existing tests fail.
3. **Phase 2** — classify + cache + slow-pool. Adds the scaffolding Phase 3 needs.
4. **Phase 3** — circuit breaker.
5. **Phase 4** — parallel ingress. Smallest diff, ship last so it's the only variable changing in the final cutover.

Total: ~580 LOC of production code + ~400 LOC of tests across 5 PRs over ~1 week.

---

## Risks

- **A misconfigured cluster legitimately routing to a bare hostname starts hard-rejecting calls** after Phase 1. Mitigation: env var rollback (`WORKER_ALLOWED_TARGET_SUFFIXES=*`) requires no redeploy.
- **`dns.resolve4` queries the configured nameserver, not `/etc/hosts`**, so `/etc/hosts`-only entries (e.g. `kindlab` in a developer's local override) fail fast. This is intentional: production must never depend on hosts files.
- **A transient CoreDNS rolling restart could open the circuit breaker** for a healthy service. Mitigation: 30 s OPEN window is short; HALF_OPEN single-probe recovers in one cycle. Operators can also set `circuitFailThreshold` higher.
- **Phase 4 ordering change** could surface a hidden ordering assumption no one has documented. Mitigation: `proxyIngressConcurrency=1` is a runtime env var rollback to sequential.
