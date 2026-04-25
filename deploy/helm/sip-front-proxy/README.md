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
| `previousHmacKey` | `""` | Set during fleet-wide key rotation for the NFR-8 1h overlap window. |
| `terminationGracePeriodSeconds` | `200` | RFC 3261 Timer C (180s) + 20s safety. |
| `healthProbe.intervalMs` | `2000` | Per `OptionsKeepaliveOpts.intervalMs`. |
| `healthProbe.timeoutMs` | `1500` | Per-probe response timeout. |
| `healthProbe.threshold` | `3` | Misses before a worker is marked dead. |

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
