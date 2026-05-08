# Health-probe recovery + replication resync — investigation & TODO

## Status: PROPOSAL — awaiting user direction

## Context

1 h endurance run [`endurance-1h-vip-chaos-20260508`](../../test-results/k8s-endurance/endurance-1h-vip-chaos-20260508/) hit two anomalies that the new VIP HA architecture must absorb but currently does not:

1. **Both workers flipped `probe-side=dead` simultaneously at 17:25:39** with no chaos in flight. Coincides with the first orphan-sweep tick on the workers (15-min mark; calls aged 902 s).
2. **They never flipped back to `alive` for ~35 min** (until chaos[3]'s node restart at 18:00:34). The probe loop is supposed to keep sending OPTIONS to dead workers and reclassify on the first 200, but did not in practice.

Plus a structural issue exposed on the queue-depth chart: `propagate:{peer}` cardinality grows steadily from t=0 and never drains. Pull-side `lag_seq` stays at 0, so the consumer is keeping up — the producer-side propagate set just isn't being trimmed. Different root cause from #1/#2 but on the same critical path (replication health gates routing decisions).

## Decisions taken

- **Keep OPTIONS-only as the probe primitive.** Don't add TCP /ready or "any inbound SIP traffic" as a recovery signal — focus on why OPTIONS-only doesn't recover.
- **No exponential backoff anywhere.** Cluster traffic is local and cheap; tight reconnects are fine.
- **Probe must remain self-healing.** A worker reaching the `dead` state must come back to `alive` on the first 200 OK without any external intervention.
- **Replication must not gate workers out of rotation.** A stuck replication stream MUST NOT take a healthy worker out of routing.
- **WARN-level OPTIONS logging** so the proxy log shows exactly what happens at each tick, not just the routing-side consequence.

## Acceptance test for the fix

A repeat of this 1 h chaos run, post-fix, produces:
- Zero "no alive workers" warnings outside of explicit chaos windows (probe self-recovers from any spurious flip).
- Every health transition appears in logs at WARN with `from`, `to`, `source`, `reason`.
- `propagate:{peer}` cardinality stays bounded across the run (peaks during chaos, drains in steady state).
- Verdict: PASS or near-PASS, with STEADY failure rate ≤ 1 % (vs 25 % in this run).

---

# TODO list — critical → nice-to-have

Each item carries: **[priority] [area] description — implementation note**, plus a checkbox for tracking. Priorities:

- **P0** — must land before the next 1 h chaos rerun. Fixes the "stuck dead" recovery path and instrumenting it. Without these we cannot meaningfully diagnose the next failure.
- **P1** — must land before declaring VIP HA production-ready.
- **P2** — strong follow-up.
- **P3** — nice-to-have / hygiene.

## P0 — instrument before fixing

Without these, every subsequent rerun is blind. Land first.

- [ ] **[P0] [logging] Log every resolved health transition at WARN.** Wrap `WorkerRegistryControl.setHealth` (kubernetes adapter) so every call that actually changes the resolved health emits `WARN HealthChange worker=<id> from=<X> to=<Y> source=<probe|k8s> reason=<...>`. Same in the simulated adapter for parity. — [src/sip-front-proxy/registry/kubernetes.ts:619-624](../../src/sip-front-proxy/registry/kubernetes.ts#L619-L624) + [src/sip-front-proxy/health/HealthProbe.ts:464-471](../../src/sip-front-proxy/health/HealthProbe.ts#L464-L471).
- [ ] **[P0] [logging] OPTIONS round-trip log at WARN per send.** In `fanOutOptions` log `WARN probe-send worker=<id> addr=<host:port> callId=<...>` on every send. In the inbound handler log `WARN probe-recv worker=<id> status=<N> reasonHeader=<...>` on every reply. Volume is N workers × 1 Hz, fine for a 2-replica STS.
- [ ] **[P0] [logging] Miss-counter at WARN when threshold hit.** `WARN probe-miss worker=<id> consecutive=N/threshold callIdsPending=<count>`. Today only DEBUG. Promote to WARN at every increment past 1, and INFO when reset.
- [ ] **[P0] [logging] Fiber-supervision log.** Log `INFO probe-fiber-start name=tickLoop` and `name=inboundDrain` when each fiber forks, and `WARN probe-fiber-exit name=<X> cause=<...>` on any termination (success or failure). Apply to ReplPuller's per-peer pull loop too.
- [ ] **[P0] [verification] Confirm tickLoop and inboundDrain stay alive across the 1 h run.** Once the supervision logs land, rerun the smoke and grep for `probe-fiber-exit`. If either fires, that IS the root cause of "never recovers". Both fibers are forked with `Effect.forkScoped` ([HealthProbe.ts:373-374](../../src/sip-front-proxy/health/HealthProbe.ts#L373-L374)) — they should outlive the run, but we have no proof today.
- [ ] **[P0] [verification] Confirm whether OPTIONS replies arrive but are ignored.** With probe-recv WARN log in place, the next failure tells us whether: (a) the probe stops sending, (b) sends but no replies arrive, (c) replies arrive but Call-ID matching fails. Each branch has a different fix.

## P1 — recovery path correctness

- [ ] **[P1] [probe] Auto-restart tickLoop and inboundDrain on any termination.** Today `Effect.forever` swallows a non-interrupted defect by re-iterating, but `inboundDrain` is `Stream.runForEach` — if the underlying `endpoint.messages` stream errors out, the fiber exits and is never rebuilt. Wrap each in a supervisor that logs the cause, re-binds the UDP socket if needed, and restarts. Acceptance: kill `endpoint` mid-test, observe restart log + recovery within 1 probe interval.
- [ ] **[P1] [probe] Verify socket re-bind on send error.** `endpoint.send` is wrapped in `Effect.catchCause` → log warning ([HealthProbe.ts:230-234](../../src/sip-front-proxy/health/HealthProbe.ts#L230-L234)) but the loop keeps using the same endpoint. If the socket entered an error state (rare with UDP, but EBADF post-fork is possible), every send silently fails forever. Detection: count consecutive send failures across all workers; if > N, force a re-bind.
- [ ] **[P1] [probe] Add a "probe still dead" heartbeat log.** While any worker is `dead`, every `intervalMs` log `WARN probe-still-dead worker=<id> since=<ts> sentSince=<count> repliesSince=0`. This makes "never recovers" visible without staring at the message dump.
- [ ] **[P1] [verification] Add unit test for `dead → alive` transition under the keepalive layer.** Exists implicitly via integration tests, but no targeted test in [tests/sip-front-proxy/](../../tests/sip-front-proxy/) that simulates "miss N times → dead → next 200 → alive" with TestClock. Asserts the recovery path is hot.
- [ ] **[P1] [verification] Add unit test for "inboundDrain stream error → fiber restart".** Inject a stream failure, assert the supervisor relogs and rebinds.
- [ ] **[P1] [verification] Reproduce the 17:25:39 cliff in fake-clock.** Possible mechanism: the worker's orphan sweep at the 15-min mark blocks SIP processing long enough for the probe to time out 2 in a row. Add a fake-clock scenario that triggers the orphan sweep mid-run and asserts the proxy never declares both workers dead simultaneously, OR that after a transient dead it recovers within 2 s.

## P1 — replication resync robustness

These are independent of the probe issue but on the same critical path.

- [ ] **[P1] [replication] Find why `propagate:{peer}` cardinality grows monotonically.** [ReplLog.ts](../../src/replication/ReplLog.ts) and [PropagateStream.ts](../../src/replication/PropagateStream.ts) reference "the periodic GC that prunes stale (call-key-gone) entries" but no ZREM-on-consume happens. Either the GC is not running, or its cadence is too slow, or it requires the original call-key TTL to expire first (10 min). Acceptance: confirm exact trim mechanism, add metric `b2bua_repl_propagate_trimmed_total{peer}` so cardinality movement is observable.
- [ ] **[P1] [replication] Pull-loop "stuck stream" detection.** Track `tLastApplied` per peer. If `now - tLastApplied > 2× max-open` (default ~50 s) AND there are entries in the peer's `propagate:{self}:`, log `WARN pull-stuck` and force a fresh connect (not a full resync — just a new HTTP request). [src/main.ts:425-465](../../src/main.ts#L425-L465).
- [ ] **[P1] [replication] Replace 35 s force-timeout with 60 s + driven by server max-open close.** Today every cycle ends via the client-side `Effect.timeout("35 seconds")` ceiling, never via the server's natural 25 s max-open. The force-cut interrupts the streamed response mid-frame, which probably correlates with whatever ZREM-on-deliver path exists not running. Refer [docs/plan/replication-pull-fork-on-peer-discovery.md "Secondary signal"](replication-pull-fork-on-peer-discovery.md).
- [ ] **[P1] [replication] Replication stall MUST NOT take the worker out of rotation.** Currently `WorkerReadiness.markReady(false)` is only flipped by `ReclaimRunner` post-respawn ([ReclaimRunner.ts:340](../../src/cache/ReclaimRunner.ts#L340)) and `ReadyGate` boot-time ([ReadyGate.ts:341](../../src/replication/ReadyGate.ts#L341)) — neither reacts to steady-state replication stall. Code-walk to confirm no future PR introduces such a coupling, and add an explicit comment / invariant test that asserts a stuck pull loop does NOT call `markReady(false)`.
- [ ] **[P1] [replication] Pull-loop full-resync trigger.** Add a `since=0` resync path triggered by: (i) `framesApplied=0 for > N×max-open`, OR (ii) on-demand admin endpoint. Today full resync only fires on epoch change (peer restart). A peer that bounces traffic but never restarts has no resync path.
- [ ] **[P1] [replication] Verify peer-rediscovery loop reacts to k8s endpoint changes.** `PullLoopSupervisor` polls `currentPeers` every 2 s ([PullLoopSupervisor.ts:62-91](../../src/replication/PullLoopSupervisor.ts#L62-L91)) and forks on new peers, never cancels existing fibers. After a peer pod-IP rotation, the existing fiber dials a stale IP forever. Acceptance: when the K8s registry emits `address_changed`, the corresponding pull loop tears down and reforks against the new IP within `watchIntervalMs`.

## P2 — state-machine documentation & hygiene

- [ ] **[P2] [docs] Exhaustive event/transition table in [docs/lb-proxy-ha.md](../lb-proxy-ha.md).** For each side (probe, k8s, composed) and for each event (`200`, `503-not-ready`, `503-draining`, `4xx`, `5xx`, `timeout x N`, `ADDED Ready`, `ADDED !Ready`, `MODIFIED Ready→!Ready`, `MODIFIED !Ready→Ready`, `MODIFIED deletionTimestamp set`, `MODIFIED creationTimestamp advanced`, `DELETED`): tabulate `prev → next` per side and the composed result via `mostRestrictiveHealth`. Today the rules are split across two source files. Cross-link from each source file's header comment.
- [ ] **[P2] [docs] Document the OPTIONS-and-/ready agreement contract** explicitly in [lb-proxy-ha.md](../lb-proxy-ha.md), citing [SipRouter.ts:457-475](../../src/sip/SipRouter.ts#L457-L475). Anyone touching either path has to keep them aligned.
- [ ] **[P2] [docs] Document "what flips `WorkerReadiness.markReady`"** so future contributors don't accidentally couple replication stalls to readiness. Single-pager listing the three callers (`ReadyGate`, `ReclaimRunner`, terminal `markReady(true)` in main.ts).
- [ ] **[P2] [logging] `health_changed` PubSub event subscriber for structured ndjson output.** A separate fiber that consumes the registry's `changes` stream and writes one structured line per event into a dedicated log target (or just the standard logger with `tag=health-changed`). Useful for offline analysis and for the endurance analyzer.
- [ ] **[P2] [verification] Snapshot the probe state in `/debug` endpoint on the proxy.** GET `/debug/probe` returns per-worker `{health, k8sHealth, probeHealth, consecutiveMisses, lastReplyAt, lastSendAt, pendingCallIds: count}`. One small route in [StatusServer.ts](../../src/http/StatusServer.ts) (proxy-side equivalent — currently this server is worker-side only). Lets an operator diff against the chaos timeline post-mortem without grepping logs.
- [ ] **[P2] [test] Add a fake-clock test that asserts the replication queue drains during steady-state.** Exists implicitly via the chaos test, but no isolated test pins it. Catches future regressions where ZREM-on-consume gets dropped.

## P3 — nice-to-have

- [ ] **[P3] [probe] Promote send/recv WARN logs back to INFO** once we are confident of the recovery path. WARN is for the diagnostic phase only; long-term volume at 1 Hz × N workers is unnecessary noise.
- [ ] **[P3] [metrics] `b2bua_probe_consecutive_misses{worker}` gauge** + `_total` counter for misses crossed-the-threshold. Already partially covered by `sip_worker_health` gauge but the miss count itself is invisible to Prometheus today.
- [ ] **[P3] [metrics] `b2bua_probe_last_reply_age_seconds{worker}` gauge** so an alerting rule can fire on "no probe reply in N s" without touching logs.
- [ ] **[P3] [chore] Reduce volume of `worker-outbound classification miss` warnings.** Every limiter ACK fires one ([ProxyCore.ts](../../src/sip-front-proxy/ProxyCore.ts)). Cosmetic since the cookie path works, but it makes real warnings hard to spot. Either rate-limit the warning or downgrade to debug once the fallback is well-exercised.
- [ ] **[P3] [chore] Endurance-renderer badge for fiber exits.** Once `probe-fiber-exit` lands, surface counts in `report.md` as a top-line health indicator alongside the chaos counts.

---

## Tracking matrix

| ID | P | Area | Title | Owner | Status | Linked PR / Commit |
|---:|---|---|---|---|---|---|
| 1 | P0 | logging | Health-transition WARN | TBD | TODO | — |
| 2 | P0 | logging | OPTIONS send/recv WARN | TBD | TODO | — |
| 3 | P0 | logging | Miss-counter WARN | TBD | TODO | — |
| 4 | P0 | logging | Fiber-supervision WARN | TBD | TODO | — |
| 5 | P0 | verification | Confirm fibers stay alive | TBD | BLOCKED on 4 | — |
| 6 | P0 | verification | Confirm replies arrive vs ignored | TBD | BLOCKED on 2 | — |
| 7 | P1 | probe | Auto-restart tickLoop + inboundDrain | TBD | TODO | — |
| 8 | P1 | probe | Verify socket re-bind on send error | TBD | TODO | — |
| 9 | P1 | probe | "Probe still dead" heartbeat | TBD | TODO | — |
| 10 | P1 | verification | Unit test dead → alive | TBD | TODO | — |
| 11 | P1 | verification | Unit test inboundDrain restart | TBD | TODO | — |
| 12 | P1 | verification | Reproduce 17:25:39 cliff in fake-clock | TBD | TODO | — |
| 13 | P1 | replication | Why propagate set never trims | TBD | TODO | — |
| 14 | P1 | replication | Pull-loop stuck-stream detection | TBD | TODO | — |
| 15 | P1 | replication | Replace 35s force-timeout | TBD | TODO | — |
| 16 | P1 | replication | Stall must not take worker out | TBD | TODO | — |
| 17 | P1 | replication | Full-resync trigger (since=0) | TBD | TODO | — |
| 18 | P1 | replication | Peer-rediscovery on address change | TBD | TODO | — |
| 19 | P2 | docs | Exhaustive event/transition table | TBD | TODO | — |
| 20 | P2 | docs | OPTIONS-and-/ready agreement | TBD | TODO | — |
| 21 | P2 | docs | What flips markReady | TBD | TODO | — |
| 22 | P2 | logging | health_changed structured ndjson | TBD | TODO | — |
| 23 | P2 | verification | /debug/probe endpoint | TBD | TODO | — |
| 24 | P2 | test | Replication-queue-drains test | TBD | TODO | — |
| 25 | P3 | probe | Demote logs back to INFO post-fix | TBD | TODO | — |
| 26 | P3 | metrics | consecutive_misses gauge + counter | TBD | TODO | — |
| 27 | P3 | metrics | last_reply_age_seconds gauge | TBD | TODO | — |
| 28 | P3 | chore | Reduce classification-miss WARN | TBD | TODO | — |
| 29 | P3 | chore | Renderer badge for fiber exits | TBD | TODO | — |

## Suggested implementation order

Land in three slices, each independently runnable through a 1 h chaos test:

**Slice 1 (instrument-only, low-risk).** Items 1–4. Re-run 1 h chaos. Read the logs. Items 5 and 6 fall out of the run — they tell us which specific failure mode #1 and #2 we are looking at.

**Slice 2 (recovery hardening).** Items 7–12, plus 13 (read-only investigation) in parallel. Re-run 1 h chaos. Acceptance: zero spurious "no alive workers" warnings.

**Slice 3 (replication resync + docs).** Items 14–24. Re-run 24 h chaos with seed reproducibility. Acceptance: PASS verdict.

P3 items can be folded in opportunistically.
