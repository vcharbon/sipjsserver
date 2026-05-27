# K8s test environment — inner loop & invariant suite

How to bring up the cluster, run the fast K8s **invariant suite**, and
verify the stack by hand. For the long-running **robustness gate** (the
canonical pre-release check, including the failover zoom-in tool) see
[docs/k8s-endurance.md](k8s-endurance.md). For host setup (kind/kubectl/
helm + inotify limits) see
[docs/installation/k8s-test-prereqs.md](installation/k8s-test-prereqs.md).

All commands assume cwd = repo root.

---

## 1. One-time setup

```bash
# CLIs present.
kind --version && kubectl version --client=true | head -1 && helm version --short

# inotify limit bumped (else kube-proxy crashloops).
cat /proc/sys/fs/inotify/max_user_instances     # → 8192 (not 128)
```

---

## 2. Canonical bring-up

```bash
npm run test:k8s:up
```

One command, everything ready. Sequence (driven by
[tests/k8s/scripts/up-full.ts](../tests/k8s/scripts/up-full.ts)):

1. **Pre-flight** — fail fast: ≥30 GiB free on `test-results/`, docker
   daemon reachable.
2. **Host observability stack** — Grafana + VictoriaMetrics +
   VictoriaLogs + VictoriaTraces via
   [deploy/observability/install.sh](../deploy/observability/install.sh) `--apply`.
3. **kind cluster** — created from
   [tests/k8s/cluster.yaml](../tests/k8s/cluster.yaml) if not already
   running. ~30 s warm, ~2–3 min cold. No-op if already up.
4. **kind-addons** — vmagent + fluent-bit + node-exporter +
   kube-state-metrics applied into the cluster (same `install.sh
   --apply` step, now with a cluster to target).
5. **Image rebuild + load** — `sipjsserver:dev` and `sipp:dev` built
   and side-loaded. Content-hashed → fast no-op when source is unchanged.
6. **Charts** — Redis + SIPp + b2bua-worker + sip-front-proxy via Helm.
7. **Sanity gate** — runs
   [tests/fullcall/e2e-register-fakeExt-realCore.test.ts](../tests/fullcall/e2e-register-fakeExt-realCore.test.ts)
   (REGISTER + INVITE + reroute) up to 3× with 10 s spacing, then probes
   `/metrics` on every worker (`:3002`) and proxy (`:9090`) pod. Fails
   the bring-up with diagnostic dumps if anything is mute.

Total wall-clock: 3–4 min cold, ~30 s warm.

### Tear down

```bash
npm run test:k8s:down
```

Deletes the kind cluster. Host observability stack stays up (it's
hostside docker-compose, intentionally persistent — tear it down
manually with `./deploy/observability/install.sh --down` if you need
to).

---

## 3. Manual host-side sanity (one-liner)

The bring-up's sanity gate is the same e2e test you can run by hand at
any time:

```bash
E2E_KIND=1 E2E_KIND_PROXY_HOST=172.20.255.250 TEST_MODE=live \
  npx vitest run \
  tests/fullcall/e2e-register-fakeExt-realCore.test.ts

E2E_KIND=1 TEST_MODE=live \
  npx vitest run tests/fullcall/e2e-register-noRr-realFabric.test.ts
```

Report goes to `test-results/real-clock/registrarFrontProxy-kind/index.html`.

Ad-hoc SIPp from the host (useful when you want to fire raw INVITEs at
the VIP without spinning up a vitest run):

```bash
sipp -s uac 172.20.255.250:5060 -i 172.27.217.175 -p 9999
```

Host-mode proxy (binds the proxy to 127.0.0.1 so a host-resident SIPp
can drive it directly; switches Record-Route stamping to `127.0.0.1` so
the dialog's route set works from outside the cluster):

```bash
npm run test:k8s:proxy-host-mode    # enter
npm run test:k8s:proxy-cluster-mode # restore
```

---

## 4. Invariant suite

Fast K8s tests asserting proxy routing, drain, scale, HMAC, smoke, and
queries. Not the robustness gate — see
[k8s-endurance.md](k8s-endurance.md) for that.

```bash
# Run all invariants. Brings up the cluster if needed, but does NOT
# rebuild images or apply observability — assumes a recent
# `test:k8s:up`.
npm run test:k8s

# Run one file.
npx vitest run -c vitest.config.k8s.ts tests/k8s/proxy-routing.test.ts
```

> **Never run K8s tests in parallel.** The shared `sip-test` namespace
> has no per-test isolation. The vitest config enforces
> `forks: { singleFork: true }`
> ([vitest.config.k8s.ts](../vitest.config.k8s.ts)).

After source changes that affect pod images, roll the workloads:

```bash
npm run test:k8s:images   # rebuild + kind load
kubectl -n sip-test rollout restart statefulset b2bua-worker
kubectl -n sip-test rollout status   statefulset b2bua-worker --timeout=120s
kubectl -n sip-test rollout restart deployment sip-front-proxy
kubectl -n sip-test rollout status   deployment sip-front-proxy --timeout=120s
```

### Pick a different namespace

```bash
K8S_TEST_NAMESPACE=my-ns npx vitest run -c vitest.config.k8s.ts \
  tests/k8s/smoke.test.ts
```

---

## 5. Verification recipes

Useful when something looks off and you want to confirm cluster health
without running a full suite.

```bash
# Nodes Ready, tier labels correct.
kubectl get nodes -L tier
# Expected: 1 control-plane (no tier), 2 edge, 2 app, 1 load.

# kube-proxy on every node.
kubectl -n kube-system get ds kube-proxy
# READY must equal DESIRED. If not, bump inotify limits.

# Workload pods Running, READY 1/1.
kubectl -n sip-test get pods -o wide

# Worker logs.
kubectl -n sip-test logs b2bua-worker-0 -c worker | head -10

# Proxy startup banner.
kubectl -n sip-test logs deploy/sip-front-proxy | head -3

# Live routing decisions.
kubectl -n sip-test logs -l app.kubernetes.io/name=sip-front-proxy \
  --prefix --max-log-requests=10 --tail=200 | grep "routed"

# Mock call-control healthz.
kubectl -n sip-test exec deploy/call-control \
  -- wget -qO- http://localhost:8080/healthz

# One-call smoke from inside the cluster.
kubectl -n sip-test run sipp-smoke --rm -i --restart=Never \
  --image=sipp:dev --image-pull-policy=IfNotPresent \
  --overrides='{"spec":{"containers":[{"name":"sipp-smoke","image":"sipp:dev","stdin":true,"args":["sip-front-proxy:5060","-s","test","-sf","/scenarios/uac-basic.xml","-m","1","-trace_msg","-message_file","/dev/stdout","-timeout","10s"],"volumeMounts":[{"name":"scenarios","mountPath":"/scenarios"}]}],"volumes":[{"name":"scenarios","configMap":{"name":"sipp-scenarios"}}]}}'
```

---

## 6. Triage when invariants start failing

```bash
# 1. Stale SIPp Jobs holding sockets?
kubectl -n sip-test get jobs
kubectl -n sip-test delete jobs --all

# 2. Workers in a clean state?
kubectl -n sip-test logs b2bua-worker-0 --tail=10
# Repeated "Transaction timeout" or "not found on checkout" → stuck call-state.

# 3. Hard reset workers.
kubectl -n sip-test rollout restart statefulset b2bua-worker
kubectl -n sip-test rollout status   statefulset b2bua-worker --timeout=120s

# 4. If still wedged, take the slow road: full rebuild.
npm run test:k8s:down
npm run test:k8s:up
```

---

## 7. Known limitations

- **Tests are sequential.** Shared namespace; concurrent runs collide.
  Single-fork enforced in the vitest config.
- **SIPp state can pollute across tests.** A SIPp Job that times out
  leaves stale UDP sockets; the worker's call-state cache may still
  hold entries keyed by the SIPp UAC's Call-ID + source-IP tuple. Per-
  test fresh namespace is the proper fix; not yet implemented.
- **No per-test cluster reset** in the invariant suite — bring-up is
  too slow to repeat per test. The robustness gate handles cluster-
  freshness; see [k8s-endurance.md](k8s-endurance.md).
