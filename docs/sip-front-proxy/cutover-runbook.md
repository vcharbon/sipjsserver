# SIP Front Proxy — Production Cutover Runbook

**Status:** Phase 1 (PR6). Owner: SIP Front Proxy.

This document drives a **blue-green cutover at the Kubernetes namespace
level** (D15 in the implementation plan). The new front-proxy +
StatefulSet worker topology is deployed in parallel with the legacy
single-process `cluster.fork()` workers; traffic is shifted via DNS-SRV
(or VIP) weight, not in-place. Rollback is one DNS change.

For background and the per-message-type behaviour matrix, read
[`resilience-model.md`](./resilience-model.md) first — its timing
assumptions table is the contract every step in this runbook honours.

---

## 1. Pre-flight checklist

Stop and unblock each item before touching production.

- [ ] **Helm release validated in staging.** `helm template` and
  `helm lint` clean against both `deploy/helm/sip-front-proxy/` and
  `deploy/helm/b2bua-worker/`. Staging cluster has run a full SIPp
  scenario through the new path with 0 % failure.
- [ ] **HMAC Secret in target namespace.** `kubectl get secret
  sip-proxy-hmac -n <new-ns>` returns a Secret with
  `data.current` (32 bytes) and (optionally) `data.previous`. Verify
  the bytes are NOT the staging key.
- [ ] **VIP / DNS-SRV record ready.** `dig _sip._udp.<svc-host> SRV`
  returns BOTH the legacy and the new endpoints, with weights set so
  100 % of traffic still hits the legacy endpoint. Plan the weight
  ramp in advance (see §3).
- [ ] **Grafana dashboard imported.** The `sip_*` metrics from PR6
  panel renders on the target Grafana — verify by hitting the new
  proxy's `:9090/metrics` from a bastion and importing the JSON.
- [ ] **`terminationGracePeriodSeconds` ≥ 200 s** on the worker
  StatefulSet (resilience-model §2). Confirm with `kubectl get sts
  -o yaml | grep terminationGracePeriodSeconds`.
- [ ] **K8s RBAC.** The proxy ServiceAccount can `watch` Pods in the
  worker namespace. `kubectl auth can-i watch pods --as
  system:serviceaccount:<new-ns>:sip-front-proxy -n <new-ns>` returns
  `yes`.
- [ ] **Alerting paused** for the **legacy** namespace's
  `b2bua_*` metrics (otherwise the dual-running phase will spam alerts
  on the legacy side as load drains).
- [ ] **On-call engineer paged in.** This is a multi-hour ramp and
  someone needs to watch the dashboards.

---

## 2. Deployment

**All commands assume `kubectl --context=<prod>` and the new namespace
`sip-prod-v2`.**

1. Apply the namespace + ServiceAccount + RBAC:

   ```bash
   helm install sip-front-proxy deploy/helm/sip-front-proxy \
     --namespace sip-prod-v2 --create-namespace \
     --set image.tag=$RELEASE_TAG \
     --values overrides/prod-v2.yaml
   ```

2. Apply the worker StatefulSet (this also creates the headless Service
   the proxy's K8s watch consumes):

   ```bash
   helm install b2bua-worker deploy/helm/b2bua-worker \
     --namespace sip-prod-v2 \
     --set image.tag=$RELEASE_TAG \
     --values overrides/prod-v2.yaml
   ```

3. Wait for full readiness:

   ```bash
   kubectl -n sip-prod-v2 rollout status sts/b2bua-worker
   kubectl -n sip-prod-v2 rollout status deploy/sip-front-proxy
   ```

4. **Internal smoke test.** From a debug pod inside the cluster, run a
   short SIPp UAC scenario against the proxy's ClusterIP. Expect
   `200 OK` on every leg.

   ```bash
   kubectl -n sip-prod-v2 run sipp --rm -it --image=ctaloi/sipp -- \
     sipp -sn uac -s alice $PROXY_VIP:5060 -m 10 -r 1 -trace_msg
   ```

   Watch the proxy's `sip_messages_total{result="forwarded"}` move on the
   dashboard. **If anything is red**, abort: tear down the new
   namespace and stop. The legacy traffic was untouched.

---

## 3. Traffic ramp (DNS-SRV weights)

Hold each step for the listed **observation window** before advancing.
At each step, verify the listed dashboard panels match the **success
criteria**.

| Step | New weight | Legacy weight | Hold for | Notes |
|------|-----------:|--------------:|----------|-------|
| 1    | 0          | 100           | n/a      | Steady state pre-cut. |
| 2    | 1          | 99            | 10 min   | First real traffic. Watch for any 4xx/5xx spike on the new side. |
| 3    | 10         | 90            | 20 min   | First non-trivial volume. Drain-grace + HMAC paths exercised. |
| 4    | 50         | 50            | 30 min   | Capacity stress. Verify routing latency p99 < 2 ms. |
| 5    | 100        | 0             | 24 h     | Full cut. Soak. |

**Success criteria at every step:**

- `sip_messages_total{direction="outbound",result="forwarded"}` rate
  rises proportional to weight. No `result="dropped"` increase.
- `sip_routing_decision_total{kind="cancel_lookup_miss"}` rate is
  **flat or decreasing**. A spike here means CANCELs are crossing
  proxy pods (L4 client-IP affinity broken at the upstream LB) —
  abort and fix VIP affinity before continuing.
- `sip_routing_hmac_failure_total` rate near zero. A spike means a
  client cached an old Record-Route or the HMAC Secret is wrong.
- `sip_worker_health{health="dead"}` always 0. A `dead` worker means
  the OPTIONS keepalive missed N consecutive ticks — page the SRE.
- `sip_routing_duration_seconds` p99 < 2 ms (AC-6 SLO).
- B-leg setup success rate from the upstream caller-side dashboard
  unchanged (within ±0.1 %).

**Rollback at any step:** flip the DNS-SRV weights back to (0, 100).
Existing dialogs continue on whichever side they were established;
new dialogs go back to the legacy stack within the DNS TTL (~60 s
typical). Investigate before retrying — do NOT re-ramp without a fix
for the symptom that caused the abort.

---

## 4. Dual-running phase

While weights are split, **both** topologies run in parallel:

- The legacy `src/cluster/`-based deployment continues serving its
  share of new dialogs and all in-flight ones from before the ramp.
- The new front-proxy + worker StatefulSet handles its share of new
  dialogs through the rendezvous-hash routing path.

There is **no shared state** between the two — calls established on
the legacy side stay on the legacy side until BYE. This is by design:
attempting to migrate a live dialog mid-call would require Redis
cross-tenant access patterns that Phase 1 does not implement.

What this means operationally:

- **Provisioning policy changes propagate on different tracks.** If
  you push a routing rule update during the cut, push it to **both**
  sides. The Helm values for the new side mount the rule bundle
  from the same ConfigMap as the legacy side; keep them in sync.
- **Aggregate metrics need to be summed across namespaces.** Grafana
  queries must use `sum by (...) (rate(... {namespace=~"sip-prod|sip-prod-v2"}))`
  while both are alive.
- **CDRs land in two locations.** Update the downstream CDR
  pipeline to pull from both namespaces. Single source of truth
  resumes once the legacy namespace is torn down.

---

## 5. Final cutover and legacy teardown

After 24 h at 100 % traffic with no regressions:

1. Lower the legacy namespace replicas to 0:

   ```bash
   kubectl -n sip-prod scale deploy/b2bua --replicas=0
   ```

   **Wait one Timer C window (180 s) before deleting** so any straggler
   in-flight INVITE has a chance to settle.

2. Tear down the legacy Helm release:

   ```bash
   helm uninstall sip-b2bua-legacy -n sip-prod
   ```

3. Remove the legacy DNS-SRV entry. The new proxy is now the only
   advertised endpoint.

4. Resume legacy-side alerting? **No.** Delete the Grafana alert
   policies tied to the legacy `b2bua_dispatcher_*` metrics — they
   have no producer anymore.

5. Update the runbook owners' wiki to point at this document and
   `resilience-model.md` for SIP front proxy operations.

---

## 6. Failure scenarios

### 6.1 Cancel-lookup misses spike during ramp

**Symptom:** `sip_routing_decision_total{kind="cancel_lookup_miss"}` rate
suddenly jumps and stays elevated.

**Cause:** Upstream LB lost client-IP affinity, so a UAC's INVITE and
its later CANCEL hit different proxy pods. The pod that received the
CANCEL has no LRU entry for it.

**Mitigation:** the CANCEL still gets forwarded via fallback through
`selectForNewDialog` — likely to a different worker than the one that
holds the INVITE. The downstream UAS may answer 481 or just time out;
the user-perceived effect is a slightly delayed CANCEL.

**Fix:** verify the upstream LB has consistent-hash on src-IP enabled.
If not, reconfigure (Cilium / kube-proxy / external LB depending on
deploy). Until fixed, hold the ramp.

### 6.2 HMAC failures during rotation overlap

**Symptom:** `sip_routing_hmac_failure_total{reason="mismatch"}` rises
shortly after a Secret update.

**Cause:** A proxy pod loaded the new `current` key but the previous
key fell out of the `previous` slot before all in-flight cookies
expired. The 1 h NFR-8 window was either too short or wasn't observed.

**Mitigation:** affected requests get 403 and the UAC retries (most
in-dialog requests). Some dialogs may drop.

**Fix:** see [`hmac-rotation-runbook.md`](./hmac-rotation-runbook.md)
§3 — re-mount the previous key, restart the proxy fleet rolling.

### 6.3 Routing latency p99 climbs above 2 ms

**Symptom:** `sip_routing_duration_seconds` p99 panel goes red.

**Cause:** worker pool small enough that rendezvous-hash candidate
filtering is dominated by registry snapshot copies, OR a debug log
level enabled by mistake.

**Mitigation:** check `EFFECT_LOG_LEVEL` env on the proxy — must be
`Info` or higher in prod. Check worker pool size — if < 4, scale up.

**Fix:** if neither helps, abort the ramp and profile the proxy with
`/debug/cpu-profile` (the proxy's status server exposes the same
endpoints as the B2BUA's).

---

## 7. Sign-off

After §5 completes successfully:

- [ ] On-call engineer confirms 24 h of clean dashboards.
- [ ] PR6 status in `docs/todos/SIP-Front-Proxy.md` is updated to
  reference the cutover date.
- [ ] This runbook gets revisited in 30 days for any lessons learned
  feedback.
