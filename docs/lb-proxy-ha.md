# LB-proxy HA — shared VIP via keepalived

How `sip-front-proxy` achieves UDP-stable failover so a dying or
rescheduled proxy pod does not take active calls with it.

Companion docs:
[k8s-endurance.md](k8s-endurance.md) (chaos events that exercise this),
[sip-front-proxy/resilience-model.md](sip-front-proxy/resilience-model.md)
(dialog-level recovery), and the diagnosis that motivated this design,
[plan/replacement-proxy-zero-traffic-fix.md](plan/replacement-proxy-zero-traffic-fix.md).

## Problem

When a `sip-front-proxy` pod dies, the kubelet schedules a replacement
that becomes `Ready=true` and is added to the Service `Endpoints`. But
existing UDP flows from clients that keep sending **never reach the
replacement**: the kernel `nf_conntrack` table on the client's path
pinned the destination to the dying pod's IP on the first packet, and
each subsequent packet refreshes that entry — kube-proxy's iptables
rules are not re-evaluated. The replacement pod logs zero routing
decisions until the client recycles its socket. For non-retrying UDP
UAs (a common shape) this is a real production outage.

Conntrack timeouts that matter:

- `nf_conntrack_udp_timeout` = 30 s (no reply seen yet)
- `nf_conntrack_udp_timeout_stream` = 180 s (after first reply)

A client sending every 50 ms refreshes either timer indefinitely.

## Solution — single shared VIP, active/passive

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

The destination IP a client's conntrack entry pins to is the VIP.
The VIP is always alive on whichever proxy is healthy. So packets
keep arriving at "the same IP" across failover — the kernel doesn't
care that the underlying pod changed, and there's nothing for it to
re-evaluate.

### What moves on failover, what doesn't

Moves: ARP ownership of the VIP. The keepalived master sends a
gratuitous ARP, the L2 segment learns the new MAC for the VIP, and
inbound client packets land on the new master.

Does **not** move:
- VIP `/32` binding on `lo` (kept on both proxies at all times so
  either can use the VIP as outbound source IP).
- Per-proxy OPTIONS probe sockets and their worker liveness map
  (each proxy maintains its own view independently — see
  [HealthProbe.ts:150-386](../src/sip-front-proxy/health/HealthProbe.ts#L150)).
- Worker pods, Redis call cache, HMAC cookie keys.

## VRRP details

`keepalived` runs as a sidecar in each proxy pod, sourced from a
small Alpine + keepalived image. Pods are `hostNetwork: true` so the
sidecar can claim the VIP on the node's primary interface and answer
ARP from the L2 segment.

### Timer settings

- `advert_int 0.5` — advertisements every 500 ms
- hold-down = `3 × advert_int` ≈ 1.5 s before the standby declares
  the master dead and takes over
- gratuitous ARP after promotion typically converges in 100–300 ms

End-to-end failover budget: **< 2 s**. SIP T2 is 4 s, so a transaction
in flight at the moment of failover sees at most one or two INVITE
retransmits before its response arrives via the new master. UAC
notices nothing more than one re-tx.

### Priority and preemption

Both pods are configured `state BACKUP` with equal priority and
`nopreempt`. After a failover, the new master keeps the VIP even
when the old master comes back — preempting back would cause
needless flapping. Operators force a manual move via `kill -USR2`
on the master keepalived process (see Runbook below).

### `vrrp_script` self-health gate

A script runs every 1 s on each proxy and probes the proxy's own
`/ready` HTTP endpoint:

- 200 → script returns 0 → no priority change
- non-200 → script returns 1 → keepalived applies `weight -50` to
  this pod's effective priority

If the master's effective priority drops below the standby's, the
standby promotes. This catches "proxy alive but degraded" cases that
pure VRRP peer-silence would miss: stuck event loop, GC pause,
DrainingState set but process not yet exiting, network partition to
workers.

### SIGTERM self-cede

K8s pod termination order on graceful drain:

1. Pod marked `Terminating`, Endpoints controller removes it from
   the Service (irrelevant for us — clients use the VIP, not the
   Service IP, but useful for any debug/admin path).
2. **`preStop` hook on the keepalived sidecar** runs first:
   `pkill keepalived`. This drops the VIP immediately — no waiting
   for the 1.5 s hold-down on the peer's side. Standby promotes
   within ~100–300 ms (just the ARP convergence).
3. Then SIGTERM is sent to the proxy container. The proxy flips
   `DrainingState` and continues forwarding in-flight transactions
   for `terminationGracePeriodSeconds` (200 s, sized for SIP Timer
   C of 180 s + 20 s safety per
   [resilience-model.md](sip-front-proxy/resilience-model.md)).
4. Process exits cleanly when the grace period expires or in-flight
   work drains.

The order is critical: VIP must move *before* SIGTERM hits the proxy
process, otherwise new INVITEs continue to arrive at the dying pod
during the drain window.

## Source-IP discipline

The proxy uses **two different source IPs** for outbound traffic:

| Outbound traffic | Source IP | Rationale |
|------------------|-----------|-----------|
| Forwarded INVITE / response (proxy → worker) | **VIP** | Worker replies to whoever owns VIP now. In-flight calls survive failover via Record-Route HMAC cookie ([LoadBalancer.ts:108-155](../src/sip-front-proxy/strategies/LoadBalancer.ts#L108)). |
| OPTIONS health probes (proxy → worker) | **per-proxy node IP** | Both proxies probe independently. Standby cannot bind the VIP source while not ARP-master, so it must use its own node IP. Workers respond to whichever IP each probe came from. |

Both proxies bind the VIP as `/32` on `lo` regardless of master
status. Linux allows binding outbound sockets to any IP that exists
on any local interface — `lo` counts. This is the classic DSR
loopback trick: ARP-wise only the master owns the VIP, but
source-IP-wise both proxies can spoof it. No raw packets needed.

The forward socket source binding is configured via
`forwardSourceIp` ([ProxyCore.ts](../src/sip-front-proxy/ProxyCore.ts)).
When `vip.enabled` is true the helm chart wires it to the VIP
address. Inbound listener stays bound to `0.0.0.0` so the proxy
accepts traffic on both VIP (when master) and node IP (debug/admin).

## State at failover

### Survives

- **Record-Route HMAC cookie** ([LoadBalancer.ts:108-155](../src/sip-front-proxy/strategies/LoadBalancer.ts#L108)) —
  every routed call has its primary + backup worker IDs encoded into
  the URI param of the Record-Route header, signed with a key both
  proxies share. The new master decodes the cookie on any in-dialog
  request and routes to the same worker the original master picked.
- **Worker call/dialog state** — held by the worker process and
  backed by Redis (`CallStateCache`). Workers don't notice the proxy
  failover at all; they just see the next request arriving from the
  same VIP source IP as before.
- **Worker liveness map** — both proxies run independent OPTIONS
  probes. The standby's map is always warm; promotion is instant
  from a routing-decision perspective.

### Does not survive

- **In-flight transaction timers** held by the dying proxy. The new
  master constructs fresh Via stamps for any retransmit it sees —
  acceptable per RFC 3261 §17 transaction layer semantics.
- **CancelBranchLru entries** ([CancelBranchLru.ts](../src/sip-front-proxy/CancelBranchLru.ts)) —
  in-memory 32 s LRU mapping `(Call-ID, CSeq)` → INVITE downstream
  target + branch, used to forward CANCELs to the right destination.
  A CANCEL in flight at the exact moment of failover loses its
  correlation; the new master responds 481. Bounded, narrow window;
  not replicated.

## Deployment-target matrix

| Target | VIP mechanism | Notes |
|--------|---------------|-------|
| **kind** (CI / dev) | keepalived sidecar | Multicast works on the kind docker bridge. Pick a static VIP from the bridge subnet (`docker network inspect kind`). Anti-affinity required. |
| **bare metal / colo** | keepalived sidecar | Native fit. VRRP is the de-facto standard on telco bare metal. |
| **AWS / GCP / Azure** | not keepalived — switch to cloud NLB or kube-vip BGP | Cloud VPCs do not pass VRRP multicast. Substitute mechanism without changing proxy code: the proxy already binds outbound to the configured `forwardSourceIp`; point that at the cloud LB's frontend IP and let the cloud LB handle inbound failover. |

The proxy code is mechanism-agnostic: all VIP-specific configuration
flows through `vip.address` and `forwardSourceIp` in helm values.
Switching from keepalived to cloud LB is a chart-level change, not a
code change.

## Operator runbook

### Verify which pod holds the VIP

```bash
# Check ARP ownership (only master should show VIP on the primary iface)
kubectl -n <ns> get pods -l app.kubernetes.io/name=sip-front-proxy -o name | \
  while read p; do
    echo "=== $p ==="
    kubectl -n <ns> exec "$p" -c sip-front-proxy -- ip -4 addr show
  done

# Check keepalived state
kubectl -n <ns> exec sip-front-proxy-0 -c keepalived -- \
  cat /tmp/keepalived.state
# expect MASTER on one pod, BACKUP on the other
```

### Force VIP failover (planned maintenance)

```bash
# Option A — drop VIP on the master, standby will promote in ~1.5s
kubectl -n <ns> exec <master-pod> -c keepalived -- pkill -USR2 keepalived

# Option B — graceful drain of the master (also moves VIP)
kubectl -n <ns> delete pod <master-pod>
# preStop pkill on the keepalived sidecar moves VIP within ~300ms
```

### Known failure modes

- **Multicast loss on the L2 segment** — VRRP advertisements are
  multicast (224.0.0.18). A noisy or congested L2 can drop them and
  trigger split-brain (both pods think they're master). With
  `nopreempt` + ARP last-writer-wins, traffic still goes somewhere,
  but health is degraded until multicast recovers. Mitigation:
  unicast VRRP via `unicast_peer` block — supported by keepalived,
  added to chart values when needed.
- **Asymmetric reachability** — master can hear standby but not
  vice-versa. Standby promotes on hold-down expiry, master keeps
  asserting; ARP table on the L2 segment converges to whichever GARP
  was seen most recently. Same mitigation as above.
- **CNI / overlay limitations** — some K8s CNIs (Cilium without
  `enable-l2-pod-announcements`, Calico in IPIP mode) drop unsolicited
  ARP from pods even with `hostNetwork`. Verify on bringup.

## How chaos exercises this

See [k8s-endurance.md](k8s-endurance.md) "LB-proxy chaos". Each
event type targets a specific failover code path and is admitted to
the catalog only if its proper handling has zero or near-zero
traffic impact:

- `proxy-pod-graceful` — SIGTERM self-cede + drain
- `proxy-pod-kill9` — VRRP peer-silence detection
- `proxy-cutoff-vrrp` — split-brain handling (designed to be
  invisible: `nopreempt` + strict-ARP keeps the original master)
- `node-shutdown-edge` (catalog event) — whole-node failure
