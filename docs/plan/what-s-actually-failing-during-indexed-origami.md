# What's actually failing during event 5 — diagnose-then-fix replication gap

## Context

The 2 h endurance chaos run `endurance-2026-05-06t06-30-03-595z` showed a
sharply asymmetric failure pattern between two `node-shutdown-app` events:

- **Event 5** (07:36:51, killed worker-0): 127 unique calls failed with 481 on
  in-dialog BYE.
- **Event 7** (08:01:55, killed worker-1, the symmetric event): 0 BYE 481s in
  the same minute.

We grilled the initial four-slice proposal and the alternative proxy-HA
proposal; the actual evidence does not support that framing. This plan
documents what we believe is happening, what we will change first, and how we
will measure to confirm whether anything else is needed.

## What is actually happening (evidence-anchored)

The proxy already routes in-dialog requests deterministically per-call: a
signed Record-Route cookie `v=2|w_pri|w_bak|c=callId` is decoded on every
in-dialog request ([LoadBalancer.ts:294-506](src/sip-front-proxy/strategies/LoadBalancer.ts)).
For event 5 the proxy logs confirm `decision=decode_forward_backup` to worker-1
(10.244.2.2) — i.e. the proxy *correctly* sent BYEs to the surviving backup.

The 481s came from worker-1's `checkout` returning `undefined` because the
calls were not present in `bak:0:call:*`
([call/CallState.ts:249-303](src/call/CallState.ts)).

The replication mechanism is in
[src/replication/AtomicWriter.ts](src/replication/AtomicWriter.ts) /
[ReplLog.ts](src/replication/ReplLog.ts) /
[ReplPuller.ts](src/replication/ReplPuller.ts). Writes atomically populate
`pri:N:call:{ref}` and `propagate:{peer}` on the writer's sidecar via Lua;
peers consume via `/replog` long-poll with reconnects bounded by `max-open ≈
25 s`. **Durability gap (load-bearing):** when the writing worker dies, its
sidecar Redis dies with it. Anything in `propagate:{peer}` that hasn't been
pushed to the peer is lost forever — the peer's `replpos:{peer}` jumps past
the gap on the writer's restart with a fresh epoch, and those calls are never
hydrated to `bak:{primary}:`.

The headline 127 ≈ 20 cps × ~6 s of un-drained backlog. **We do not believe
the system actually had 6 s of replication lag at 20 cps total** — the
documented steady-state target is ~5 ms. Either steady-state lag was much
larger than the spec claims (H-Drain), or a `/replog` reconnect cycle
swallowed an interval (H-Reconnect). We will not guess: we will instrument and
re-run.

## Out of scope

- **Proxy active/standby with shared external IP.** Different failure mode
  (proxy-pod death, not worker death). Independent layer; no simplification
  benefit. Carve-out in `docs/plan/proxy-active-standby-vip.md` (separate
  plan).
- **Re-architecting durability** (synchronous fan-out write, quorum). The
  spec already calls out propagate-on-primary-death as an acknowledged loss
  class (§4.3, §11.4). We are working inside that boundary, not redesigning
  it.

## Slices (serial, single branch)

### Slice E — HealthProbe tighten *(first)*

Detection lag from up-to-6 s to up-to-2 s. Cuts the void-routing sub-component
of any future event-5-shaped failure.

- **[src/sip-front-proxy/health/HealthProbe.ts:124-127](src/sip-front-proxy/health/HealthProbe.ts):**
  `DEFAULT_INTERVAL_MS: 2000 → 1000`, `DEFAULT_THRESHOLD: 3 → 2`.
- **[tests/support/proxyB2bFakeStack.ts:375](tests/support/proxyB2bFakeStack.ts):**
  pin to `intervalMs: 2000, threshold: 3` to preserve existing HA fake-stack
  scenario timing assumptions.
- The three tests that already pass explicit values
  ([health-probe.test.ts:63](tests/sip-front-proxy/transparency/health-probe.test.ts),
  [health-probe-late-reply.test.ts:77](tests/sip-front-proxy/transparency/health-probe-late-reply.test.ts),
  [options-end-to-end.test.ts:83](tests/sip-front-proxy/integration/options-end-to-end.test.ts))
  are unaffected.
- Retry-reset semantic confirmed in
  [HealthProbe.ts:329-332](src/sip-front-proxy/health/HealthProbe.ts) — any
  successful response clears `consecutiveMisses`, so transient blips don't
  flap workers under the tighter threshold.

**Verify:** `npm run typecheck`; existing fake-clock health-probe tests pass;
`npm run test` clean.

### Slice A — Replication observability

Add four signals so future runs are interpretable. No behavioural change.

| Signal | Where | Shape |
|---|---|---|
| `replication.lag_seq{peer}` | reader (ReplPuller) | gauge — `head_seq − lastSeq`, sampled 200 ms, log+publish at 1 s (min/max/mean of the 5 samples) |
| `replication.queue_depth{peer}` | writer (AtomicWriter) | gauge — `ZCARD propagate:{peer}`, same cadence as `lag_seq` |
| `replication.connection_event{peer, kind, reason}` | both | structured one-shot log on open / close / `caught_up` / `hello`, with `sinceSeq` |
| `replication.frame_lag_ms` | reader | histogram — writer's wall-clock timestamp included in each frame, reader records receive-time delta on apply |

Emit to **both** structured logs (forensic readability for K8s reports) and
Prometheus (live ops, cross-pod aggregation). Histograms via the existing
[`Metrics.ts`](src/sip-front-proxy/observability/Metrics.ts) surface.

**Verify:** `npm run typecheck`; existing replication tests still green;
sanity-check on a fake-stack run that the four signals emit non-nonsense
values (`lag_seq` ≤ small under healthy steady state; `queue_depth` tracks
`lag_seq` ± 1; one `connection_event` per puller cycle; histogram populated).

### Slice B′ — Fake-clock diagnostic mini-test

A deterministic, seconds-fast regression that reproduces the event-5 shape in
the fake stack so we can see the durability gap with absolute timing control.
**Subagent-delegated:** the test code design is delegated when this slice is
implemented, so the planning context stays clean.

Scenario:

1. Create 20 Alice + 20 Bob legs in a loop; start 40 calls.
2. Tick fake clock until all 40 INVITE/200/ACK have completed and replication
   to `bak:{peer}:` should be drained (assert `lag_seq == 0` for both peers).
3. Kill worker A via fault-injection.
4. For each call whose primary was A, send BYE; assert all return 200 (zero
   481s on calls that were *established* before the kill — losses on calls
   mid-handshake are accepted).
5. Restart worker A; let ReadyGate drain `propagate:A` from peer B.
6. Send BYE on remaining A-primary calls (which now go to A again under cookie
   `w_pri=A` after the freshPodGuard window expires); assert all 200.

Distribution of primary across A/B is left to the natural Call-ID rendezvous
hash — we don't care which call lands where; we run enough calls (40) that
both workers hold a non-empty population, and the metrics let us attribute
post-hoc.

**Acceptance:** zero 481s on BYE for any call established before the kill.
Any 481 → real signal; investigate before merging.

**Verify:** the test itself is the verification. Lives under `tests/scenarios/`
with the rest of the fake-stack scenarios; consumed by the existing fake-clock
runner.

### Slice C — Replication-only K8s endurance run

Ground-truth Slice B′ at production-shaped traffic.

- Add `--proxy-chaos-disabled` flag in
  [tests/k8s/endurance/run-endurance.ts:107-160](tests/k8s/endurance/run-endurance.ts)
  that sets `weights: { "proxy-pod-graceful": 0, "proxy-pod-kill9": 0 }`
  through to
  [scheduler.ts:39-75](tests/k8s/endurance/scheduler.ts) (`buildSchedule`
  already accepts `weights`).
- Reuse existing endurance scenarios; metrics from Slice A are captured
  automatically via pod-log scraping.
- One run: full duration with worker-only chaos. Compare per-event 481 counts
  to the asymmetric event-5/event-7 baseline.

**Acceptance:** ≤ ~50 BYE 481s during a worker `node-shutdown-app` event
(~10× reduction from 127). **And** the new metrics are populated and
interpretable across the run.

### Slice D — Decide & fix (contingent on Slice C results)

Mode-of-failure-driven choice; cannot be designed ahead. Sketch:

- If `lag_seq` p99 stayed small but `queue_depth` spiked at the moment of
  crash: **H-Drain on the apply path** — investigate ReplPuller batching /
  apply-pipeline parallelism.
- If `connection_event` shows a torn `/replog` connection in the seconds
  before the kill: **H-Reconnect** — bound the gap by streaming since=hello,
  not since=lastSeq, on the new connection (or shorten max-open and re-prove
  the regression).
- If both metrics are clean and small but the loss still happens: **structural
  floor** — document the residual loss class, sized to the measured floor,
  and stop chasing it through this lens.

### Fake-clock fallback (contingent)

Only if Slices B′ and C together don't produce an interpretable picture:
delegate further fake-clock investigation (e.g. fault-injection on individual
ReplPuller frames, microbenchmarks of the Lua-write path) to a subagent so the
planning context stays clean. Not gated on this work; only triggered by the
diagnostic.

## Asymmetry between event 5 and event 7 (open question, not gating)

Documented hypothesis: the worker-0 → worker-1 replication direction was
worse-loaded or had a torn connection at the moment of the event-5 kill,
while the symmetric direction was fine. Slice C will surface this directly
via the new metrics across both directions; we don't need to investigate it
further before then.

## Verification end-to-end

1. Run `npm run typecheck` after each slice — zero errors, zero warnings
   (Effect language-service plugin must also be clean per
   [CLAUDE.md](CLAUDE.md)).
2. Run `npm run test` after Slices E and A.
3. Slice B′'s fake-clock test runs as part of `npm run test:fake`.
4. Slice C runs once: `npm run test:k8s:endurance -- --proxy-chaos-disabled
   --duration 30m` (or whatever the harness's flag wiring requires).
5. Compare per-event 481 counts to the event-5 baseline (127 BYE 481s) and
   to the asymmetric event-7 baseline (0). Acceptance threshold ≤ ~50 per
   worker `node-shutdown-app` event.

## Slice B′ findings (2026-05-07) — surprise discovery

The fake-clock diagnostic test landed at [tests/sip-front-proxy/failover/replication-gap-mini.test.ts](tests/sip-front-proxy/failover/replication-gap-mini.test.ts) as `it.effect.fails` (expected-fail) and reproduced a **different** failure mode than event 5:

- **Phase 2 (post-establish settle, pre-kill):** `expectLagSeqZero` PASSES for both peer directions. Replication is steady-state caught up.
- **Phase 5 (BYE during outage on b2b-1):** zero 481s. Backup-takeover serving works correctly under fake-clock timing for in-outage BYEs.
- **Phase 6 (post-respawn settle):** `expectLagSeqZero` PASSES. Replication has nothing pending to drain.
- **Phase 7 (BYE on calls primary=b2b-1, post-respawn):** **20/20 fail with 481.**

### Diagnosed mechanism — "post-respawn pri-partition rebuild gap"

When worker A is killed and respawned without any of A's calls being touched on B's `bak:A:` partition during the outage:
1. Calls sit untouched in `bak:A:` on B (no rule re-eval, no state change → no backup write).
2. Because nothing changed, B never wrote a reverse-direction entry to `propagate:A`.
3. On A's respawn, ReadyGate drains `propagate:A` from B — finds nothing for those quiet calls.
4. A's `pri:A:` stays empty.
5. Post fresh-pod-guard, BYE arrives at proxy → cookie says `w_pri=A` → A is alive → forwarded to A → A's `checkout` returns undefined → 481.

**This is structurally distinct from event 5.** Event 5's 481s happened DURING the outage (worker-0 still down), and the failure was the backup not having `bak:0:` for those calls. Slice B' phase 5 — the same shape — passed cleanly under fake-clock. The fake stack does not reproduce the event-5 mechanism.

### Implications for the plan

- Event 5's mechanism is **not** reproducible under fake-clock — depends on real network / real Redis / real timing properties not modelled in the fake stack. Slice C is now the only path to ground-truth event 5.
- Slice B′ found a **separate, real bug**: post-respawn rebuild leaves a 100% miss rate for quiet calls. This is a different failure mode and deserves its own treatment in Slice D (or a precursor).
- Neither H-Drain nor H-Reconnect (the original hypotheses) was confirmed by B′. Slice C will surface evidence for/against them at production-shaped traffic.

### Files touched in B′

- New: [tests/sip-front-proxy/failover/replication-gap-mini.test.ts](tests/sip-front-proxy/failover/replication-gap-mini.test.ts).
- Modified (test-harness only — no production-code changes): `src/test-harness/framework/{types,recorder,interpreter}.ts`, `tests/scenarios/basic-call.ts` (added split-form `establishCallBody` / `byeCallBody` / `EstablishedCall` plus `allowExtra("OPTIONS")` for keepalive tolerance).

### Note on assertion mechanics

`expectLagSeqZero` was wired against `PeerFabricControl.snapshotPeer` directly (reads `replpos:*` and `propagate_seq:*`) rather than via the new `ReplMetrics` snapshot, because the fake-stack `k8sFakeStack` layer constructs `ReplPuller.makeMemoryUnsafe` without a metrics handle. Future work could thread `ReplMetrics` through that layer to unify the two assertion paths; not gating Slice C.

## Decisions (locked)

- **D1.** Headline failure: 127 calls × in-dialog BYE 481 in event 5; 0 in event 7.
- **D2.** Root cause: replication durability gap, not load-balancer routing.
- **D3.** Detection-window tightening (Slice E) is cheap polish, not the main fix.
- **D4.** Don't trust 6 s steady-state lag on its face; instrument and measure.
- **D5.** Keep 481 on backup miss; harden the test surface with realistic call shapes (deferred).
- **D6.** Proxy active/standby HA is a separate plan.
- **D7.** Slice E uses option (ii): code defaults flipped, fake-stack fixture pinned.
- **D8.** Instrument to both structured logs and Prometheus; gauge sample 200 ms / log+publish 1 s.
- **D9.** Slice B′ is fake-clock with explicit Alice/Bob loop, not K8s. Subagent-delegated implementation.
- **D10.** Strict acceptance for B′: zero 481s on established calls.
- **D11.** Serial slice execution, single branch.
