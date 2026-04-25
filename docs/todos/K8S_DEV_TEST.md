Plan 2 — Kubernetes Test Environment for SIP Stack

1. Purpose and Scope

Provide a reproducible, automated Kubernetes environment for end-to-end and chaos testing of the SIP stack (front proxy + B2BUA workers + Redis dual-write). Designed for local development, CI nightly runs, and on-demand reproduction of failure scenarios.
Goals:

One-command bring-up and tear-down
Deterministic and reproducible test runs
Fault injection at multiple layers (process, network, resource)
Continuous metrics collection for regression analysis
Local-first (developer laptop) but CI-portable (GitHub Actions, GitLab CI)

Out of scope:

Production-grade hardening of the test cluster itself
Multi-region or multi-cluster topologies
Performance benchmarking against production hardware (use a dedicated benchmark cluster for that)


2. Cluster Topology
2.1 Base Cluster

kind (Kubernetes IN Docker) as the cluster runtime
1 control-plane node + 4 worker nodes
Kubernetes version: track latest stable minus one (e.g., if 1.32 is latest, use 1.31)
CNI: default kindnet (sufficient for UDP and chaos networking)

yaml# cluster.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: sip-e2e
nodes:
  - role: control-plane
  - role: worker
    labels:
      role: sip-proxy
  - role: worker
    labels:
      role: sip-worker
  - role: worker
    labels:
      role: sip-worker
  - role: worker
    labels:
      role: redis
extraPortMappings:
  - containerPort: 30060   # SIP UDP exposed
    hostPort: 5060
    protocol: UDP
  - containerPort: 30090   # Grafana
    hostPort: 3000
    protocol: TCP

2.2 Workload Layout

ComponentReplicasNode selectorNotesSIP front proxy2role=sip-proxyActive/active behind NodePort UDPB2BUA worker3role=sip-workerPod anti-affinity preferredRedis-A (checkpoint)1role=redisStatefulSet, anti-affinityRedis-B (checkpoint)1role=redisStatefulSet, anti-affinitySIPp UAC (load gen)1-NanyJob or DeploymentSIPp UAS (sink)1-NanyJob or DeploymentGrafana LGTM1anySingle-pod observability stackChaos Meshsystemsystem namespaceHelm install
2.3 Networking

SIP exposure: NodePort UDP 30060 mapped to host 5060 (single ingress for SIPp UAC running outside cluster, or cluster-internal Service for SIPp inside cluster).
Worker discovery by proxy: Kubernetes headless Service + DNS SRV, or label-based pod discovery via API.
Redis: ClusterIP Services, two distinct ones (redis-a, redis-b).
No LoadBalancer: not needed for test env; if required later, install MetalLB.

3. Component Specifications
3.1 Image Management

All custom images (proxy, worker, SIPp scenarios) built locally and loaded:

  docker build -t sip-proxy:dev ...
  kind load docker-image sip-proxy:dev --name sip-e2e

Image tag :dev always re-loaded; production tags :vX.Y.Z for regression baselines.

3.2 Helm Charts
Single umbrella chart sip-e2e with subcharts:

proxy/ — front proxy
worker/ — B2BUA worker
redis/ — dual Redis StatefulSets with anti-affinity
sipp/ — load generator and sink
observability/ — Grafana LGTM stack
chaos/ — Chaos Mesh experiments as templated CRDs

3.3 Anti-Affinity Constraints
yaml# Required for Redis pair (must be on distinct nodes)
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            app: redis-checkpoint
        topologyKey: kubernetes.io/hostname
Workers and proxies use preferred anti-affinity (not required) to allow scheduling flexibility on small clusters.
3.4 Observability Stack
Single pod running grafana/otel-lgtm (consistent with existing dev setup):

Loki for logs (via OpenTelemetry collector sidecar on each pod)
Tempo for traces (OTLP)
Prometheus for metrics (scrape proxy and worker /metrics)
Grafana for visualization

Pre-provisioned dashboards:

SIP Routing Overview (proxy metrics)
B2BUA Worker Health (worker metrics)
Dual-Write Consistency (Redis metrics + divergence)
Chaos Run Summary (annotations + impact)

3.5 Chaos Mesh
Installed via Helm. Scenarios defined as YAML manifests in chaos/scenarios/:

pod-kill-worker-random.yaml: kill 1 worker at random every 30s
pod-kill-proxy-random.yaml: kill 1 proxy at random every 60s
network-partition-worker-redis.yaml: isolate one worker from one Redis instance for 60s
network-delay-uac-proxy.yaml: add 200ms latency on UAC → proxy path
network-loss-uas-worker.yaml: 5% packet loss on worker → UAS UDP
cpu-stress-worker.yaml: pin one worker CPU to 95% for 2 min
pod-stop-redis-a.yaml: SIGSTOP on Redis-A for 30s (simulates GC freeze)
clock-skew-worker.yaml: shift clock by +500ms on one worker

Each scenario is parameterized (duration, target selector, intensity) and version-controlled.

3.6 Test Harness

Language: Python with pytest + kubernetes client + requests
Layout:

k8stests/e2e/ — happy-path scenarios
k8stests/chaos/ — chaos scenarios with assertions
k8stests/perf/ — load tests with thresholds


Fixtures: cluster bring-up/tear-down, SIPp setup, metric snapshots, Chaos Mesh injection
Reporting: JUnit XML + HTML, plus Grafana dashboard URL with time range pinned to test run

4. Functional Requirements
4.1 Lifecycle

FR-1 Single command brings up the cluster: make e2e-up (creates kind cluster, builds images, loads them, installs charts, waits for readiness).
FR-2 Single command tears down: make e2e-down (deletes cluster, cleans up Docker artifacts).
FR-3 Idempotent re-deploy: make e2e-redeploy (rebuilds images, reloads, helm upgrades, no full cluster recreation).
FR-4 Bring-up time: <3 minutes from clean state to ready, on a developer laptop (8-core, 16 GB RAM).

4.2 Test Execution

FR-5 Run all E2E tests: make e2e-test.
FR-6 Run a specific chaos scenario: make chaos SCENARIO=pod-kill-worker-random.
FR-7 Run nightly regression suite (CI): make e2e-nightly runs all chaos scenarios sequentially, generates report, uploads artifacts.

4.3 Determinism

FR-8 Random seeds for chaos selectors are configurable; default deterministic per run ID.
FR-9 SIPp scenarios run with fixed call rates and durations; no time-of-day variation.
FR-10 All test runs tagged with a unique run ID (timestamp + git SHA) used in metric labels and log indexing.

4.4 Assertion Framework

FR-11 Each chaos test asserts on:

Active call count before/during/after disturbance
Recovery duration (time from injection to stable steady state)
Number of dropped calls
Number of orphaned dialogs in Redis
Absence of error logs above threshold


FR-12 Tests fail if any threshold is breached; failure reports include Grafana dashboard link with annotated time range.

5. Non-Functional Requirements

NFR-1 Local resource budget: cluster fits in 8 GB RAM, 4 vCPU.
NFR-2 CI resource budget: GitHub Actions standard runner (7 GB RAM, 2 vCPU); reduce SIPp call rate accordingly.
NFR-3 Test isolation: each test run uses a fresh namespace or a fresh cluster (configurable); no state leak between runs.
NFR-4 Reproducibility: same git SHA + same chaos seed → same test outcome (within statistical noise).
NFR-5 Reporting: test results published as JUnit + HTML, retained for 30 days in CI artifacts.

6. Standard Test Scenarios
6.1 E2E Sanity (always-green)
IDDescriptionExpectedE2E-1Single call setup, BYE, teardown200 OK on INVITE, BYE, no errorsE2E-2100 concurrent calls, hold 30s, all teardown100/100 successE2E-3Re-INVITE during call (SDP renegotiation)200 OK on re-INVITE, call continuesE2E-4CANCEL before 200 OK487 Request Terminated receivedE2E-5Sustained 50 cps for 5 minutes0 errors, P99 setup latency <500ms
6.2 Chaos Scenarios
IDInjectionThresholdCHAOS-1Kill 1 worker (of 3) during 100 active calls≥66% calls survive (those on other workers); recovered: ≥95% within 10s if hydration enabledCHAOS-2Kill 1 proxy (of 2) during load0 calls dropped; <2s detection; new traffic absorbedCHAOS-3Network partition worker ↔ Redis-A for 60s0 calls dropped (Redis-B absorbs writes); divergence reconciled <30s after partition healsCHAOS-4Both Redis instances unavailable for 30sWorkers continue with degraded mode (in-memory); resync after recovery; no call dropsCHAOS-55% UDP packet loss on UAC → proxySetup success rate ≥99% (SIP retransmissions absorb); latency increase acceptableCHAOS-6200ms added latency proxy ↔ workerSetup latency P99 increase ≤300ms; no call timeoutsCHAOS-7CPU stress 95% on 1 workerOther workers absorb new calls; existing calls on stressed worker degrade gracefullyCHAOS-8Add a new worker mid-load (resharding)Existing dialogs unaffected (cookie); new dialogs distribute
6.3 Perf Baselines
IDProfileTargetPERF-1100 cps, 60s hold, 10 minP99 setup <500ms, 0 drops, memory stablePERF-2500 cps burst (10s), then 100 cps steadyNo backlog buildup, recovery <30sPERF-324h soak at 50 cpsNo memory leak, no FD leak, no Redis growth

7. CI Integration
7.1 GitHub Actions Workflow

for future version

7.2 Failure Handling

Test failure does not auto-tear-down cluster in dev mode (developer can inspect).
In CI: cluster torn down regardless, but logs and metrics dumped to artifacts first.
Flaky tests quarantined (separate suite, not blocking merges, alerted weekly).


9. Acceptance Criteria

AC-1 Fresh laptop: git clone + make e2e-up + make e2e-test completes successfully in <10 min.
AC-2 All E2E sanity tests pass on every PR build.
AC-3 Chaos scenarios CHAOS-1 through CHAOS-8 produce stable, non-flaky results across 10 consecutive nightly runs.
AC-4 Test report includes pinned Grafana URL; clicking shows the test run's metrics.
AC-5 Adding a new chaos scenario requires only: a YAML manifest + a Python test file; no framework modification.
AC-6 Cluster brought down cleanly, no Docker orphans (docker ps -a and docker volume ls clean after make e2e-down).

10. Risks and Mitigations

RiskImpactMitigationTest flakiness from timing-sensitive chaosFalse CI failuresUse deterministic seeds; allow retries on chaos tests (not E2E)Resource exhaustion on CI runnerTests OOMTunable replica counts; "small" profile for CI, "large" for nightlykind networking quirks (UDP, NAT)Tests pass locally, fail in CIRun identical workflow on CI from day 1; pin kind versionChaos Mesh CRD version driftScenarios break on upgradePin Chaos Mesh version; upgrade in dedicated PRSIPp version differencesScenario incompatibilityPin SIPp image; document required versionImage pull rate limits (Docker Hub)CI failuresMirror critical images to GHCR or self-hosted registry
11. Deliverables

D-1 kind cluster configuration and bring-up scripts
D-2 Helm umbrella chart with all subcharts
D-3 Chaos Mesh scenario library (8 scenarios minimum)
D-4 Pytest harness with fixtures and assertion library
D-5 Grafana dashboards (4 minimum, JSON)
D-6 Documentation: runbook, contributing guide, troubleshooting