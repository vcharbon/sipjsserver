# Plan — Kubernetes Test Environment for SIP Stack
 
## 1. Purpose and Scope
 
Provide a reproducible, automated Kubernetes environment for end-to-end and chaos testing of the SIP stack (front proxy + B2BUA workers + Redis dual-write). Designed for local development and on-demand reproduction of failure scenarios.
 
**Goals:**
- One-command bring-up and tear-down
- Deterministic and reproducible test runs
- Fault injection at multiple layers (process, network, resource)
- Continuous metrics collection for regression analysis
- Local-first (developer laptop), portable to CI later
- **Exercise the proxy-front philosophy end-to-end**: HMAC-signed Record-Route stickiness (rendezvous HRW for *initial* placement, cookie for in-dialog), OPTIONS-as-canonical draining signal, K8s-watch + active probe with most-restrictive health resolution, ACK/CANCEL exemption from drain-grace fallback, HMAC key rotation overlap (NFR-8). See [docs/sip-front-proxy/resilience-model.md](../sip-front-proxy/resilience-model.md) for the per-message-type behavior matrix this environment validates.

**Out of scope:**
- CI/CD integration (deferred to a later phase)
- Production-grade hardening of the test cluster itself
- Multi-region or multi-cluster topologies
- Performance benchmarking against production hardware
---
 
## 2. Cluster Topology
 
### 2.1 Base Cluster
 
- **kind** (Kubernetes IN Docker) as the cluster runtime
- 1 control-plane node + 4 worker nodes (Kubernetes-level workers, i.e., non-control-plane nodes)
- Kubernetes version: track latest stable minus one
- CNI: default kindnet (sufficient for UDP and chaos networking)
```yaml
# cluster.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: sip-e2e
nodes:
  - role: control-plane
  - role: worker
    labels:
      tier: edge        # for SIP front proxies
  - role: worker
    labels:
      tier: edge
  - role: worker
    labels:
      tier: app         # for SIP workers + Redis (co-located)
  - role: worker
    labels:
      tier: app
extraPortMappings:
  - containerPort: 30060   # SIP UDP exposed
    hostPort: 5060
    protocol: UDP
  - containerPort: 30030   # Grafana
    hostPort: 3000
    protocol: TCP
```
 
> **Naming clarification:** `role: worker` (kind-level) means "this is a Kubernetes worker node, not control-plane." It is unrelated to the SIP B2BUA worker. The SIP workers are pods scheduled onto these Kubernetes nodes via labels and selectors.
 
### 2.2 Tier Design
 
Two functional tiers, each on dedicated nodes:
 
- **`tier: edge`** — hosts the stateless SIP front proxies. 2 nodes for HA.
- **`tier: app`** — hosts the B2BUA workers **and** their co-located Redis instances. 2 nodes for HA.
Co-locating Redis with SIP workers on the same `app` node has two benefits:
 
1. **Local-availability**: even during a network partition between nodes, each worker keeps a local Redis reachable.
2. **Realistic failure correlation**: killing an `app` node kills one worker + one Redis simultaneously, which mirrors a real VM/host loss in production.
### 2.3 Workload Layout
 
| Component | Workload kind | Replicas | Node selector | Anti-affinity | Notes |
|---|---|---|---|---|---|
| SIP front proxy | Deployment | 2 | `tier: edge` | required, hostname | Active/active behind NodePort UDP. Watches B2BUA worker pods via the K8s API. RBAC: `get,list,watch` on `pods` in the worker namespace. |
| B2BUA worker | **StatefulSet** | 2 | `tier: app` | required, hostname | Stable pod names (`b2bua-worker-0`, `b2bua-worker-1`) used as `worker_id` in the proxy's HMAC stickiness cookie (D3). Headless Service for per-pod DNS. `terminationGracePeriodSeconds: 200` — Timer C (3 min INVITE establishment) + safety. |
| Redis-A / Redis-B (checkpoint) | StatefulSet | 2 | `tier: app` | required, hostname | One per app node, co-located with a worker |
| SIPp UAC (load gen) | Job/Deployment | 1–N | any | none |   |
| SIPp UAS (sink) | Job/Deployment | 1–N | any | none |   |
| Grafana LGTM | Deployment | 1 | any | none | Single-pod observability stack |
| Chaos Mesh | system | — | system namespace | n/a | Helm install |
 
Resulting placement:
 
```
Node edge-1   →  proxy-1
Node edge-2   →  proxy-2
Node app-1    →  sip-worker-1   +   redis-checkpoint-0
Node app-2    →  sip-worker-2   +   redis-checkpoint-1
```
 
### 2.4 Networking
 
- **SIP exposure**: NodePort UDP 30060 mapped to host port 5060. SIPp UAC can run inside or outside the cluster.
- **Worker discovery by proxy**: K8s API watch on Pods (label-selector `app.kubernetes.io/name=b2bua-worker`). The proxy's `WorkerRegistry.kubernetesStatefulSet` impl translates pod state to `WorkerEntry`:
  - `pod.metadata.name` → `WorkerId` (stable across pod restarts thanks to StatefulSet ordinals)
  - `pod.status.podIP:<podPort>` → `address`
  - `Ready=True` → `health=alive`; `pod.metadata.deletionTimestamp != null` → `health=draining` (D5 K8s accelerant — fires up to 2s before SIGTERM-driven OPTIONS 503).
  - The proxy's active `HealthProbe.optionsKeepalive` runs in parallel and **most-restrictive wins**: `dead > draining > alive`. Either signal source can demote a worker; only both agreeing on `alive` keeps it in rotation.
- **Worker draining**: workers expose OPTIONS-as-canonical signal — `200 OK` while `DrainingState=serving`, `503 Service Unavailable` + `Retry-After: 0` while `draining`. SIGTERM in the worker pod flips DrainingState. K8s `terminationGracePeriodSeconds: 200` keeps the SIP stack alive through the grace window so the proxy can drain in-flight INVITEs (Timer C max).
- **HMAC stickiness**: Record-Route URI param `;sig=<128-bit base64url MAC>` over `(v=1|w=<workerId>|c=<callId>)`, signed/verified by `HmacKeyProvider.kubernetesSecret` reading a mounted Secret with `fs.watch` rotation. `current` + optional `previous` for NFR-8 1h overlap during rotation.
- **Redis**: ClusterIP Services, two distinct Services (`redis-a`, `redis-b`) backed by the StatefulSet pod ordinals.
- **No LoadBalancer**: not needed for the test environment; if required later, install MetalLB.
---
 
## 3. Component Specifications
 
### 3.1 Image Management
 
All custom images (proxy, worker, SIPp scenarios) are built locally and loaded into the kind cluster:
 
```bash
docker build -t sip-proxy:dev ./proxy
docker build -t sip-worker:dev ./worker
kind load docker-image sip-proxy:dev --name sip-e2e
kind load docker-image sip-worker:dev --name sip-e2e
```
 
- Image tag `:dev` is always re-loaded during iteration.
- Production tags `:vX.Y.Z` are reserved for regression baselines.
- All Deployments use `imagePullPolicy: IfNotPresent` (default for non-`:latest` tags), and a tag bump or pod restart is required to pick up new images.
### 3.2 Helm Charts
 
Single umbrella chart `sip-e2e` that pulls in the **production charts** as dependencies, plus test-only subcharts:
 
```
charts/sip-e2e/
├── Chart.yaml                 # depends on sip-front-proxy, b2bua-worker (deploy/helm/)
├── values.yaml
└── charts/
    ├── sip-front-proxy/       # symlink or vendor → deploy/helm/sip-front-proxy/
    ├── b2bua-worker/          # symlink or vendor → deploy/helm/b2bua-worker/
    ├── redis/                 # test-only
    ├── sipp/                  # test-only
    ├── observability/         # test-only Grafana LGTM
    └── chaos/                 # test-only Chaos Mesh scenarios
```
 
The umbrella chart's `values.yaml` exposes the main knobs (replica counts, image tags, chaos enable flags, observability settings) and re-exposes the production charts' values under `sipFrontProxy:` and `b2buaWorker:` keys so test scenarios can flip e.g. `b2buaWorker.terminationGracePeriodSeconds`, `sipFrontProxy.healthProbe.intervalMs`, or `sipFrontProxy.hmac.previousKeyPath` without editing subcharts. The two production charts are the same artefacts that go to staging/prod — the test environment must not fork them.
 
### 3.3 Pod Placement and Anti-Affinity
 
**SIP proxy Deployment:**
 
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sip-proxy
spec:
  replicas: 2
  selector:
    matchLabels:
      app: sip-proxy
  template:
    metadata:
      labels:
        app: sip-proxy
    spec:
      nodeSelector:
        tier: edge
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: sip-proxy
              topologyKey: kubernetes.io/hostname
      containers:
        - name: proxy
          image: sip-proxy:dev
          ports:
            - containerPort: 5060
              protocol: UDP
```
 
**SIP worker StatefulSet** (NOT a Deployment — pod identity matters):
 
The worker MUST be a StatefulSet. The proxy's HMAC stickiness cookie carries `w=<pod-name>`; only StatefulSets give stable, ordinal-derived pod names (`b2bua-worker-0`, `b2bua-worker-1`). A Deployment's randomly-suffixed pod names would force the proxy to re-shard on every restart and would break in-dialog routing across worker restarts.
 
```yaml
apiVersion: v1
kind: Service
metadata:
  name: b2bua-worker            # headless — gives per-pod DNS
  labels:
    app.kubernetes.io/name: b2bua-worker
spec:
  clusterIP: None
  selector:
    app.kubernetes.io/name: b2bua-worker
  ports:
    - port: 5060
      protocol: UDP
      name: sip
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: b2bua-worker
spec:
  serviceName: b2bua-worker     # MUST match the headless Service above
  replicas: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: b2bua-worker
  template:
    metadata:
      labels:
        app.kubernetes.io/name: b2bua-worker   # selector the proxy watches
    spec:
      # Timer C upper bound (3 min INVITE establishment) + safety margin.
      # SIGTERM flips DrainingState → OPTIONS replies 503 + Retry-After:0;
      # the SIP stack stays alive through this entire window so the proxy
      # observes drain through OPTIONS rather than hard timeout (D5).
      terminationGracePeriodSeconds: 200
      nodeSelector:
        tier: app
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app.kubernetes.io/name: b2bua-worker
              topologyKey: kubernetes.io/hostname
      containers:
        - name: worker
          image: sip-worker:dev
          env:
            - name: REDIS_A_HOST
              value: redis-checkpoint-0.redis-checkpoint.default.svc.cluster.local
            - name: REDIS_B_HOST
              value: redis-checkpoint-1.redis-checkpoint.default.svc.cluster.local
```
 
**Redis StatefulSet:**
 
```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis-checkpoint
spec:
  serviceName: redis-checkpoint
  replicas: 2
  selector:
    matchLabels:
      app: redis-checkpoint
  template:
    metadata:
      labels:
        app: redis-checkpoint
    spec:
      nodeSelector:
        tier: app
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: redis-checkpoint
              topologyKey: kubernetes.io/hostname
      containers:
        - name: redis
          image: redis:7-alpine
          ports:
            - containerPort: 6379
```
 
**Note on dual-write semantics:** Both Redis instances are peers, not primary/secondary. Workers write to **both** in parallel for every checkpoint, regardless of co-location. The "local Redis" is just a network-locality optimization for read paths; the write fanout is symmetric. This is critical to preserve dual-write guarantees.
 
### 3.4 Observability Stack
 
Single pod running `grafana/otel-lgtm` (Loki + Tempo + Prometheus + Grafana):
 
- **Loki** for logs (via OpenTelemetry collector sidecars or stdout scraping). Proxy logs are structured JSON; primary correlation key is `callId`.
- **Tempo** for traces (OTLP). The proxy emits one `sip-front-proxy.route` span per inbound message with attributes `sip.method`, `sip.callid`, `routing.strategy`, `routing.decision`, `worker.target` (sample rate env-driven, default 10%).
- **Prometheus** scrapes `/metrics` on each proxy pod (port `9090`, served by the proxy's `MetricsServer`) and on each worker pod.
- **Grafana** for visualization, exposed on host port 3000.

**Proxy metrics emitted** (these are the metric names PR6 ships — dashboards must use these exact names):

| Metric | Type | Labels | Use |
|---|---|---|---|
| `sip_messages_total` | counter | `direction`, `method_or_status`, `result` (forwarded \| rejected \| dropped) | Throughput + reject/drop ratio |
| `sip_routing_duration_seconds` | histogram | `strategy`, `decision` | Routing-path latency (AC-6 target: P99 < 2 ms @ 5K msg/s) |
| `sip_routing_decision_total` | counter | `strategy`, `kind` (`select_new`, `decode_forward`, `decode_reject`, `decode_unknown`, `cancel_lookup_hit`, `cancel_lookup_miss`) | What the strategy decided per request |
| `sip_routing_hmac_failure_total` | counter | `reason` (`missing`, `decode`, `mismatch`, `unknown_kid`) | Cookie tamper / rotation issues |
| `sip_worker_health` | gauge | `worker_id`, `health` (1 for current state, 0 otherwise) | Registry annotation per pod |
| `sip_cancel_lookup_total` | counter | `outcome` (`hit`, `miss`, `expired_sweep`) | LRU correlation health |
| `sip_active_dialogs_estimate` | gauge | — | LRU size as proxy for active dialogs (documented approximation) |

**Pre-provisioned dashboards** (each row in the table above maps to at least one panel):

- **SIP Front Proxy — Routing** — `sip_messages_total` rate, `sip_routing_duration_seconds` percentiles, `sip_routing_decision_total` stacked, `sip_routing_hmac_failure_total` by reason, `sip_cancel_lookup_total{outcome}`.
- **SIP Front Proxy — Worker Health** — `sip_worker_health` heatmap (rows = worker_id, columns = time, color = current health) overlaid with K8s pod events; `sip_active_dialogs_estimate` line.
- **B2BUA Worker** — call processing metrics from the worker side, dialog counts, checkpoint rates, dual-write divergence.
- **Dual-Write Consistency** — Redis metrics, divergence counters, write latency.
- **Chaos Run Summary** — chaos experiment annotations overlaid on the four dashboards above; chaos events should be visible as vertical lines on every panel.
### 3.5 Chaos Mesh
 
Installed via Helm into the `chaos-mesh` namespace. Scenarios are version-controlled YAML manifests in `chaos/scenarios/`:
 
| File | Description | Proxy-front behaviour exercised |
|---|---|---|
| `pod-kill-worker-random.yaml` | Kill 1 SIP worker at random every 30s | Hard crash path: K8s watch sees pod gone before next probe; HealthProbe demotes via consecutive-timeout threshold (~6s); in-dialog requests fall back via `selectForNewDialog` after `drainGraceMs`; new worker hydrates from Redis or replies 481 |
| `pod-kill-proxy-random.yaml` | Kill 1 SIP proxy at random every 60s | NodePort/upstream-LB redistributes; surviving proxy's local registry view is independent (per-proxy local health view, D3); `sip_messages_total{result=dropped}` should not spike at the surviving proxy |
| `pod-kill-redis-random.yaml` | Kill 1 Redis instance at random | Dual-write degrades to single-write; recovery triggers reconciliation |
| `pod-graceful-drain-worker.yaml` | **NEW** — `kubectl delete pod <worker>` (graceful), gives K8s the full `terminationGracePeriodSeconds=200` window | The full D5 drain lifecycle: SIGTERM → DrainingState → OPTIONS replies 503 → proxy's HealthProbe and K8s watch both annotate `draining` (most-restrictive resolution); new INVITEs excluded immediately; in-dialog requests forwarded to draining worker for `drainGraceMs=5s` then fall back; ACK on 2xx and CANCEL **always** go to the draining worker regardless of grace |
| `hmac-key-rotation-during-load.yaml` | **NEW** — write a new key file to `HMAC_KEY_PREVIOUS` mount; restart proxies (or wait for fs-watch); wait 5 min; write new key to `HMAC_KEY_CURRENT`; wait 1 h overlap window; drop `HMAC_KEY_PREVIOUS` | NFR-8 1h overlap: in-dialog requests signed with old kid still verify; new INVITEs use new kid. `sip_routing_hmac_failure_total{reason=unknown_kid}` must remain 0 throughout |
| `k8s-watch-outage.yaml` | **NEW** — kill the K8s API server briefly, or revoke the proxy's RBAC for `pods` for 30s | Graceful degradation: routing path keeps using the last-known registry snapshot (D4); HealthProbe is the only signal during the outage; recovery resyncs via watch reconnect with backoff |
| `network-partition-worker-redis.yaml` | Isolate one worker from one Redis instance for 60s | Local-Redis-only fallback, partial-write detection, reconciliation after partition heals |
| `network-partition-proxy-worker.yaml` | Partition between proxy tier and app tier | All workers appear `dead` after threshold; new INVITEs fail until heal; `sip_routing_decision_total{kind=select_new}` should drop to ~0 |
| `network-delay-uac-proxy.yaml` | Add 200 ms latency on UAC → proxy path | Setup latency P99 increase ≤ added delay; no timeouts |
| `network-loss-uas-worker.yaml` | 5% UDP packet loss on worker → UAS path | SIP retransmissions absorb loss |
| `cpu-stress-worker.yaml` | Pin one worker CPU to 95% for 2 min | Worker can still reply to OPTIONS (else proxy demotes to `dead`); other worker absorbs new calls |
| `pod-stop-redis-a.yaml` | SIGSTOP on Redis-A for 30 s (simulates GC freeze) | Dual-write blocks on Redis-A → degraded write mode |
| `clock-skew-worker.yaml` | Shift clock by +500 ms on one worker | DrainingState `drainingSince` would be skewed at the demoted worker; proxy uses its OWN clock for `drainGraceMs` so behavior is unaffected (validates D4 invariant that registry timestamps are proxy-side) |
| `node-drain-app-1.yaml` | Drain one app node (simulates planned maintenance) | Full app-tier failover; combines worker drain + Redis loss + pod reschedule |

Each scenario is parameterized (duration, target selector, intensity).
 
### 3.6 Test Harness
 
- **Language**: Python with `pytest` + the official `kubernetes` client
- **Layout**:
  - `tests/e2e/` — happy-path scenarios
  - `tests/chaos/` — chaos scenarios with assertions
  - `tests/perf/` — load tests with thresholds
- **Fixtures**: cluster bring-up/tear-down, SIPp setup, metric snapshots, Chaos Mesh injection helpers
- **Reporting**: JUnit XML + HTML, plus a Grafana dashboard URL with the time range pinned to the test run
---
 
## 4. Functional Requirements
 
### 4.1 Lifecycle
 
- **FR-1** Single command brings up the cluster: `make e2e-up` (creates kind cluster, builds images, loads them, installs charts, waits for readiness).
- **FR-2** Single command tears down: `make e2e-down` (deletes cluster, cleans up Docker artifacts).
- **FR-3** Idempotent re-deploy: `make e2e-redeploy` (rebuilds images, reloads, helm upgrades, no full cluster recreation).
- **FR-4** Bring-up time: <3 minutes from clean state to ready, on a developer laptop (8-core, 16 GB RAM).
### 4.2 Test Execution
 
- **FR-5** Run all E2E tests: `make e2e-test`.
- **FR-6** Run a specific chaos scenario: `make chaos SCENARIO=pod-kill-worker-random`.
- **FR-7** Run the full chaos suite: `make e2e-chaos-all` (all chaos scenarios sequentially, with a stabilization window between each).
### 4.3 Determinism
 
- **FR-8** Random seeds for chaos selectors are configurable; default is deterministic per run ID.
- **FR-9** SIPp scenarios run with fixed call rates and durations; no time-of-day variation.
- **FR-10** All test runs are tagged with a unique run ID (timestamp + git SHA) used in metric labels and log indexing.
### 4.4 Assertion Framework
 
- **FR-11** Each chaos test asserts on:
  - Active call count before, during, and after the disturbance
  - Recovery duration (time from injection to stable steady state)
  - Number of dropped calls (vs. tolerance threshold)
  - Number of orphaned dialogs in Redis
  - Absence of error logs above threshold
  - **Proxy-front specific** (added in PR4–PR6):
    - `sip_routing_hmac_failure_total` total delta during the run (must be 0 except for tamper-injection scenarios)
    - `sip_routing_decision_total{kind=cancel_lookup_miss}` delta (CANCELs that fell back to selectForNewDialog — should be 0 except for re-balance + worker-loss combinations)
    - `sip_worker_health` transitions match expected state machine for the injected fault (e.g. CHAOS-11 graceful drain must transition `alive → draining → dead` in that order, never `alive → dead` directly)
    - `sip_routing_duration_seconds` P99 stays under the AC-6 threshold (2 ms) during steady state
- **FR-12** Tests fail if any threshold is breached; failure reports include a Grafana dashboard link with annotated time range.
---
 
## 5. Non-Functional Requirements
 
- **NFR-1** Local resource budget: cluster fits in 8 GB RAM, 4 vCPU, leaving headroom for IDE and other dev tools.
- **NFR-2** Test isolation: each test run uses a fresh namespace or a fresh cluster (configurable); no state leak between runs.
- **NFR-3** Reproducibility: the same git SHA + the same chaos seed yield the same test outcome (within statistical noise).
- **NFR-4** Reporting: test results published as JUnit + HTML, retained locally for at least 7 days.
---
 
## 6. Standard Test Scenarios
 
### 6.1 E2E Sanity (always-green)
 
| ID | Description | Expected |
|---|---|---|
| E2E-1 | Single call setup, BYE, teardown | 200 OK on INVITE, BYE; no errors |
| E2E-2 | 100 concurrent calls, hold 30 s, all teardown | 100/100 success |
| E2E-3 | Re-INVITE during call (SDP renegotiation) | 200 OK on re-INVITE; call continues; in-dialog request traverses the same worker as INVITE (HMAC stickiness) |
| E2E-4 | CANCEL before 200 OK | 487 Request Terminated received; CANCEL reaches the SAME worker as the INVITE (Call-ID + CSeq correlation, RFC 3261 §9.1) |
| E2E-5 | Sustained 50 cps for 5 minutes | 0 errors; P99 setup latency <500 ms |
| E2E-6 | OPTIONS keepalive: probe each worker; assert `sip_worker_health{health=alive}=1` for all workers continuously | Workers reply 200 OK; `sip_routing_decision_total{kind=cancel_lookup_*}` unaffected |
| E2E-7 | Two parallel INVITEs with same Call-ID prefix but different suffix | Rendezvous distributes them; cookie carries different `w=` per dialog |
| E2E-8 | Initial INVITE while one worker is `draining` | Proxy excludes the draining worker from `selectForNewDialog`; INVITE lands on the surviving worker |
 
### 6.2 Chaos Scenarios
 
| ID | Injection | Threshold |
|---|---|---|
| CHAOS-1 | **Hard-kill** 1 worker (of 2) during 100 active calls | Calls on the surviving worker keep going; calls on the killed worker either drop or recover via Redis hydration ≥95% within 10 s. **Detection lag**: ≤ `HealthProbe.intervalMs * threshold = 6s` per D-RES (since K8s watch fires faster, expect ≤ 2 s in practice). `sip_worker_health{worker_id=<killed>,health=dead}=1` after detection. |
| CHAOS-2 | Kill 1 proxy (of 2) during load | 0 calls dropped; <2 s detection; new traffic absorbed by surviving proxy |
| CHAOS-3 | Kill 1 Redis (of 2) | 0 calls dropped; surviving Redis absorbs all dual-writes; reconciliation triggered when killed Redis comes back |
| CHAOS-4 | Network partition worker-1 ↔ Redis-B for 60 s | Worker-1 falls back to local Redis-A only; partial-write metric increments; reconciliation after partition heals; 0 call drops |
| CHAOS-5 | Both Redis instances unavailable for 30 s | Workers continue with degraded mode (in-memory only); resync after recovery; no call drops |
| CHAOS-6 | 5% UDP packet loss on UAC → proxy | Setup success rate ≥99% (SIP retransmissions absorb loss); latency increase acceptable |
| CHAOS-7 | 200 ms added latency proxy ↔ worker | Setup latency P99 increase ≤300 ms; no call timeouts |
| CHAOS-8 | CPU stress 95% on 1 worker | Other worker absorbs new calls; existing calls on stressed worker degrade gracefully |
| CHAOS-9 | Add a new worker mid-load (resharding) | **Existing dialogs unaffected** — they carry an HMAC-signed `w=<old-worker-id>` cookie in their Record-Route, so in-dialog routing stays sticky. **New dialogs** redistribute via rendezvous HRW with the enlarged pool — only ~`1/N` of NEW dialogs move per the rendezvous-hash property. |
| CHAOS-10 | `docker kill` an entire app node | Combined loss of 1 worker + 1 Redis on that node; surviving app node has full local stack; minimal call disruption |
| CHAOS-11 | **Graceful drain** of 1 worker (`kubectl delete pod`) during 100 active calls | New INVITEs **immediately** excluded (K8s `deletionTimestamp` accelerant fires within ~2s, before the next OPTIONS round). In-dialog requests continue to the draining worker for `drainGraceMs=5s`; after grace, fall back via `selectForNewDialog`. **ACK on 2xx and CANCEL exempt** — must reach the draining worker for the entire `terminationGracePeriodSeconds=200` window. Final exit only after grace timer pops. **Zero dropped calls** is the bar. |
| CHAOS-12 | **HMAC key rotation** during sustained 50 cps load | Day 0: write new key to `HMAC_KEY_PREVIOUS` mount → both proxies pick up via fs-watch within 200ms. Day 0+ε: write to `HMAC_KEY_CURRENT` mount → new INVITEs sign with new kid; in-dialog requests with old kid still verify via the previous-key fallback. Day 1: drop `HMAC_KEY_PREVIOUS`. **Threshold**: `sip_routing_hmac_failure_total{reason=unknown_kid}` must stay at 0 across the entire rotation; `sip_messages_total{result=rejected}` must not increment. |
| CHAOS-13 | **K8s watch outage** for 30 s (revoke proxy RBAC for `pods` or kill API server) | Proxy keeps routing using last-known registry snapshot (D4 invariant: routing path is non-blocking, registry reads are pure `Ref.get`). HealthProbe is the only signal during the outage. **Detection**: a worker that dies during the outage is detected via probe timeouts (~6s) instead of via watch (~2s). On recovery, watch reconnects with exponential backoff and resyncs. |
| CHAOS-14 | **Probe vs K8s watch disagreement** — block worker's reply path so probe sees timeouts; K8s watch still shows `Ready=True` | Most-restrictive wins (D5): probe says `dead`, watch says `alive` → registry resolves to `dead`. New INVITEs excluded; existing dialogs fall back after grace. When the reply path is unblocked, probe says `alive` again → registry resolves to `alive`. |
| CHAOS-15 | **CANCEL across re-balance** — start a long-ringing INVITE on worker A; add worker B mid-ring; UAC sends CANCEL | CANCEL must reach worker A (CancelBranchLru is keyed on `(Call-ID, CSeq number)` per RFC 3261 §9.1, NOT on the rendezvous output that just changed). `sip_routing_decision_total{kind=cancel_lookup_hit}` increments; `cancel_lookup_miss` does NOT. |
 
### 6.3 Performance Baselines
 
| ID | Profile | Target |
|---|---|---|
| PERF-1 | 100 cps, 60 s hold, 10 min | P99 setup <500 ms, 0 drops, memory stable |
| PERF-2 | 500 cps burst (10 s), then 100 cps steady | No backlog buildup, recovery <30 s |
| PERF-3 | 24 h soak at 50 cps | No memory leak, no FD leak, no Redis growth |
 
---
 
## 7. Directory Structure
 
```
sip-e2e/
├── cluster.yaml                 # kind config
├── Makefile                     # entry points (up, down, test, chaos)
├── charts/                      # Helm umbrella + subcharts
│   └── sip-e2e/
│       ├── Chart.yaml
│       ├── values.yaml
│       └── charts/
│           ├── proxy/
│           ├── worker/
│           ├── redis/
│           ├── sipp/
│           ├── observability/
│           └── chaos/
├── chaos/
│   └── scenarios/               # Chaos Mesh manifests
├── tests/
│   ├── e2e/
│   ├── chaos/
│   ├── perf/
│   └── conftest.py              # pytest fixtures
├── sipp/
│   └── scenarios/               # XML scenario files
├── dashboards/                  # Grafana JSON dashboards
└── docs/
    ├── runbook.md
    ├── adding-scenarios.md
    └── troubleshooting.md
```
 
---
 
## 8. Acceptance Criteria
 
- **AC-1** Fresh laptop: `git clone` + `make e2e-up` + `make e2e-test` completes successfully in <10 minutes.
- **AC-2** All E2E sanity tests pass on a clean cluster.
- **AC-3** Chaos scenarios CHAOS-1 through CHAOS-10 produce stable, non-flaky results across 10 consecutive runs on a developer laptop.
- **AC-4** Test report includes a pinned Grafana URL; clicking shows the test run's metrics with chaos events annotated.
- **AC-5** Adding a new chaos scenario requires only: a YAML manifest + a Python test file; no framework modification.
- **AC-6** Cluster brought down cleanly with no Docker orphans (`docker ps -a` and `docker volume ls` clean after `make e2e-down`).
- **AC-7** Killing an entire `app` node (`docker kill`) confirms combined-failure behavior matches CHAOS-10 expectations.
---
 
## 9. Risks and Mitigations
 
| Risk | Impact | Mitigation |
|---|---|---|
| Test flakiness from timing-sensitive chaos | False local failures | Use deterministic seeds; allow a small number of retries on chaos tests (not on E2E sanity) |
| Resource exhaustion on developer laptop | Tests OOM, system slowdown | Tunable replica counts via `values.yaml`; "small" profile for constrained environments |
| kind networking quirks (UDP, NAT) | Tests behave differently than expected | Pin kind version; test UDP path explicitly in E2E sanity |
| Chaos Mesh CRD version drift | Scenarios break on upgrade | Pin Chaos Mesh version; upgrade in a dedicated PR with full test re-run |
| SIPp version differences | Scenario incompatibility across machines | Pin SIPp image; document required version in `runbook.md` |
| Co-located worker + Redis means losing both on node death | Less granular failure isolation | This is the **intended** behavior to mirror real host loss; pod-level chaos via Chaos Mesh covers the granular cases |
| StatefulSet anti-affinity prevents Redis rescheduling on node loss | Redis pod stays Pending until node returns | This is also intended: it mirrors production (you don't want a new Redis silently appearing without operator awareness); recovery requires explicit node bring-back or scale operation |
| **Worker StatefulSet pod-name reuse after delete + recreate** | Same pod name (e.g. `b2bua-worker-0`) but different `podIP` could fool the proxy into routing in-dialog requests to a fresh, empty worker | The `WorkerRegistry.kubernetesStatefulSet` impl tracks `(id, address)` as one unit — an `address_changed` event is emitted on rebind, and the proxy re-keys its local routing tables. Validated by E2E-3 and CHAOS-11. |
| **HMAC rotation skew across the proxy fleet** | Proxy A picks up the new key via fs-watch before Proxy B → in-dialog request signed by A fails to verify at B during the lag | Both proxies hold `current` + `previous` (NFR-8 1h overlap). Operator rotation procedure (`docs/sip-front-proxy/hmac-rotation-runbook.md`) writes to the `previous` mount first, waits for fs-watch propagation across all replicas, then promotes to `current`. CHAOS-12 exercises this. |
| **K8s API watch outage** | Proxy can't see pod state changes | D4 invariant holds: routing path uses cached `Ref` snapshot. HealthProbe is the secondary signal during the outage. CHAOS-13 validates graceful degradation. |
| **Probe vs K8s watch disagreement** | One source says `alive`, the other says `draining`/`dead` | Most-restrictive resolution (D5): `dead > draining > alive`. CHAOS-14 validates. |
| **Rendezvous re-shard on registry change** | Adding/removing a worker could move existing dialogs | False alarm — the HMAC stickiness cookie in Record-Route pins in-dialog routing to the original worker; rendezvous only affects NEW dialogs. CHAOS-9 and CHAOS-15 validate; ~`1/N` of NEW dialogs move per rendezvous-hash property. |
| **`terminationGracePeriodSeconds` too short** | SIGKILL fires before in-flight INVITEs finish; calls drop on graceful drain | Hardcoded to 200s in both Helm charts (Timer C max + safety per D-RES). Don't lower it without re-running CHAOS-11. |
 
---
 
## 10. Deliverables
 
- **D-1** `kind` cluster configuration and bring-up scripts
- **D-2** Helm umbrella chart with all subcharts
- **D-3** Chaos Mesh scenario library (10 scenarios minimum)
- **D-4** Pytest harness with fixtures and assertion library
- **D-5** Grafana dashboards (4 minimum, JSON)
- **D-6** Documentation: runbook, contributing guide, troubleshooting
---
 
## Appendix A — Killing Scenarios at Three Granularities
 
A core property of this topology is that failures can be tested at **three granularities**, each exposing different code paths in the proxy-front philosophy:
 
| Action | Effect | Proxy-front signal | Tests |
|---|---|---|---|
| `kubectl delete pod sip-proxy-X` | Pod-level proxy loss; node intact | Other proxy's local registry view unaffected (per-proxy local health, D3) | Proxy HA, traffic absorption by peer, restart loop |
| `docker kill <edge-node>` | Node-level proxy loss; pod replaced elsewhere only after node returns | NodePort/upstream-LB redistributes | NodePort failover, real host loss simulation |
| `kubectl delete pod b2bua-worker-X` (graceful) | **Graceful drain**: SIGTERM → DrainingState → OPTIONS 503 + Retry-After:0; K8s deletionTimestamp accelerant | Proxy demotes to `draining` immediately; in-dialog grace `drainGraceMs=5s`; ACK/CANCEL exempt; final exit only after `terminationGracePeriodSeconds=200` | CHAOS-11 (full D5 lifecycle) |
| `kubectl delete pod b2bua-worker-X --grace-period=0 --force` | **Hard kill**: no SIGTERM, no drain | K8s watch fires fast (~2s); HealthProbe demotes to `dead` after `intervalMs * threshold` (~6s) regardless | CHAOS-1 (hard crash path) |
| `kubectl delete pod redis-checkpoint-X` | Pod-level Redis loss; worker on the same node intact | Worker continues with degraded dual-write | CHAOS-3 |
| `docker kill <app-node>` | Combined loss of worker + Redis on that node | Worker disappears WITHOUT graceful drain → hard-crash path; surviving app node has full local stack | CHAOS-10 |
| Network chaos isolating an app node | Worker on isolated node can only reach local Redis | Worker still answers OPTIONS (probe sees `alive`) BUT can't replicate to the partitioned Redis | CHAOS-4 |
| Network chaos blocking worker's SIP reply path only | Worker is "alive" to K8s but invisible to SIP probe | Most-restrictive resolution: probe says `dead`, watch says `alive` → `dead` wins | CHAOS-14 |
| `kubectl exec proxy -- chmod 000 /etc/secrets/hmac/key` (or rotate) | Proxy's HMAC source changes mid-flight | fs-watch debounce 200ms; reload failure logs + retains prior key (D4) | CHAOS-12 (operator-driven), `hmac-rotation-runbook.md` |

This three-granularity split is what the proxy-front philosophy exists to handle: **graceful drain** is the common case (rolling deploys, node maintenance) and must be invisible to active calls; **hard kill** is the chaos-engineering case and must bound the call-loss radius via probe + Redis hydration; **node loss** is the catastrophic case and must not silently re-shard active dialogs.

Co-locating worker and Redis on the same `app` node is what makes the realistic catastrophic case (entire host dies) directly testable with a single `docker kill`.