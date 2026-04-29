# End-to-end K8s failover robustness tests

## Context

Slices 3–6 of the data-replication layer (ReplLog, ReplPuller, ReadyGate, dual-write tombstoning) shipped in commits `c2b9c00`–`6237d7d`. They are unit-tested (`tests/replication/*`) but have no end-to-end test in the K8s kind environment — and the kind environment itself does not yet deploy the dual-Redis-per-worker topology the design requires (single shared Redis at [tests/k8s/values/b2bua-worker.yaml:38-39](../../tests/k8s/values/b2bua-worker.yaml#L38-L39)).

Goal: prove the full path — front proxy + workers + per-worker dual-write — survives load-balancer and worker pod failures under sipp load, and *measure* the impact (re-emissions, establishment failures, badly-treated established calls) per scenario. Existing INV-3 ([tests/k8s/proxy-drain.test.ts:25-31](../../tests/k8s/proxy-drain.test.ts#L25-L31)) was deliberately deferred pending dual-write — this plan promotes it from informational to assertion and adds the failover scenarios on top.

Random chaos / long soak runs are explicitly **out of scope** — that is a future phase.

## Phase ordering

| Phase | Scope | Status |
|-------|-------|--------|
| 0a | Per-pod Redis sidecar topology in kind | **DONE** — Helm chart + workerOrdinalLabel plumbing |
| 0b | Production wiring of `ReplPuller` + `ReadyGate` + HTTP `ReplogClient` in `main.ts` | **TODO** — gating Phase 3 |
| 1 | Promote `proxy-drain` (INV-3) to assertion | Independent of Phase 0 |
| 2 | LB-proxy failover — kill 1 of 2 proxy pods | Independent of Phase 0 |
| 3 | Worker failover — kill primary, dual-write must hand over | **Requires Phase 0a + 0b** |

Phases 1 and 2 may land before or in parallel with Phase 0. Phase 3 ships only after both 0a and 0b.

## Phase 0a — DONE: per-pod Redis sidecar topology

Delivered:
- Redis sidecar container in the b2bua-worker pod (`localhost:6379`, `emptyDir`), gated behind `.Values.redis.enabled` so production stays opt-in.
- `/replog` reachable via headless StatefulSet DNS — confirmed `b2bua-worker-1` GETs `http://b2bua-worker-0.b2bua-worker.<ns>.svc.cluster.local:<adminPort>/replog?caller=…&since=0` and gets a clean NDJSON stream. Note: `/replog` rides the existing `admin` named port on the worker (StatusServer); it is not a separate port — K8s disallows two containers binding the same TCP port in a pod.
- `REDIS_URL=redis://localhost:6379` in `tests/k8s/values/b2bua-worker.yaml`.
- Shared `tests/k8s/charts/redis/` Deployment removed.
- `WORKER_ORDINAL_LABEL` / `POD_NAME` / `HOSTNAME` precedence plumbed in `src/config/AppConfig.ts` so each worker partitions its keys under the StatefulSet pod hostname (`b2bua-worker-0`, etc.) — without this, both workers would partition under `"self"`.
- Smoke proven: `pri:b2bua-worker-0:call:*` only on worker-0's sidecar; `pri:b2bua-worker-1:call:*` only on worker-1's; no cross-pollination. `propagate:{peer}` sorted sets populate as the proxy stamps `w_bak` cookies.

## Phase 0b — TODO: production wiring of ReplPuller / ReadyGate

Slices 3–6 left the production HTTP wiring deferred. Symptom: `bak:N:call:*` keys are empty on peer sidecars even though `propagate:{peer}` is populated, because nothing is consuming the propagate stream.

A separate plan / slice ("data-replication slice 7") must deliver:
- HTTP-backed `ReplogClient.layer` using `FetchHttpClient` + a headless-StatefulSet `PeerEndpointResolver`.
- Production `ReplPuller.redisLayer` (or store-wrapper) using the local sidecar for bookkeeping.
- `PeerEnumerator` layer wired in `src/main.ts`: `headlessStatefulSet({ serviceName: "b2bua-worker", namespace: <K8S_NAMESPACE>, portName: "admin", self: workerOrdinalLabel })`.
- A scoped fiber per peer: run `ReadyGate.run` on boot, then steady-state `ReplPuller.applyStream` loop.
- Env: `K8S_NAMESPACE` (downward API `metadata.namespace`).

Files relevant: `src/main.ts`, `src/replication/ReadyGate.ts`, `src/replication/ReplPuller.ts`, `src/cache/PeerEnumerator.ts`, `src/cache/PeerEndpointResolver.ts`.

Acceptance criterion (smoke): after a sipp call lands on worker-0, `kubectl exec b2bua-worker-1 -c redis -- redis-cli keys 'bak:b2bua-worker-0:*'` returns the corresponding backup keys.

## Phase 1 — Promote proxy-drain to assertion

**File modified:** [tests/k8s/proxy-drain.test.ts](../../tests/k8s/proxy-drain.test.ts)

Promote INV-3(a) from informational logging (lines 181–198) to a hard assertion: BYEs for dialogs originally routed to the drained worker must arrive at *some* worker that still has the dialog state. With dual-write deployed (Phase 0 done), `drainedByeStuck + drainedByeMigrated > 0` must equal the count of established calls on the drained worker, and `drainedByeMigrated` calls must succeed (not 481).

Runs the existing sizing (`N_HOLD = 20` at 20 cps).

Asserts (in addition to existing 3b/3c):
- Every established-on-drained call's BYE eventually receives a 2xx (no `481 Call/Transaction Does Not Exist`)
- The hold-job final `stats.successful >= N_HOLD - 2` (allow ≤2 calls in the inherent-loss window during the SIGTERM/grace boundary)

## Phase 2 — LB-proxy failover

Two new tests, `replicaCount: 2` proxy pods, kill one mid-call:

| File | Kill mode |
|------|-----------|
| `tests/k8s/proxy-failover-lb-delete.test.ts` | `kubectl delete pod --grace-period=0 --force` (test 2a) |
| `tests/k8s/proxy-failover-lb-killdash9.test.ts` | `kubectl exec -- kill -9 1` (test 2b) |

Sizing: 20 cps × 5s ramp + kill at T=5s + 10s post-kill traffic + 15s drain ≈ 35s wall, ~300 calls.

Sipp scenario: existing [sippperftest/uac.xml](../../sippperftest/uac.xml) shape (basic INVITE/200/ACK/BYE) — adapt to `tests/k8s/charts/sipp/scenarios/uac-basic-failover.xml` if not already present.

Selecting which proxy pod to kill: enumerate proxy pods, pick whichever owns the most in-flight calls per the routing log (same approach as [proxy-drain.test.ts:84-99](../../tests/k8s/proxy-drain.test.ts#L84-L99)). LB pods are stateless w.r.t. dialog state, so the "primary handler" is a UDP-conntrack accident; killing the busier one is enough.

Asserts:
- `unaffected.failed == 0` (calls whose INVITE never traversed the killed proxy)
- Surviving proxy pod is still routable post-test (final smoke INVITE round-trip)
- Killed pod recreated by the Deployment within 30s

## Phase 3 — Worker failover

Four new tests = 2 kill modes × 2 scenario shapes. Land in order: `*-hold` first, then `*-pingpong`.

| File | Kill mode | Lifecycle |
|------|-----------|-----------|
| `tests/k8s/proxy-failover-worker-delete-hold.test.ts` | delete `--grace=0 --force` | (B) hold-then-BYE |
| `tests/k8s/proxy-failover-worker-delete-pingpong.test.ts` | delete `--grace=0 --force` | (C) full ping-pong |
| `tests/k8s/proxy-failover-worker-killdash9-hold.test.ts` | `kill -9 1` in container | (B) hold-then-BYE |
| `tests/k8s/proxy-failover-worker-killdash9-pingpong.test.ts` | `kill -9 1` in container | (C) full ping-pong |

Stage-1 (`*-hold`) sizing: 20 cps × 5s ramp + kill at T=5s + 10s post-kill + 25s drain ≈ 45s wall, ~300 calls.

Stage-2 (`*-pingpong`) sizing: 10 cps × 15s ramp + kill at T=15s + 30s post-kill + 30s drain ≈ 80s wall, ~450 calls. Lower cps because each call lasts ~40s (`INVITE → ACK → 10s pause → re-INVITE(1) → ACK → 10s pause → re-INVITE(2) → ACK → 10s pause → BYE`); 800 concurrent dialogs at 20 cps stresses kind unnecessarily.

**New sipp scenarios:**
- [tests/k8s/charts/sipp/scenarios/uac-hold-failover.xml](../../tests/k8s/charts/sipp/scenarios/uac-hold-failover.xml) — `INVITE → 200 → ACK → 10s pause → BYE → 200`. May be a parameterized variant of existing `uac-hold.xml`.
- [tests/k8s/charts/sipp/scenarios/uac-pingpong.xml](../../tests/k8s/charts/sipp/scenarios/uac-pingpong.xml) — full ping-pong as above. New file.

**Stage-2 test note:** the *second* re-INVITE after the kill may land on either the backup B or the restored primary P (depending on OPTIONS-probe timing × StatefulSet restart speed × ReadyGate boot drain). The test asserts only that the call survives end-to-end, never on which worker handled the second re-INVITE. This is intentional — pinning to one outcome would test kind's pod-restart latency rather than the B2BUA's failover correctness.

Asserts (per test):
- `unaffected.failed == 0` (hard gate, regression net for surviving worker)
- Run completes within wall-budget × 1.5
- Final smoke INVITE through the proxy succeeds
- Killed pod was actually killed (`kubectl get pod` confirms `Terminating` then `Running` again)
- `established-on-dying` count > 0 (sanity: kill actually hit some calls)
- For Phase 3 `*-pingpong`: at least one call where the second re-INVITE was successful AFTER the kill (sanity: failover path was exercised, not just the simple case)

Survival rates of the `established-on-dying` / `in-flight-on-dying` / `pre-routed-on-dying` populations are **logged, not asserted** for this plan. Once 3+ baseline runs exist on `main`, a follow-up patch can add per-population thresholds. This avoids burning weeks tuning thresholds before we know baseline behavior.

## Shared infrastructure

### Outcome taxonomy

Per Call-ID, outcome ∈ `{clean, retransmitted, establish-failed, bye-timeout, mid-dialog-error}`.

State at kill ∈ `{unaffected, established-on-dying, in-flight-on-dying, pre-routed-on-dying}`.

The 5×4 matrix is the headline output. Rollup counters: `re-emissions` (sum of retransmits), `establish-failures` (count of `establish-failed`), `badly-treated` (count of `bye-timeout` + `mid-dialog-error`).

### New fixture modules

| File | Purpose |
|------|---------|
| `tests/k8s/fixtures/podKill.ts` | `type KillMode = "delete-grace0" \| "exec-kill-9"`. Wraps both kill paths. |
| `tests/k8s/fixtures/sippOutcomes.ts` | Parses sipp `-trace_msg` and `-trace_stat` to produce `Map<callId, { outcome, retransmits, lastResponse }>`. |
| `tests/k8s/fixtures/callLifecycle.ts` | Joins `fetchRoutingDecisions` + `sippOutcomes` + `T_kill` → `Array<{ callId, state, outcome, retransmits }>`. |
| `tests/k8s/fixtures/failoverReport.ts` | Renders the 5×4 matrix + 3 rollup counters; writes `summary.txt`, `categories.json`. |

### Extended fixtures

| File | Change |
|------|--------|
| [tests/k8s/fixtures/sippJob.ts](../../tests/k8s/fixtures/sippJob.ts) | Mount `/out` writable scratch volume in sipp pod. Pass `-trace_msg -message_file /out/msg.log -trace_stat -stat_file /out/stat.csv -trace_screen -screen_file /out/screen.log -trace_rtt -rtt_file /out/rtt.csv`. After job completes, `kubectl cp` `/out` from the pod into `<archiveDir>/sipp-traces/` before deleting the job. |
| [tests/k8s/fixtures/kubectl.ts](../../tests/k8s/fixtures/kubectl.ts) | Add `execInPod(ns, pod, container, cmd[])` (for `kill -9`) and `waitForStatefulSetSteady(ns, name, replicas, timeoutSec)`. |

### Reused as-is

- [tests/k8s/fixtures/proxyLogs.ts](../../tests/k8s/fixtures/proxyLogs.ts) — `fetchRoutingDecisions`, `aggregatePerCall`, `workerIpToName`
- [tests/k8s/fixtures/proxyMetrics.ts](../../tests/k8s/fixtures/proxyMetrics.ts) — for the post-test smoke INVITE
- [tests/k8s/fixtures/cluster.ts](../../tests/k8s/fixtures/cluster.ts) — kind cluster lifecycle
- [tests/k8s/fixtures/helm.ts](../../tests/k8s/fixtures/helm.ts) — Helm CLI

### Per-test isolation

Every failover test:
1. Captures `T_test_start = Date.now()` at entry; all log queries scope to `since: T_test_start`.
2. Generates a unique `runId = ${test-name}-${T_test_start.toString(36)}` for the archive directory.
3. In `afterEach`, calls `waitForStatefulSetSteady` (workers) and `waitForDeploymentSteady` (proxy) before yielding to the next test.

### Archive layout

```
test-results/k8s-failover/<runId>/
  summary.txt              # human-readable 5×4 matrix + rollup counters
  categories.json          # per-callId: {state, outcome, retransmits}
  routing-decisions.ndjson # full proxy log for the test window
  kill-timeline.json       # T_invite_first, T_kill_issued, T_pod_terminated, T_pod_recreated, T_proxy_marked_dead, T_invite_last
  proxy-logs/<pod>.log     # both proxy pods (current); --previous if killed
  worker-logs/<pod>.log    # all workers (current + --previous on the killed one)
  sipp-traces/             # raw sipp -trace_* files copied from the sipp pod
```

No automatic pruning. The user runs cleanup manually.

### Cross-run analysis & cleanup scripts

| File | Purpose |
|------|---------|
| `tests/k8s/scripts/failover-summary.ts` | Walks `test-results/k8s-failover/*/summary.txt`; prints a chronological table of (run × scenario × the 3 rollup counters) so trends across runs are visible at a glance. |
| `tests/k8s/scripts/failover-cleanup.sh` | Manual: `bash tests/k8s/scripts/failover-cleanup.sh [--keep N]`. Lists archive dirs sorted oldest→newest and offers to delete all but the last N. Defaults to listing only. |

## Test sizing reference

| Test | cps | Ramp | Post-kill | Drain | Wall | Total calls | Concurrent peak |
|------|-----|------|-----------|-------|------|-------------|-----------------|
| 1 (proxy-drain) | 20 | 1s | (drain takes 30s) | n/a | ~30s | 20 | 20 |
| 2a / 2b (LB) | 20 | 5s | 10s | 15s | ~35s | ~300 | ~150 |
| 3a-B / 3b-B (worker hold) | 20 | 5s | 10s | 25s | ~45s | ~300 | ~250 |
| 3a-C / 3b-C (worker pingpong) | 10 | 15s | 30s | 30s | ~80s | ~450 | ~400 |

All knobs overridable via env: `K8S_FAILOVER_CPS`, `K8S_FAILOVER_RAMP_S`, `K8S_FAILOVER_HOLD_S`, `K8S_FAILOVER_POSTKILL_S`. Defaults match the table.

## Run cadence

- New `npm run test:k8s:failover` opt-in script (vitest filter on the 6 new test files + the modified proxy-drain).
- Add the failover suite to `npm run test:nightly` so regressions are caught daily.
- **Not** added to `npm run test:k8s` — the existing K8s suite must stay quick.

## Verification

For each phase, after implementation:

**Phase 1 (modified [tests/k8s/proxy-drain.test.ts](../../tests/k8s/proxy-drain.test.ts)):**
```bash
npm run test:k8s:up                                                  # bring up kind
npm run test:k8s:images                                              # build + load
npx vitest run -c vitest.config.k8s.ts tests/k8s/proxy-drain.test.ts
# Expect: passes, summary.txt shows BYE-handoff working post-Phase-0
```

**Phase 2:**
```bash
npx vitest run -c vitest.config.k8s.ts tests/k8s/proxy-failover-lb-delete.test.ts
npx vitest run -c vitest.config.k8s.ts tests/k8s/proxy-failover-lb-killdash9.test.ts
# Expect: unaffected.failed == 0; surviving proxy still routable; killed pod recreated
# Inspect: test-results/k8s-failover/*/summary.txt — re-emissions/establish-failures/badly-treated counters
```

**Phase 3 (requires Phase 0 done):**
```bash
npx vitest run -c vitest.config.k8s.ts tests/k8s/proxy-failover-worker-delete-hold.test.ts
npx vitest run -c vitest.config.k8s.ts tests/k8s/proxy-failover-worker-killdash9-hold.test.ts
npx vitest run -c vitest.config.k8s.ts tests/k8s/proxy-failover-worker-delete-pingpong.test.ts
npx vitest run -c vitest.config.k8s.ts tests/k8s/proxy-failover-worker-killdash9-pingpong.test.ts
# Expect: unaffected.failed == 0; established-on-dying > 0; pingpong tests show at least one
#         successful re-INVITE-after-kill round trip; sidecar inspection shows bak:N:call:*
#         keys on the surviving worker
```

**Cross-run analysis:**
```bash
npx tsx tests/k8s/scripts/failover-summary.ts
# Expect: chronological table across all archived runs
```

**Manual cleanup (run as needed):**
```bash
bash tests/k8s/scripts/failover-cleanup.sh --keep 10
```

**Sanity checks against the type-check and existing suites:**
```bash
npm run typecheck   # zero errors, zero warnings
npm run test:fake   # all unit + fake-stack tests still pass
```

## File index

### Created
- `tests/k8s/proxy-failover-lb-delete.test.ts`
- `tests/k8s/proxy-failover-lb-killdash9.test.ts`
- `tests/k8s/proxy-failover-worker-delete-hold.test.ts`
- `tests/k8s/proxy-failover-worker-delete-pingpong.test.ts`
- `tests/k8s/proxy-failover-worker-killdash9-hold.test.ts`
- `tests/k8s/proxy-failover-worker-killdash9-pingpong.test.ts`
- `tests/k8s/fixtures/podKill.ts`
- `tests/k8s/fixtures/sippOutcomes.ts`
- `tests/k8s/fixtures/callLifecycle.ts`
- `tests/k8s/fixtures/failoverReport.ts`
- `tests/k8s/charts/sipp/scenarios/uac-hold-failover.xml`
- `tests/k8s/charts/sipp/scenarios/uac-pingpong.xml`
- `tests/k8s/scripts/failover-summary.ts`
- `tests/k8s/scripts/failover-cleanup.sh`

### Modified
- [tests/k8s/proxy-drain.test.ts](../../tests/k8s/proxy-drain.test.ts) — promote INV-3(a) to assertion
- [tests/k8s/fixtures/sippJob.ts](../../tests/k8s/fixtures/sippJob.ts) — mount /out volume + capture trace files
- [tests/k8s/fixtures/kubectl.ts](../../tests/k8s/fixtures/kubectl.ts) — add `execInPod`, `waitForStatefulSetSteady`
- [package.json](../../package.json) — add `test:k8s:failover` script + extend `test:nightly`

### Out of scope (Phase 0, separate plan)
- [tests/k8s/charts/redis/](../../tests/k8s/charts/redis/) — to be removed
- [deploy/helm/b2bua-worker/templates/statefulset.yaml](../../deploy/helm/b2bua-worker/templates/statefulset.yaml) — add Redis sidecar container, /replog port
- [tests/k8s/values/b2bua-worker.yaml](../../tests/k8s/values/b2bua-worker.yaml) — point `REDIS_URL` to `localhost`, add peer enumeration env

## Implementation strategy

Each phase is a self-contained slice that can be implemented by a subagent with a focused brief:

- **Phase 1 slice** — modify `proxy-drain.test.ts` only; introduce no new fixtures.
- **Shared-infra slice** — land `podKill.ts`, `sippOutcomes.ts`, `callLifecycle.ts`, `failoverReport.ts`, the `sippJob.ts` extension, and the `kubectl.ts` additions in one pass (Phases 2 and 3 both consume them).
- **Phase 2 slices** — one per kill mode (2a, 2b).
- **Phase 3-B slices** — one per kill mode (3a-B, 3b-B), validates dual-write under (B) lifecycle.
- **Phase 3-C slices** — one per kill mode (3a-C, 3b-C), validates ping-pong + restored-primary path.

When delegating each slice to a subagent, the brief must include: this plan file path, the slice's file list, the fixture functions to reuse with their paths, and the explicit assertion targets from this plan. Do not ask subagents to invent thresholds — the assertion set is the hard gate (`unaffected.failed == 0` + plumbing checks); everything else is logged.
