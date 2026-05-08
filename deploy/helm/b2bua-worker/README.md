# b2bua-worker

Helm chart for the B2BUA worker. Deploys a `StatefulSet` of replicas
plus a headless `Service` for stable per-pod DNS. The
`sip-front-proxy` chart watches these pods via the K8s API and
load-balances UDP SIP traffic across them.

## Quick start

```bash
helm install b2bua deploy/helm/b2bua-worker \
  --namespace sip \
  --set replicaCount=3
```

## REQUIRED when paired with `sip-front-proxy`: `B2B_OUTBOUND_PROXY`

When this chart is co-deployed with the `sip-front-proxy` chart in the
same namespace, the worker MUST be told the proxy's address via the
`B2B_OUTBOUND_PROXY` env var. Set it through `extraEnv` in your values
file:

```yaml
extraEnv:
  - name: B2B_OUTBOUND_PROXY
    # Use the front-proxy VIP when sip-front-proxy.vip.enabled (the
    # default for HA topologies — see the sip-front-proxy README).
    # Otherwise use the Service DNS `sip-front-proxy:5060`.
    value: "172.20.255.250:5060"
```

### Why this is required

The B2BUA originates several **B2BUA→Bob in-dialog requests** that have
nothing to do with messages it received from the proxy:

- **15-min keepalive OPTIONS** (`keepaliveRule`) — without `B2B_OUTBOUND_PROXY`
  the b-leg INVITE bypasses the proxy, so the response carries no
  Record-Route, the b-leg dialog's `routeSet` stays empty, and 15 min
  later the keepalive OPTIONS is sent worker-direct to bob's pod IP.
  In a typical k8s deployment that pod IP is unreachable across NAT /
  network-policy boundaries; the OPTIONS times out and
  `keepaliveTimeoutRule` tears the call down. **Every long-hold call
  (>15 min) gets ripped out** until this is set.
- **Relay re-INVITE / INFO / UPDATE / MESSAGE** — same egress path. A
  UAC-initiated mid-dialog request gets relayed by the worker through
  the same code; without the outbound-proxy invariant it bypasses the
  proxy and may not reach bob.
- **Worker-originated BYE / CANCEL / NOTIFY / re-INVITE** — same.

### What the worker does with the value

When set, `helpers.ts` preloads `Route: <sip:<value>;lr;outbound>` on
every b-leg-initiating INVITE. The proxy strips the Route, classifies
the request as worker-outbound via the `;outbound` param, and forwards
to the R-URI (bob). The proxy Record-Routes its own address back into
the response, populating the worker's b-leg routeSet so subsequent
in-dialog requests transit the proxy automatically.

Even when the b-leg routeSet ends up empty for some reason (proxy
didn't Record-Route, dialog state lost), the worker now falls back to
`B2B_OUTBOUND_PROXY` for in-dialog egress and logs an error so the
misconfiguration surfaces. If the value is unset and the proxy is
required, every b-leg in-dialog request goes pod-direct silently.

### Schema — b-leg (private) call flow

The b-leg is the dialog the worker **originates** toward bob (callee).
It is *not* a pass-through of alice's a-leg dialog: the worker mints
a new Call-ID, new From-tag, new Via, new transactions, and acts as a
UAC. Every b-leg wire packet must traverse the front proxy.

```
        b2bua-worker                  sip-front-proxy                bob
        pod 10.244.4.2                bind = VIP                  10.244.5.5
            :5060                     e.g. 172.20.255.250:5060      :5060

   B-leg INVITE (initial)
   ──────────────────────────────►
   src=10.244.4.2 dst=VIP            classify by `;outbound`,
   Route: <sip:VIP;lr;outbound>      strip Route, insert R-Route,
   ↑ preloaded from                  forward to R-URI:
     B2B_OUTBOUND_PROXY              ─────────────────────────────►
   Via: worker                       src=VIP  dst=10.244.5.5
   R-URI: sip:bob@10.244.5.5         R-Route: <sip:VIP;lr;sticky=w>

   200 OK comes back through proxy → worker stores
     bLeg.routeSet = [<sip:VIP;lr;sticky=w>]

   In-dialog egress (keepalive OPTIONS, relay re-INVITE, INFO, BYE…)
   ──────────────────────────────►
   src=10.244.4.2 dst=VIP            classify by `;outbound`,
   Route: <sip:VIP;lr;sticky=w;      forward to R-URI = bob:
           outbound>                 ─────────────────────────────►
   ↑ `;outbound` appended on         src=VIP  dst=10.244.5.5
     egress (E.2 invariant)
```

If `B2B_OUTBOUND_PROXY` is unset: the initial INVITE is sent direct
to bob's pod IP, the response carries no Record-Route, the b-leg
`routeSet` stays empty, and **every subsequent worker-originated b-leg
request goes pod-direct**. The 15-min keepalive then tears down every
long-hold call. See the sip-front-proxy chart README for the full
two-leg topology.



## Why a StatefulSet (D3)

- Pod names are stable and ordered (`b2bua-worker-0`, `-1`, ...).
- The proxy uses `pod.metadata.name` as the worker id stamped into
  the routing-cookie (D3). Stable names mean cookies survive pod
  restarts.
- Headless Service gives each pod a DNS A record
  (`<pod>.<svc>.<ns>.svc.cluster.local`) that operators can poke at
  with `nc -u` for debugging.

## Drain semantics (D5)

- The worker's `DrainingState.Default` SIGTERM handler flips the
  OPTIONS reply to `503 Service Unavailable` + `Retry-After: 0`
  immediately on receipt of SIGTERM (RFC 3261 §11 / §21.5.4).
- The proxy's K8s watch additionally treats
  `pod.metadata.deletionTimestamp != null` as `draining` (the
  deletion-timestamp accelerant), so detection is bounded above by
  the K8s watch latency rather than the OPTIONS interval.
- `terminationGracePeriodSeconds: 200` (default) covers RFC 3261
  Timer C (180s) plus 20s safety so in-flight INVITEs / CANCELs reach
  the original worker for the entire window.

## Probes

K8s probes are TCP-socket against the admin port (`3002` by default).
This is a hard-crash detector only. SIP-level readiness ("drained
but still serving") is owned by the proxy's `HealthProbe.optionsKeepalive`
(D5) — Phase 2 will add a real HTTP `/health` endpoint that exposes
`DrainingState.mode` so K8s can flip readiness without taking the pod
out of `LoadBalancer` rotation.
