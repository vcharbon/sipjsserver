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
