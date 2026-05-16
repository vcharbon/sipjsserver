# Overload Protection & Emergency Priority

Reference for the five-gate overload-protection model. Replaces the
2026-04 three-tier model (which described a cluster-mode Dispatcher
that no longer exists post-ADR-0005). Companion to
[b2bua-sip-headers.md](b2bua-sip-headers.md) and [ADR-0006](adr/0006-overload-five-gate-and-aimd.md).

## Goal

Under traffic spikes, shed *new* call attempts as early and as cheaply
as possible so already-admitted calls keep flowing without packet loss
or retransmit-induced amplification. Emergency calls
(`Resource-Priority: esnet.0|wps.0|q735.0`) are never dropped at any
gate.

## The five gates

```
external new-dialog non-emergency INVITE
        │
        ▼
  Gate 1: UDP queue threshold (Tier-1 brake, byte-scan)
        │   ──► stateless 503 (template, no parse, no fiber)
        │
        ▼
  Gate 2: Proxy-self ELU + CPS bucket  (slice 6 — ProxySelfGate)
        │   ──► stateless 503 reason=proxy_overload_{elu|cps}
        │
        ▼
  Gate 3: Candidate filter — drop workers in above_critical band
        │   ──► NoTargetAvailable when set is empty
        │
        ▼
  Gate 4: Per-(LB, worker) AIMD bucket (WorkerLoadObserver)
        │   ──► RateCapExhausted ──► stateless 503 reason=rate_cap_exhausted
        │
        ▼
  Gate 5: Worker-side panic backstop  (OverloadController)
        │   ──► 503 reason=panic_elu  (or bucket_empty for CPS hard cap)
        │
        ▼
   SipRouter → handlers → CallLimiter
```

| Traffic class | Gates that apply |
|---|---|
| External, new-dialog, non-emergency INVITE | 1 → 2 → 3 → 4 → 5 |
| Emergency INVITE (Resource-Priority matches) | 1 only (defense-in-depth at UDP layer) |
| In-dialog request (re-INVITE, BYE, ACK, …) | 1 only |
| Worker-originated INVITE (B-leg via proxy) | 1 only — gates 2-5 bypassed |
| REGISTER, OPTIONS, responses | 1 only |

## The signal flow

```
                       ┌──────────────────────────────────────────────────────┐
                       │ worker                                               │
                       │                                                      │
                       │  LoadSampler.elu/gcFraction (perf_hooks)             │
                       │              │                                       │
                       │              ▼                                       │
                       │  OverloadController                                  │
                       │    eluEwma, gcFractionEwma, nonEmergencyAdmittedTotal│
                       │    xOverloadHeaderValue()                            │
                       │              │                                       │
                       └──────────────│───────────────────────────────────────┘
                                      │
                  X-Overload: v=1;    │
                  elu=…; gc=…; adm=…  │   stamped on:
                                      │     - every OPTIONS 200/503 reply
                                      │     - every 503 reply to non-emergency INVITE
                                      ▼
                       ┌──────────────────────────────────────────────────────┐
                       │ LB (front-proxy)                                     │
                       │                                                      │
                       │  HealthProbe                                         │
                       │    parses X-Overload from OPTIONS replies            │
                       │    → applyPayload(workerId, payload, nowMs)          │
                       │              │                                       │
                       │              ▼                                       │
                       │  WorkerLoadObserver                                  │
                       │    per-worker AIMD state machine                     │
                       │    bandFor(workerId), tryConsumeFor(workerId)        │
                       │              │                                       │
                       │              ▼                                       │
                       │  LoadBalancerStrategy.selectForNewDialog             │
                       │    filter band==above_critical (non-emergency only)  │
                       │    rendezvous-select among remaining                 │
                       │    bucket consume (non-emergency only)               │
                       │              │                                       │
                       └──────────────│───────────────────────────────────────┘
                                      ▼
                              forwarded INVITE
```

## Worker side

### `LoadSampler` ([src/observability/LoadSampler.ts](../src/observability/LoadSampler.ts))

Two readings, each `0..1`, computed since the previous read:

- `elu()` — Node `perf_hooks.performance.eventLoopUtilization()` delta. Includes
  major GC pauses ("loop is busy"). Production layer uses `perf_hooks`; the
  simulated layer is ref-backed for fake-clock tests.
- `gcFraction()` — fraction of wall time spent in GC pauses
  (`PerformanceObserver type=gc`).

The sampler is sync. EWMA smoothing is done by the consumer
(`OverloadController`), not the sampler — keeps the test fixture
simple ("inject 0.85 directly, no convergence wait").

### `OverloadController` ([src/b2bua/OverloadController.ts](../src/b2bua/OverloadController.ts))

Roles:
1. **Publisher.** EWMA-smooths the LoadSampler's readings and the
   `nonEmergencyAdmittedTotal` counter, exposes
   `xOverloadHeaderValue()` for OPTIONS / 503 stamping.
2. **Panic backstop.** Local 503 only when ELU EWMA crosses
   `OVERLOAD_PANIC_ELU_THRESHOLD` (default `0.98`) — well above the LB's
   `OVERLOAD_ELU_CRITICAL`, so it almost never fires in normal
   operation. Catches "LB absent / misconfigured / itself overloaded".
3. **CPS hard ceiling.** Pre-existing `CPS_BUCKET_SIZE` /
   `CPS_BUCKET_RATE` token bucket — keeps the worker from ever
   exceeding a configured CPS regardless of LB decisions.

What was removed in slice 7 of the rework:
- The probabilistic shedder (`Math.random() < p`). Gradual response is
  the LB AIMD's job.
- The `inDialogQueueDepth` signal — no longer meaningful post-ADR-0005
  (per-call dispatch removed the global in-dialog queue).
- The `fraction*` shedding signals, `shedProbability` metric.

What was kept:
- `setActiveCalls`, `setInDialogQueueDepth` as no-op setters (backwards
  compat with callers that still pass a gauge).
- `observeRoutingApiLatency` for the routing-API latency metric (used
  by dashboards, not by admission).

### `X-Overload` wire format

```
X-Overload: v=1; elu=0.852; gc=0.310; adm=12345
```

| Param | Semantics |
|---|---|
| `v` | Schema version. `1` is the only defined version. Future-extensible. LB silently ignores unknown versions (treats as legacy = `notePayloadMissing`). |
| `elu` | EWMA-smoothed Event Loop Utilization (0..1), 3 decimal places. |
| `gc` | EWMA-smoothed fraction of wall time spent in GC pauses (0..1), 3 decimal places. Day-1 LB records as a metric only; future bands can switch to `effective_elu = max(0, elu - gc)`. |
| `adm` | Monotonic counter of non-emergency new-dialog INVITEs admitted since process start. Worker restart resets the counter; the LB detects the decrease and re-baselines (`workerTreatedRateCps := 0` for that tick). |

Stamped on:
- Every OPTIONS 200 reply ([src/sip/SipRouter.ts](../src/sip/SipRouter.ts)).
- Every OPTIONS 503 reply ([src/sip/SipRouter.ts](../src/sip/SipRouter.ts)).
- (Future slice) Every 503 reply to a non-emergency INVITE — collapses
  the 1 s OPTIONS lag for the "I just got overloaded" signal.

## LB side

### `WorkerLoadObserver` ([src/sip-front-proxy/WorkerLoadObserver.ts](../src/sip-front-proxy/WorkerLoadObserver.ts))

Per-(LB, worker) AIMD state machine. One bucket per worker, fed by
`HealthProbe` from `X-Overload` payloads.

**Band derivation (with hysteresis):**

```
elu > eluCritical                  → above_critical   (filter out)
elu > eluHard                      → hard_to_critical (decrease)
elu > eluSoft                      → soft_to_hard     (hold)
elu ≤ eluSoft                      → below_soft       (increase if not in cooldown)
```

Boundaries are hysteresis-aware: once **in** the higher band, the
worker must drop below `enter − bandHysteresis` before transitioning
out. Prevents flap when `elu` oscillates around a boundary.

**AIMD action per OPTIONS tick:**

```
above_critical:       cap ← floor; arm cooldown   (filter applies in selectForNewDialog)
hard_to_critical:     cap ← max(floor, cap × decreaseFactor); arm cooldown
soft_to_hard:         hold (deadband)
below_soft:           if cooldown elapsed: cap ← min(ceiling, cap + increaseStep)
```

**Stale-payload sweep:** if a worker's last payload is older than
`payloadStaleMs` (default 5 s), `sweepStale` decreases its cap
conservatively. Acts as a backstop when OPTIONS replies fail to
arrive (network partition / worker freeze).

### Selection at the LB

```
selectForNewDialog(msg):
  isEmergency = readResourcePriority(msg)
  candidates = snapshot.alive
  if !isEmergency: candidates = candidates.filter(bandFor(w) !== above_critical)
  if candidates.empty: fail NoTargetAvailable
  winner = rendezvousSelect(callId, candidates)
  if isEmergency: recordOwnAdmitted(winner); return winner
  if !tryConsumeFor(winner): fail RateCapExhausted(retryAfterSec)
  recordOwnAdmitted(winner)
  return winner
```

Emergency INVITEs bypass both the CRITICAL filter and the bucket. The
proxy core converts `NoTargetAvailable` → `503 Reason=no_target_available`
and `RateCapExhausted` → `503 Reason=rate_cap_exhausted` with the
suggested Retry-After.

### Stickiness cookie (`w_pri` / `w_bak`) is ELU-agnostic

The backup ordinal stamped in the Record-Route cookie is the
second-best HRW winner among the alive set — **no ELU filter applied
at encode time**. Rationale (locked during the design grilling):

- The backup will normally do 0 work for this call; current CPU at
  encode time has no bearing on its load at fail-over time, which may
  be hours later.
- "Overload + half the fleet dies" is a chaos event already covered by
  the CRITICAL filter on new-dialog selection: a backup that takes
  on a wave of decoded-cookie traffic and crosses CRITICAL is
  automatically stripped from the new-dialog candidate set,
  redistributing further work to whoever has headroom.

## Proxy-self gate ([src/sip-front-proxy/ProxySelfGate.ts](../src/sip-front-proxy/ProxySelfGate.ts))

The front-proxy is a single Node process; under flood it saturates
before any worker sees the traffic. The `ProxySelfGate` gates external
new-dialog non-emergency INVITEs on two checks:

```
if proxy_elu_ewma > PROXY_ELU_CRITICAL: reject proxy_overload_elu
elif !cpsBucket.tryConsume(): reject proxy_overload_cps
```

Both checks are binary (no AIMD) — the proxy's ELU is its own; there's
no second party to converge with.

Classification of "external" relies on
`registry.lookupByAddress(srcAddr)`: a packet whose source IP:port
matches a registered worker is **internal** and bypasses the gate.
Rejecting internal traffic would just bounce the worker's B-leg
attempt — added load, not shed load.

Emergency INVITEs also bypass the gate (`isEmergencyRequest(req)`
matches the same RPH tokens the worker uses).

## Configuration

| Knob | Default | Effect |
|---|---|---|
| **Worker side** | | |
| `OVERLOAD_PANIC_ELU_THRESHOLD` | `0.98` | Worker panic-503 trigger |
| `CPS_BUCKET_SIZE` | 1000 | Worker CPS hard ceiling (capacity) |
| `CPS_BUCKET_RATE` | 500 | Worker CPS hard ceiling (rate) |
| `UDP_QUEUE_MAX` | 100 | Bounded UDP recv queue |
| `UDP_QUEUE_TIER1_THRESHOLD_PCT` | 70 | Tier 1 brake activation |
| **LB-AIMD side** (parameterised at layer-build via `WorkerLoadObserverConfigData`) | | |
| `eluSoft` | `0.60` | AIMD increase enabled below |
| `eluHard` | `0.80` | AIMD multiplicative decrease above |
| `eluCritical` | `0.95` | Worker filtered out of new-dialog set |
| `bandHysteresis` | `0.02` | Exit threshold = enter − h |
| `aimdIncreaseStepCps` | `+5` | Additive increase per OPTIONS tick |
| `aimdDecreaseFactor` | `0.75` | Multiplicative decrease (×0.75) |
| `aimdCooldownTicks` | `3` | No increases for N ticks post-decrease |
| `capInitialCps` | `100` | Fresh worker's starting cap |
| `capFloorCps` | `1` | Cap never below |
| `capCeilingCps` | `10000` | Cap never above |
| `payloadStaleMs` | `5000` | Stale-payload sweep threshold |
| `optionsIntervalMs` | `1000` | Cooldown clock unit |
| **Proxy-self gate** | | |
| `ProxySelfGate.eluCritical` | `0.95` | Proxy-self 503 trigger |
| `ProxySelfGate.cpsBucketSize` | `1000` | Proxy external new-dialog CPS cap |
| `ProxySelfGate.cpsBucketRate` | `500` | Proxy CPS refill rate |

Every knob is live-tunable in principle (no constants are hardcoded
in admission paths); production currently bakes defaults at layer
build. Wire as AppConfig / env in the next operations push when
operator data motivates it.

## Observability

`b2bua_overload_*` (worker), `sip_proxy_worker_*` (LB-AIMD),
`sip_proxy_self_*` (proxy gate), and the existing
`b2bua_dispatch_worker_*` queue metrics together feed the
[overload-protection Grafana dashboard](../deploy/observability/stack/grafana/dashboards/overload-protection.json).

The chaos cockpit's lead panel is the **rejection-by-gate stacked
time series**, which shows where in the chain each shed INVITE was
dropped — operator can read the gate that fired without grepping
logs.

## Verification

| Test | Coverage | Where |
|---|---|---|
| `WorkerLoadObserver.test.ts` | AIMD math (bands, hysteresis, cooldown, decrease/increase, floor/ceiling, stale sweep) | unit |
| `OverloadController-xoverload.test.ts` | Worker-side X-Overload publication | unit |
| `LoadSampler.test.ts` | Sampler service shape (production + simulated) | unit |
| `selectForNewDialog-overload.test.ts` | LB integration (emergency bypass, CRITICAL filter, RateCapExhausted) | integration |
| `non-emergency-burst` chaos event in K8s endurance | End-to-end acceptance under sipp load | live |

The K8s endurance acceptance rule lives in
[tests/k8s/endurance/expectedImpact.ts](../tests/k8s/endurance/expectedImpact.ts)
under `non-emergency-burst`: emergency baseline streams MUST stay
below 2% failure rate during the burst, burst stream MUST be ≥ 50%
rejected (shed).
