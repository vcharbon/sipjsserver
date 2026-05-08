# Front-proxy HA via shared VIP (keepalived) — re-enable LB-proxy chaos

## Context

The existing plan
[replacement-proxy-zero-traffic-fix.md](./replacement-proxy-zero-traffic-fix.md)
diagnosed the failure mode: when a `sip-front-proxy` pod dies under
chaos, UDP-conntrack pinning at the kube-proxy DNAT layer keeps
existing client 5-tuples nailed to the dead pod IP. The replacement
pod gets zero traffic. The plan's recommended remediation
(Option B graceful drain + Option C endurance test mitigation) was
implemented and **did not fix the problem** — the post-fix
`nzjs7` run still showed an empty replacement-pod log because
sipp's still-alive UDP flow keeps refreshing conntrack indefinitely.
This is also a real production failure mode for any non-retrying
UDP UA.

Goal here: make destination IP **stable across proxy failover**, so
in-cluster conntrack pinning becomes irrelevant — the IP the kernel
pins to is the one we keep alive on whichever proxy is healthy.
Side benefit: the endurance test's LB-proxy chaos stops being a
"don't ask, can't fix" exclusion and becomes a real CI gate.

This plan supersedes the Slice-2 remediation choice in the existing
plan. The diagnosis section there remains authoritative.

## Architecture

```
                     ┌──────────────────────────────┐
   client (sipp/UA) ─┤  VIP  (single shared IP)     │
                     │   ARP-master = active proxy  │
                     └──────────────┬───────────────┘
                                    │
                ┌───────────────────┴───────────────────┐
                │                                       │
        ┌───────▼─────────┐                     ┌───────▼─────────┐
        │ sip-front-proxy │  ◄── VRRP advert ──►│ sip-front-proxy │
        │   pod A (node1) │                     │   pod B (node2) │
        │  + keepalived   │                     │  + keepalived   │
        │   sidecar       │                     │   sidecar       │
        │                 │                     │                 │
        │  hostNetwork    │                     │  hostNetwork    │
        │  VIP on lo      │                     │  VIP on lo      │
        │  node IP on eth │                     │  node IP on eth │
        └────────┬────────┘                     └────────┬────────┘
                 │                                       │
                 │  forwarded INVITEs use VIP as source  │
                 │  OPTIONS probes use node IP as source │
                 └───────────────────┬───────────────────┘
                                     ▼
                            sip-worker / b2bua
```

**Decisions (settled in design discussion):**

1. **Mechanism**: keepalived sidecar per proxy pod (VRRP). Kind-simulatable
   identically to bare-metal prod. No cloud target yet — when needed,
   swap mechanism (cloud NLB / kube-vip BGP) without touching proxy code.
2. **Failover trigger**: VRRP peer-silence + `vrrp_script` self-health
   gate + SIGTERM-driven explicit self-cede via keepalived control
   socket. Catches crash, hang, and graceful-shutdown cases.
3. **Failover latency budget**: < 2s (sub-T2). `advert_int=500ms`,
   `hold_down=1500ms`. UAC sees 1–2 INVITE retransmits then succeeds.
4. **IP topology**: **single VIP**, used in both directions.
   - Inbound (client → proxy): only active answers ARP for VIP.
   - Outbound forwarded SIP (proxy → worker): both proxies bind VIP
     as `/32` on `lo` so either can use it as outbound source. Worker
     replies hit VIP → reach whoever owns it now → in-flight calls
     survive failover via the existing Record-Route HMAC cookie
     ([LoadBalancer.ts:108-155](../../src/sip-front-proxy/strategies/LoadBalancer.ts#L108-L155)).
   - OPTIONS probes (proxy → worker, healthProbe socket): use
     per-proxy node IP automatically (separate socket on port 5061,
     standby cannot bind VIP source while not ARP-master). Both
     proxies probe independently so the standby's worker view stays
     warm.
5. **Anti-affinity**: hard required. Two proxy pods on different
   nodes; otherwise both keepalived sidecars on the same L2 endpoint.
6. **Accepted trade-off — CancelBranchLru loss**: in-flight CANCELs at
   the exact moment of failover lose their branch correlation
   (`CancelBranchLru` is in-memory, not replicated). Bounded impact:
   32s LRU, narrow window. Documented; not fixed here.

## Files to modify

### Helm chart — `deploy/helm/sip-front-proxy/`

- **`templates/deployment.yaml`** — add:
  - `hostNetwork: true` on the pod spec
  - `terminationGracePeriodSeconds` already set to 200; keep
  - `affinity.podAntiAffinity` requiredDuringScheduling with
    `topologyKey: kubernetes.io/hostname` matching the chart's
    selector — see existing `_helpers.tpl` `selectorLabels`
  - `securityContext.capabilities.add: [NET_ADMIN, NET_RAW]` on
    the keepalived sidecar
  - new sidecar container `keepalived` from upstream image
    (`osixia/keepalived` or build a small Alpine + keepalived layer)
    sourcing config from a ConfigMap, with `lifecycle.preStop` that
    triggers self-cede before keepalived exits
- **`templates/configmap.yaml`** — add a second key `keepalived.conf`
  rendered from values:
  - `vrrp_instance VI_1` block with `state BACKUP`, both pods, equal
    priority + `nopreempt` (avoids flapping when failed pod recovers)
    OR explicit `priority` + `preempt_delay` if the operator wants
    deterministic primary
  - `advert_int 0.5`
  - `virtual_ipaddress { {{ .Values.vip.address }} }`
  - `notify_master`/`notify_backup` scripts that
    `ip addr add VIP/32 dev lo` (ensures both nodes always have VIP
    bound on `lo` for outbound source) — see "Outbound source binding"
    below
  - `vrrp_script chk_proxy` running every 1s, checking proxy's
    `/ready` HTTP endpoint; `weight -50` so failed script drops
    priority below standby's
- **`templates/service.yaml`** — keep as-is for cluster-internal Service
  discovery (used by Helm tooling, kubectl, etc.) but client traffic
  no longer goes through it. The Service can remain as a debug/admin
  path.
- **`values.yaml`** — add:
  ```yaml
  vip:
    enabled: true
    address: ""        # required when enabled; static IP in node subnet
    interface: ""      # auto-detect if empty
    routerId: 51       # VRRP virtual_router_id, must be unique per L2
    priorityActive: 110
    priorityBackup: 100
    advertIntSec: 0.5
    holdMultiplier: 3
  ```
  And `bind.advertisedHost` — when `vip.enabled`, default to `vip.address`
  so the proxy stamps its Via with the stable VIP, not the Service
  ClusterIP.

### Proxy code — `src/sip-front-proxy/`

- **[ProxyCore.ts:254](../../src/sip-front-proxy/ProxyCore.ts#L254) and
  [ProxyCore.ts:282](../../src/sip-front-proxy/ProxyCore.ts#L282)** —
  the two outbound `bindUdp` calls. Add an optional
  `forwardSourceIp` config that, when set, binds the outbound socket
  to that source IP instead of `0.0.0.0`. When VIP is enabled this is
  set to the VIP. Keeps `0.0.0.0` listener for inbound.
- **`SipRouter.ts` / `ProxyCore.ts` Via stamping** — confirm Via
  `sent-by` uses `bind.advertisedHost` (which now defaults to VIP).
  No code change expected; verify in tests.
- **HealthProbe** — no change. It already binds its own socket on
  5061 and uses kernel-default source IP (= node IP). That's correct.
- **New `src/sip-front-proxy/keepalivedCede.ts`** — small Effect
  Layer that:
  - On SIGTERM, before flipping DrainingState, writes to the
    keepalived control socket (or sends `kill -USR1` to the keepalived
    sidecar PID via a shared process-namespace IPC) to release the
    VIP immediately. This causes ARP convergence to start ~T0
    instead of waiting for the 1.5s VRRP hold-down.
  - Then proceeds with the existing graceful-drain path
    (DrainingState flip, in-flight transactions complete, exit).
  - Implementation tip: keepalived's notify-script signaling is
    fragile across distros; the most portable option is to have the
    proxy `exit(0)` on SIGTERM and rely on the `preStop` hook in the
    keepalived sidecar (which fires before SIGTERM in K8s) to
    `pkill keepalived` — the sidecar's exit triggers immediate VIP
    release on this node.

### Documentation deliverables

These docs land **with the implementation**, not as follow-up:

- **New `docs/lb-proxy-ha.md`** — the architecture reference. Sections:
  1. Problem statement (UDP conntrack pinning; reference existing
     diagnosis plan)
  2. The shared-VIP solution: ASCII topology (ingress + outbound
     paths), explicit "what moves on failover and what doesn't"
  3. VRRP details: keepalived sidecar role; advert_int=500ms,
     hold_down=1.5s, virtual_router_id allocation, priority and
     `nopreempt` rationale; `vrrp_script` health gate semantics
     (probe `/ready`, weight delta, sub-second detection ceiling);
     SIGTERM-driven explicit cede via sidecar `preStop`
  4. Source-IP discipline: VIP for forwarded SIP (in-flight
     survival), per-proxy node IP for OPTIONS probes (warm standby
     view), why the standby binds VIP on `lo`
  5. State at failover: what survives (Record-Route HMAC cookie,
     Redis-backed call state in workers, OPTIONS-driven worker
     liveness re-built independently per proxy) vs. what is lost
     (CancelBranchLru in-flight CANCEL correlation, current
     transaction timers)
  6. Deployment-target matrix: kind, bare-metal, cloud (and the
     swap path to NLB / kube-vip BGP when cloud is needed)
  7. Operator runbook: how to verify which pod is master
     (`ip addr show`), how to force failover for maintenance
     (`kill -USR2` on keepalived, or scale active to 0), known
     failure modes (multicast loss → flapping; mitigations)
- **Update `docs/k8s-endurance.md`** — add a section
  "LB-proxy chaos" listing the new event types
  (`proxy-pod-graceful`, `proxy-pod-kill9`,
  `proxy-cutoff-workers`, `proxy-cutoff-vrrp`,
  `proxy-cutoff-ingress`) with one-line semantics each, link to
  `lb-proxy-ha.md` for the architecture, and remove the existing
  "exclude LB chaos" Option-C carve-out.
- **Update `CLAUDE.md`** progressive-reading-guide table — add
  `docs/lb-proxy-ha.md` row keyed on "LB-proxy HA / VIP /
  keepalived".
- **Cross-link from `docs/plan/replacement-proxy-zero-traffic-fix.md`**
  — add a header note "Superseded by
  [cuddly-skipping-wigderson.md](./cuddly-skipping-wigderson.md);
  diagnosis below remains authoritative."

### Anti-affinity in test cluster

- **`tests/k8s/values/sip-front-proxy.yaml`** — set `vip.enabled: true`,
  pick a VIP from the kind docker bridge subnet (e.g., `172.18.0.250`,
  verify available with `docker network inspect kind`), and add
  `affinity.podAntiAffinity` matching the chart selector.
- **`tests/k8s/cluster.yaml`** — already has 5 nodes; load-tier worker
  hosts the NodePort today. With VIP, `extraPortMappings` is no longer
  needed for the client path (the VIP is reachable directly within the
  kind docker network from the WSL host *if* kind's bridge is exposed,
  or from sipp pods running inside the cluster). For host-side sipp,
  add a route from WSL to the kind docker bridge or run sipp as a
  Pod (recommended — simpler, matches in-cluster traffic shape).
- **`tests/k8s/values/sip-front-proxy.host.yaml`** — the
  `externalTrafficPolicy: Local` overlay becomes unnecessary; can be
  removed or kept disabled.

## Verification

### Fake-clock coverage (already in place — no new tests needed)

The two fake-clock tests originally proposed both turned out to be
covered by existing coverage once the proxy code change collapsed to
zero (the chart binds `PROXY_BIND_HOST` directly to the VIP, making
outbound source-IP selection automatic via the kernel — no new
forward-source code path to test):

- **vip-handoff invariant** — the claim that "HMAC cookie + shared
  VIP source IP = stateless in-flight failover" reduces to "any
  proxy with the right HMAC key can decode and route a cookie
  produced by any other proxy." This is exhaustively covered by:
  - `tests/sip-front-proxy/load-balancer/cookie-route-fallback.test.ts`
  - `tests/sip-front-proxy/load-balancer/hmac-tampering-rejected.test.ts`
  - `tests/sip-front-proxy/load-balancer/decode-forward-respawn-window.test.ts`
- **SIGTERM cede ordering** — moved entirely to the keepalived
  sidecar's K8s `preStop` hook, no proxy-side code involved. The
  proxy's existing SIGTERM-flips-DrainingState behaviour is already
  covered by `tests/sip-front-proxy/transparency/draining.test.ts`.

The genuinely new behaviour — VIP migration timing, ARP
convergence, sidecar preStop ordering, conntrack staleness — only
manifests under real network conditions and is exercised by the
kind chaos events below.

### New chaos events — `tests/k8s/endurance/chaosOps.ts`

Extend the chaos catalog with **network-cutoff** events that exercise
the VIP failover code paths (vs. just pod death). All implemented via
`docker exec <kind-node> iptables ...` since kind nodes are Docker
containers; no need to enter pod netns when proxies are `hostNetwork`.

**Catalog rule:** only events whose proper handling has zero or
near-zero traffic impact when the architecture works as designed.

| Event | Mechanism | Tests |
|-------|-----------|-------|
| `proxy-pod-graceful` | `kubectl delete --grace-period=200` | SIGTERM self-cede + drain (preStop on keepalived sidecar) |
| `proxy-pod-kill9` | `kubectl delete --grace-period=0 --force` | VRRP peer-silence detection |
| `proxy-cutoff-vrrp` | `iptables -A INPUT -p vrrp -j DROP` on one proxy node | Split-brain quietness — with `nopreempt` + strict-ARP the original master keeps the VIP, peer just sees a silent partner; designed to be invisible to clients |
| `node-shutdown-edge` (existing) | `docker stop <kind-node>` for 60s | Whole-node failure → VIP migrates via VRRP peer-silence |

Two earlier candidates were rejected from the catalog:

- **`proxy-cutoff-ingress`** (drop UDP/5060 on active node) — no
  realistic prod analog and no clean handling path. The active proxy
  has no in-stack signal that it's been blackholed.
- **`proxy-cutoff-workers`** (drop egress to cluster pod CIDR) — has
  a real-world analog and a clean design (proxy detects via OPTIONS
  probe failures and cedes VIP), but depends on a working
  `vrrp_script` self-health gate. Re-introduce when that's wired and
  proven to cede sub-second.

Each event records `tFire`, target pod/node, and `tRecovered` (when
iptables rule cleared / pod restored). `chaosOps.ts:38-46` is the
existing pattern.

### Staged verification plan

The code change invalidates seed reproducibility from the existing
plan (the original `1777960808113` seed exercised the pre-fix
chaos schedule that excluded LB events). Run in three phases:

#### Phase 1 — LB-only weighted run (regression isolation)

Chaos schedule weighted to **only** LB-proxy events (every type from
the table above). Short duration to validate each event type works
end-to-end:

```bash
npm run test:k8s:endurance -- --caps 20 --duration 30m \
  --proxy-target "<vip-address>:5060" \
  --chaos-weights "proxy-pod-graceful=1,proxy-pod-kill9=1,\
proxy-cutoff-vrrp=1,node-shutdown-edge=1" \
  --chaos-min-interval 90s --chaos-max-interval 150s
```

Acceptance:
- Each event type fires at least 3× during the run
- Replacement pod (after `pod-graceful` / `pod-kill9`) receives ≥ 1
  routing decision within 30s of Ready (regression gate against
  `ck74t`/`nzjs7`)
- In-flight call survival ≥ 95% in the `tFire`..`tFire+5s` window
- VIP migration observed in `kubectl exec` smoke check after each
  failover event

#### Phase 2 — LB-only long-term (stability)

Same weights, 4h duration. Looks for late-emerging issues: VIP
flapping, ARP cache staleness on persistent clients, leaked
iptables rules from cutoff events, keepalived memory growth.

Acceptance: same as Phase 1, plus zero regressions in trailing
windows vs. opening hour.

#### Phase 3 — Full chaos mix restoration

Restore default chaos weights (all event types from the existing
catalog including worker-side events), 1h duration. Verifies the
LB-HA change didn't break unrelated chaos paths.

Acceptance: full endurance verdict clean, including all
non-LB-proxy event categories.

### Smoke checks (run during all phases)

- `kubectl exec sip-front-proxy-A -- ip addr show` — exactly one
  pod has VIP on its primary interface; both have VIP on `lo`
- `kubectl exec sip-front-proxy-A -c keepalived -- cat /tmp/keepalived.state`
  — one pod reports `MASTER`, one `BACKUP`
- After each chaos event: confirm VIP migrated by polling
  `ip addr show` until master flips, record convergence latency

### Acceptance criteria

- [ ] `npm run typecheck` clean (zero warnings, zero errors — both
      `tsc` and Effect language-service plugin)
- [ ] `npm run test:fake` passes including the two new fake-clock
      tests (`vip-handoff.test.ts`, `sigterm-cede.test.ts`)
- [ ] All three phases of the staged verification pass
- [ ] Documentation deliverables landed in the same PR
      (`lb-proxy-ha.md`, `k8s-endurance.md` update, `CLAUDE.md`
      table row, supersession note on the original plan)

## Out of scope

- **Cloud deployment paths.** keepalived/VRRP doesn't traverse cloud
  VPCs. When a cloud target appears, swap to cloud NLB or kube-vip
  BGP — the proxy code remains identical.
- **CancelBranchLru replication.** Accepting bounded loss for
  in-flight CANCELs at exact failover moment. Revisit if endurance
  data shows this is meaningful.
- **TCP/TLS transport.** Independent migration; would moot the whole
  conntrack-pinning class of bug but at large cost.
- **Three or more proxies.** VRRP supports it; chart anti-affinity
  would need topology spread instead. Defer until needed.

## References

- Existing diagnosis:
  [replacement-proxy-zero-traffic-fix.md](./replacement-proxy-zero-traffic-fix.md)
- HMAC cookie / Record-Route stickiness:
  [LoadBalancer.ts:108-155](../../src/sip-front-proxy/strategies/LoadBalancer.ts#L108-L155)
- Existing OPTIONS health probing (kept as-is, drives both proxies'
  independent worker views):
  [HealthProbe.ts:150-386](../../src/sip-front-proxy/health/HealthProbe.ts#L150-L386)
- Worker-side OPTIONS responder:
  [SipRouter.ts:452-517](../../src/sip/SipRouter.ts#L452-L517)
- Outbound forward sockets to modify:
  [ProxyCore.ts:254](../../src/sip-front-proxy/ProxyCore.ts#L254),
  [ProxyCore.ts:282](../../src/sip-front-proxy/ProxyCore.ts#L282)
- Endurance harness:
  [tests/k8s/endurance/](../../tests/k8s/endurance/)
- Kind cluster topology:
  [tests/k8s/cluster.yaml](../../tests/k8s/cluster.yaml)
