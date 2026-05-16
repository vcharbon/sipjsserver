# 0006 — Five-gate overload model + per-(LB, worker) AIMD

**Status:** accepted (2026-05-16)

## Context

The 2026-04 overload model was a three-tier design: UDP byte-brake →
cluster-mode Dispatcher class queues → worker-side max-of-fractions
shedder. The Dispatcher tier was retired by ADR-0005 (per-call
dispatch). The worker-side shedder relied on `inDialogQueueDepth` —
a signal that no longer exists post-ADR-0005, because there's no
global in-dialog queue; events are immediately dispatched to per-call
queues.

The 2026-05 chaos-burst observation in the K8s endurance run made the
gap visible: a 200-CAPS non-emergency burst leaked 10% failures into
the emergency baseline stream (see
[tests/k8s/endurance/expectedImpact.ts](../../tests/k8s/endurance/expectedImpact.ts)
`non-emergency-burst` rule comment). The plan-of-record predicted
≤ 2% — the shedder wasn't even emitting 503s, just dropping silently
via UDP retransmit timeouts.

Two structural issues:

1. **No load signal feeding the LB.** The LB selected workers by HRW
   over the alive set, with no per-worker load awareness. A hot
   worker continued to receive its share of Call-IDs regardless of
   how loaded it was.
2. **No proxy-self gate.** Under flood the proxy itself can saturate
   (its event loop) before any worker sees the traffic. The
   pre-existing UDP byte-brake fires only when the recv queue is
   already deep; it has no notion of "I'm too loaded to do useful
   routing work right now."

## Decision summary

Replace the post-ADR-0005 broken model with a **five-gate** model
backed by **per-(LB, worker) AIMD** and a **proxy-self gate**:

1. UDP queue threshold (unchanged — Tier-1 brake).
2. **Proxy-self gate** — new, slice 6. ELU + CPS bucket gating
   external new-dialog non-emergency INVITEs only.
3. **Candidate filter** — new, slice 5. Workers in `above_critical`
   band excluded from new-dialog selection (non-emergency only).
4. **Per-(LB, worker) AIMD bucket** — new, slice 5. Token bucket per
   worker, cap tuned by AIMD on every OPTIONS reply.
5. **Worker-side panic backstop** — slice 7. Local 503 only when ELU
   crosses `OVERLOAD_PANIC_ELU_THRESHOLD` (default 0.98); the existing
   CPS hard ceiling stays.

Worker publishes `(elu, gc, adm)` as `X-Overload` on every OPTIONS
200/503 reply. HealthProbe parses it; `WorkerLoadObserver` runs AIMD
math; `LoadBalancerStrategy.selectForNewDialog` consults the bucket.

## Decision: ELU as the worker self-signal

The pre-rework signal stack — `inDialogQueueDepth`, `loopLag_ms`,
`activeCalls`, `routingApiP95` — had two problems:

- `inDialogQueueDepth` is dead post-ADR-0005.
- `loopLag_ms` mixed Node-internal scheduling delay with whatever
  caused it; threshold semantics drifted across workloads.
  Operators didn't trust the number.

**Decision: Event Loop Utilization (ELU) via Node `perf_hooks`** is the
single CPU-pressure signal. Normalised 0..1; includes major GC pauses
(GC = "loop is busy"); no threshold to invent ("am I more than 80%
busy" is a unitless question with a unitless answer).

`gc` (fraction of wall time in GC pauses) ships on the wire from day
one but the LB doesn't act on it yet. Future bands can switch to
`effective_elu = max(0, elu - gc)` once operator data shows GC-induced
false positives.

## Decision: AIMD at the LB, not at the worker

Two architectures were considered:

- **A — Worker self-publishes a CPS budget.** Worker computes
  "allowed non-emergency calls/sec in the next second" from its own
  signals, broadcasts via OPTIONS. LB respects the number.
- **B — LB-driven AIMD over worker-reported ELU.** Worker just
  reports ELU + a monotonic admit counter. LB observes its own send
  rate, runs AIMD per-(LB, worker) on those observations.

**B chosen.**

| Property | A | B |
|---|---|---|
| Worker must predict future load | yes — brittle | no |
| Adapts to changing capacity (noisy neighbour) | only if thresholds re-tune | yes, automatic |
| Multi-LB consistency | broken — N LBs each take 100% of the budget | symmetric — every LB applies same AIMD step in parallel |
| Where rejection happens | LB respects worker's number | LB derives + enforces its own cap |

Multi-LB consistency was the deciding factor. With A, three LBs each
seeing "budget = 100 cps" would each send 100 cps, total 300 cps —
breaks the budget. With B, every LB applies the same AIMD step
(`cap × 0.75` on hot, `cap + 5` on cool) in parallel; aggregate
behaviour is correct without coordination.

## Decision: hysteresis on band boundaries, no per-step share-scaling

**Hysteresis = 0.02.** Once a worker enters `hard_to_critical`, it
must drop below `eluHard − 0.02` to transition out. Prevents flap
when ELU oscillates around the boundary. Same hysteresis applies at
`above_critical` and `soft_to_hard`.

**No share-scaling on AIMD steps.** Early designs scaled the decrease
step by each LB's share of worker load. Rejected because all LBs see
the same OPTIONS reply and apply the same step in parallel —
aggregate decrease is correct. Scaling would make small-share LBs
under-react. Share is computed and exported as a metric
(`sip_proxy_worker_share`) for observability only.

## Decision: backup selection is ELU-agnostic

The Record-Route cookie's `w_bak` is the second-best HRW winner among
the alive set, **not filtered or weighted by ELU** at encode time.
Rationale (locked during grilling):

- The backup will normally do 0 work for this call; current CPU at
  encode time has no bearing on its load at fail-over time, which is
  generally hours later.
- "Overload + half the fleet dies" is a chaos event already covered
  by the CRITICAL filter on new-dialog selection. An overloaded
  backup-turned-primary self-evicts from the new-dialog candidate
  set, redistributing further admission work to whoever has
  headroom.

Encode-time complexity reduced; decode-time logic unchanged.

## Decision: proxy-self gate is binary

The proxy-self gate (`ProxySelfGate`) uses two binary checks:
`proxy_elu > eluCritical` → reject; CPS token bucket → reject. No
AIMD. The proxy's ELU is its own; there's no second party to
converge with — AIMD would be over-engineering.

Internal traffic (`registry.lookupByAddress(srcAddr)` returns a
worker) bypasses the gate entirely. Rejecting a worker's B-leg
INVITE causes re-routing churn (the worker retries via a different
path), adding load instead of shedding it.

## Decision: probabilistic shedder is dead — worker is a pure publisher + panic backstop

The slice-7 simplification of `OverloadController`:

- The probabilistic `Math.random() < p` shedder is gone. AIMD at the
  LB handles gradual response; two probabilistic shedders deciding
  the same call's fate is a debuggability nightmare.
- The worker's local 503 fires only when ELU crosses
  `OVERLOAD_PANIC_ELU_THRESHOLD` (default 0.98) — well above
  `eluCritical=0.95`, so it almost never fires in normal operation.
  Defense-in-depth fence against "LB absent / misconfigured / itself
  overloaded".
- The CPS hard ceiling (`CPS_BUCKET_*`) is retained as an
  absolute-max-CPS fence that survives any ELU bug.

## Reaction-speed envelope

OPTIONS interval is 1 s. A burst that saturates a worker in 200 ms
gets up to 800 ms of unmitigated load before any LB reacts. Two
mitigations:

- **Multiplicative decrease per tick** — one AIMD step closes 25% of
  the gap. After 3 ticks (3 s), cap is at ~42% of pre-burst level.
- **(Future)** Piggyback `X-Overload` on 503 INVITE replies —
  collapses the OPTIONS lag for the LB that hit the overloaded
  worker first. Stamped on OPTIONS replies today; INVITE 503 stamping
  is a follow-up.

## Test strategy

- **Fake-clock unit:** `WorkerLoadObserver.test.ts` exercises the
  AIMD math at extreme ELU values (0.0 / 1.0). Validates bands,
  hysteresis, cooldown, floor/ceiling, stale sweep, counter-reset
  detection.
- **Fake-clock integration:** `selectForNewDialog-overload.test.ts`
  exercises emergency bypass, CRITICAL filter, RateCapExhausted.
- **Live K8s endurance:** `non-emergency-burst` chaos event with
  tightened acceptance rules (slice 9 of the rework).

Fake-clock cannot validate gradient AIMD convergence under realistic
load — that's the K8s endurance's job. Fake-clock is the structural
gate: "does the code path exist and fire?"

## References

- [src/observability/LoadSampler.ts](../../src/observability/LoadSampler.ts) — perf_hooks-backed sampler
- [src/b2bua/OverloadController.ts](../../src/b2bua/OverloadController.ts) — worker publisher + panic backstop
- [src/sip-front-proxy/WorkerLoadObserver.ts](../../src/sip-front-proxy/WorkerLoadObserver.ts) — LB AIMD state machine
- [src/sip-front-proxy/ProxySelfGate.ts](../../src/sip-front-proxy/ProxySelfGate.ts) — proxy-self gate
- [src/sip-front-proxy/strategies/LoadBalancer.ts](../../src/sip-front-proxy/strategies/LoadBalancer.ts) — `selectForNewDialog` integration
- [src/sip-front-proxy/health/HealthProbe.ts](../../src/sip-front-proxy/health/HealthProbe.ts) — `X-Overload` parsing
- [docs/overload-protection.md](../overload-protection.md) — operator-facing reference
- Related: [ADR-0005 — Per-call FIFO](./0005-per-call-fifo-via-router-and-workers.md) (removed Tier-2 cluster Dispatcher)
