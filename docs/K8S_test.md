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

The harness installs four charts into a single namespace (`sip-test` by
default). Charts: `redis` + `sipp` + `b2bua-worker` + `sip-front-proxy`.

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

# Redis
helm upgrade redis tests/k8s/charts/redis -n sip-test --wait --timeout 60s
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
# Worker connects to Redis + binds UDP on pod IP (not 0.0.0.0).
kubectl -n sip-test logs b2bua-worker-0 | head -10
# Expected lines:
#   "Redis connected to redis://redis:6379"
#   "UDP socket listening on <POD_IP>:5060 (queueMax=100, ...)"

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
--

## VCH commands

```
bash kubectl delete pod -n sip-test -l app.kubernetes.io/name=b2bua-worker 2>&1 && kubectl rollout status statefulset b2bua-worker -n sip-test --timeout=60s 2>&1 
```


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
