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
npm run test:k8s:endurance -- --caps 20 --duration 1h

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
--reuse-cluster            skip BRINGUP — DEV ONLY, see warning below
--smoke                    10-min self-test mode
--run-id <name>            artifact dir name    (default timestamp)
--no-analyze               skip ANALYZE phase
```

### ⚠️ Rule: do NOT use `--reuse-cluster` for verdict-bearing runs

**Default policy: every endurance run — smoke or full — must start
from a freshly destroyed and recreated kind cluster.** The runner
already does this on the default path; `--reuse-cluster` is the only
way to bypass it and exists *exclusively* for inner-loop development
where you accept that cluster state is whatever the last run left
behind.

It must NEVER be used in any of these situations, all of which
produce silent verdict-corrupting contamination:

- **Chaining independent runs** (e.g. smoke → 1h, or run #1 → run
  #2). The earlier run's long-stream calls and limiter-probe state
  remain in worker memory and sidecar Redis. The follow-on run's
  orphan sweeper cannot drain it fast enough; ~5–10 min into SOAK
  the worker chokes, `currentCall` accumulates, successes go to 0
  before any chaos has fired, and per-event "during/after" buckets
  attribute the collapse to whichever chaos event happens to fire
  next. Confirmed in run
  `endurance-2026-05-09t18-38-55-758z` (post-replication-fix 1h
  reusing a smoke cluster: 64% STEADY failure caused entirely by
  contamination, not by the system under test).
- **Investigating a regression or chasing a verdict.** If you don't
  know whether the last run left dirty state, the only safe answer
  is to recreate.
- **Comparing two runs / reproducing a result.** Different leftover
  state from each prior run = different baselines.

Acceptable uses (narrow):
- Iterating on the orchestrator code itself when you've just
  observed a clean exit and want to skip the ~2–3 min BRINGUP cost.
- Re-running ANALYZE alone on a cluster you control (see
  `--no-analyze` + the `analyze-endurance.ts` recipes below).

When in doubt, run without the flag. The 2–3 minute BRINGUP cost is
cheap insurance; a corrupted 1-hour or 6-hour verdict is not.

## What the run does

| # | Phase | Default | Purpose |
|---|-------|---------|---------|
| 1 | BRINGUP | ~3 min | Tear down + recreate kind cluster, install all charts. **Always run on the default path.** Skipped only under `--reuse-cluster` (DEV-ONLY — see warning under "CLI flags"). |
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
| Worker pod kill graceful | 13% |
| Worker pod kill -9 | 13% |
| Proxy pod kill graceful | 10% |
| Proxy pod kill -9 | 10% |
| Proxy cutoff VRRP (iptables INPUT drop -p vrrp) | 5% |
| Shared limiter Redis kill (50/50 g/a) | 5% |
| Kind node shutdown — app tier | ~17% |
| Kind node shutdown — edge tier | ~17% |

LB-proxy event semantics — see [lb-proxy-ha.md](lb-proxy-ha.md) for
the architecture each one targets:

| Event | Mechanism | Failover path tested |
|-------|-----------|----------------------|
| `proxy-pod-graceful` | `kubectl delete --grace-period=200` | SIGTERM self-cede + drain |
| `proxy-pod-kill9` | `kubectl delete --grace-period=0 --force` | VRRP peer-silence detection |
| `proxy-cutoff-vrrp` | `docker exec <node> iptables -A INPUT -p vrrp -j DROP` | Split-brain handling (`nopreempt` + ARP last-writer-wins, designed to be invisible to clients) |

**Catalog rule** — only events whose proper handling has zero or
near-zero traffic impact are admitted. Two earlier candidates were
rejected:

- `proxy-cutoff-ingress` (drop UDP/5060 on the active node) — no
  realistic prod analog and no clean handling path. The active proxy
  has no signal that it's been blackholed; VRRP keeps flowing,
  workers stay reachable.
- `proxy-cutoff-workers` (drop egress to the cluster pod CIDR) —
  has a real-world analog (flaky proxy-node→worker network) and a
  clean handling design (proxy detects via OPTIONS-probe failures,
  cedes VIP, peer takes over), but depends on a working `vrrp_script`
  self-health gate. Re-introduce when that's wired and proven to
  cede sub-second.

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

# html report
npm run test:k8s:endurance:render -- test-results/k8s-endurance/enduranc
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

5. **`ABORT_PRE_SOAK_SANITY: stream 'endurance-limiter-…' has no
   live or completed calls`** after a `--reuse-cluster` retry that
   followed an interrupted run: the previous run's sipp Job pods
   keep firing INVITEs after the orchestrator exits, and rejected
   limiter calls leak in-flight credit into the limiter Redis.
   Within seconds the limiter pins above its cap and rejects
   *every* new call from the new run's probe stream — the sanity
   gate samples `successful=0` and `currentCall=0` and aborts.
   Same shape can hit the short stream when the leftover load
   saturates the workers.

   Cleanup before retrying:

   ```bash
   # 1. Drop every leftover sipp Job (and its pod). Job-name prefix
   #    is the runId; deleting the Job cascade-deletes the pod.
   kubectl -n sip-test get jobs -o name \
     | grep '^job\.batch/endurance-' \
     | xargs -r kubectl -n sip-test delete

   # 2. Clear the shared-limiter Redis. Default key prefix is
   #    `sipas:limiter:` (see src/config/AppConfig.ts).
   kubectl -n sip-test exec deploy/redis -- sh -c \
     "redis-cli --scan --pattern 'sipas:limiter:*' | xargs -r redis-cli del"
   ```

   Alternative — and the only correct answer for any verdict-bearing
   run: drop `--reuse-cluster` entirely so BRINGUP recreates the
   kind cluster from scratch. Costs ~2–3 min more per attempt but
   guarantees clean state. See the rule under "CLI flags" above —
   `--reuse-cluster` exists only for inner-loop dev iteration.
