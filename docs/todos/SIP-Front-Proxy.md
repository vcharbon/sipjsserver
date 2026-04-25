# SIP Front Proxy — Implementation Plan

## Context

Replace the in-process Node `cluster.fork()` master/worker model (`src/cluster/Dispatcher.ts` + `WorkerEntry.ts`) with a standalone, stateless **SIP front proxy** that distributes calls to a pool of B2BUA workers running as a Kubernetes StatefulSet. Reference spec: [docs/todos/SIP-Front-Proxy.md](../../sipjsserver/docs/todos/SIP-Front-Proxy.md).

The change unbundles two roles that are currently fused: (a) UDP packet ingress + dispatch, (b) B2BUA call processing. After the change, K8s schedules and supervises both, and the proxy's "load-balance to workers" behavior is just one routing strategy among a small family — a SIPp-tester-fanout strategy is one swap away.

### Architectural constraints (user-imposed)

1. **Dependency isolation.** `src/sip-front-proxy/` may only cross-reference the rest of the codebase through:
   - the **network layer** (`SignalingNetwork`)
   - the **SIP stack** (parser, generators, transaction primitives)

   No imports of `CallStateCache`, `CallLimiter`, `CallDecisionEngine`, rules framework, `OverloadController`, `UdpTransport`, etc. Enforced by ESLint `no-restricted-imports`.

2. **Don't re-implement the SIP stack inside the proxy.** Header parsing, message generation, Via/Route manipulation, retransmits — the proxy *uses* the stack, never re-implements it.

3. **Effect-Layer-first from day one.** Every swappable concern is its own `Layer` so simulated end-to-end tests over `SignalingNetwork.simulated()` are trivial — including single-process composition of `proxy + N workers + UAC + UAS + TestClock`.

4. **Pluggable routing strategy.** The proxy core takes a `RoutingStrategy` Layer; `LoadBalancer` is one impl, `ForwardAll` (test/dev), `SippFanout` (future), etc.

5. **B2BUA impact is minimal:** correct Route / Record-Route handling and a new `DrainingState` service. Rules/decision logic untouched.

6. **`SO_REUSEPORT`** as the multi-process scaling primitive (not Node `cluster.fork` IPC).

7. **Routing path is non-blocking.** Worker crashes / K8s LAN issues never delay or lock; ongoing-transaction loss on crash is acceptable.

---

## Architecture Decisions

### D1 — Package shape
New top-level dir `src/sip-front-proxy/`, own `bin/proxy.ts` entry. One `package.json`, one Docker base image with two CMDs (`bin/main.js` for worker, `bin/proxy.js` for proxy). Workspace split deferred until a second consumer of the SIP stack exists.

### D2 — `RoutingStrategy` seam (Split B: fat core, narrow strategy)
The proxy core owns all SIP mechanics (classify, top-Route inspect/strip via stack helpers, Via push/pop via stack helpers, CANCEL branch→target LRU, forward via `SignalingNetwork`). The strategy never touches message bytes; the core never makes a routing policy decision.

```ts
interface RoutingStrategy {
  readonly name: string
  selectForNewDialog(msg: ParsedSipMessage): Effect<SocketAddr, NoTargetAvailable>
  decodeStickiness(routeParam: RouteParams, msg: ParsedSipMessage): Effect<DecodeResult, never>
  encodeStickiness(target: SocketAddr, msg: ParsedSipMessage): Option<RouteParams>
}
type DecodeResult =
  | { kind: 'forward'; target: SocketAddr }
  | { kind: 'reject'; status: 403; reason: string }
  | { kind: 'unknown' }
```

Three strategies in Phase 1: `LoadBalancer`, `ForwardAll`, `SippFanout` (future). `WorkerRegistry`, `HealthProbe`, `HmacKeyProvider` are separate Layers that individual strategies depend on as needed.

### D3 — Worker identity & `WorkerRegistry`

- **Identity:** `worker_id = K8s pod name`. Workers run as **StatefulSet** with headless Service for per-pod DNS. Cookie carries `w=<pod-name>`.
- **Interface** — strictly non-suspending reads on the routing path:
  ```ts
  class WorkerRegistry extends Effect.Service<WorkerRegistry>()(...) {
    snapshot: Effect.Effect<ReadonlyArray<WorkerEntry>>           // Ref.get
    resolve: (id: WorkerId) => Effect.Effect<Option<WorkerEntry>> // Ref.get + HashMap
    changes: Stream.Stream<RegistryEvent>                         // SubscriptionRef.changes
  }
  type WorkerEntry = {
    id: WorkerId; address: SocketAddr
    health: 'alive' | 'draining' | 'dead'
    drainingSince?: Instant
  }
  ```
- **Three implementations:** `kubernetesStatefulSet` (production, K8s API watch), `static` (env-driven, dev/local), `simulated` (test-controllable).
- **Per-proxy local health view** in Phase 1 (no shared health store across proxy fleet).

### D4 — Routing-path non-blocking invariant

1. All routing-path I/O is fire-and-forget UDP `sendto`.
2. Registry & health state lives in `Ref`/`SubscriptionRef`; routing path reads synchronously.
3. Background fibers (K8s watch, HealthProbe) update state in isolation; their failures cannot propagate to the request path.
4. Forward errors are counted as a metric and dropped. UA retransmissions are the recovery mechanism.

### D5 — Draining model (OPTIONS-as-canonical, K8s as accelerant)

**Detection.** Worker's OPTIONS handler returns `200 OK` while serving, `503 Service Unavailable` + `Retry-After: 0` while draining. Proxy `HealthProbe` interprets `200`→`alive`, `503`→`draining` (sets `drainingSince`), timeout×threshold→`dead`. K8s watcher additionally treats `pod.metadata.deletionTimestamp != null` as immediate `draining` (shaves up to 2s). **Most-restrictive wins** if sources disagree.

**Two-stage proxy behavior** (in `LoadBalancerStrategy`):
- Initial INVITEs (`selectForNewDialog`): exclude `draining`+`dead` immediately.
- In-dialog requests (`decodeStickiness`): forward to draining worker for `drainGraceMs` (default 5s); after grace, fall back via `selectForNewDialog` → new worker hydrates from Redis (best-effort).
- ACK on 2xx and CANCEL: **always forward to original worker** (closing handshakes; only that worker has the INVITE transaction).

**Worker-side change in B2BUA.** New service `src/b2bua/DrainingState.ts`: SIGTERM handler flips a `Ref<'serving'|'draining'>`. OPTIONS handler reads it. Worker keeps SIP stack alive through entire grace period (silence would mark it `dead`, not `draining`). `setTimeout(process.exit, ...)` exits before K8s `SIGKILL`.

### D6 — Process model & scaling

- One process per pod, scale by K8s replicas. The "instance" in FR-8 = the pod.
- `SO_REUSEPORT` set defensively on the bind call (multi-process per pod is a future config toggle, not a refactor).
- No in-pod supervisor. K8s probes drive lifecycle.
- CANCEL LRU cross-pod split: mitigated at upstream LB (consistent-hash VIP on src_ip, or DNS-SRV with client affinity). Documented as topology assumption.

### D7 — UDP bind path

- Proxy depends on `SignalingNetwork` via Effect Layer injection — never references `SignalingNetwork.real` directly. Production wiring provides `.real`; fake-stack tests provide `.simulated`. **This is what enables single-process `proxy + B2BUA + UAC + UAS + TestClock` composition.**
- Proxy bypasses [`src/sip/UdpTransport.ts`](../../sipjsserver/src/sip/UdpTransport.ts) (which injects B2BUA's `OverloadController`). Proxy gets its own thin ingress with no overload brake in Phase 1.
- Add `reusePort?: boolean` to `BindUdpOpts` in [`src/sip/SignalingNetwork.ts`](../../sipjsserver/src/sip/SignalingNetwork.ts) and plumb to `dgram.createSocket(...)`. Simulated path: no-op.

### D8 — `SignalingNetwork` K8s fidelity

No production-path changes needed. Pod-IP rotation is modeled at the `WorkerRegistry` layer (id stable, address mutable). Source-IP preservation, kube-proxy NAT, MTU are operational concerns (Service config, `externalTrafficPolicy: Local`). Verify during PR2 that simulated fabric supports rebinding a logical id to a new fake IP.

### D9 — Layer composition shape (layered, not mega-layer)

```
ProxyCoreLayer  : requires SignalingNetwork, RoutingStrategy, BindConfig
LoadBalancerStrategyLive : Layer<RoutingStrategy>  requires WorkerRegistry, HmacKeyProvider
ForwardAllStrategyLive   : Layer<RoutingStrategy>  requires nothing

ProxyProductionLayer = ProxyCore + LoadBalancer + WorkerRegistry.k8s
                                 + HealthProbe.optionsKeepalive
                                 + HmacKeyProvider.k8sSecret
                                 + SignalingNetwork.real

ProxyTestLayer (fixture) = ProxyCore + <strategy> + WorkerRegistry.simulated
                                     + HealthProbe.manual
                                     + HmacKeyProvider.static
                                     + SignalingNetwork.simulated  (shared)
```

Wiring lives in `bin/proxy.ts` (production) and `tests/support/proxy-fakeStack.ts` (tests). Core never changes between them.

### D10 — Three test suites

1. **`tests/sip-front-proxy/transit-only/*.test.ts`** — Alice → Proxy(ForwardAll) → Bob. No B2BUA. Validates pure transit mechanics (Record-Route insert, Route strip per RFC 3261 §16.4, Via push/pop, CANCEL branch correlation, response routing by Via, malformed-message rejection). Used to localize proxy bugs without B2BUA noise.
2. **`tests/sip-front-proxy/load-balancer/*.test.ts`** — Alice → Proxy(LoadBalancer → N workers). Strategy-specific behavior: distribution, HMAC, draining, fallback, hydration.
3. **`tests/sip-front-proxy/transparency/*.test.ts`** — topology-parameterized (`topologyTest(name, body)` runs each scenario through `[direct, withProxy]`). Asserts behavior, not byte-exact bytes. Phase 1 ships 5–10 happy-path scenarios; existing `tests/fullcall/` are NOT mass-migrated (lazy rollout).

### D11 — `ForwardAllStrategy` (third built-in)

Trivial alongside `LoadBalancer` and (future) `SippFanout`. `selectForNewDialog`→static target; `encodeStickiness`→`;target=<addr>` cookie (no HMAC); `decodeStickiness`→parse and forward. ~30 LOC. Used by the transit-only test suite and as a dev/local default.

### D12 — B2BUA worker-side verification (transparency prerequisite)

For `withProxy` topology to pass transparently, audit & patch as needed on the worker side:
1. UAS-side mirrors `Record-Route` in 2xx responses to inbound INVITE (RFC 3261 §12.1.1).
2. UAS-side honors `Route` headers in inbound in-dialog requests (RFC 3261 §12.2.2).
3. Worker-originated A-leg in-dialog requests build `Route` sets including the proxy's `Record-Route` (RFC 3261 §12.2.1.1).
4. **New**: OPTIONS handler reads `DrainingState.mode` → `200` vs `503 + Retry-After: 0`.

The transparency suite is the verification harness — gaps surface as failures and are patched.

### D13 — Hash ring algorithm
**Rendezvous (HRW)**. ~150ns/lookup, no virtual-node bookkeeping, 1/N keys move on membership change. Implemented as a pure function over `(callId, ReadonlyArray<WorkerEntry>) → WorkerEntry`.

### D14 — HMAC key source & rotation
K8s Secret mounted as file. `HmacKeyProvider.kubernetesSecret` uses **fs-watch on the mount path** to reload on Secret update — no pod restart. NFR-8 overlap window via a second mounted file `HMAC_KEY_PREVIOUS`; provider exposes `verify(input, sig) → boolean` checking against both, `sign(input)` always uses current.

### D15 — Production cutover
**Blue-green at K8s namespace level.** Deploy proxy + new-style worker StatefulSet in a separate namespace. Drain traffic via DNS SRV weight or VIP redirect. Rollback is instant. Slower full cut but lowest risk given untested call-state hydration paths.

---

## Resilience Architecture Document (D-RES, Phase 1 deliverable)

`docs/sip-front-proxy/resilience-model.md` — must cover:

1. **Per-message-type behavior matrix** for worker states `alive` / `draining-pre-grace` / `draining-post-grace` / `dead`.
2. **Timing assumptions table:**

   | Parameter | Value | Why |
   |---|---|---|
   | K8s `terminationGracePeriodSeconds` | ≥ 200s (180s + safety) | RFC 3261 Timer C: max INVITE establishment is 3 min. CANCELs to in-flight INVITEs must reach the original worker for the entire window. |
   | `drainGraceMs` (proxy) | 5s default | Bound for in-dialog re-INVITE/UPDATE/INFO/REFER fallback. ACK/CANCEL exempt. |
   | `HealthProbe` interval × threshold | 2s × 3 = 6s | Worst-case detection lag for hard crash without K8s signal. |
   | HMAC overlap window | 1h (NFR-8) | Key rotation across proxy fleet. |

3. **Failure modes NOT mitigated:** UDP loss in proxy→worker hop, K8s watch outage (graceful degradation only), multi-pod CANCEL LRU split (relies on upstream LB src-IP affinity).
4. **Recovery flow** when fallback happens: proxy → new worker → Redis hydration → 481 if hydration miss.

---

## PR Slicing (seven PRs, each independently mergeable)

### PR 1 — Foundation ✅ DONE (2026-04-25)
**Scope:** create `src/sip-front-proxy/` skeleton + `bin/proxy.ts` that binds UDP and echoes. ESLint `no-restricted-imports` rule scoped to `src/sip-front-proxy/**` banning `src/{b2bua,call,decision,redis,cdr,cluster,http,observability}/**`. Add `reusePort?: boolean` to `BindUdpOpts` in `src/sip/SignalingNetwork.ts`, plumb to `dgram`.
**Critical files:** `src/sip/SignalingNetwork.ts`, `bin/proxy.ts` (new), `src/sip-front-proxy/index.ts` (new), `eslint.config.*`.
**Verification:** unit test that binds and echoes; CI test that introduces a forbidden import and asserts the lint rule fails the build.
**Status:** Implemented. New files: `bin/proxy.ts`, `src/sip-front-proxy/index.ts`, `eslint.config.js` (flat), `tsconfig.bin.json`, `tests/sip-front-proxy/transit-only/bind-echo.test.ts`, `tests/sip-front-proxy/lint-negative/{forbidden-import.fixture.ts,forbidden-import.test.ts}`. Modified: `src/sip/SignalingNetwork.ts` (`reusePort?` plumbed to `dgram.createSocket`), `package.json` (`proxy:dev`, `lint`, expanded `build`/`typecheck`), `.gitignore` (`dist-bin/`). `npm run typecheck` clean; full `npm run test:fake` 602 passed / 1 skipped, no regressions. Carry-forward: future `bin/*.ts` should reuse `tsconfig.bin.json`; ESLint install pulled vulns to revisit in PR6.

### PR 2 — `ProxyCoreLayer` + `ForwardAllStrategy` + transit-only test suite ✅ DONE (2026-04-25)
**Scope:** `RoutingStrategy` interface; `ProxyCoreLayer` (classify / top-Route inspect+strip / Via push+pop / CANCEL LRU / forward) — using stack helpers from `src/sip/`; `ForwardAllStrategy`; `proxyOnlyFakeStack` fixture.
**Critical files:** `src/sip-front-proxy/RoutingStrategy.ts` (new), `src/sip-front-proxy/ProxyCore.ts` (new), `src/sip-front-proxy/strategies/ForwardAll.ts` (new), `src/sip-front-proxy/CancelBranchLru.ts` (new), `tests/support/proxy-only-fakeStack.ts` (new), `tests/sip-front-proxy/transit-only/*.test.ts` (new).
**Verification:** Alice → Proxy(ForwardAll) → Bob full INVITE/200/ACK/BYE; CANCEL during ringing; re-INVITE in-dialog; malformed messages rejected; response routing by Via.
**Status:** Implemented. RFC 3261 §16.3, §16.4, §16.6.4, §16.6.5, §16.7.3, §16.10/§17.2.3 honoured; Max-Forwards decrement; stateless (no retransmits). 7 transit-only tests pass; full fake suite 609 passed (was 602; +7). `bin/proxy.ts` now drives a real `ForwardAll` proxy via `PROXY_FORWARD_TARGET=host:port`. **Carry-forward for PR3b:** `CancelBranchLru` is currently keyed on the proxy's outbound branch but at CANCEL time the upstream UAC's branch is what's on top — `ForwardAll` papers over this via fallback to `selectForNewDialog`; `LoadBalancer` must re-key the LRU on upstream branch (or Call-ID+CSeq). Local header helpers (`removeFirstHeader`, `prependHeader`, `upsertHeader`, `buildRecordRouteValue`) live in `ProxyCore.ts` — promote to `src/sip/MessageHelpers.ts` if B2BUA needs them in PR4. ESLint flat config now uses `tseslint.parser` for the proxy block (default parser can't read `import type`).

### PR 3a — `WorkerRegistry` + `HmacKeyProvider` ✅ DONE (2026-04-25)
**Scope:** `WorkerRegistry` interface; `static` and `simulated` implementations. `HmacKeyProvider` interface; `static` impl with rotation overlap. No strategy yet.
**Critical files:** `src/sip-front-proxy/registry/WorkerRegistry.ts` (new), `src/sip-front-proxy/registry/static.ts` (new), `src/sip-front-proxy/registry/simulated.ts` (new), `src/sip-front-proxy/security/HmacKeyProvider.ts` (new), tests for each.
**Verification:** unit tests on registry snapshot/resolve/changes semantics; simulated registry add/remove/health-flip; HMAC sign/verify; rotation overlap (verify accepts both keys, sign uses current).
**Status:** Implemented. Followed project's `ServiceMap.Service` convention (not `Effect.Service` as plan suggested). `WorkerRegistry.snapshot/resolve` are pure `Ref.get` (D4 invariant) — kept a plain `Ref<HashMap>` + `PubSub<RegistryEvent>` rather than `SubscriptionRef` (which emits whole-state, not deltas). HMAC uses HMAC-SHA256 + `crypto.timingSafeEqual`; rotation accepts current OR previous kid. Tests: 38 passed across registry + security; full fake suite 645 passed. **Carry-forward for PR3b:** `Stream.fromPubSub` only emits post-subscription events — load-balancer tests must subscribe before publishing if they assert on `changes`. `Effect.fork` is dead in v4 — use `Effect.forkChild`. `Layer.scoped` → `Layer.effect`; `Layer.scopedDiscard` → `Layer.effectDiscard`; no `Layer.scopedContext` (use `Layer.effectServices`). `drainingSince` is plain epoch-ms `number` (matches `CancelBranchLru.Entry.expiresAtMs`), not Effect's `Instant`.

### PR 3b — `LoadBalancerStrategy` + load-balancer test suite ✅ DONE (2026-04-25)
**Scope:** `LoadBalancerStrategy` (rendezvous HRW selection, HMAC signed cookie, fallback via own `selectForNewDialog`); canonical `proxyFakeStack` fixture; load-balancer test suite.
**Critical files:** `src/sip-front-proxy/strategies/LoadBalancer.ts` (new), `src/sip-front-proxy/strategies/RendezvousHash.ts` (new), `tests/support/proxy-fakeStack.ts` (new), `tests/sip-front-proxy/load-balancer/*.test.ts` (new).
**Verification:** distribution across N workers (chi-square ish); HMAC tampering rejected with 403; unresolvable id falls back via hash ring; simulated worker add/remove resharding affects only new dialogs.
**Status:** Implemented. Rendezvous HRW = SHA-1 over `"<callId>:<workerId>"`, top-8 bytes uint64, weighted via bigint. HMAC tag truncated to 128 bits (RFC 4868 §2.6) and base64url-encoded into Record-Route URI param `;sig=`. `verifyTruncated` added to `HmacKeyProvider` (additive, kid-aware so rotation overlap covers truncated tokens too). **CancelBranchLru re-keyed on `(Call-ID, CSeq number)` per RFC 3261 §9.1** — fixes the PR2 bug where the LRU stored proxy's outbound branch but CANCEL carries upstream UAC's branch. ProxyCore updated. Tests: 5 new load-balancer scenarios (distribution chi-square-ish, HMAC tampering → 403, unresolvable id falls back, add/remove resharding doesn't move existing dialogs, CANCEL after re-balance). Full fake suite 650 passed (was 645; +5). **Carry-forward for PR4:** `encodeStickiness` is `Option`-returning (no Effect), so `LoadBalancer` had to use `Effect.runSync` on `Ref.get` + `Effect.sync` HMAC sign; widening this to `Effect`-returning is worth considering if a future strategy needs real I/O — would need ProxyCore changes too. Distribution test discovered `SignalingNetwork.simulated.send` is forked-per-packet, so flushing a 1000-msg burst needs ~1000 pump cycles, not one.

### PR 4 — `DrainingState` + `HealthProbe` + draining behavior + transparency suite
**Scope:** B2BUA-side: `src/b2bua/DrainingState.ts` + OPTIONS handler integration. Proxy-side: `HealthProbe` interface + `optionsKeepalive` + `manual` impls, registry health annotation. Audit B2BUA worker for D12 items 1–3 and patch any gaps surfaced. Transparency test suite. **Ship `docs/sip-front-proxy/resilience-model.md` (D-RES).**
**Critical files:** `src/b2bua/DrainingState.ts` (new), worker SIP OPTIONS handler (existing, locate and modify), `src/sip-front-proxy/health/HealthProbe.ts` (new), `tests/support/topologies.ts` (new), `tests/sip-front-proxy/transparency/*.test.ts` (new), `docs/sip-front-proxy/resilience-model.md` (new).
**Verification:** draining worker stops new INVITEs within one probe interval; in-dialog flows continue for `drainGraceMs` then fall back; CANCEL still reaches draining worker; transparency scenarios pass under both `[direct, withProxy]` topologies.
**Status:** Implemented. New files: `src/b2bua/DrainingState.ts` (Default + test layer; SIGTERM hook via `MutableRef.set` to avoid runtime fabrication on the OS-signal callback), `src/sip-front-proxy/health/HealthProbe.ts` (`optionsKeepaliveLayer` + `manualLayer`; gate-flag-driven tick loop with `sleep(intervalMs) → fanOut → sleep(timeoutMs) → reap`), `src/sip-front-proxy/health/WorkerRegistryControl.ts` (interface + `simulatedAdapterLayer` + `noopLayer`), `tests/support/topologies.ts` (`topologyTest(name, opts, body)` runs each scenario through `[direct, withProxy]` via `runProxyScenario`), `tests/sip-front-proxy/transparency/{happy-call,cancel-during-ringing,reinvite,draining,health-probe}.test.ts`, `tests/b2bua/draining-options.test.ts`, `docs/sip-front-proxy/resilience-model.md` (5 sections per spec). Modified: `src/sip/SipRouter.ts` (out-of-dialog OPTIONS short-circuit before call resolution → 200 / 503+`Retry-After: 0` based on `DrainingState.mode`; in-dialog OPTIONS still falls through to the rule chain), `src/sip-front-proxy/strategies/LoadBalancer.ts` (D5 wiring in `decodeStickiness`: alive→forward; ACK/CANCEL exempt → forward to original worker regardless of grace; draining within grace → forward; draining post-grace OR dead → `unknown` so the core falls back via `selectForNewDialog`), `src/call/CallModel.ts` (`makeDialogFromIncoming` accepts a `routeSet` arg — RFC 3261 §12.1.1), `src/b2bua/rules/framework/ActionExecutor.ts` (a-leg dialog construction now seeds `routeSet` from the original INVITE's Record-Route headers in order, fixing D12 #3), `src/b2bua/B2buaCore.ts` + `src/main.ts` + `src/cluster/WorkerEntry.ts` + `tests/support/{fake,live}Stack.ts` (provide `DrainingState.Default`/`.test`), `src/sip-front-proxy/index.ts` (re-export `HealthProbe`, `WorkerRegistryControl`; bump `PROXY_VERSION` to `0.5.0-pr4`).

**RFC rules honoured:** §11 / §21.5.4 / §20.33 (OPTIONS + 503 + Retry-After), §8.2.6.2 (response echo), §12.1.1 (UAS Record-Route mirror — verified correct in `generateResponse`), §12.1.2 / §12.2.1.1 (UAC route-set reverse — verified correct in `confirm-dialog`), §12.1.1 (UAS dialog route set in order — patched at the a-leg construction sites), §12.2.2 (UAS in-dialog Route honor — verified the worker doesn't crash on unfamiliar Route headers), §13.2.2.4 / §9.1 / §16.10 (ACK / CANCEL routing exemption). RFC 3327 (Path) explicitly out of scope; documented in resilience-model.md §3.

**D12 audit findings:**
- (1) Record-Route mirror in 2xx INVITE response — **correct as-is** (`src/sip/generators.ts:494-498`).
- (2) UAS in-dialog Route honor — **correct as-is**; relay rules rebuild Vias/Contact via the dialog state, never re-emitting opaque Route headers from the inbound message.
- (3) Worker-originated A-leg in-dialog Route set — **patched at `src/b2bua/rules/framework/ActionExecutor.ts:828-838` and `:1027-1042`**, plus the `routeSet` arg added to `src/call/CallModel.ts:makeDialogFromIncoming`.

**Tests:** Full fake suite 660 passed / 1 skipped (was 650; +10 from this PR — 6 transparency + 1 draining + 1 health-probe + 1 OPTIONS + topology tests already counted via the parameterised body). `npm run typecheck` clean (zero errors / zero warnings).

**Carry-forward for PR5:** `WorkerRegistryControl.noopLayer` is the production stub until the K8s watcher lands; PR5 must replace it with a `kubernetesStatefulSet` impl that drives both registry membership AND health flips. The `HealthProbe.optionsKeepalive` tick loop's idle-gate pattern (`sleep(intervalMs)` then check `enabled`) makes TestClock-driven tests deterministic but means the **first** tick after `start` waits one full interval — production deployments may want a one-shot warm-up tick.

### PR 5 — Kubernetes integration ✅ DONE (2026-04-25)
**Scope:** `WorkerRegistry.kubernetesStatefulSet` impl using `@kubernetes/client-node` watch on Pods. Deletion-timestamp accelerant for draining. Helm chart: proxy `Deployment`, worker `StatefulSet`, headless `Service`, `ServiceAccount` + RBAC for proxy to watch Pods, `Secret` for HMAC, `ConfigMap` for non-secret config.
**Critical files:** `src/sip-front-proxy/registry/kubernetes.ts` (new), `deploy/helm/sip-front-proxy/*` (new), `deploy/helm/b2bua-worker/*` (new or update).
**Verification:** deploy to local `kind` cluster in CI; SIPp scenario through `LoadBalancer` Service; `kubectl delete pod` triggers `draining` annotation before OPTIONS reflects it.
**Status:** Implemented. New files: `src/sip-front-proxy/registry/kubernetes.ts` (`kubernetesStatefulSetLayer` + `kubernetesWatchClient` + `mostRestrictiveHealth` + injectable `WatchClient` testing seam), `tests/sip-front-proxy/registry/kubernetes.test.ts` (8 tests covering ADDED/MODIFIED/DELETED translation, deletionTimestamp → draining, K8s+probe most-restrictive composition, watch reconnect after onClose error, deferred ADDED with no podIP), `deploy/helm/sip-front-proxy/{Chart.yaml,values.yaml,README.md,templates/{_helpers.tpl,deployment.yaml,service.yaml,configmap.yaml,secret.yaml,serviceaccount.yaml,rbac.yaml}}`, `deploy/helm/b2bua-worker/{Chart.yaml,values.yaml,README.md,templates/{_helpers.tpl,statefulset.yaml,service.yaml}}`. Modified: `src/sip-front-proxy/security/HmacKeyProvider.ts` (`kubernetesSecretLayer` + content-derived kid via SHA-1 prefix + node:fs.watch with debounce + addFinalizer cleanup; on rotation the old current slides into `previous` for NFR-8 overlap), `bin/proxy.ts` (mode-switched static vs kubernetes wiring; new env vars `PROXY_REGISTRY_MODE`, `PROXY_K8S_*`, `PROXY_HMAC_KEY_PATH`, `PROXY_HEALTH_PROBE_*`), `Dockerfile` (multi-stage build now copies both `dist/` and `dist-bin/`; default CMD still worker; Helm chart for proxy overrides to `node dist-bin/bin/proxy.js`), `src/sip-front-proxy/index.ts` (re-exports for new layers + `PROXY_VERSION` bumped to `0.6.0-pr5`), `package.json` (added `@kubernetes/client-node@^1.4.0`).

**K8s pod state → `WorkerEntry.health` mapping (D5):** `pod.metadata.deletionTimestamp != null` → `draining` (with `drainingSince` stamped via `Clock.currentTimeMillis`); else Ready=True → `alive`; else not-ready: keep prior health, or `dead` if it was `alive` and just dropped (matches kubelet semantics; freshly-scheduled pods that haven't reached Ready yet don't flap to dead). New pods are deferred until they have both a name and a `status.podIP`. **Most-restrictive composition** (D5): per-id `(k8sHealth, probeHealth)` pair; resolved via `dead > draining > alive`. `WorkerRegistryControl.setHealth` overlays the probe value; the K8s watch overlays the K8s value; either flip recomputes the resolution and emits `health_changed` only when the resolved value moves.

**HMAC fs-watch + rotation (D14):** `kubernetesSecretLayer({ keyPath, previousKeyPath? })` reads the mounted Secret file at startup (failing the layer if it can't), derives the kid as a 16-hex-char SHA-1 prefix of the bytes (so distinct keys get distinct kids automatically — no operator decision needed), and installs `node:fs.watch` with a 200ms debounce. **Single-path mode**: when the watched file content changes, the new key becomes `current` and the old `current` slides into `previous` for the NFR-8 1h overlap window — verify accepts cookies signed by either kid. **Two-path mode**: each file is watched independently; operator-controlled rotation. Failures during reload (file removed, parse error) log + retain the prior key, never crash. K8s mounts Secrets via a `..data/` symlink that gets renamed atomically on update — `fs.watch` on the leaf path fires when the symlink target moves.

**Probe-side / K8s-watcher cooperation:** the K8s registry layer provides BOTH `WorkerRegistry` (read surface) and `WorkerRegistryControl` (write surface used by the OPTIONS keepalive probe), so a single layer wiring satisfies the existing `HealthProbe` topology without changes to PR4 code. The `WorkerRegistryControl.setHealth` write only mutates `pair.probe`; the K8s watch only mutates `pair.k8s`; both go through the same recompute-and-publish path so events stay consistent.

**Reconnect:** the K8s watch loop runs `Effect.callback` over the `WatchClient.start` Promise, waits for `onClose`, then sleeps for an exponential backoff (200ms → 5s capped) and reconnects in `Effect.forever`. `Effect.runForkWith(parentServices)` is used for the per-event handler so logging/clock services flow into the node-callback context. **All errors are logged + swallowed inside the watch fiber** — D4 invariant.

**Tests:** Full fake suite 668 passed / 1 skipped (was 660; +8 new K8s registry tests covering pod ADDED/MODIFIED/DELETED translation, deletionTimestamp accelerant, probe-vs-K8s most-restrictive composition, deferred ADDED without podIP, and watch reconnect after onClose error). `npm run typecheck` clean (zero errors / zero warnings); `npm run lint` clean. Helm `lint`/`template` not run (helm not installed in this dev env — see Surprises).

**Carry-forward for PR6:** `dist-bin/bin/proxy.js` path in the Helm Deployment depends on `tsc -p tsconfig.bin.json` outputting under `dist-bin/` — confirm matches CI build artifact path. `mode === "kubernetes"` branch in `bin/proxy.ts` calls `KubeConfig.loadFromCluster()` synchronously at module scope — fine inside a pod, but means the entry file can't be imported from a non-pod context (PR6 metrics may want to test parts of the wiring; consider lazy-load if needed). The K8s watch uses `Effect.runForkWith(parentServices)` for per-event callbacks, which means handler errors are visible in the parent runtime's logger but never flow back to the loop — intentional, but worth flagging in observability dashboards (look for `kubernetes registry: handlePhase failed` log lines as the canary).

### PR 6 — Observability + cutover + retire `src/cluster/`
**Scope:** all metrics from spec §3.4 (`sip_messages_total`, `sip_routing_duration_seconds`, `sip_routing_decision_total`, `sip_routing_hmac_failure_total`, `sip_worker_health`, `sip_cancel_lookup_total`, `sip_active_dialogs_estimate`); OpenTelemetry tracing with sample rate; structured JSON logging with Call-ID correlation; **blue-green cutover plan + runbook**; delete `src/cluster/{Dispatcher,WorkerEntry,IpcProtocol,IpcTransport}.ts` once cutover succeeds.
**Critical files:** `src/sip-front-proxy/observability/*` (new), `docs/sip-front-proxy/cutover-runbook.md` (new), `docs/sip-front-proxy/hmac-rotation-runbook.md` (new), deletions from `src/cluster/`.
**Verification:** Grafana dashboard renders all metrics under load (`AC-6` P99 routing latency <2 ms at 5K msg/s); 24-hour soak test (`AC-7` no leak); blue-green dry run on staging.

---

## Critical Files Touched

### New (proxy)
- `bin/proxy.ts`
- `src/sip-front-proxy/{index,ProxyCore,RoutingStrategy,CancelBranchLru}.ts`
- `src/sip-front-proxy/strategies/{ForwardAll,LoadBalancer,RendezvousHash}.ts`
- `src/sip-front-proxy/registry/{WorkerRegistry,static,simulated,kubernetes}.ts`
- `src/sip-front-proxy/health/HealthProbe.ts`
- `src/sip-front-proxy/security/HmacKeyProvider.ts`
- `src/sip-front-proxy/observability/*`

### Modified (existing)
- `src/sip/SignalingNetwork.ts` — add `reusePort?: boolean` to `BindUdpOpts`, plumb to `dgram`.
- B2BUA worker OPTIONS handler — read `DrainingState.mode`.
- B2BUA worker UAS code — verify Record-Route mirroring; verify Route-set construction on worker-originated A-leg in-dialog requests.
- `eslint.config.*` — add `no-restricted-imports` rule for `src/sip-front-proxy/**`.
- `package.json` / `Dockerfile` — add `bin/proxy.js` build target and CMD.

### New (B2BUA worker)
- `src/b2bua/DrainingState.ts`

### New (tests)
- `tests/support/{proxy-only-fakeStack,proxy-fakeStack,topologies}.ts`
- `tests/sip-front-proxy/{transit-only,load-balancer,transparency}/*.test.ts`

### New (deploy)
- `deploy/helm/sip-front-proxy/*`
- `deploy/helm/b2bua-worker/*` (StatefulSet conversion if needed)

### New (docs)
- `docs/sip-front-proxy/resilience-model.md` (D-RES, hard prereq for PR4)
- `docs/sip-front-proxy/cutover-runbook.md`
- `docs/sip-front-proxy/hmac-rotation-runbook.md`

### Deleted (PR6)
- `src/cluster/{Dispatcher,WorkerEntry,IpcProtocol,IpcTransport,HashUtils}.ts`

---

## Reused (do NOT reimplement)

- **SIP parser:** `src/sip/Parser.ts` — proxy uses for inbound message parsing.
- **Generators:** `src/sip/generators.ts` — proxy uses for any message it constructs (synthesized 503/481 responses, OPTIONS keepalive in HealthProbe). Also, the existing Via push/pop and Record-Route helpers.
- **Message helpers:** `src/sip/MessageHelpers.ts` — for header inspection.
- **Serializer:** `src/sip/Serializer.ts` — for outbound bytes.
- **`SignalingNetwork`:** `src/sip/SignalingNetwork.ts` — production `.real` and test `.simulated` variants. Proxy depends on the interface.

The CANCEL branch LRU is ~30 LOC of `Effect-friendly map with TTL` and is a proxy-specific concern (RFC 3261 §16.10 client-transaction-side correlation that the existing `TransactionLayer` does not expose since it's worker-side). Implement in `src/sip-front-proxy/CancelBranchLru.ts` rather than extending the existing transaction layer.

---

## Verification Strategy (end-to-end)

### Per-PR
Each PR ships its own test suite (see "Verification" line per PR above). All tests run under `vitest.config.fake.ts` (TestClock, simulated network) — no real cluster needed for PR1–PR4.

### Phase 1 acceptance (after PR6)
- `npm run test:fake` — full transit-only + load-balancer + transparency suites pass.
- `npm run test:ci` — same plus medium-tier live tests including SIPp scenarios from spec §10 D-3.
- `kind`-based integration test in CI: full call through deployed proxy + worker StatefulSet; `kubectl delete pod` mid-load; verify proxy health annotation flips and call drops are bounded.
- Spec acceptance criteria (`AC-1` through `AC-7` from `docs/todos/SIP-Front-Proxy.md`) — explicit pass/fail per criterion in the PR6 verification report.

### Continuous after Phase 1
- `tests/sip-front-proxy/transparency/*` runs on every PR touching B2BUA or proxy → guards the transparency claim against regressions.
- Existing `tests/fullcall/*` continues to test B2BUA logic without proxy noise.

---

## Phase 2+ Deferred (Reference)

Per spec §8, explicitly NOT designed against in Phase 1: TLS/TCP/WSS, SIP Outbound (RFC 5626), Path header (RFC 3327), multiple Record-Route (RFC 5658), mTLS, full NAT traversal. Additionally deferred from this plan: shared cross-proxy health view, multi-process-per-pod via `SO_REUSEPORT` (config toggle exists, not exploited), `SippFanoutStrategy`, mass migration of existing `tests/fullcall/` to topology-parameterized form (opportunistic in 1.5+).
