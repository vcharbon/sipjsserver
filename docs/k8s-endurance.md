# K8s Endurance Test (operator guide)

Long-duration soak (5–24h) at moderate load with semi-random chaos
injection. Used **manually before major releases** — not part of CI.
Source layout under [tests/k8s/endurance/](../tests/k8s/endurance/).

For the full design rationale see
[`docs/plan/long-endurence-tests-session-hidden-graham.md`](plan/long-endurence-tests-session-hidden-graham.md).

## TL;DR

```bash
# 10-min self-test — run this first to validate the harness
npm run test:k8s:endurance:smoke -- --caps 20

# Real run — defaults to 6h SOAK at 45 CAPS, ~6h 38min wall time
npm run test:k8s:endurance -- --caps 20

# 24h pre-release run with explicit seed for reproducibility
npm run test:k8s:endurance -- --duration 24h --seed 12345
```

Artifacts land under `test-results/k8s-endurance/<runId>/` and the
analyzer is invoked automatically at the end (unless `--no-analyze`).

## Pre-flight checks

Before kicking off a multi-hour run:

- [ ] **≥30 GB free disk** on the artifact volume. 24 h of sipp traces
  + pod logs come out to ~5–15 GB; gzipped sipp traces shrink to a
  few GB but live emptyDir usage on each sipp pod can reach 6 GB
  before stop time.
- [ ] **≥16 GB RAM** for kind cluster + sipp pods + orchestrator.
- [ ] **WSL sleep disabled** (Windows hosts). A WSL sleep mid-run kills
  the kind cluster and ends the run with no recovery. Suggested:
  `[boot] systemd=true` in `/etc/wsl.conf` and disable Windows sleep
  while the run is active.
- [ ] **Docker daemon healthy** and not under load from other workloads.
- [ ] **Images built**: `npm run test:k8s:images`.
- [ ] **Clean kind cluster name available**: BRINGUP tears down any
  existing `sip-e2e` cluster, but if that fails (orphan docker
  containers from a previous crash), `npm run test:k8s:down` first
  is a safer reset.

The orchestrator does not auto-resume on its own crash. If your host
goes to sleep at hour 18, the partial artifact dir is still
analyzable (`outcome: INCOMPLETE` in the verdict), but you must
re-run from scratch to get a clean PASS/FAIL.

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
--seed <N>                 deterministic chaos  (default = now-ms)
--reuse-cluster            skip BRINGUP
--smoke                    10-min self-test mode
--run-id <name>            artifact dir name    (default timestamp)
--no-analyze               skip ANALYZE phase
```

## What the run does

| # | Phase | Default | Purpose |
|---|-------|---------|---------|
| 1 | BRINGUP | ~3 min | Tear down + recreate kind cluster, install all charts. Skipped under `--reuse-cluster`. |
| 2 | WARMUP | 5 min | Sipp streams start, no chaos. Verifies steady state before chaos. |
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
| Worker pod kill graceful | 15% |
| Worker pod kill -9 | 15% |
| Proxy pod kill graceful | 15% |
| Proxy pod kill -9 | 15% |
| Shared limiter Redis kill (50/50 g/a) | 5% |
| Kind node shutdown — app tier | ~17.5% |
| Kind node shutdown — edge tier | ~17.5% |

Constraints (scheduler-enforced):

- Never kill a Deployment/StatefulSet replica that would leave the
  workload with zero ready.
- After any chaos event, wait at least 1 min AND wait for the
  target's replica count to return to ready before the next event.
- Node shutdown: `docker stop <kind-node>` for 60 s then `docker
  start`. Pod stays bound; kubelet re-attaches on return.

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
| **PASS** | Zero STEADY failures, limiter stayed at-or-below cap, run completed all phases. |
| **FAIL** | At least one STEADY-category call failed OR limiter in-flight exceeded cap (TTL leak). |
| **INCOMPLETE** | Orchestrator didn't reach DRAIN; partial verdict, useful forensics. |
| **ABORTED** | Pre-flight sanity gate (WARMUP or SOAK-START) caught a broken cluster before SOAK began. |

The soft targets for chaos-window categories (MID_DIALOG_DURING_CHAOS,
ESTABLISHING_DURING_CHAOS, POST_RECOVERY) are reported in `report.md`
but do not gate PASS/FAIL.

## Subcommand recipes

```bash
# Re-run analysis on an existing artifact dir
npm run test:k8s:endurance:analyze -- test-results/k8s-endurance/<runId>

# Generate a forensic file for one specific Call-ID
npm run test:k8s:endurance:analyze -- forensic --call-id <id> test-results/k8s-endurance/<runId>

# Slice all timelines to a specific time window
npm run test:k8s:endurance:analyze -- window 2026-05-04T15:00:00Z..2026-05-04T16:00:00Z test-results/k8s-endurance/<runId>

# Print path(s) to a metric's CSV(s)
npm run test:k8s:endurance:analyze -- metric process_resident_memory_bytes test-results/k8s-endurance/<runId>

# List the worst chaos events by per-window failures
npm run test:k8s:endurance:analyze -- top-failures test-results/k8s-endurance/<runId>
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

4. **No data in `metrics/<pod>.ndjson`**: `/metrics` server may not
   be wired in `bin/proxy.ts` yet (see `proxyMetrics.ts` note). The
   limiter probe + chaos timeline + per-call data are all
   independent of `/metrics` so the verdict is still meaningful.
