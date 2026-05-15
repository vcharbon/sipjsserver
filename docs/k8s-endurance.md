# Robustness test (K8s endurance) — operator guide

The canonical pre-release robustness gate. Long-duration soak
(10 min – 24 h) at moderate load with semi-random chaos injection.
Run manually before major releases; not part of CI.

For *why* this is the canonical gate (and how it relates to the
narrower failover suite) see
[ADR-0002](adr/0002-endurance-as-canonical-robustness-gate.md). For
inner-loop / invariant-suite operator notes see
[docs/K8S_test.md](K8S_test.md). For the full design rationale see
[`docs/plan/long-endurence-tests-session-hidden-graham.md`](plan/long-endurence-tests-session-hidden-graham.md).

## Role of this test

The endurance run is the **canonical robustness gate**:

- Always starts from a freshly recreated kind cluster (no opt-out).
- Always rebuilds and side-loads images.
- Always applies the observability collector
  (vmagent/fluent-bit/node-exporter/kube-state-metrics) so every pod is
  scraped from second one.
- Always runs a real representative call + `/metrics` probe before
  SOAK begins — fails the run immediately if the cluster is
  half-broken.
- Covers every failover case the standalone failover suite exercises
  (worker pod kill graceful/kill-9, proxy pod kill graceful/kill-9)
  *plus* VRRP cutoff and node shutdown, on top of sustained load.

The narrower [failover zoom-in suite](#appendix-failover-zoom-in)
exists only as a debugging tool to iterate on one specific
`(state-at-kill × kill-mode)` cell — not as a regression gate.

## TL;DR

```bash
# 10-min self-test — run this first to validate the harness.
npm run test:k8s:endurance:smoke -- --caps 20

# Real run — defaults to 6h SOAK at 45 CAPS, ~6h 38min wall time.
npm run test:k8s:endurance -- --caps 20 --duration 1h

# 24h pre-release run with explicit seed for reproducibility.
npm run test:k8s:endurance -- --duration 24h --seed 12345
```

Artifacts land under `test-results/k8s-endurance/<runId>/`; the analyzer
runs automatically at the end (unless `--no-analyze`).

## Pre-flight checks

Most of the historical checklist is now enforced by the bring-up
script itself. Operator-side concerns that remain:

- [ ] **WSL sleep disabled** (Windows hosts). A WSL sleep mid-run kills
  the kind cluster and ends the run with no recovery. Suggested:
  `[boot] systemd=true` in `/etc/wsl.conf` and disable Windows sleep
  while the run is active. Not script-enforceable cleanly.
- [ ] **Other workloads quiet**. Docker daemon should not be under
  load from unrelated builds during the run.

What used to be operator-side checklist items, now hard-guarded in
[tests/k8s/scripts/up-full.ts](../tests/k8s/scripts/up-full.ts):

- ≥30 GiB free on the artifact volume (`test-results/`).
- Docker daemon reachable.
- Images rebuilt + side-loaded (no more "did I forget `test:k8s:images`?").
- Observability collector applied (no more "the dashboards are empty for
  this run because vmagent wasn't deployed").
- A real REGISTER + INVITE + reroute call succeeds end-to-end before
  SOAK starts.

The orchestrator does not auto-resume on its own crash. If your host
goes to sleep at hour 18, the partial artifact dir is still
analyzable (`outcome: INCOMPLETE` in the verdict) but you must re-run
from scratch to get a clean PASS/FAIL.

## CLI flags

```
--duration <N>{m,h}        SOAK length          (default 6h)
--caps <N>                 total CAPS           (default 45)
--limiter-cap <N>          shared-limiter cap   (default 10)
--warmup <N>{m,s}                               (default 5m)
--cooldown <N>{m,s}                             (default 5m)
--drain <N>{m,s}                                (default 25m)
--chaos-min-interval <N>                        (default 5m)
--chaos-max-interval <N>                        (default 15m)
--chaos-weights k=v,...    weight allow-list    (omitted = catalog defaults)
--seed <N>                 deterministic chaos  (default = now-ms)
--smoke                    10-min self-test mode
--run-id <name>            artifact dir name    (default timestamp)
--no-analyze               skip ANALYZE phase
--no-chaos                 long-running baseline; no chaos schedule
--stop-at-first-failure    abort SOAK on the first ExpectedImpact FAIL
```

`npm run test:k8s:chaos` (the iteration sub-command — see
[Iteration workflow](#iteration-workflow)):

```
--event <type>             one of the catalog ChaosEventType values
--artifact-dir <path>      override the .active pointer
--no-wait                  fire-and-forget; skip per-event verdict
--params k=v,...           event-specific parameters (e.g. peerSet, intensity)
```

The cluster is **always** torn down and recreated at the start of every
endurance run. There is no `--reuse-cluster` flag — verdict-bearing
runs cannot inherit state from a previous run. The original
contamination modes that motivated this policy are recorded in
[ADR-0002](adr/0002-endurance-as-canonical-robustness-gate.md).

## What the run does

| # | Phase | Default | Purpose |
|---|-------|---------|---------|
| 1 | BRINGUP | ~3–4 min | `clusterDown` then `upFull`: host stack + cluster + kind-addons + images + charts + sanity gate. Always runs. |
| 2 | WARMUP | 5 min | Sipp streams start, no chaos. Verifies steady state. |
| 3 | SOAK-START SANITY GATE | 60 s | Confirms each sipp stream has ≥1 successful call. Aborts early if not. |
| 4 | SOAK | `--duration` | Chaos schedule active. |
| 5 | COOLDOWN | 5 min | No new chaos events; let last event's recovery clear. |
| 6 | DRAIN | 25 min | Stop sipp streams; wait for in-flight calls (notably 20-min long-options calls) to complete. |
| 7 | SNAPSHOT | ~30 s | Pod state, Redis dbsizes, `/metrics`, OOMKilled detection. |
| 8 | ANALYZE | async | Verdict + report + forensics + per-metric CSVs. |

Cluster is **always fresh on entry** and **never auto-torn down on
exit**. Manual teardown: `npm run test:k8s:down`.

## Call mix

At default CAPS=45:

- **Short-hold** (~88% of CAPS): INVITE/200/ACK/30s hold/BYE.
  Scenario `uac-endurance-short.xml`.
- **Long-options** (~1% of CAPS, fractional): 20-min calls with the
  B2BUA's keepalive rule firing in-dialog OPTIONS (default
  `keepaliveIntervalSec=900`). Sipp answers each OPTIONS with 200 OK.
  Scenario `uac-long-options.xml`. Exercises HA, replication backup,
  and B2BUA in-dialog OPTIONS routing on a non-INVITE method.
- **Limiter probe** (~11% of CAPS): 10-s holds hitting a fleet-wide
  limiter (`endurance-probe`) capped at `--limiter-cap` (default 10).
  Offered concurrency vastly exceeds the cap; analyzer reads the
  shared limiter Redis on a 10-s cadence to verify in-flight count
  pins at cap and never exceeds it. **Cleanup-TTL leaks would push it
  above cap over time — that is the leak we are catching.**

## Chaos schedule

Inter-arrival: uniform-random in `[--chaos-min-interval,
--chaos-max-interval]`. Default 5–15 min ⇒ ~144 events in 24 h.
Reproducible given `--seed`.

Default event-type weights:

| Event | Weight |
|-------|-------:|
| Worker pod kill graceful | 13% |
| Worker pod kill -9 | 13% |
| Proxy pod kill graceful | 10% |
| Proxy pod kill -9 | 10% |
| Proxy cutoff VRRP (iptables INPUT drop -p vrrp) | 5% |
| Proxy full isolate (all proxy ingress/egress dropped) | 0% (opt-in) |
| Shared limiter Redis kill (50/50 g/a) | 5% |
| Kind node shutdown — app tier | ~17% |
| Kind node shutdown — edge tier | ~17% |
| Worker network-isolate — from proxy (hard drop, 30 s) | 0% (opt-in) |
| Worker network-isolate — from peer workers (hard drop, 30 s) | 0% (opt-in) |
| Worker network-isolate — from limiter Redis (hard drop, 30 s) | 0% (opt-in) |
| Worker network-isolate — all three at once (hard drop, 30 s) | 0% (opt-in) |
| Worker network-degrade — proxy path, tc netem loss 30 % | 0% (opt-in) |
| Non-emergency burst (200 CAPS, 60 s, no Resource-Priority) | 0% (opt-in) |

The new network-chaos and burst events ship at weight 0 so the random
schedule keeps its current shape. Opt in per run via `--chaos-weights`
once the per-event ExpectedImpact rules are settled — see
[Expected-impact mechanism](#expected-impact-mechanism) and
[Iteration workflow](#iteration-workflow) below.

LB-proxy event semantics — see [lb-proxy-ha.md](lb-proxy-ha.md) for
the architecture each one targets:

| Event | Mechanism | Failover path tested |
|-------|-----------|----------------------|
| `proxy-pod-graceful` | `kubectl delete --grace-period=200` | SIGTERM self-cede + drain |
| `proxy-pod-kill9` | `kubectl delete --grace-period=0 --force` | VRRP peer-silence detection |
| `proxy-cutoff-vrrp` | `docker exec <node> iptables -A INPUT -p vrrp -j DROP` | Split-brain handling (`nopreempt` + ARP last-writer-wins, designed to be invisible to clients) |
| `proxy-full-isolate` | `docker exec <node> iptables -A INPUT/OUTPUT -j DROP` on the proxy pod's veth | Clean VIP fail-over (peer takes VIP cleanly; client-side ~1–2 s of failed calls during fail-detect) |

Worker network-chaos event semantics:

| Event | Mechanism | What it tests |
|-------|-----------|---------------|
| `worker-cut-from-proxy-hard` | `tc netem loss 100 %` on the worker pod veth for UDP/5060 ↔ both proxy pods | Proxy stickiness reroute + backup partition serving in-dialog traffic |
| `worker-cut-from-peers-hard` | tc loss 100 % for HTTP /replog + /bootstrap ↔ peer workers | Replication channel resilience; watermark catch-up after recovery |
| `worker-cut-from-limiter-redis-hard` | tc loss 100 % for TCP/6379 ↔ shared limiter Redis | Per-worker limiter degradation; aggregate inflight may temporarily exceed cap |
| `worker-isolate-all-hard` | tc loss 100 % on all three peer classes at once | "Full cutover" case — proxy detection makes overall impact smaller than partial cuts |
| `worker-cut-from-proxy-loss30` | tc netem `loss 30 %` worker ↔ proxy | UDP retransmit amplification under partial loss; harder to handle than a clean partition |
| `non-emergency-burst` | Spawns an ad-hoc sipp Job (200 CAPS, 60 s, no `Resource-Priority`) | Tier-1/2/3 shedder triggers for non-emergency calls; emergency-marked streams sail through |

**Catalog rule (2026-05-15)** — an event is admissible iff its impact
on running traffic is **explicitly modelled in an ExpectedImpact
spec**. The earlier "near-zero impact only" rule is retired (see
[ADR-0002 amendment](adr/0002-endurance-as-canonical-robustness-gate.md)).
Two consequences:

- The previously-rejected `proxy-cutoff-workers` is admitted under the
  new rule as `worker-cut-from-proxy-hard`. Detection via
  proxy-side OPTIONS-probe failures is no longer a prerequisite —
  detection-failure modes are modelled in the ExpectedImpact rules
  (`failureRate` tolerance on the affected stream during the cut
  window, `successCount` recovery assertion after recovery).
- `proxy-cutoff-ingress` (drop UDP/5060 on the active node) is still
  not in the catalog, but for a different reason: no realistic prod
  analog. The catalog ships what we want to defend against, not every
  technically-injectable failure.

LB-proxy chaos remains constrained to "fully isolated" or "VRRP
only" — partial-loss / latency / asymmetric variants on the proxy
don't model anything real (VRRP either holds the VIP or it doesn't).

Cutoff events restore on `tRecovered` by deleting the matching
iptables rule. Recovery target: ≤ 60 s after `tFire` for cutoffs;
≤ 30 s for pod kills (kubelet reschedule + Ready).

Constraints (scheduler-enforced):

- Never kill a Deployment/StatefulSet replica that would leave the
  workload with zero ready.
- After any chaos event, wait at least 1 min AND wait for the
  target's replica count to return to ready before the next event.
- Node shutdown: `docker stop <kind-node>` for 60 s then `docker
  start`. Pod stays bound; kubelet re-attaches on return.

## Emergency markers on baseline streams

All three baseline sipp scenarios ship with `Resource-Priority:
esnet.0` in the initial INVITE so they bypass all three overload
tiers (UdpTransport byte-brake, Dispatcher class queues, OverloadController
token bucket — see [overload-protection.md](overload-protection.md)).
The CallLimiter does **not** bypass on emergency, so the
`endurance-limiter` probe stream still hits the cap; only the shedders
ignore them.

This matters when the catalog includes `non-emergency-burst`: the
200 CAPS spike is shed at Tier 1, while the three baseline streams
keep flowing.

Scenarios touched: `uac-endurance-short.xml`, `uac-long-options.xml`,
`uac-endurance-limiter.xml`.

## Expected-impact mechanism

Each `ChaosEventType` in the catalog carries a structured
`ExpectedImpact` spec in [tests/k8s/endurance/expectedImpact.ts](../tests/k8s/endurance/expectedImpact.ts).
The analyzer evaluates each rule against the actual run data and emits
PASS / FAIL / WARN at the per-rule level.

```ts
interface ExpectedImpact {
  readonly description: string             // human-readable, for report.md
  readonly rules: ReadonlyArray<ImpactRule>
}

interface ImpactRule {
  readonly description: string             // human-readable per-rule
  readonly window: {
    readonly anchor: "tFire" | "tRecovered"
    readonly startOffsetMs: number         // 0 = at anchor
    readonly durationMs: number
  }
  readonly metric:
    | { kind: "failureRate"; stream: string; codes?: ReadonlyArray<number> }
    | { kind: "midDialogFailureRate"; stream: string; codes?: ReadonlyArray<number> }
    | { kind: "stream503Rate"; stream: string }
    | { kind: "limiterInflight" }
    | { kind: "concurrentCalls"; stream: string }
  readonly bound:
    | { kind: "lessThan"; value: number }      // tolerance (verdict mask)
    | { kind: "greaterThan"; value: number }   // chaos-effectiveness assertion
    | { kind: "around"; target: number; tolerance: number }  // recovery
  readonly severity?: "fail" | "warn"        // default "fail"
}
```

Rule kinds in practice:

- **Tolerance** (verdict mask): "during the cut window, `failureRate`
  on `endurance-short` may rise to 0.20" — `lessThan 0.20` with
  `severity: "fail"`. Without this rule the analyzer's STEADY-counter
  would tank and the verdict would FAIL. With it, breaches above 0.20
  still fail; everything below is absorbed.
- **Chaos-effectiveness assertion**: "during the cut window,
  `limiterInflight` must climb above cap" — `greaterThan cap` with
  `severity: "warn"`. If the assertion fails, the chaos may have
  silently no-op'd (the cut didn't land on the right path). Default
  severity for assertions is `warn` so a flaky chaos primitive doesn't
  fail the verdict.
- **Recovery assertion**: "2 min after `tRecovered`, `concurrentCalls`
  on `endurance-limiter` should be around 10 ± 2" — `around` with the
  window anchored at `tRecovered + 120 s`. Catches "the cut left the
  system in a degraded state that didn't self-heal".

Per-call-code precision: `failureRate.codes` and
`midDialogFailureRate.codes` accept a SIP-code allow-list, so rules
can target specific failure modes (e.g. "<10 % `481` mid-dialog
during the one-minute window").

**Severity behaviour.** All rules default to `fail`. The analyzer
collects every breach into the report; it never aborts the run
mid-flight. `--stop-at-first-failure` opts in to fail-fast for tight
iteration loops.

**Spec coverage.** v1 ships the schema + a fully-modelled
`worker-cut-from-limiter-redis-hard` (the limiter cap-excursion
example). Other new events ship with empty `rules: []` and a TODO
note in the spec; their first runs surface an
"expected-impact-not-yet-modelled" WARN, and rules are added as we
observe real behaviour.

## Iteration workflow

The random 6-hour SOAK isn't the right tool for "is this new chaos
event wired correctly, and is my ExpectedImpact spec right?". Two
new entry points exist for tight inner-loop iteration:

**Baseline campaign (`--no-chaos`).** Full bring-up (kind cluster,
images, observability stack, charts), then runs the three sipp
streams at default CAPS with zero chaos. Long-running until SIGINT;
writes a `.active` pointer file at `test-results/k8s-endurance/.active`
so the chaos sub-command can find it.

```bash
npm run test:k8s:endurance -- --no-chaos --caps 40
```

**Chaos sub-command (`npm run test:k8s:chaos`).** A separate process
that:

1. Reads `.active` (or `--artifact-dir` override) to find the running
   campaign's artifact dir.
2. Reads `metadata.json` for sipp Job names + phase boundaries.
3. Fires the chaos primitive itself (kubectl exec, docker exec,
   iptables, tc — implemented in the same `chaosOps` module used by
   the SOAK loop).
4. Appends a row to `chaos-timeline.ndjson`.
5. Waits for the impact window + post-recovery grace + any
   recovery-anchor windows the ExpectedImpact spec defines.
6. Reads the recorder's ndjson outputs + the running sipp Jobs' state
   to evaluate each ImpactRule.
7. Prints a per-rule PASS / FAIL / WARN summary and exits non-zero on
   any FAIL.

```bash
# Fire one event into a running --no-chaos campaign.
npm run test:k8s:chaos -- --event worker-cut-from-limiter-redis-hard

# Override artifact-dir explicitly.
npm run test:k8s:chaos -- --event non-emergency-burst \
  --artifact-dir test-results/k8s-endurance/<runId>

# Fire-and-forget (don't block on verdict).
npm run test:k8s:chaos -- --event worker-cut-from-proxy-hard --no-wait
```

The chaos sub-command is end-to-end: fire + analyzer + verdict are
all in-process. Editing `chaosOps.ts` or `expectedImpact.ts` and
re-running the sub-command picks up the new code immediately —
the baseline campaign keeps running. If a chaos event leaves the
cluster in a state that can't be recovered, stop the baseline,
re-run `--no-chaos`, retry.

Transport between baseline and sub-command is the **shared
artifact dir** (filesystem, no HTTP). The orchestrator never imports
chaos or expected-impact code in `--no-chaos` mode; it only owns the
recorder, sipp streams, and cluster lifecycle.

The random-schedule SOAK loop uses the same chaos library functions
the sub-command uses — one pipeline, two entry points.

## Reading the artifact dir

```
test-results/k8s-endurance/<runId>/
├── metadata.json            run config + phase boundaries
├── verdict.json             machine-readable verdict
├── report.md                human-readable report (read this first)
├── snapshot.json            end-of-run pod / Redis state
├── chaos-timeline.ndjson    one row per scheduled event
├── k8s-events.ndjson        kubectl get events --watch stream
├── limiter-probe.ndjson     limiter Redis 10s poll
├── sipp-results.ndjson      sipp daemon results at stop time
├── pod-logs/<pod>.log       per-pod kubectl logs -f
├── metrics/<pod>.ndjson     per-pod /metrics scrape
├── metrics/<metric>__<pod>.csv   analyzer-emitted CSVs for plotting
├── sipp/<jobName>/
│   ├── msg.log.gz           sipp -trace_msg (gzipped)
│   ├── screen.log           sipp final stats
│   └── err.log              sipp -trace_err
└── forensics/<Call-ID>.txt  per-call forensic for failed STEADY +
                              capped sample of chaos-window failures
```

`report.md` is the entry point. Open it first; it links to specific
forensic files when individual calls deserve attention.

## Verdict semantics

| Outcome | Meaning |
|---------|---------|
| **PASS** | Zero STEADY failures, limiter stayed at-or-below cap outside expected-impact windows, every ExpectedImpact rule passed (or was below `severity: "fail"` threshold), run completed all phases. |
| **FAIL** | At least one STEADY-category call failed OR limiter in-flight exceeded cap outside expected-impact windows OR any ExpectedImpact rule with `severity: "fail"` was breached. |
| **WARN** | Run completed and would PASS, but at least one ExpectedImpact rule with `severity: "warn"` was breached (most commonly a chaos-effectiveness assertion that didn't fire — chaos may have silently no-op'd). |
| **INCOMPLETE** | Orchestrator didn't reach DRAIN; partial verdict, useful forensics. |
| **ABORTED** | Pre-flight sanity gate (WARMUP or SOAK-START) caught a broken cluster before SOAK began. |

The soft targets for chaos-window categories (MID_DIALOG_DURING_CHAOS,
ESTABLISHING_DURING_CHAOS, POST_RECOVERY) are reported in `report.md`
but do not gate PASS/FAIL — they're now subsumed by per-event
ExpectedImpact rules.

## Subcommand recipes

```bash
# Re-run analysis on an existing artifact dir.
npm run test:k8s:endurance:analyze -- test-results/k8s-endurance/<runId>

# Forensic for one specific Call-ID.
npm run test:k8s:endurance:analyze -- forensic --call-id <id> \
  test-results/k8s-endurance/<runId>

# Slice all timelines to a specific time window.
npm run test:k8s:endurance:analyze -- window \
  2026-05-04T15:00:00Z..2026-05-04T16:00:00Z \
  test-results/k8s-endurance/<runId>

# Path(s) to a metric's CSV(s).
npm run test:k8s:endurance:analyze -- metric \
  process_resident_memory_bytes \
  test-results/k8s-endurance/<runId>

# Worst chaos events by per-window failures.
npm run test:k8s:endurance:analyze -- top-failures \
  test-results/k8s-endurance/<runId>

# HTML report.
npm run test:k8s:endurance:render -- test-results/k8s-endurance/<runId>
```

## Reproducibility

Two runs with the same `--seed`, same SOAK duration, and same chaos
interval bounds produce the same chaos sequence (type + relative
time). Useful for replaying a confusing failure:

```bash
diff <(jq -c '{type,relativeSec}' .../runA/chaos-timeline.ndjson) \
     <(jq -c '{type,relativeSec}' .../runB/chaos-timeline.ndjson)
# must match
```

The actual wall-clock recovery durations may vary slightly (kubelet
scheduling, image pulls, etc.), so the per-event impact windows can
differ by seconds; the schedule itself is exact.

## When something goes wrong

1. **Verdict says FAIL with STEADY failures**: open `report.md`, pick
   one Call-ID from the forensics index, open the corresponding
   `forensics/<Call-ID>.txt`. The file shows the call's outcome +
   nearest chaos events. Look for a chaos event whose impact window
   should have included the call (analyzer may have miscategorized);
   if no chaos was nearby, the call failed under steady state — that
   is a real bug.

2. **Verdict says FAIL with limiter exceededCap=true**: open
   `limiter-probe.ndjson`, find the first sample where `inflight >
   cap`. That timestamp is the start of a TTL leak. Cross-reference
   `chaos-timeline.ndjson` to see if a limiter-Redis kill preceded
   it.

3. **Verdict says INCOMPLETE**: the orchestrator died. Check
   `metadata.json` for which phase boundaries were written. If
   `tDrainEnd` is present the run finished but ANALYZE was
   interrupted — you can re-run analyze on the dir. If earlier
   boundaries are missing, the cluster or orchestrator probably died;
   investigate `pod-logs/` and the host syslog.

4. **BRINGUP fails at the sanity gate**: the post-up sanity check
   prints `kubectl get pods -o wide`, `kubectl describe pod` for any
   non-Ready pod, and the last 50 lines of proxy + worker logs. Read
   those first. Common causes: stale Redis sidecar PVCs from a prior
   manual install in `sip-test`, a leftover host SIPp process holding
   port 5060, a host-stack docker-compose container that died and
   wasn't restarted.

---

## Appendix: failover zoom-in

The failover suite is a **debugging tool**, not a regression gate.
Use it to iterate on a specific `(state-at-kill × kill-mode)` cell
without paying the full robustness-run cost (~5 min vs ~6 h). The
robustness run already covers every cell exercised here.

The 7 tests covering 1 promoted scenario + 6 failover scenarios:

| File | Phase | Kill mode | Lifecycle |
|------|-------|-----------|-----------|
| `proxy-drain.test.ts` | regression | graceful drain | `uac-hold.xml` (3 s pause) |
| `proxy-failover-lb-delete.test.ts` | 2a | `delete --grace=0 --force` (proxy) | `uac-basic.xml` |
| `proxy-failover-lb-killdash9.test.ts` | 2b | `kill -9 1` in proxy container | `uac-basic.xml` |
| `proxy-failover-worker-delete-hold.test.ts` | 3a-B | `delete --grace=0 --force` (worker) | `uac-hold-failover.xml` (10 s pause) |
| `proxy-failover-worker-killdash9-hold.test.ts` | 3b-B | `kill -9 1` in worker container | `uac-hold-failover.xml` |
| `proxy-failover-worker-delete-pingpong.test.ts` | 3a-C | `delete --grace=0 --force` (worker) | `uac-pingpong.xml` |
| `proxy-failover-worker-killdash9-pingpong.test.ts` | 3b-C | `kill -9 1` in worker container | `uac-pingpong.xml` |

```bash
# Whole suite (sequential by design; ~5 min).
npm run test:k8s:failover

# Single scenario.
npx vitest run -c vitest.config.k8s.ts tests/k8s/proxy-failover-lb-delete.test.ts
```

Tuning knobs (env-var overridable):

| Variable | Default (3a-B / 2a/2b) | Default (3a-C / 3b-C "pingpong") |
|---------|-----------------------|----------------------------------|
| `K8S_FAILOVER_CPS`      | 20  | (uses `K8S_FAILOVER_CPS_C`, default 10) |
| `K8S_FAILOVER_RAMP_S`   | 5   | (uses `K8S_FAILOVER_RAMP_S_C`, default 15) |
| `K8S_FAILOVER_POSTKILL_S` | 10 | (uses `K8S_FAILOVER_POSTKILL_S_C`, default 30) |

Every run writes an archive under `test-results/k8s-failover/<runId>/`.
The first thing to look at is `summary.txt`:

```bash
ls -1t test-results/k8s-failover/
cat test-results/k8s-failover/<runId>/summary.txt
```

The hard gate is `unaffected.failed == 0` — the entire `unaffected`
row's `establish-failed`, `bye-timeout`, and `mid-dialog-error` cells
must all be zero. Survival in the other rows is logged but not
asserted at the failover-suite level. Cross-run trends:

```bash
npx tsx tests/k8s/scripts/failover-summary.ts
npx tsx tests/k8s/scripts/failover-summary.ts --filter phase-3
```

Archive cleanup (manual; archives are kept by default):

```bash
bash tests/k8s/scripts/failover-cleanup.sh             # report, no delete
bash tests/k8s/scripts/failover-cleanup.sh --keep 10   # prompts before deleting
bash tests/k8s/scripts/failover-cleanup.sh --keep 10 --yes
```

Known issues — see
[docs/todos/K8S_FAILOVER_FOLLOWUPS.md](todos/K8S_FAILOVER_FOLLOWUPS.md).
