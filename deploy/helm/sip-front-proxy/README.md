# sip-front-proxy

Helm chart for the SIP front proxy. Deploys a `Deployment` of N replicas
that watch a sibling B2BUA-worker `StatefulSet` and load-balance UDP SIP
traffic across its pods using rendezvous-hash + HMAC-signed
Record-Route stickiness.

See `docs/todos/SIP-Front-Proxy.md` and
`docs/sip-front-proxy/resilience-model.md` for the architectural model
this chart implements.

## Quick start

```bash
# Generate a 32-byte HMAC key.
openssl rand -base64 32 > /tmp/hmac.key

helm install sip-proxy deploy/helm/sip-front-proxy \
  --namespace sip \
  --create-namespace \
  --set worker.statefulSetName=b2bua-worker \
  --set worker.podPort=5060 \
  --set-file hmacKey=/tmp/hmac.key
```

## Required values

| Key | Why |
|---|---|
| `worker.statefulSetName` | Drives the `app.kubernetes.io/name=…` label selector the proxy uses to discover B2BUA worker pods. |
| `worker.podPort` | SIP UDP port the worker pods listen on. |
| `hmacKey` | HMAC-SHA256 key material for routing-cookie signing. Min 16 bytes, recommend ≥32. Use `--set-file` for binary content. |

## Optional values

| Key | Default | Notes |
|---|---|---|
| `replicaCount` | `2` | Scale horizontally as needed; per D6 each replica is a self-contained ingress. |
| `bind.port` | `5060` | UDP port the proxy listens on. |
| `vip.enabled` | `false` | Active/passive shared VIP via keepalived sidecar — see [docs/lb-proxy-ha.md](../../../docs/lb-proxy-ha.md). When on, the proxy listener binds the VIP **only** (overrides `bind.host`). |
| `vip.address` | (none) | The shared VIP (e.g. `172.20.255.250`). Required when `vip.enabled`. |
| `previousHmacKey` | `""` | Set during fleet-wide key rotation for the NFR-8 1h overlap window. |
| `terminationGracePeriodSeconds` | `200` | RFC 3261 Timer C (180s) + 20s safety. |
| `healthProbe.intervalMs` | `2000` | Per `OptionsKeepaliveOpts.intervalMs`. **Calibration constraint**: `intervalMs + timeoutMs` is one full HealthProbe cycle; the `WorkerLoadObserver` rejects any combination where `payloadStaleMs < 2 × (intervalMs + timeoutMs)` and the pod refuses to boot. See [`src/sip-front-proxy/config-validation.ts`](../../../src/sip-front-proxy/config-validation.ts). |
| `healthProbe.timeoutMs` | `1500` | Per-probe response timeout. Counted toward the probe cycle (see `intervalMs`). |
| `healthProbe.threshold` | `3` | Misses before a worker is marked dead. |

## Client target — `vip.enabled` changes how SIP traffic reaches the proxy

When `vip.enabled: true`, the proxy listener binds **the VIP only** (the
chart overrides `bind.host` with `vip.address`). The cluster Service
DNS `sip-front-proxy:5060` still exists, but it DNATs to the underlying
pod / node IPs — and **nothing is listening there** because the proxy
process is bound to the VIP. UDP traffic sent to the Service DNS hits
the kernel and is dropped with no ICMP for the sender; SIPp UACs see
this as `UDP retransmission timeout`.

**Operators / clients must target the VIP directly**, not the Service
DNS:

```
# wrong (when vip.enabled): silently dropped
INVITE sip:test@sip-front-proxy:5060 …

# right
INVITE sip:test@172.20.255.250:5060 …
```

This applies to:
- Test sipp jobs in the in-cluster harness — see
  `tests/k8s/fixtures/frontProxyTarget.ts` (`FRONT_PROXY_VIP_TARGET`)
  for the shared constant.
- The `b2bua-worker` chart's `B2B_OUTBOUND_PROXY` env — see that
  chart's README. Point it at the VIP.
- Any external SIP element (SBC, gateway, soft-client) that routes to
  the proxy — give it the VIP, not the Service.

When `vip.enabled: false` (legacy single-pod or external-LB-fronted
deployments), the proxy binds `bind.host:bind.port` and Service DNS
works normally.

## Call-flow schema — a-leg (public) and b-leg (private)

The B2BUA terminates one dialog with the calling party (alice) and
*originates a brand-new dialog* toward the callee (bob), with new
Call-ID, new tags, new Via stack, and new transactions. The two
dialogs are stitched together inside the worker; SIP-wise they are
independent. The schema below shows the addresses and key headers on
each hop. Both legs traverse the **same proxy VIP** — the b-leg is
not a separate ingress, it just goes back out through the proxy that
fronts the worker.

```
   ┌──────────┐         ┌────────────────────┐        ┌──────────────┐        ┌──────────┐
   │  alice   │         │  sip-front-proxy   │        │ b2bua-worker │        │   bob    │
   │ external │         │  bind = VIP        │        │ pod          │        │ UAS pod  │
   │   UAC    │         │  e.g. 172.20.255   │        │ 10.244.4.2   │        │ 10.244.  │
   │ 1.2.3.4  │         │   .250:5060        │        │   :5060      │        │ 5.5:5060 │
   │  :5060   │         │  vip.enabled:true  │        │              │        │          │
   └────┬─────┘         └──────────┬─────────┘        └──────┬───────┘        └────┬─────┘
        │                          │                         │                     │
   ─── A-LEG (public, alice-initiated) ──────────────────────────────────────      │
        │                          │                         │                     │
   (1)  │ INVITE sip:bob@VIP       │                         │                     │
        │ Route: (none)            │                         │                     │
        │ Via: alice               │                         │                     │
        │ ────────────────────────►│                         │                     │
        │  src=1.2.3.4  dst=VIP    │                         │                     │
        │                          │ proxy: insert Via,      │                     │
        │                          │   Record-Route(VIP;     │                     │
        │                          │   lr;sticky=worker),    │                     │
        │                          │   load-balance pick     │                     │
        │                          │ ──────────────────────► │                     │
        │                          │  src=VIP  dst=10.244.4.2│                     │
        │                          │  Via: proxy, alice      │                     │
        │                          │  R-Route: <sip:VIP;lr;  │                     │
        │                          │            sticky=w>    │                     │
        │                          │                         │                     │
        │       worker stores aLeg.routeSet = [<sip:VIP;lr;sticky=w>]              │
        │       (extracted from inbound R-Route — RFC 3261 §12.1.1)                │
        │                          │                         │                     │
   ─── B-LEG (private, b2bua-originated) ─────────────────────────────────────     │
        │                          │                         │                     │
        │                          │                         │ b2bua acts as UAC,  │
        │                          │                         │ MINTS new Call-ID,  │
        │                          │                         │ new From-tag, new   │
        │                          │                         │ Via, new branches   │
        │                          │                         │                     │
   (2)  │                          │                         │ INVITE sip:bob@     │
        │                          │                         │   10.244.5.5:5060   │
        │                          │                         │ Route: <sip:VIP;lr; │
        │                          │                         │         outbound>   │
        │                          │                         │ ◄ preloaded from    │
        │                          │                         │   B2B_OUTBOUND_PROXY│
        │                          │                         │ Via: worker         │
        │                          │ ◄───────────────────────│                     │
        │                          │  src=10.244.4.2 dst=VIP │                     │
        │                          │                         │                     │
        │                          │ proxy: classify by      │                     │
        │                          │   `;outbound` ⇒         │                     │
        │                          │   worker-outbound,      │                     │
        │                          │   strip Route, insert   │                     │
        │                          │   Via + R-Route(sticky) │                     │
        │                          │ ──────────────────────────────────────────►   │
        │                          │  src=VIP  dst=10.244.5.5                      │
        │                          │  Via: proxy, worker                           │
        │                          │  R-Route: <sip:VIP;lr;sticky=w>               │
        │                          │                         │                     │
        │       worker stores bLeg.routeSet = [<sip:VIP;lr;sticky=w>]              │
        │       (extracted from b-leg 200 OK's R-Route)                            │
        │                          │                         │                     │
   ─── In-dialog egress on either leg ────────────────────────────────────────     │
        │                          │                         │                     │
   (3)  │  worker-originated b-leg │                         │ keepalive OPTIONS,  │
        │  in-dialog: OPTIONS,     │                         │ relay re-INVITE,    │
        │  re-INVITE, INFO, BYE    │                         │ worker-originated   │
        │                          │                         │ BYE / CANCEL …      │
        │                          │                         │                     │
        │                          │                         │ applyEgressRouting: │
        │                          │                         │  routeSet→VIP, on   │
        │                          │                         │  egress add         │
        │                          │                         │  `;outbound` to top │
        │                          │                         │  Route URI (E.2     │
        │                          │                         │  invariant)         │
        │                          │ ◄───────────────────────│                     │
        │                          │  src=10.244.4.2 dst=VIP │                     │
        │                          │  Route: <sip:VIP;lr;    │                     │
        │                          │   sticky=w;outbound>    │                     │
        │                          │                         │                     │
        │                          │ proxy: classify by      │                     │
        │                          │   `;outbound` ⇒         │                     │
        │                          │   forward to R-URI=bob  │                     │
        │                          │ ──────────────────────────────────────────►   │
        │                          │  src=VIP  dst=10.244.5.5                      │
        │                          │                         │                     │
   (4)  │                          │ bob-originated in-dialog│                     │
        │                          │ (BYE, re-INVITE…):      │                     │
        │                          │ Route from bob's stored │                     │
        │                          │ routeSet = <sip:VIP;lr; │                     │
        │                          │   sticky=w>             │                     │
        │                          │ ◄────────────────────────────────────────     │
        │                          │  src=10.244.5.5 dst=VIP │                     │
        │                          │                         │                     │
        │                          │ proxy: NO `;outbound`,  │                     │
        │                          │   src is not a worker ⇒ │                     │
        │                          │   decode stickiness     │                     │
        │                          │   cookie ⇒ forward to   │                     │
        │                          │   the recorded source   │                     │
        │                          │   worker                │                     │
        │                          │ ──────────────────────► │                     │
        │                          │  src=VIP  dst=10.244.4.2│                     │
        │                          │                         │                     │
```

### Why the b-leg is "private"

- It has its **own dialog state** at the worker: distinct Call-ID, distinct
  From/To tags, distinct CSeq counters, distinct timers. The worker
  bridges payloads (SDP, headers) between legs but the SIP-level
  dialogs are independent.
- The worker **acts as a UAC on the b-leg**, including all the UAC
  responsibilities (maintaining CSeq, ACK-for-2xx routing, BYE on
  termination). bob never sees alice's IP, headers, or tags directly.
- The b-leg traverses the **same proxy** as the a-leg. Nothing in the
  b-leg flow is "internal" or skips the proxy — every wire packet hits
  the VIP. That property is what makes the proxy's HMAC-signed
  Record-Route stickiness work in both directions.

### The B2BUA→Bob outbound invariant

Every B2BUA→bob message — initial INVITE, mid-dialog re-INVITE / INFO /
UPDATE / MESSAGE / BYE / CANCEL, and the worker-originated 15-min
keepalive OPTIONS — is required to traverse the proxy. The mechanism:

1. `B2B_OUTBOUND_PROXY` env on the worker → preloaded `Route: <sip:VIP;lr;outbound>` on the initial b-leg INVITE.
2. Proxy classifies via `;outbound`, strips the Route, inserts its own
   Record-Route → b-leg's 200 OK carries it back → worker's b-leg
   `routeSet` is populated with `<sip:VIP;lr;sticky=w>`.
3. Subsequent in-dialog requests use `routeSet` (RFC 3261 §12.2.1.1) →
   wire dest = VIP. The worker also appends `;outbound` to the top
   Route URI on egress so the proxy classifies on the explicit param,
   not on a fragile source-IP lookup.
4. If `routeSet` ends up empty for any reason (proxy didn't
   Record-Route, dialog state lost), the worker **falls back to
   `B2B_OUTBOUND_PROXY`** for in-dialog egress and logs an error.

If `B2B_OUTBOUND_PROXY` is **unset** the b-leg INVITE bypasses the
proxy, the response carries no Record-Route, the b-leg `routeSet` is
empty, and the in-dialog fallback has nothing to fall back to → calls
that survive past the keepalive interval get torn down (15-min
keepalive OPTIONS goes pod-direct, times out, `keepaliveTimeoutRule`
fires). See the b2bua-worker chart README.

## RBAC

The chart creates a `Role` granting `get,list,watch` on `pods` in the
release namespace, bound to the proxy's `ServiceAccount`. Required for
`WorkerRegistry.kubernetesStatefulSet`.

## Phase 2 follow-ups

- Liveness / readiness probes: K8s does not support UDP probes
  natively. Phase 2 will add a thin HTTP `/health` sidecar endpoint so
  K8s can drive proxy lifecycle. For now the chart relies on the
  workload's own crash-loop detection.
- Cross-proxy shared health view (D9 carry-forward).
