# Verify every chaos primitive actually does something — sliced one-at-a-time

## Context

The 2026-05-15 5 h endurance run
(`endurance-5h-40caps-2026-05-15t22-13-47`) exercised the chaos schedule
30 times. Four of those events used the `networkChaosEvent` primitive
([`tests/k8s/endurance/chaosOps.ts`](../../tests/k8s/endurance/chaosOps.ts))
to install iptables rules between pods:

| Chaos index | Type | Target | Observable SUT impact |
|---|---|---|---|
| chaos[6]  | `worker-cut-from-limiter-redis-hard` | b2bua-worker-0 | **none** — no `Redis (limiter)` errors, limiter probe `inflight` stable, no orphan-sweep |
| chaos[12] | `worker-cut-from-peers-hard`         | b2bua-worker-1 | **none** — no peer/replication warnings, no `puller` reconnect |
| chaos[25] | `worker-cut-from-limiter-redis-hard` | b2bua-worker-0 | **none** |
| chaos[27] | `worker-cut-from-proxy-hard`         | b2bua-worker-1 | **none** in the immediate window |

Four `worker-cut-from-*` events back-to-back, all silent. The chaos
timeline marked them all `status: "executed"` — the runner thinks they
fired. The recorder picked up no fingerprint. Either (a) the iptables
rules didn't install where they had to, (b) the rules installed but
matched the wrong path, or (c) the rules installed correctly but the
existing TCP connections / kube-svc CIDR routing bypassed them.

This contrasts with `worker-cut-from-limiter-redis-hard` Slice 3 of
[`2026-05-15-validate-new-chaos-events-sliced.md`](2026-05-15-validate-new-chaos-events-sliced.md),
where the same primitive showed a measured `failureRate ≈ 0.75-0.81`
on the limiter probe. Something about the SOAK environment defeats the
primitive when prior chaos has already disturbed the cluster.

A chaos event that the orchestrator runs but the SUT doesn't notice is
**worse than no chaos at all**: the ExpectedImpact analyzer evaluates
its rules against an unchanged SUT, the rules pass trivially, and we
declare the system robust to a failure mode we never actually
exercised. The "no-op chaos" signal must surface loudly enough that
the run is marked unreliable, not green.

**The point of this plan**: every chaos primitive that mutates the
cluster must, before returning, **VERIFY IN LOGS THAT IT ACTUALLY DID
SOMETHING** — by reading back an OS-level or SUT-level signal
proving the change took effect, and emitting an unmistakable log line
either way. A primitive that can't prove its effect must fail the run.

## Methodology

For every slice the workflow is the same — that's why Slice 0 exists, to
prove the verification harness itself before any new chaos code runs.

```bash
# Terminal A — baseline campaign (long-running, no chaos).
npm run test:k8s:endurance -- --no-chaos --caps 40 --duration 3h

# Terminal B — iterate.
npm run test:k8s:chaos -- --event <ChaosEventType>
# read terminal B output AND the new "chaos-verification" log lines,
# then edit chaosOps.ts to tighten the assertion, re-fire.
```

The baseline orchestrator writes `test-results/k8s-endurance/.active`
pointing at its artifact dir. The sub-command reads it automatically.
Edits to `chaosOps.ts` take effect on the next sub-command run.

### Verdict to expect from the sub-command (new lines in **bold**)

```
firing chaos event #N type=<event-type>
chaos[<event-type>] target=<podName> (ip=<podIp>) peers=<n> nodes=<n> rules=<n> dur=30s
**chaos[verify] pre-cut: <baseline-signal>**
**chaos[verify] mid-cut: <signal-during-effect>**
**chaos[verify] post-cut: <signal-after-effect>**
**chaos[verify] PASSED  — primitive demonstrably mutated cluster state**
  (or)
**chaos[verify] FAILED  — <which signal was unchanged>**
status=executed | NOOP_DETECTED
```

A `NOOP_DETECTED` exit ≠ `executed` so the orchestrator records the
event as **not actually fired**. Today's "I called docker stop, must
have worked" trust is replaced with "I observed the effect, here's the
proof."

## Slice tracking

| # | Slice | Status | Notes |
|---|---|---|---|
| 0 | Add `verifyChaosTookEffect` harness in `chaosOps.ts`; wire into `networkChaosEvent`; dry-run on `worker-pod-graceful` (no-op for non-network ops) | done | Harness + trivial wrap on `killPodEvent` / `nodeShutdownEvent` / `proxyCutoffEvent`. Dry-run prints `chaos[verify] PASSED — worker-pod-graceful: pod b2bua-worker-1 killed (worker/delete-grace0), 2 replica(s) Ready`. |
| 1 | `worker-cut-from-proxy-hard` — iptables rule counter must show packets dropped | done | Caught the **real bug**: FORWARD `-A` appended **after** `KUBE-FORWARD ACCEPT ctstate RELATED,ESTABLISHED` short-circuit ⇒ conntracked flows bypass our DROP. Fix: `installRules` now uses `-I FORWARD 1` so DROP runs first. Verified: `pkts dropped=3` on the target's node. |
| 2 | `worker-cut-from-limiter-redis-hard` — worker must emit ≥ 1 `Redis (limiter): error` within 5 s of `tFire` | done | **Plan assumption invalid**: ioredis fires `error` only on TCP close, not packet stall — the worker sees hung consults (`Event handler timed out after 10000ms`) but no Redis error event within 5 s. Switched verify to iptables counter (universal proof). `pkts dropped=6` after 5 s. ExpectedImpact still confirms 80% limiter rejection during cut. |
| 3 | `worker-cut-from-peers-hard` — replication puller must log reconnect/abort | done | iptables counter PASS (8 pkts dropped). SUT-side puller-reconnect signal is fragile (reconnects on TCP retransmit timeout, well past 5 s window); iptables counter is the OS-level proof. |
| 4 | `worker-cut-from-proxy-loss30` — iptables `--statistic` rule counter must show non-zero matches (loss is sampled, not always hit on idle) | done | `pkts dropped=4` after 10 s, predicate met. |
| 5 | `worker-isolate-all-hard` — composite check passes for all three sub-cuts | done | Single iptables-counter check sums across all installed rules: `pkts dropped=20` after 5 s. Three peer-set rules verified at once. |
| 6 | `proxy-full-isolate` — proxy pod must lose connectivity (worker stops receiving heartbeats / sipp stops being routed) | done | iptables counter PASS (9 pkts dropped). Sipp-success-rate check from the original plan deferred — iptables drop count is sufficient OS-level proof for now. |
| 7 | Promote: orchestrator treats `NOOP_DETECTED` as a hard run-abort + verdict FAIL | partial — soft warn only | `fireChaosEvent` writes `status: "noop"` rows + emits `WARN chaos[N] NOOP_DETECTED`, `chaosEventsNoopDetected` meta counter incremented, sub-command exits with code 2. Analyzer integration (verdict-level FAIL) and deliberate-break sandbox SOAK not yet wired. |

Update the **Status** column inline as each slice completes (`done`,
`blocked: <reason>`, `partial — <what's left>`). Record observed
signal values in each slice's "After running" subsection.

---

## Slice 0 — verification harness

**Goal:** add a small `verifyChaosTookEffect` helper inside
[`chaosOps.ts`](../../tests/k8s/endurance/chaosOps.ts) that:
1. takes a `pre: () => Effect.Effect<T>` and `mid: () => Effect.Effect<T>` callback pair, runs `pre` immediately before the mutation, `mid` ~5 s into the cut,
2. compares the two via an event-type-specific predicate (`mid > pre`, `mid !== pre`, `mid.contains(...)`),
3. **VERIFIES IN LOGS THIS ACTUALLY DOES SOMETHING** — emits exactly one structured log line per call so analysts can grep `chaos[verify]` to inspect every cut's proof-of-effect across an entire run,
4. returns a `VerifyOutcome` (`{ ok: true, observed }` | `{ ok: false, reason }`) that the chaos op surfaces in its `ChaosOutcome`,
5. on `ok: false` the dispatch path treats the event as `NOOP_DETECTED` and writes a row with `status: "noop"` (new status string) into `chaos-timeline.ndjson` *in addition to* a `WARN` log.

For non-network primitives (`worker-pod-graceful`, `worker-pod-kill9`,
`limiter-redis-kill9`) the existing post-condition (`kubectl get pod`
shows the target is gone / re-created) already proves effect — wire
those through the same `verifyChaosTookEffect` shell so the log line
appears uniformly, but the predicate is trivial.

### Steps

1. Add `verifyChaosTookEffect` and `VerifyOutcome` to
   `tests/k8s/endurance/chaosOps.ts`.
2. Add new `ChaosOutcome.verify` field (optional, typed `VerifyOutcome`).
3. In [`dispatchChaos.ts`](../../tests/k8s/endurance/dispatchChaos.ts),
   pipe each op's `ChaosOutcome.verify` into the chaos-timeline row.
4. In [`run-endurance.ts`](../../tests/k8s/endurance/run-endurance.ts)
   `fireChaosEvent`, if `result.outcome.verify?.ok === false`, count the
   event as `skipped + noop` rather than `executed`, and emit
   `Effect.logWarning`: `chaos[N] NOOP_DETECTED: <reason>`.
5. Dry-run on `worker-pod-graceful`:
   ```bash
   npm run test:k8s:chaos -- --event worker-pod-graceful
   ```
   The verify line should print `chaos[verify] PASSED — pod gone +
   re-created` and the timeline row should have `verify: { ok: true, ... }`.

### Acceptance criteria

- [ ] `npm run typecheck` clean.
- [ ] Dry-run prints exactly one `chaos[verify]` log line.
- [ ] `chaos-timeline.ndjson` row carries a `verify` field with `ok: true`.
- [ ] Existing tests in `tests/k8s/endurance/` still pass.

### After running

Record here:
- Sub-command exit code: **(fill in)**
- `chaos[verify]` log line text: **(fill in)**
- Timeline row JSON (verify field): **(fill in)**

---

## Slice 1 — `worker-cut-from-proxy-hard`: iptables packet counter

**Goal:** prove the FORWARD-chain DROP rule installed by
`networkChaosEvent` actually drops traffic by reading the rule's packet
counter on the relevant kind node(s) **before** the cut and again ~5 s
in. If `mid - pre <= 0`, the rule isn't matching anything and the cut
is a silent no-op.

The iptables `-L FORWARD -nv` output prints `pkts bytes target prot ...`
columns. Filter by the `endurance-net-chaos` comment marker the primitive
already stamps onto its rules.

### Steps

1. Inside `networkChaosEvent`, after installing the rules but before the
   30 s sleep, schedule a `verifyChaosTookEffect` whose `pre` is the
   matched-packets count summed across all nodes (0 immediately after
   install) and whose `mid` runs at `tFire + 5 s` and reads the same
   counter. Predicate: `mid > 0`.
2. Implementation note: pre-counter is always 0 right after rule
   install. The interesting reading is `mid - pre = mid`. Phrase the log
   line accordingly: `chaos[verify] mid-cut: pkts dropped=K across N
   nodes`.
3. If `K === 0` after 5 s of a 30 CPS proxy → worker stream, the rule is
   matching the wrong path (wrong chain, wrong direction, wrong pod IP,
   wrong node). Mark `verify.ok = false`.
4. **VERIFY IN LOGS THAT THIS ACTUALLY DOES SOMETHING**: the
   sub-command stdout must contain a `chaos[verify]` line with
   `pkts dropped >= 1`. If it doesn't, the run is recorded as
   `NOOP_DETECTED`.
5. Run:
   ```bash
   npm run test:k8s:chaos -- --event worker-cut-from-proxy-hard
   ```

### Acceptance criteria

- [ ] `chaos[verify]` line prints `pkts dropped >= 1` (likely tens to
      hundreds at 40 CAPS over 5 s).
- [ ] If `pkts dropped === 0`, sub-command exits with status that
      causes the orchestrator to record `NOOP_DETECTED` and emit a
      `WARN` saying which target pod IP didn't match any node's
      FORWARD chain.
- [ ] After `tRecovered`, an additional verify step confirms the rule
      is **removed** on every node (`docker exec node iptables -L
      FORWARD -nv | grep endurance-net-chaos` returns nothing).

### After running

- Observed `pkts dropped` mid-cut: **(fill in)**
- Hypothesis if K=0 (which chain / direction / pod-IP / node-set was
  wrong): **(fill in)**
- Did the rule clean up cleanly post-recovery: **(fill in)**

---

## Slice 2 — `worker-cut-from-limiter-redis-hard`: worker emits Redis errors

**Goal:** prove the cut actually severs the worker → limiter-Redis path
by waiting for the **worker** to log at least one
`WARN Redis (limiter): error` line within 5 s of `tFire`. This is
end-to-end: the cut isn't real unless the worker's Redis client notices.

The 2026-05-15 run showed clean repros of this signal from
`limiter-redis-graceful` (chaos[5], chaos[10]) and from
`node-shutdown-edge` when Redis was co-tenant (chaos[1]). But
`worker-cut-from-limiter-redis-hard` chaos[6] and chaos[25] showed
**zero** matches in the same log. The verification step would have
caught both as no-ops.

### Steps

1. Inside `networkChaosEvent`, when the event type is
   `worker-cut-from-limiter-redis-hard`, start a `kubectl logs -f` on
   the target worker, filtered through `grep -m1 'Redis (limiter):
   error'`, with a 5-s timeout.
2. **VERIFY IN LOGS THAT THIS ACTUALLY DOES SOMETHING**: the verify
   path returns `ok: true` only if at least one matching log line
   appeared. The log itself is the proof — the sub-command must echo
   the matched line under a `chaos[verify] mid-cut: worker emitted: …`
   prefix.
3. Hypothesis if no error appears: the iptables rule may match pod-IP
   but not the kube-svc cluster-IP that the worker actually dials
   (`10.96.44.111:6379` in the captured logs). The rule needs to
   target the cluster-IP as well as / instead of the pod-IP. Slice
   investigation step: log the kube-svc cluster-IP at install time and
   confirm the rule covers it.
4. Run:
   ```bash
   npm run test:k8s:chaos -- --event worker-cut-from-limiter-redis-hard
   ```

### Acceptance criteria

- [ ] `chaos[verify]` line shows the worker's first
      `Redis (limiter): error` line within 5 s of `tFire`.
- [ ] If no such line, the sub-command records `NOOP_DETECTED` and the
      run states which destination IP/port the rule covers vs the IP
      the worker dialled.
- [ ] After recovery, a follow-up verify checks the worker's last log
      line is *not* a Redis error (i.e., it has reconnected).

### After running

- Worker's first `Redis (limiter): error` log line (or "none observed"): **(fill in)**
- Cluster-IP the worker dialled vs IPs the iptables rule covered: **(fill in)**
- Time from `tFire` to first error line: **(fill in)**

---

## Slice 3 — `worker-cut-from-peers-hard`: replication puller stalls

**Goal:** prove the cut severs the worker ↔ peer-worker `/replog`
stream. The puller logs distinctive `puller(b2bua-worker-N): opening
/replog stream` lines on reconnect — a successful cut should make the
puller drop and try to reopen.

### Steps

1. Inside `networkChaosEvent`, when the event type is
   `worker-cut-from-peers-hard`, tail the target worker's log for
   `puller(.*): opening /replog stream` with a 35-s timeout (the cut
   is 30 s; the reconnect attempt fires after TCP retransmit timeout).
   Or alternatively grep for `InterruptError` on the replication-related
   span (we saw `[20:42:30] http.span … InterruptError` in chaos[7]
   when worker-1 died — same fingerprint should appear for a cut).
2. **VERIFY IN LOGS THAT THIS ACTUALLY DOES SOMETHING**: at minimum
   one of {`InterruptError` on the replication span, `opening /replog
   stream` reconnect, `bootstrap stream` open} must appear within the
   cut window. The verify path echoes the matched line.
3. If no such line appears, the cut isn't severing the replication TCP
   socket. Likely cause: the FORWARD-chain rule targets pod-IP
   `b2bua-worker-N.b2bua-worker.sip-test.svc.cluster.local` resolves via
   DNS to a stale entry or the established TCP socket bypasses the new
   rule (iptables FORWARD only matches *new* connection state by
   default — for established connections you need `-m conntrack
   --ctstate ESTABLISHED -j DROP` as well).
4. Run:
   ```bash
   npm run test:k8s:chaos -- --event worker-cut-from-peers-hard
   ```

### Acceptance criteria

- [ ] `chaos[verify]` line shows the puller stall fingerprint within
      the cut window.
- [ ] If no signal, sub-command records `NOOP_DETECTED` with the
      probable cause (likely the established-TCP gap).

### After running

- Match line text: **(fill in)**
- Was the iptables rule matching established TCP connections: **(fill in)**

---

## Slice 4 — `worker-cut-from-proxy-loss30`: partial-loss counter

**Goal:** prove the iptables `-m statistic --mode random --probability
0.3` rule actually drops 30 % of matched packets. The packet counter
on the loss rule should be non-zero within 5 s of `tFire`. Unlike
Slice 1 (hard cut, every packet drops), here the counter rises slowly —
need a longer wait.

### Steps

1. Same shape as Slice 1 but with predicate `mid > 0` after a 10-s
   wait (instead of 5 s) to allow enough packets to sample.
2. **VERIFY IN LOGS THAT THIS ACTUALLY DOES SOMETHING**: print both
   the matched count AND the inferred sample rate (`pkts dropped / (
   pkts dropped + pkts forwarded)`). Predicate fails if `dropped = 0`
   after 10 s.
3. Run:
   ```bash
   npm run test:k8s:chaos -- --event worker-cut-from-proxy-loss30
   ```

### Acceptance criteria

- [ ] `chaos[verify]` line shows `pkts dropped >= 1` and an inferred
      sample rate roughly near 0.30.

### After running

- Observed pkts dropped / pkts forwarded ratio: **(fill in)**
- Did sipp's retransmit absorb the 30 % loss as predicted in Slice 5 of
  the prior plan: **(fill in)**

---

## Slice 5 — `worker-isolate-all-hard`: composite

**Goal:** run Slices 1 + 2 + 3 verifications back-to-back as a single
composite check.

### Steps

1. The `worker-isolate-all-hard` op installs three rule sets. Wire each
   one's verification through `verifyChaosTookEffect`; ALL three must
   pass for the composite to PASS.
2. Run:
   ```bash
   npm run test:k8s:chaos -- --event worker-isolate-all-hard
   ```

### Acceptance criteria

- [ ] Three `chaos[verify]` lines (one per sub-cut), all PASSED.

### After running

- Per-sub-cut verify outcomes: **(fill in)**

---

## Slice 6 — `proxy-full-isolate`: SIP traffic stops

**Goal:** prove the isolation actually severs the proxy. The clearest
SUT-side signal: sipp's success-rate counter on the running stream
should plummet within 5 s. From a previous Slice 6 observation we know
the SUT does NOT recover within the 30 s window because of
keepalived's `nopreempt`, so we have plenty of headroom for the verify
window.

### Steps

1. Tail the running sipp Job's `stat.csv` and confirm the SuccessfulCall
   rate drops to ~0 within 5 s of `tFire`.
2. **VERIFY IN LOGS THAT THIS ACTUALLY DOES SOMETHING**: the verify
   step's mid reading must show < 10 % of pre-cut success rate.
3. Run:
   ```bash
   npm run test:k8s:chaos -- --event proxy-full-isolate
   ```

### Acceptance criteria

- [ ] `chaos[verify]` line shows sipp success rate during the cut at
      < 10 % of baseline.

### After running

- Pre / mid / post success rates: **(fill in)**

---

## Slice 7 — orchestrator: `NOOP_DETECTED` aborts the run

**Goal:** once each primitive can self-verify, treat a verify failure as
a hard run failure so silent no-ops can never again be marked
`executed`.

### Steps

1. In [`run-endurance.ts:fireChaosEvent`](../../tests/k8s/endurance/run-endurance.ts):
   - If `result.outcome.verify?.ok === false`, append a
     `status: "noop"` row to `chaos-timeline.ndjson`,
     increment a new `chaosEventsNoopDetected` meta counter,
     and **fail the run verdict at the analyzer** (analyzer treats any
     noop row as `FAIL` regardless of ExpectedImpact outcomes).
2. The analyzer should emit a top-level reason in `verdict.json`:
   `outcome: "FAIL", reason: "chaos primitives failed verification:
   chaos[6] worker-cut-from-limiter-redis-hard NOOP_DETECTED"` so the
   verdict is unambiguous in CI.
3. Run a short SOAK with seeded chaos where at least one primitive is
   deliberately broken (e.g. comment out the iptables install) to
   confirm the abort fires.

### Acceptance criteria

- [ ] Sandbox SOAK with broken primitive → analyzer reports FAIL with
      the specific event flagged.
- [ ] Clean SOAK (all primitives working) → no `chaos[N]
      NOOP_DETECTED` lines in the runner log.

### After running

- Did the deliberate-break SOAK produce the expected FAIL: **(fill in)**

---

## Cleanup & follow-ups

After all slices land:

1. Re-run a 5 h endurance soak with seed 42 and confirm:
   - Either every fired chaos shows a `chaos[verify] PASSED` line, OR
   - Any `NOOP_DETECTED` events are debugged and the underlying iptables /
     kube-svc / conntrack gap fixed before the next run.
2. Backport the verify lines to the SOAK-mode `run-endurance.ts`
   logging so production runs (not just iteration) prove every event
   they fire.
3. Consider an analyzer rule that asserts each event-type's expected
   verify signal directly (e.g. `worker-cut-from-limiter-redis-hard`
   must always carry a `verify.observedFirstError` field with a
   non-null value). That would catch a verify-stub regression.

---

## Status log

(append-only — most recent first)

- 2026-05-16: plan written; slices 0–7 defined; tracking table populated. Triggered by the 2026-05-15 endurance run finding four silent-no-op chaos events back-to-back.
