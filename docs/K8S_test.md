# K8s test environment — operator guide

How to bring up, tear down, rebuild, and run the K8s-tier tests for the
sip-front-proxy load-balancer mechanism. For the *plan* and Phase A
status, see [docs/todos/K8S_DEV_TEST.md](todos/K8S_DEV_TEST.md). For
host setup (kind/kubectl/helm install + inotify limits), see
[docs/installation/k8s-test-prereqs.md](installation/k8s-test-prereqs.md).

All commands assume cwd = repo root.

---

## 1. One-time setup

Done once per host. Idempotent.

```bash
# Verify CLIs are installed (see docs/installation/k8s-test-prereqs.md
# if any are missing).
kind --version && kubectl version --client=true | head -1 && helm version --short

# Verify inotify limits are bumped (else kube-proxy crashloops).
cat /proc/sys/fs/inotify/max_user_instances     # → 8192 (not 128)
```

---

## 2. Daily commands

### Start cluster (idempotent)

```bash
npm run test:k8s:up
```

What it does: creates the `sip-e2e` kind cluster from
[tests/k8s/cluster.yaml](../tests/k8s/cluster.yaml) (1 control + 2 edge +
2 app + 1 load node) if not already running. ~30s warm, ~2–3 min cold.
No-op if cluster already exists.

### Tear down cluster (and Docker artifacts)

```bash
npm run test:k8s:down
```

Deletes the kind cluster. Underlying Docker volumes get cleaned up by kind.

### Recreate from scratch

```bash
npm run test:k8s:fresh
```

`down` + `up` + run all tests. Use when chart manifests change or for
debugging cluster state.

---

## 3. Image build + reload

### Force rebuild and reload `sipjsserver:dev`

```bash
npm run test:k8s:images
```

Runs `docker build -t sipjsserver:dev .` then
`kind load docker-image sipjsserver:dev --name sip-e2e`. Slow part is the
`kind load` (~10–15 s per image). The `docker build` short-circuits on
unchanged source.

After loading a fresh image you typically want to roll the pods so they
pick up the new image:

```bash
# Roll the StatefulSet (workers).
kubectl -n sip-test rollout restart statefulset b2bua-worker
kubectl -n sip-test rollout status   statefulset b2bua-worker --timeout=120s

# Roll the Deployment (proxy). Anti-affinity is `preferred` in test
# values so rolling updates don't deadlock.
kubectl -n sip-test rollout restart deployment sip-front-proxy
kubectl -n sip-test rollout status   deployment sip-front-proxy --timeout=120s
```

### Build the SIPp image (rare — only when its Dockerfile changes)

```bash
docker build -t sipp:dev tests/k8s/charts/sipp/
kind load docker-image sipp:dev --name sip-e2e
```

---

## 4. Install / reinstall the SUT into a namespace

The harness installs three charts into a single namespace (`sip-test` by
default): `sipp` + `b2bua-worker` + `sip-front-proxy`. Each
`b2bua-worker` pod runs its own Redis sidecar (no shared Redis chart;
see `docs/replication/call-cache-backup.md`).

### One-shot install

```bash
npx tsx tests/k8s/scripts/install-stack.ts sip-test
```

Idempotent — safe to re-run; `helm upgrade --install` per chart with
`--wait`.

### Apply changes to a single chart

```bash
# Worker
helm upgrade b2bua-worker deploy/helm/b2bua-worker \
  -n sip-test -f tests/k8s/values/b2bua-worker.yaml --wait --timeout 120s

# Proxy
helm upgrade sip-front-proxy deploy/helm/sip-front-proxy \
  -n sip-test -f tests/k8s/values/sip-front-proxy.yaml --wait --timeout 120s

# SIPp (UAS + mock-call-control + scenarios ConfigMap)
helm upgrade sipp tests/k8s/charts/sipp -n sip-test --wait --timeout 60s
```

### Tear down everything in a namespace

```bash
kubectl delete namespace sip-test --wait=true
```

---

## 5. Running tests

> **Important: Never run K8s tests in parallel.** The shared `sip-test`
> namespace has no per-test isolation; concurrent tests would collide on
> StatefulSet replica counts, SIPp Job names, and proxy/worker
> registry state. The vitest config enforces a single fork
> ([vitest.config.k8s.ts](../vitest.config.k8s.ts) sets
> `forks: { singleFork: true }`).

### Run a single test (recommended)

```bash
npx vitest run -c vitest.config.k8s.ts tests/k8s/proxy-routing.test.ts
npx vitest run -c vitest.config.k8s.ts tests/k8s/proxy-drain.test.ts
npx vitest run -c vitest.config.k8s.ts tests/k8s/proxy-scale.test.ts
npx vitest run -c vitest.config.k8s.ts tests/k8s/proxy-hmac.test.ts
npx vitest run -c vitest.config.k8s.ts tests/k8s/smoke.test.ts
npx vitest run -c vitest.config.k8s.ts tests/k8s/queries.smoke.test.ts
```

Each invariant test passes in isolation. Runtime per file: 6–30 s.

### Run the full suite (with caveats)

```bash
npm run test:k8s
```

Brings the cluster up if needed, then runs every file under
`tests/k8s/**/*.test.ts`. **Phase A limitation:** the suite-level run is
flaky because workers accumulate transaction-timeout state across tests
(notably INV-2's intentionally-failing burst-B leaves stuck transactions
the worker times out for ~30 s). The fix is per-test namespace
isolation; tracked in [docs/todos/K8S_DEV_TEST.md](todos/K8S_DEV_TEST.md)
under "Findings".

**Workaround until per-test isolation lands:** between flaky test files,
roll the workers:

```bash
kubectl -n sip-test rollout restart statefulset b2bua-worker
kubectl -n sip-test rollout status   statefulset b2bua-worker --timeout=120s
```

### Pick a different namespace

```bash
K8S_TEST_NAMESPACE=my-ns npx vitest run -c vitest.config.k8s.ts tests/k8s/smoke.test.ts
```

The harness reads `K8S_TEST_NAMESPACE` (default `sip-test`). Useful if
you want a private sandbox while another run is in progress (note: the
`b2bua-worker` StatefulSet name + Service name are shared between
namespaces, so the proxy's K8s pod-watch is namespace-scoped already
and won't cross-contaminate).

---

## 6. Verification — checking correct behavior

### Cluster-level

```bash
# All nodes Ready, tier labels correct.
kubectl get nodes -L tier
# Expected: 1 control-plane (no tier), 2 edge, 2 app, 1 load.

# kube-proxy on every node (else cluster networking is broken).
kubectl -n kube-system get ds kube-proxy
# READY column must equal DESIRED. If not, bump inotify limits.

# CoreDNS Running.
kubectl -n kube-system get pods -l k8s-app=kube-dns
```

### Stack-level (per namespace)

```bash
# All workload pods Running, READY 1/1, on the right tier nodes.
kubectl -n sip-test get pods -o wide

# Helm releases healthy.
helm -n sip-test list

# Worker StatefulSet replicas.
kubectl -n sip-test get statefulset b2bua-worker

# Services + endpoints.
kubectl -n sip-test get svc
kubectl -n sip-test get endpoints
# `b2bua-worker` headless Service should list each worker pod IP.
# `sip-front-proxy` ClusterIP should resolve from inside the cluster.
```

### Proxy behavior

```bash
# Proxy startup banner.
kubectl -n sip-test logs deploy/sip-front-proxy | head -3
# Expected: "sip-front-proxy ... mode=kubernetes ns=sip-test sts=b2bua-worker"

# Live routing decisions across both proxy pods (multi-pod fetch).
kubectl -n sip-test logs -l app.kubernetes.io/name=sip-front-proxy \
  --prefix --max-log-requests=10 --tail=200 | grep "routed"

# Distribution of decision kinds (sanity for INV-5 path coverage).
kubectl -n sip-test logs -l app.kubernetes.io/name=sip-front-proxy \
  --prefix --max-log-requests=10 --tail=500 \
  | grep "routed" | grep -oE "decision=[^,]+" | sort | uniq -c

# Env vars actually applied to a proxy pod.
kubectl -n sip-test exec deploy/sip-front-proxy -- env | grep PROXY_

# HMAC keys mounted as files (Secret projection).
kubectl -n sip-test exec deploy/sip-front-proxy -- ls /etc/sip-proxy/hmac
# Expected: current  previous
```

### Worker behavior

```bash
# Worker connects to its sidecar Redis + binds UDP on pod IP (not 0.0.0.0).
kubectl -n sip-test logs b2bua-worker-0 -c worker | head -10
# Expected lines:
#   "Redis connected to redis://localhost:6379"
#   "UDP socket listening on <POD_IP>:5060 (queueMax=100, ...)"

# Sidecar Redis on the same pod (separate container).
kubectl -n sip-test exec b2bua-worker-0 -c redis -- redis-cli ping
# Expected: PONG

# Per-pod partitioning: pri:<pod>:* on the pod's own sidecar,
# bak:<peer>:* on the peer's sidecar. No cross-pollination.
kubectl -n sip-test exec b2bua-worker-0 -c redis -- redis-cli keys 'sipas:pri:b2bua-worker-0:*'
kubectl -n sip-test exec b2bua-worker-1 -c redis -- redis-cli keys 'sipas:bak:b2bua-worker-0:*'
# (Empty until a call lands; populated as the proxy stamps w_pri/w_bak.)

# Per-call activity (timeout warnings indicate stuck transactions —
# normal during a chaotic test, alarming if persistent).
kubectl -n sip-test logs b2bua-worker-0 --tail=20

# Check if a specific Call-ID was handled by this worker.
kubectl -n sip-test logs b2bua-worker-0 | grep "MyCallId"
```

### Mock call-control + UAS

```bash
# Mock call-control is up and configured.
kubectl -n sip-test logs deploy/call-control
# Expected: "mock call-control listening on :8080, target=sipp-uas:5060"

# Direct healthz check (in-cluster).
kubectl -n sip-test exec deploy/call-control \
  -- wget -qO- http://localhost:8080/healthz
# Expected: {"ok":true}

# UAS pod up (no logs until it gets a call — normal).
kubectl -n sip-test get pod -l app.kubernetes.io/name=sipp-uas
```

### One-call smoke from inside the cluster

```bash
# Fire one INVITE through proxy → worker → mock-call-control → UAS.
# Cleans itself up via `--rm`.
kubectl -n sip-test run sipp-smoke --rm -i --restart=Never \
  --image=sipp:dev --image-pull-policy=IfNotPresent \
  --overrides='{"spec":{"containers":[{"name":"sipp-smoke","image":"sipp:dev","stdin":true,"args":["sip-front-proxy:5060","-s","test","-sf","/scenarios/uac-basic.xml","-m","1","-trace_msg","-message_file","/dev/stdout","-timeout","10s"],"volumeMounts":[{"name":"scenarios","mountPath":"/scenarios"}]}],"volumes":[{"name":"scenarios","configMap":{"name":"sipp-scenarios"}}]}}'
# Expected: full SIP trace ending with "Test Terminated" and "Successful call: 1".
```

### When tests start failing — quick triage

```bash
# 1. Are stale SIPp Jobs holding sockets?
kubectl -n sip-test get jobs
kubectl -n sip-test delete jobs --all   # safe; Jobs auto-clean after TTL

# 2. Are workers in a clean state?
kubectl -n sip-test logs b2bua-worker-0 --tail=10
# Look for repeated "Transaction timeout" or "not found on checkout" —
# means stuck call-state from a prior test.

# 3. Hard reset workers.
kubectl -n sip-test rollout restart statefulset b2bua-worker
kubectl -n sip-test rollout status   statefulset b2bua-worker --timeout=120s

# 4. If totally stuck, nuke + reinstall (≈30 s).
kubectl delete namespace sip-test --wait=true
npx tsx tests/k8s/scripts/install-stack.ts sip-test
```

---

## 7. Failover test suite

The failover suite (plan:
[docs/plan/proper-end-to-end-cheerful-lobster.md](plan/proper-end-to-end-cheerful-lobster.md))
runs sustained sipp load through the proxy and kills a pod mid-call,
then measures end-to-end survival across the matrix of `(state-at-kill
× outcome)`. It is **not** part of `npm run test:k8s` — the inner-loop
K8s suite stays fast; failover is opt-in or nightly.

The 7 tests covering 1 promoted scenario + 6 new failover scenarios:

| File | Phase | Kill mode | Lifecycle |
|------|-------|-----------|-----------|
| `proxy-drain.test.ts` | regression | graceful drain | `uac-hold.xml` (3 s pause) |
| `proxy-failover-lb-delete.test.ts` | 2a | `delete --grace=0 --force` (proxy) | `uac-basic.xml` |
| `proxy-failover-lb-killdash9.test.ts` | 2b | `kill -9 1` in proxy container | `uac-basic.xml` |
| `proxy-failover-worker-delete-hold.test.ts` | 3a-B | `delete --grace=0 --force` (worker) | `uac-hold-failover.xml` (10 s pause) |
| `proxy-failover-worker-killdash9-hold.test.ts` | 3b-B | `kill -9 1` in worker container | `uac-hold-failover.xml` |
| `proxy-failover-worker-delete-pingpong.test.ts` | 3a-C | `delete --grace=0 --force` (worker) | `uac-pingpong.xml` |
| `proxy-failover-worker-killdash9-pingpong.test.ts` | 3b-C | `kill -9 1` in worker container | `uac-pingpong.xml` |

### 7.1 Run the whole failover suite

```bash
# Bring kind up (idempotent), then run all 7 tests sequentially.
npm run test:k8s:failover
```

Wall-clock for one full pass: ~5 min (3 short + 4 long). Tests are
sequential by design (the suite mutates pod state; concurrent runs
collide). The suite is also chained into `npm run test:nightly`.

### 7.2 Run a single scenario

```bash
# Just the LB delete-grace0 case.
npx vitest run -c vitest.config.k8s.ts tests/k8s/proxy-failover-lb-delete.test.ts

# Just the headline pingpong + worker kill-9 case.
npx vitest run -c vitest.config.k8s.ts tests/k8s/proxy-failover-worker-killdash9-pingpong.test.ts
```

### 7.3 Tune the sizing

All 4 knobs are env-var overridable. Defaults match the plan; lower
them for quick local sanity, raise for stress.

| Variable | Default (3a-B / 2a/2b) | Default (3a-C / 3b-C "pingpong") |
|---------|-----------------------|----------------------------------|
| `K8S_FAILOVER_CPS`      | 20  | (uses `K8S_FAILOVER_CPS_C`, default 10) |
| `K8S_FAILOVER_RAMP_S`   | 5   | (uses `K8S_FAILOVER_RAMP_S_C`, default 15) |
| `K8S_FAILOVER_POSTKILL_S` | 10 | (uses `K8S_FAILOVER_POSTKILL_S_C`, default 30) |

```bash
# Quick local sanity: 5 cps, 3s ramp, 5s post-kill (≈8s of load).
K8S_FAILOVER_CPS=5 K8S_FAILOVER_RAMP_S=3 K8S_FAILOVER_POSTKILL_S=5 \
  npx vitest run -c vitest.config.k8s.ts tests/k8s/proxy-failover-lb-delete.test.ts
```

### 7.4 Verify a single run's results

Every run writes an archive under `test-results/k8s-failover/<runId>/`.
The first thing to look at is `summary.txt`:

```bash
# Most recent archive (any scenario).
ls -1t test-results/k8s-failover/ 
cat test-results/k8s-failover/<runId>/summary.txt
```

Expected layout

```
scenario: phase-3a-B-worker-delete-hold
total calls: 300

state x outcome (counts):
state \ outcome      clean  retransmitted  establish-failed  bye-timeout  mid-dialog-error
unaffected           148    0              0                 0            0
established-on-dying  47    2              0                 1            0
in-flight-on-dying     0    0              8                 0            0
pre-routed-on-dying    3    1              0                 0            0

rollup counters:
  re-emissions:        12
  establish-failures:  8
  badly-treated:       1
```

The hard gate is `unaffected.failed == 0` — the entire `unaffected`
row's `establish-failed`, `bye-timeout`, and `mid-dialog-error` cells
must all be zero. Survival in the other rows is logged but not
asserted (until per-population thresholds are added; see
[docs/todos/K8S_FAILOVER_FOLLOWUPS.md](todos/K8S_FAILOVER_FOLLOWUPS.md) #2).

Other artefacts in the same directory:

| File / dir | Use |
|-----------|-----|
| `categories.json` | Per-Call-ID `{state, outcome, retransmits}` — joinable to other artefacts by `callId`. |
| `routing-decisions.ndjson` | Every routing line the proxy emitted in the test window, parsed. |
| `kill-timeline.json` | `tInviteFirst`, `tKillIssued`, `tInviteLast`, recovery time, killed pod, scenario stats, rollup counters. |
| `proxy-logs/all.log` | Both proxy pods' logs scoped to the test window. |
| `worker-logs/all.log` | All worker logs scoped to the test window. For `kill-9` the killed pod's `--previous.log` is also captured. |
| `sipp-traces/msg.log` | Sipp's `-trace_msg` per-message log (the source of truth for outcomes). |
| `sipp-traces/stat.csv` | Sipp's cumulative `-stf` stats. |
| `sipp-traces/screen.log` | Sipp's terminal output. |

### 7.5 Cross-run trends

```bash
# Chronological table across all archived runs.
npx tsx tests/k8s/scripts/failover-summary.ts

# Filter to one phase.
npx tsx tests/k8s/scripts/failover-summary.ts --filter phase-3
```

Useful when looking for slow drift in `re-emissions` /
`establish-failures` / `badly-treated` after a code change that the
hard-gate assertion didn't catch.

### 7.6 Clean up archives

Archives are NOT auto-pruned (per plan — they're the "investigation"
artefact). Manual:

```bash
# List what's there + size; nothing deleted.
bash tests/k8s/scripts/failover-cleanup.sh

# Keep only the 10 most recent runs (prompts before deleting).
bash tests/k8s/scripts/failover-cleanup.sh --keep 10

# Same, but skip the prompt.
bash tests/k8s/scripts/failover-cleanup.sh --keep 10 --yes
```

### 7.7 Known issues / follow-ups

See [docs/todos/K8S_FAILOVER_FOLLOWUPS.md](todos/K8S_FAILOVER_FOLLOWUPS.md):
- Rolling-restart (both worker pods) leaves one ReplPuller fiber hung
  until that pod is restarted individually. Single-pod kill (the test
  path) works correctly.
- LB / worker harnesses are 90 % duplicated; merge candidate.
- Survival-rate thresholds deferred until 3+ baseline runs exist on
  `main`.

---

## VCH commands

```
bash kubectl delete pod -n sip-test -l app.kubernetes.io/name=b2bua-worker 2>&1 && kubectl rollout status statefulset b2bua-worker -n sip-test --timeout=60s 2>&1 
```
# One-time setup (or after src/ changes)
npm run test:k8s:up                     # creates the kind cluster (skips if up)
npm run test:k8s:images                 # builds + loads sipjsserver:dev
npx tsx tests/k8s/scripts/install-stack.ts  # installs proxy + worker + redis + call-control

# After src/ changes that affect cluster pods
kubectl delete pod -n sip-test -l app.kubernetes.io/name=b2bua-worker
kubectl rollout restart deployment sip-front-proxy -n sip-test

# The actual test run
E2E_KIND=1 E2E_KIND_PROXY_HOST=172.20.255.250 npx vitest run -c vitest.config.live.ts \
  tests/fullcall/e2e-register-fakeExt-realCore.test.ts
Open test-results/real-clock/registrarFrontProxy-kind/index.html to see the report.

sipp -s uac 172.20.255.250:5060 -i  172.27.217.175 -p 9999

## external SIPP with K8S

### Manual host-mode for ad-hoc sipp from WSL:
npm run test:k8s:proxy-host-mode

### Switch back:
npm run test:k8s:proxy-cluster-mode

---



## 7. Known limitations + future work

### Tests are inherently sequential

The shared `sip-test` namespace has no per-test isolation, so two tests
running concurrently would collide on:

- StatefulSet replica counts (INV-4 scales 2→3, restores 2)
- SIPp Job names (each test picks a unique name, but pod scheduling
  windows overlap)
- Proxy K8s pod-watch state (every pod-event ripples through every
  proxy pod's registry)

The vitest config enforces single-fork. Running tests in parallel is
not just slower — it's incorrect. Phase B will add per-test fresh
namespaces so concurrency becomes safe.

### SIPp pollution across tests — possible mitigation

Even sequentially, SIPp-side state can pollute subsequent runs:

- A SIPp Job that times out leaves stale UDP sockets / call contexts
- The worker's call-state cache may still hold entries keyed by the
  SIPp UAC's Call-ID + source-IP tuple

**Idea (not implemented):** give each SIPp run a distinct source IP so
the worker treats subsequent tests as coming from a fresh UAC. The
SIPp pod's IP is K8s-assigned; we'd either need

- a CNI that supports per-pod static IPs, or
- run each SIPp Job pod in its own short-lived sub-namespace, or
- use SIPp's `-i` flag with multiple bind addresses if the load node
  has multiple IPs configured

This avoids the heavier "fresh namespace per test" path and may be
sufficient on its own. Worth a small proof-of-concept in Phase A++.

### Other limitations

- **No per-test cluster reset** — bring-up is slow (~30 s warm), so we
  reuse the cluster across tests.
- **Worker `MetricsServer` not bound** — `proxyMetrics.fetchProxyMetrics`
  returns empty. Tests use log-based assertions instead.
- **B2BUA doesn't reflect Leg-A `Record-Route`** — the proxy's HMAC
  cookie path is never exercised end-to-end by SIPp's stock UAC
  scenario; sticky routing is satisfied by HRW determinism alone.
  Independent B2BUA fix needed before INV-5's failure path can be
  verified end-to-end.

See [docs/todos/K8S_DEV_TEST.md](todos/K8S_DEV_TEST.md) "Findings"
section for the full list.
