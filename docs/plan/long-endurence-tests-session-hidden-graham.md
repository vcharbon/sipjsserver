# Long Endurance Test Session on K8s

## Context

The B2BUA needs **pre-release endurance validation**: long-duration (5–24h) soak tests under sustained load + injected chaos that prove the system survives without leaks, OOMs, replication divergence, call-limiter TTL leaks, or silent regressions in the in-dialog OPTIONS keepalive path.

Existing infra covers fragments: `proxy-limiter-soak.test.ts` (20-min, single concern), `proxy-failover-*.test.ts` (chaos at small scale, no soak), `sippperftest/memleak-test.sh` (memory only). No unified endurance harness exists.

This plan adds a standalone CLI orchestrator (no vitest in the path — it is the wrong tool for a 24h workflow) that brings up a clean kind cluster, drives a structured call mix, injects semi-random chaos under safety constraints, records everything as append-only artifacts, and hands off to a post-analysis CLI that produces both a deterministic verdict and an explorable forensic dataset (since "we don't know what to look for").

Default load is **moderate (45 CAPS)** so the run reads as a regression check: at this load, the only acceptable failures are those caused by injected chaos.

## Non-goals

- CI integration (manual, pre-release only).
- Cloud / non-kind k8s.
- Auto-resume of orchestrator on its own crash.
- Chaos on the call-control mock (stateless, out of scope).
- Packet capture (sipp app-level traces, gzipped, are sufficient).

## Design summary

### Entry points

- Orchestrator: `tests/k8s/endurance/run-endurance.ts` (Effect CLI program)
- Analyzer: `tests/k8s/endurance/analyze-endurance.ts`
- Doc: `docs/k8s-endurance.md`
- Artifacts: `test-results/k8s-endurance/<runId>/`
- npm scripts: `test:k8s:endurance`, `test:k8s:endurance:smoke`, `test:k8s:endurance:analyze`

### Phases

| # | Phase | Default | Behaviour |
|---|-------|---------|-----------|
| 1 | BRINGUP | ~3 min | Tear down any existing kind cluster of the same name; bring up fresh; verify all pods Ready and `/metrics` reachable. Override: `--reuse-cluster`. |
| 2 | WARMUP | 5 min | Sipp jobs at full CAPS, **no chaos**. Limiter probe must stabilize at cap. Any STEADY failure → abort `ABORT_WARMUP_FAIL`. |
| 3 | SOAK-START SANITY GATE | 60 s | Observation right after WARMUP. STEADY success ≥98% required, else abort `ABORT_PRE_SOAK_SANITY`. |
| 4 | SOAK | `--duration` | Full chaos schedule active. |
| 5 | COOLDOWN | 5 min | Stop scheduling new chaos events; let last event's recovery complete cleanly. |
| 6 | DRAIN | 25 min | Stop sipp jobs; wait for in-flight calls (long 20-min calls dominate this) to complete naturally. Anything left after hard-cut counts as a leak candidate. |
| 7 | SNAPSHOT | ~30 s | Capture pod restart counts, OOMKilled events, sidecar Redis dbsize per worker, shared limiter Redis counters, replication backlog, final `/metrics`. |
| 8 | ANALYZE | async | Invoke `analyze-endurance.ts`; emits `verdict.json`, `report.md`, `forensics/`, `metrics/*.csv`. |

Cluster is **always fresh on entry** and **never auto-torn down on exit** (success or failure). Manual teardown with `npm run test:k8s:down`.

### Call mix at default 45 CAPS

- **40 CAPS background hold** (one sipp Job per stream so caps are independently controllable):
  - **39.6 CAPS short-hold**: existing-style INVITE/200/ACK/(30 s)/BYE.
  - **0.4 CAPS long-hold**: 20-min duration, new sipp scenarios tolerant of 0–N in-dialog OPTIONS from the B2BUA (`<recv method="OPTIONS" optional="true">` loop with branching). The B2BUA's keepalive rule ([TimerRules.ts:45](src/b2bua/rules/defaults/TimerRules.ts#L45)) fires OPTIONS to both legs at `keepaliveIntervalSec` (default 900 s, [embedded.ts:52](src/b2bua/embedded.ts#L52)). With 20-min calls + default interval, ~1 OPTIONS exchange per leg per long-call. Over 24 h × 0.4 CAPS that is ~34 k keepalive cycles tested. **Do not override the keepalive interval — endurance must validate the production-default value.** The 200 OK from sipp is absorbed by [DialogRules.ts:181](src/b2bua/rules/defaults/DialogRules.ts#L181), not relayed.
- **5 CAPS limiter probe**: 10 s hold, hits a shared-limiter directive with cap = `--limiter-cap` (default 10). Offered concurrency (5 × 10 = 50) far exceeds the cap, so a healthy system pins at cap; cleanup-TTL leaks would push it above cap over time — that is the leak we are catching.

`--caps N` rescales all three streams proportionally.

### Chaos schedule

- **Inter-arrival**: uniform-random in `[--chaos-min-interval, --chaos-max-interval]`, defaults 5 min and 15 min (mean ~10 min ⇒ ~144 events in 24 h).
- **Event weights** (pod kills 50/50 graceful vs `kill -9`):

| Event | Weight |
|-------|--------|
| Worker pod kill graceful (`kubectl delete --grace-period=0 --force`) | 15% |
| Worker pod kill -9 (`kill -9 1` in container) | 15% |
| Proxy pod kill graceful | 15% |
| Proxy pod kill -9 | 15% |
| Shared limiter Redis kill (50/50 graceful/abrupt) | 5% |
| Kind node shutdown | 35% (≈17.5% app node, ≈17.5% edge node; random replica per role) |

- **Constraints (scheduler-enforced)**:
  - Never kill a Deployment/StatefulSet replica that would leave it with zero ready.
  - After any chaos event, wait at least `MIN_INTERVAL` AND wait for the target's replica count to return to ready before the next event.
  - Node shutdown: `docker stop <kind-node>` for 60 s then `docker start`. Pod stays bound; kubelet re-attaches on return; pod is **not** deleted.
  - Sidecar Redis is killed transitively when its worker pod is killed; no separate sidecar-only target.
- **Reproducibility**: `--seed N` (default = now-ms); seed recorded in `metadata.json`.

### Verdict semantics

Each call is assigned exactly one category by the analyzer based on its timing relative to chaos impact windows (`[event_fire, recovery_complete + 10 s grace]`).

| Category | Definition | Verdict |
|----------|-----------|---------|
| STEADY | Establishes AND completes outside every impact window | **100% must succeed** — any fail = test failure |
| MID_DIALOG_DURING_CHAOS | Held across an impact window | Soft target ≥95%; warn only |
| ESTABLISHING_DURING_CHAOS | Setup overlaps an impact window | Soft target ≥80%; warn only |
| POST_RECOVERY | First 5 s after recovery completes | Soft target ≥98%; warn only |
| LIMITER_PROBE | From limiter-probe stream | Always-on invariant: shared-Redis in-flight count converges to cap, never exceeds; calls beyond cap rejected with expected code |

**Steady-state hard invariants** (any failure = test failure regardless of chaos):

- No call leaks: at end of DRAIN, `CallStateCache` size ≈ 0, sidecar Redis call DBs ≈ 0, shared-limiter window counters all 0.
- No unexpected pod restarts (orchestrator's intentional-restart list vs `kubectl get pod -o ...restartCount`).
- No `OOMKilled` events at all.
- Worker replication backlog never exceeds threshold for >X seconds.

**Per-chaos-event breakdown** in `verdict.json`:

```json
{
  "events": [{
    "time": "...",
    "type": "worker-kill-9",
    "target": "b2bua-worker-1",
    "impact_window": { "start": "...", "end": "..." },
    "during_issue":     { "ok": N, "failed": M, "by_category": { ... } },
    "stabilized_after": { "ok": N, "failed": M },
    "replication_resync_duration_s": ...
  }]
}
```

### Run-to-completion policy

Always run to full duration. **Single exception**: STEADY success rate <50% over any 5-consecutive-minute window → abort `ABORT_CLUSTER_DEAD` (the cluster is broken; further data is noise). WARMUP and SOAK-START failures abort immediately with their own labels.

### Recording (append-only NDJSON, no buffering)

| Layer | What | Storage |
|-------|------|---------|
| Sipp traces | `-trace_msg` per Job | per-job log file, hourly rotation, gzip on closed segments |
| Pod logs | `kubectl logs -f` per pod, kept whole | `pod-logs/<pod>/<date>.log` |
| K8s events | `kubectl get events --watch` | `k8s-events.ndjson` |
| Routing decisions | reuse failover-suite parser | `routing-decisions.ndjson` |
| Metrics | scrape `/metrics` from proxy + each worker, every 10 s | `metrics/<pod>.ndjson` |
| Limiter probe | poll shared-limiter window keys via `redis-cli`, every 10 s | `limiter-probe.ndjson` |
| Chaos timeline | one row per scheduled / executed event, with target / mode / recovery / pre+post pod state | `chaos-timeline.ndjson` |

Disk budget at default settings, 24 h: ~5–15 GB. No tcpdump / pcap.

### Smoke mode (`--smoke`)

Same orchestrator, ~10 min total: WARMUP 1 min + SOAK 5 min with exactly two chaos events (one worker `kill -9`, one node shutdown) + DRAIN 2 min + ANALYZE. Validates full harness pipeline before any real run.

### Post-analysis (`analyze-endurance.ts`)

**Default invocation** produces from an artifact dir:

- `verdict.json` — machine-readable; outcome (PASS / FAIL / ABORTED / INCOMPLETE), per-category counts, per-event breakdown, invariant results, limiter-probe stability.
- `report.md` — human-readable: verdict, baseline (post-WARMUP) numbers, memory/CPU min/max/p95 per pod, per-chaos-event table, limiter-probe stability summary, invariant pass/fail, top-failure summary with pointers into `forensics/`.
- `forensics/<Call-ID>.txt` for every failed STEADY call and a capped sample (100/category) for MID_DIALOG, ESTABLISHING, POST_RECOVERY chaos-window failures. Each file: full SIP trace + filtered proxy/worker logs + nearest chaos events + routing decision for that one call.
- `metrics/*.csv` — one CSV per metric family (memory_rss, cpu_user, calls_per_min, limiter_inflight, queue_depth, replication_backlog, …). Analyst plots externally; tool ships zero plotting deps.

**Subcommands** for ad-hoc exploration:

- `forensic --call-id X` — generate per-call forensic on demand for any Call-ID
- `window <T1>..<T2>` — slice all logs to a time window
- `metric <name>` — print one metric's CSV
- `top-failures` — list worst chaos events / time periods

Analyzer handles partial (orchestrator-crashed) artifact dirs gracefully — emits `outcome: INCOMPLETE` and proceeds with what's on disk.

### CLI surface (`run-endurance.ts`)

```
--duration <N>{m,h}        SOAK length          (default 6h)
--caps <N>                 total CAPS, scaled   (default 45)
--limiter-cap <N>          shared-limiter cap   (default 10)
--warmup <N>{m,s}                               (default 5m)
--cooldown <N>{m,s}                             (default 5m)
--drain <N>{m,s}                                (default 25m)
--chaos-min-interval <N>                        (default 5m)
--chaos-max-interval <N>                        (default 15m)
--seed <N>                 deterministic chaos  (default = now)
--reuse-cluster            skip BRINGUP
--smoke                    10-min self-test
--run-id <name>            artifact dir name    (default timestamp)
--no-analyze               skip ANALYZE phase
```

## Files to create

- `tests/k8s/endurance/run-endurance.ts` — main CLI; phase orchestration; pre-flight checks; signal handling.
- `tests/k8s/endurance/scheduler.ts` — chaos scheduler, deterministic given seed; constraint enforcement (replica count, MIN_INTERVAL).
- `tests/k8s/endurance/sippJobs.ts` — manage three concurrent sipp Jobs (extend `tests/k8s/fixtures/sippJob.ts`).
- `tests/k8s/endurance/chaosOps.ts` — pod-kill / node-shutdown primitives, reusing failover-suite helpers.
- `tests/k8s/endurance/recorder.ts` — pod logs, metrics scrape, k8s events, limiter Redis poll; all append-only NDJSON.
- `tests/k8s/endurance/snapshot.ts` — final-state capture.
- `tests/k8s/endurance/analyze-endurance.ts` — post-analysis CLI; subcommand dispatch; partial-run tolerance.
- `tests/k8s/endurance/categorize.ts` — assign per-call category from sipp + chaos timeline.
- `tests/k8s/charts/sipp/scenarios/uac-long-options.xml` — 20-min UAC, optional in-dialog OPTIONS recv-and-200 loop.
- `tests/k8s/charts/sipp/scenarios/uas-long-options.xml` — 20-min UAS counterpart.
- `docs/k8s-endurance.md` — operator guide: pre-flight checks, how to launch, how to read `report.md`, subcommand recipes.

## Files to study and reuse

- `tests/k8s/scripts/up.ts`, `tests/k8s/scripts/install-stack.ts` — reused for BRINGUP.
- `tests/k8s/fixtures/sippJob.ts`, `tests/k8s/fixtures/sippOutcomes.ts` — extend.
- `tests/k8s/proxy-failover-*.test.ts`, `lbFailoverHarness.ts` — pod-kill + node-shutdown primitives, kill-timeline schema.
- `tests/k8s/charts/sipp/scenarios/uac-limiter-soak.xml` — model for the limiter-probe scenario.
- `src/observability/MetricsRegistry.ts`, `src/sip-front-proxy/observability/Metrics.ts`, `src/http/StatusServer.ts` — `/metrics` endpoints scraped.
- `src/call/CallLimiter.ts` — Redis Lua window keys read by limiter probe.
- `src/b2bua/rules/defaults/TimerRules.ts`, `src/b2bua/rules/defaults/DialogRules.ts` — keepalive OPTIONS generator + 200-OK absorber, semantics of the long-call scenario.

## RFC compliance for the new sipp scenarios

(per CLAUDE.md planning discipline — list every relevant rule the UAC/UAS must honour before coding.)

- **RFC 3261 §11**: in-dialog OPTIONS may be sent by either party; UAS responds 200 OK echoing Allow / Supported as appropriate for the dialog context.
- **RFC 3261 §12.2.1.1**: in-dialog request CSeq must increment within the dialog. The B2BUA generates OPTIONS using its own dialog-side CSeq; sipp's 200 OK must echo CSeq verbatim from the request.
- **RFC 3261 §8.2.6.1**: 200 OK to OPTIONS includes To-tag (already established in dialog).
- **RFC 3261 §12.2.1.1**: Route set established at dialog setup is honoured (sipp's response uses the existing dialog Route).
- Sipp scenario branching: `<recv method="OPTIONS" optional="true" next="answer_options">` paired with a labelled answer block that loops back to wait for the next OPTIONS or BYE — must tolerate 0, 1, or N OPTIONS arrivals interleaved with the eventual BYE.

## Verification

### Smoke (~10 min) — must pass before any real run

```
npm run test:k8s:endurance:smoke
```

Verifies: cluster brings up clean → 3 sipp streams launch → 2 chaos events fire and recover → metrics / log files exist with expected schema → analyzer produces `verdict.json` + `report.md` → cluster left up.

### Sipp long-call scenario precursor

Before the 20-min long-call scenario joins endurance, validate it standalone with one short-form vitest test under the existing k8s test config: launch a single 20-min call against the cluster, confirm the B2BUA fires OPTIONS at ~15 min on both legs (visible in `kubectl logs`), confirm sipp 200 OKs land at the B2BUA and are absorbed (not relayed onward — verifiable via the other leg's sipp trace), confirm BYE completes cleanly.

### Short endurance (~1h soak, total ~1h 38min) — sanity before any 24h run

```
npm run test:k8s:endurance -- --duration 1h --seed 12345
```

Verifies: full pipeline under real durations, chaos scheduler respects all constraints, zero STEADY-call failures at 45 CAPS outside chaos windows, limiter probe converges and never exceeds cap.

### Reproducibility check

```
npm run test:k8s:endurance -- --duration 30m --seed 42
# … then again …
npm run test:k8s:endurance -- --duration 30m --seed 42
diff <(jq -c '{type,target,relative_t}' .../runA/chaos-timeline.ndjson) \
     <(jq -c '{type,target,relative_t}' .../runB/chaos-timeline.ndjson)
# must match
```

### Real runs (pre-release)

```
npm run test:k8s:endurance -- --duration 6h        # baseline
npm run test:k8s:endurance -- --duration 24h       # before major release
```

Pre-flight checks documented in `docs/k8s-endurance.md`:

- ≥30 GB free disk on the artifact volume
- ≥16 GB RAM available to host (kind cluster + sipp pods)
- WSL sleep disabled (`/etc/wsl.conf` `[boot]` `systemd=true`, plus `wsl --shutdown` policies)
- Docker daemon healthy and not under load
- B2BUA + proxy images built (`npm run test:k8s:images`)
- Clean kind cluster name available (no leftover from prior aborted run)

### Analyzer subcommand verification

```
npm run test:k8s:endurance:analyze -- forensic --call-id <id>     <run-dir>
npm run test:k8s:endurance:analyze -- window  <T1>..<T2>          <run-dir>
npm run test:k8s:endurance:analyze -- metric  memory_rss          <run-dir>
npm run test:k8s:endurance:analyze -- top-failures                <run-dir>
```

Run analyzer against an artifact dir from a synthetic crashed run (kill orchestrator at 30 % progress) — must emit `outcome: INCOMPLETE` and otherwise process whatever is on disk.
