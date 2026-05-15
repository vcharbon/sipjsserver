# Observability — VictoriaMetrics + VictoriaLogs + VictoriaTraces + Grafana

Single-command install of a complete observability stack for sipjsserver
running in kind. Host-side storage + UI, in-cluster scraper/forwarder.

## Architecture

```
                 host (docker compose)                   kind cluster
                 ────────────────────                    ────────────
   Grafana :3333  ◀──── PromQL ────  VictoriaMetrics :8428  ◀──── remote_write ──── vmagent (DaemonSet)
                  ◀──── LogsQL ────  VictoriaLogs   :9428  ◀──── HTTP push  ────── fluent-bit (DaemonSet)
                  ◀──── Jaeger  ───  VictoriaTraces :10428 ◀──── OTLP HTTP  ────── sipjsserver pods

                                                                vmagent k8s SD scrapes:
                                                                  • pods annotated prometheus.io/scrape=true
                                                                  • kubelet /metrics + cAdvisor (every node)
                                                                  • node-exporter   (every node, hostNetwork)
                                                                  • kube-state-metrics

                                                                fluent-bit DaemonSet ships:
                                                                  • /var/log/containers/*.log  + k8s metadata
```

The host stack joins the `kind` docker network so the in-cluster vmagent
and fluent-bit can reach it via the kind network gateway (resolved at
install time and substituted into the manifests).

## Quick start

```bash
# first install
./deploy/observability/install.sh --bootstrap

# Grafana: http://localhost:3333  (anonymous admin)
# VictoriaMetrics vmui:  http://localhost:8428/vmui
# VictoriaLogs vmui:     http://localhost:9428/select/vmui
# VictoriaTraces vmui:   http://localhost:10428/vmui
```

## Iterate on dashboards / scrape rules

Dashboards under [stack/grafana/dashboards/](stack/grafana/dashboards/) are
**bind-mounted** into the Grafana container — edit the JSON in this repo
and Grafana picks up changes within 10s. No restart, no upload.

For scrape rules in [stack/victoriametrics/prometheus.yml](stack/victoriametrics/prometheus.yml)
(host-side scrape config, mostly self-monitoring) and the vmagent
config in [kind-addons/vmagent.yaml](kind-addons/vmagent.yaml):

```bash
./deploy/observability/install.sh --apply
```

`--apply` is fully idempotent — safe to run repeatedly while refining.

## Layout

```
deploy/observability/
├── README.md
├── install.sh                # --bootstrap | --apply | --down | --status
├── stack/                    # docker compose stack (host)
│   ├── docker-compose.yml
│   ├── victoriametrics/prometheus.yml
│   └── grafana/
│       ├── provisioning/{datasources,dashboards}/*.yaml
│       └── dashboards/*.json    ← bind-mounted, edit freely
└── kind-addons/              # kubectl apply -f targets (substitutes __HOST_IP__)
    ├── 00-namespace.yaml
    ├── node-exporter.yaml        # DaemonSet, hostNetwork :9100
    ├── kube-state-metrics.yaml   # Deployment + ClusterRole
    ├── vmagent.yaml              # Deployment + ClusterRole + k8s SD + remote_write
    └── fluent-bit.yaml           # DaemonSet → host VictoriaLogs
```

## Dashboards

| UID | Title | Use it when |
|---|---|---|
| `b2bua-overview` | B2BUA — Overview | Watching live traffic: calls/sec, overload, drops |
| `b2bua-worker-internals` | B2BUA — Worker internals | Debugging GC, queue depth, terminating calls, OTel pipeline |
| `kind-nodes` | Kind — Node infrastructure | CPU/mem/disk/network IO per kind node (node-exporter) |
| `k8s-state` | Kubernetes — state & per-pod resources | Pod restarts, per-pod CPU/mem, restart counts |

Add new dashboards by dropping JSON into [stack/grafana/dashboards/](stack/grafana/dashboards/).

## How scraping works

The vmagent in [kind-addons/vmagent.yaml](kind-addons/vmagent.yaml) auto-discovers
any pod carrying:

```yaml
metadata:
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port:   "<port>"
    prometheus.io/path:   "/metrics"     # optional, defaults to /metrics
```

Both `b2bua-worker` and `sip-front-proxy` have these annotations set in
the test values overlays at [tests/k8s/values/](../../tests/k8s/values/).
For production helm installs, add the same `podAnnotations` block.

## Ports cheatsheet

| Component | Host port | Use |
|---|---|---|
| Grafana | 3333 | UI |
| VictoriaMetrics | 8428 | Prometheus query API + vmui + remote_write ingest |
| VictoriaLogs | 9428 | LogsQL + vmui + jsonline ingest |
| VictoriaTraces | 10428 | Jaeger query API + OTLP HTTP ingest + vmui |

## Tracing (sipjsserver wiring)

VictoriaTraces uses a non-standard OTLP path. Set on sipjsserver:

```bash
OTEL_TRACES_URL=http://<host-from-pod>:10428/insert/opentelemetry/v1/traces
```

In kind, `<host-from-pod>` is whatever the kind gateway resolves to —
typically `host.docker.internal` if your kind config exposes it, or the
gateway IP printed during `--bootstrap`. For host-side sipjsserver
processes use `http://localhost:10428/insert/opentelemetry/v1/traces`.

## Known issues / caveats

- **VictoriaTraces is pre-1.0.** Pinned at `v0.8.2`. API/storage may
  change between versions — see [changelog](https://docs.victoriametrics.com/victoriatraces/changelog/).
- **kube-state-metrics CRDs.** The list of `apiGroups` in the
  ClusterRole reflects k8s 1.30+. Older clusters may warn about unknown
  resources; harmless.
- **Persistent storage on host.** `stack/data/` is gitignored; it
  survives `--down`. Run `rm -rf stack/data/` for a clean slate.
