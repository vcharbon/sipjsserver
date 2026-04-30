# K8s failover suite — follow-ups

Tracks deferred refactor / hardening work surfaced while landing
[docs/plan/proper-end-to-end-cheerful-lobster.md](../plan/proper-end-to-end-cheerful-lobster.md).
None of these block the failover test suite from running and asserting
the existing hard gates — they're correctness or ergonomics improvements
worth doing before a wider rollout.

Priority scale:
- **P1** — observable bug or correctness gap; will bite production HA.
- **P2** — code-quality / dedup / ergonomics that compounds over time.
- **P3** — cosmetic / nice-to-have.

---

## 1. Rolling-restart of both worker pods leaves one ReplPuller fiber hung — P1

**Symptom.** `kubectl rollout restart statefulset b2bua-worker` starts
the higher-ordinal pod (`b2bua-worker-1`) first while the lower-ordinal
is still terminating. Worker-1's `ReadyGate` succeeds quickly (against
the still-alive old worker-0), forks the steady-state pull fiber, then
that pull fiber opens its first long-poll against old-worker-0 — which
dies as the StatefulSet replaces it. Worker-1's pull fiber subsequently
goes silent (no outbound TCP, no log entries, `replpos` stuck) until the
operator restarts worker-1 individually.

**Mitigations already in place** (none fully resolves the hang):
- 35 s `Effect.timeout` on `applyStream` in the steady-state loop
- 250 ms reconnect pause between long-polls
- `Effect.never` at the bottom of `runReplicationConsumer` to keep the
  layer scope alive for the worker's lifetime

**Suspected root cause.** Effect's `forkDetached` interaction with a
fiber whose first invocation observes a connection going from healthy →
broken mid-response. The 35s timeout SHOULD recover, but observation is
that it doesn't fire as expected on the half-open TCP path.

**Acceptance.** `kubectl rollout restart statefulset b2bua-worker;
kubectl rollout status; kubectl exec b2bua-worker-1 -c redis -- redis-cli
get replpos:b2bua-worker-0` shows `lastSeq` advancing within 60s of the
rollout completing — without manual intervention.

**Why it matters.** Production graceful upgrades use rolling restart;
this is the most common HA scenario. Phase 3 single-pod kill tests
work fine, so nothing regresses today, but cluster operators will trip
this the first time they roll the worker StatefulSet under load.

**Where to look.** `src/main.ts` `runReplicationConsumer`,
`src/replication/ReplPuller.ts` `applyStream`, the `forkDetached` per
peer + the wrapping `Effect.timeout`. Smoke is reproducible by hand
against a kind cluster.

---

## 2. Survival-rate thresholds not asserted on Phase 3 populations — P1

**Current state.** All Phase 2/3 tests assert `unaffected.failed == 0`
plus plumbing checks (smoke INVITE, recovery time). Survival of
`established-on-dying` / `in-flight-on-dying` / `pre-routed-on-dying`
populations is logged in `summary.txt` but never asserted (per plan
§ "Pass criteria — start as measurement-only").

**What's needed.** After 3+ baseline runs land cleanly on `main`:
1. Run `tsx tests/k8s/scripts/failover-summary.ts` to read the typical
   `re-emissions` / `establish-failures` / `badly-treated` counters.
2. Set per-test thresholds (e.g., `expect(result.counters.badlyTreated)
   .toBeLessThan(N)`) at ~1.5× observed baseline.
3. Tighten over time as the baseline stabilises.

**Acceptance.** A regression that doubles `badly-treated` is caught at
the assertion level, not by humans eyeballing nightly summaries.

---

## 3. `lbFailoverHarness` and `workerFailoverHarness` are 90 % identical — P2

**Symptom.** Two near-identical files in `tests/k8s/fixtures/` differ
only in:
- Pod label selector (`sip-front-proxy` vs `b2bua-worker`)
- Recovery wait (`waitForDeploymentSteady` vs `waitForStatefulSetSteady`)
- Classification key (`killedProxyPod` vs `killedWorkerIp`)
- Default sipp scenario file

**Why we kept them split.** Worker tests have specific concerns
(`postKillReinviteSuccesses`, `establishedOnDyingCount`, `--previous`
log capture for `kill-9`, future `bak:` key inspection) that LB tests
don't share. Mixing them in one harness with optional fields is
murky.

**Refactor target.** Pull out the 90% common path into a thin
`failoverScenarioCore.ts` that takes a target-discriminator value
(`{ kind: "lb-proxy" } | { kind: "worker" }`) carrying its own pod
selector / steady-wait / classify-key. The two harnesses become very
small wrappers that add their kind-specific extras.

**Why it matters.** When we add Phase 4 (chaos) tests they'll likely
reuse 80% of the same code; deduplication should land before that.

---

## 4. RTT trace capture not working for stock scenarios — P3

**Symptom.** Sipp's `-trace_rtt` only writes when at least one `<recv
rtd="true"/>` block fires AND `-rtt_freq` is met (default 200). The
fixture toolkit `cp`s `/out/<scenario>_<pid>_rtt.csv` after the run,
but it's typically empty or absent because all the failover scenarios
have only 1 `rtd` and call counts are well under 200.

**Workaround in place.** Tests can pass `extraArgs: ["-rtt_freq", "1"]`
to force RTT capture per call.

**What to do.** Either bake `-rtt_freq 1` into the failover harnesses by
default (so RTT lands in archives without per-test opt-in), or document
the override in `K8S_test.md` next to the failover section. The data is
useful for diagnosing slow paths after the fact; today it's just absent.

---

## 5. `kubectl exec ... -- kill -9 1` may race the trace-pod-stays-alive
   wrapper in some sipp Job pods — P3

**Symptom.** Sipp Job pods with `captureTraces: true` wrap the sipp
binary in `/bin/sh -c '... ; touch .done ; sleep 600'` so that
`kubectl cp` can pull `/out/*` after the workload exits. If a test
also targets `kill -9 1` against that very pod (for some hypothetical
"kill the sipp generator" scenario — not a current scenario), PID 1
is the shell, not sipp.

**Today's state.** Not actually broken because no current test kills
sipp pods — only worker / proxy. Worth a comment in `podKill.ts` so
the next person doesn't get burned reading it.

---

## 6. YAML linter false-positive on `tests/k8s/charts/sipp/templates/scenarios-configmap.yaml` — P3

**Symptom.** VS Code's YAML linter reports "Implicit map keys need to
be followed by map values" on each `{{ .Files.Get "..." | indent 4 }}`
line. The file is a Helm template, not pure YAML; `helm template`
renders it correctly.

**Fix options.**
- Add a `# yaml-language-server: $schema=...` directive that excludes
  the file, OR
- Use the `range` form to iterate over `.Files.Glob "scenarios/*.xml"`
  and emit one entry per match, which the linter handles better.

The second option is probably cleaner long-term since adding a new
scenario currently requires editing both the file and this template.

---

## 7. No per-test namespace isolation for failover suite — P2

The existing `K8S_test.md` notes per-test namespace isolation as a
Phase B aspiration. The failover suite makes this MORE pressing
because each test deletes pods, mutates StatefulSet/Deployment state,
and runs sustained load — concurrent runs would chaos each other.

The vitest config enforces `singleFork`, so this is "wrong but safe"
today. Per-test namespaces would let nightly runs parallelise across
3 namespaces × ~80s = ~80s wall instead of ~5 min wall sequential.

Tracked alongside the broader K8s test isolation work in
[K8S_DEV_TEST.md](K8S_DEV_TEST.md).
