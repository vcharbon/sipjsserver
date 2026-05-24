# ADR 0012 — B2BUA worker memory sizing model

## Status

Accepted. Drives `tests/k8s/values/b2bua-worker*.yaml` and the
production helm chart's `resources.limits.memory`. Complements
ADR 0007 (overload protection — bounds traffic) and ADR 0011
(codec — bounds per-call body size).

## Context

The May 2026 endurance investigation
(`gauges-verify-20caps-1abuse-30m-2026-05-24t11-21`) revealed that
worker RSS under abuse traffic plateaus at ~1.1–1.2 GB, well above
the "small-server" intuition for a B2BUA whose live JS heap is
~550 MB. The gap had four sources, in order of contribution:

1. **glibc malloc retention** (`MALLOC_ARENA_MAX` default of
   `8 × nproc` arenas → high alloc churn pins arenas indefinitely);
2. **V8 code space + map space** (not counted by
   `process.memoryUsage().heapTotal` — grows with workload variety);
3. **txnMap Timer H/J occupancy** (RFC 3261 §17 — every server
   final response pins the transaction for 32 s, including
   `lastResponse` Buffer);
4. **flushCache encoded msgpack bodies** (one per live call,
   grows with `messageCount` up to `maxMessagesPerCall`).

Each of these is bounded — but only if we (a) know the bound,
(b) measure it, and (c) gate admission before the bound is hit.
Without an explicit sizing model, every endurance run rediscovers
the plateau and re-investigates from scratch.

## Decision

The B2BUA worker's memory budget is a sum of **named, observed,
and asserted** components. Each component has:

- a **steady-state target** that admission control must respect,
- a **gauge** in `/metrics` whose ratio against the target is
  visible on the *Memory Sizing* Grafana dashboard,
- an **escape valve** (admission cap, queue bound, or trim) that
  fires before the component blows past its target.

### Sizing model

```
RSS(steady-state) ≈
    BASE_NATIVE                              # libuv + V8 code base + thread stacks
  + V8_CODE_SPACE                            # JIT'd code (grows with workload variety)
  + V8_OLD_SPACE(live JS objects)
  + EXTERNAL(Buffer backing for live work)
  + ALLOCATOR_RETENTION(churn)
```

Component-by-component:

| Component | Steady-state target | Gauge | Escape valve |
|---|---|---|---|
| `BASE_NATIVE` | 150 MB | derived: `rss − (heap_total + external)` baseline | none — constant |
| `V8_CODE_SPACE` | 100 MB | `b2bua_v8_heap_space_bytes{space="code_space",kind="committed"}` | none — bounded by V8 |
| `V8_OLD_SPACE` (live calls) | 200 MB | `b2bua_v8_heap_space_bytes{space="old_space",kind="used"}` | `--max-old-space-size=800` |
| `flushCache` encoded bodies | 100 MB | `b2bua_flush_cache_bytes` | `MAX_MESSAGES_PER_CALL` (caps body size) + `MAX_CONCURRENT_CALLS` (caps entry count) |
| `txnMap` Buffers (Timer H/J) | 50 MB | `b2bua_worker_active_transactions{role="server",state="completed"}` × ~1.5 KB | overload Tier-3 admission (caps INVITE rate) |
| `ALLOCATOR_RETENTION` | 100 MB | `b2bua_v8_heap_stats_bytes{kind="peak_malloced_memory"}` − `…malloced_memory` | `MALLOC_ARENA_MAX=2` env var |
| **TOTAL TARGET** | **700 MB** | `b2bua_process_memory_bytes{kind="rss"}` | container `resources.limits.memory: 2Gi` (headroom) |

The 2 GiB container limit is ~3× the steady-state target. The
headroom absorbs (a) transient bursts during admission decisions,
(b) heap-snapshot doubling during diagnostics, and (c) abuse
traffic whose admission has not yet been tightened to the
target.

### Workload assumptions

The targets above hold under these workload bounds. Drift means
the targets must be revisited:

| Parameter | Target | Gauge | Source |
|---|---|---|---|
| Concurrent calls per worker | ≤ 1000 | `b2bua_active_dialogs` | T_concurrent_calls |
| Call-setup rate (CPS) | ≤ 50/s/worker | `rate(b2bua_overload_admit_total)` | Tier-3 admission cap |
| Messages per call (lifetime) | ≤ 100 | `b2bua_worker_messages_processed_total / b2bua_active_dialogs` | `MAX_MESSAGES_PER_CALL` |
| Avg inbound SIP message size | ≤ 2 KB | `rate(b2bua_messages_bytes_total{direction="inbound"}) / rate(b2bua_messages_total{direction="inbound"})` | empirical |
| Avg encoded Call body | ≤ 100 KB | `b2bua_flush_cache_bytes / b2bua_flush_cache_entries` | empirical, scales with `messageCount` |
| Replication writes / s / worker | ≤ 500/s | `rate(b2bua_replication_writes_total)` | derived from CPS × messages-per-call |

The B2BUA does **not** enforce these via admission — the
overload controller (ADR 0007) bounds CPS and the
`MAX_MESSAGES_PER_CALL` cap (`SipRouter.ts:999-1108`) bounds the
per-call tail. The assumptions are tracked so a regression
(e.g. avg body size doubling because a new feature added a
50-field schema field) trips the dashboard, not the production
incident.

### Sizing assertions in launch parameters

`tests/k8s/values/b2bua-worker.endurance.yaml` and the
production helm values document the assertions inline. Three
load-bearing environment variables:

```yaml
# Caps V8 old-space at 800 MB. Combined with the 2Gi container cap,
# leaves ~1.2 GiB for code space + external + allocator + diagnostic
# heap snapshot doubling. See ADR 0012 §"Sizing model".
NODE_OPTIONS: "--max-old-space-size=800 ..."

# Clamps glibc to 2 arenas (default is 8 × nproc). Reduces ALLOCATOR_RETENTION
# under high alloc churn by ~50%. See ADR 0012 §"Allocator retention".
MALLOC_ARENA_MAX: "2"

# Caps the per-call message count. Bounds flushCache encoded body size to
# ~100 KB per entry (scales with messageCount). See ADR 0012 §"flushCache".
MAX_MESSAGES_PER_CALL: "100"
```

### Memory Sizing dashboard

Single dashboard (`grafana/dashboards/memory-sizing.json`) layers
**three** levels of view, top to bottom:

1. **Node level** — `node_memory_MemAvailable_bytes`,
   `node_memory_MemTotal_bytes` (node_exporter). Confirms the
   cluster has the capacity model the targets above assume.
2. **Container level** — `container_memory_working_set_bytes`,
   `kube_pod_container_resource_limits{resource="memory"}`
   (cAdvisor + kube-state-metrics). Shows each worker pod's
   actual cgroup usage vs its limit.
3. **Process level** — every gauge in the table above. Each
   panel includes a horizontal threshold line at the target
   value so the operator can see the assumption alongside the
   measurement.

### Out of scope

- **Front-proxy sizing** — separate model, separate ADR if needed.
- **Limiter Redis sizing** — addressed by per-call limiter design;
  not memory-budget-constrained.
- **Local sidecar Redis sizing** — see ADR `lb-proxy-ha.md` /
  the propagate-ZSET section of the
  `gauges-verify-20caps-1abuse-30m-2026-05-24t11-21` handoff.
  The sidecar's `maxmemory` setting is the bound for
  peer-dead replication backlog.

## Consequences

- Sizing regressions show up on the dashboard the same shift a PR
  lands, instead of two endurance cycles later.
- Container `resources.limits.memory` is **derived**, not picked
  arbitrarily. Production changes go through this ADR.
- New code that allocates per-call native memory must be added
  to the model (or justified as fitting within the existing
  component's target).
- The targets are subject to revision when workload assumptions
  change. Every revision updates this ADR and the dashboard
  threshold lines.
