# Replication redesign + probe instrumentation

## Context

The 1 h endurance run [`endurance-1h-vip-chaos-20260508`](../../test-results/k8s-endurance/endurance-1h-vip-chaos-20260508/) exposed two failure modes that the current architecture cannot absorb:

1. **Proxy-stuck dead-state.** Both workers flipped `probe-side=dead` simultaneously at 17:25:39 with no chaos in flight; the proxy never reclassified them as alive for ~35 minutes despite worker recreations during chaos[1] (17:38) and chaos[2] (17:50). Worker logs around the cliff show `/ready` was answering 200 OK three seconds before the cliff; transaction timeouts begin 4 s *after* the cliff; the orphan sweep fires 8 s *after* the cliff (so the original plan's "orphan sweep blocks SIP" hypothesis is timing-incompatible). Whatever caused the cliff also overran the replog connection (32 s span past a 25 s server max-open). The proxy-side state must be instrumented before any further fix attempt.

2. **Replication state grows without bound.** `propagate:{peer}` is built with `ZADD` only — no `ZREM`-on-deliver, no per-entry trim, only a sliding 1 h TTL on the whole set that gets refreshed by every write under load. User reports the failure correlates with the propagate set reaching ~20 K on **both** workers simultaneously, pointing at sidecar memory / scan pressure as the root mechanism. The current architecture violates the hard invariant **"a backup unreachable for arbitrary duration imposes zero growing cost on its primary"** and is not patchable in place — it requires a clean-sheet redesign starting from explicit goals.

Two independent tracks land in this plan, in order:

- **Track A** (small, immediate): probe-side WARN logging so the next chaos rerun produces enough data to disambiguate the cliff between (a) probe stops sending, (b) sends but no replies, (c) replies arrive but are ignored. No behavior changes.
- **Track B** (design-first): replication architecture rewrite. The deliverable of Track B's first step is a design document; no implementation primitives are picked until the goals + invariants are signed off. The current `propagate:` ZSET, `ReplLog`, `ReplPuller`, `ReadyGate`, and `ReclaimRunner` are all in scope for replacement.

The original plan [`health-probe-recovery-and-replication-resync-todo.md`](health-probe-recovery-and-replication-resync-todo.md) is superseded. Its P0 items 1-4 are folded into Track A; its P1 replication items #13-18 are dropped (all patch the dying implementation that Track B replaces); its P1 probe items #7-12 are deferred to Track A.A3 (data-driven hardening after A2's chaos rerun reveals what to harden).

---

## Track A — probe instrumentation

### A1. Land WARN logs — no behavior changes

Files:

- [src/sip-front-proxy/health/HealthProbe.ts](../../src/sip-front-proxy/health/HealthProbe.ts) — `fanOutOptions` (line 199) and `inboundDrain` (line 281) get `WARN probe-send` and `WARN probe-recv` per packet; `reapTimeouts` (line 241) promotes the `Effect.logDebug` at line 267 to `WARN probe-miss` on every increment past 1, plus `INFO probe-miss-reset` when the counter resets to 0; `tickLoop` (line 359) and `inboundDrain` (line 281) get `INFO probe-fiber-start` at fork (line 373-374) and `WARN probe-fiber-exit` if either terminates (success OR cause).
- [src/sip-front-proxy/registry/kubernetes.ts](../../src/sip-front-proxy/registry/kubernetes.ts) — wrap the per-id `setHealth` (line 580) so every call that actually changes resolved health (line 596 onward) emits `WARN HealthChange worker=<id> from=<X> to=<Y> source=<probe|k8s> reason=<...>`. Mirror in the simulated registry adapter (search `setHealth` in [src/sip-front-proxy/registry/](../../src/sip-front-proxy/registry/)) for fake-stack parity.
- [src/main.ts](../../src/main.ts) — wrap the per-peer pull loop forked at [line 471-479](../../src/main.ts#L471-L479) with `INFO repl-fiber-start name=pull-loop peer=<P>` and `WARN repl-fiber-exit name=pull-loop peer=<P> cause=<...>` on any termination.

Volume sanity: 1 Hz × 2 workers × (send + recv) = 4 WARN/s. Demote to INFO post-fix in a follow-up (original P3 #25).

### A2. Rerun the 1 h chaos with seed `1778260136090`

Acceptance: the log stream around the next cliff (or a clean run) tells us which of these is the failure mode:

- `probe-fiber-exit` fires for `tickLoop` or `inboundDrain` → fiber died, we know the cause from the log; A3 hardening = supervisor-restart.
- `probe-send` keeps firing but `probe-recv` does not → packets arrive nowhere; A3 = socket re-bind on persistent send failure.
- `probe-recv` fires but `HealthChange` does not flip dead→alive → `setHealth` resolution bug; A3 = fix the resolution path.
- `HealthChange` flips correctly but `[ProxyCore] no alive workers` persists → routing-side state divergence; A3 = LoadBalancer cache invalidation.

### A3. Recovery hardening — gated on A2 evidence

Choose the specific item(s) from the original plan's P1 #7-9 (auto-restart, socket re-bind, "still dead" heartbeat) plus #10-12 (unit + fake-clock tests) **based on what A2 reveals**, not in advance. This is intentional: the original plan paid the cost of writing all three before knowing which was the actual failure mode.

---

## Track B — replication redesign (design-first)

### B0. Write the design document

Deliverable: [`docs/replication/redesign-call-cache-backup.md`](../replication/redesign-call-cache-backup.md) (NEW). The current [docs/replication/call-cache-backup.md](../replication/call-cache-backup.md) is preserved untouched until B2 cuts over.

The design document MUST list, in order, the following sections. **No implementation primitives are chosen in this plan file** — they are decided inside the design doc and signed off before B1 starts.

#### B0.1 Goals

- **G1.** Per-worker storage holds: (a) calls the worker is primary for, (b) calls the worker is backup-of-record for, (c) per-call monotonic index tracking local edits in each role.
- **G2.** On restart, a worker pulls from every peer:
  - data the peer holds **regardless of whether the peer changed it** on calls where this worker is primary (so a quick reboot leaves the worker able to process subsequent in-dialog messages as if no event had happened);
  - data the peer is primary on, where this worker should be backup;

  efficient, pull-based, with proper watermark tracking and idempotent apply.
- **G3.** Sub-second steady-state propagation under healthy peers.
- **G4.** A backup that has fallen behind beyond the in-memory steady-state window can resync via SCAN of the source partition (correctness over speed).
- **G5.** Zero data loss when a backup is temporarily unreachable but the primary stays up — primary's authoritative state is never compromised by backup absence.
- **G6.** Observable: every replication path exposes lag, queue-depth-or-equivalent, and last-applied-gen as Prometheus metrics.

#### B0.2 Non-goals

- **NG1.** Distributed consensus, strong cross-pod consistency, cross-DC replication.
- **NG2.** Recovery of state lost when both primary AND backup go down within the same call-TTL window (existing accepted small-loss class).
- **NG3.** Strict ordering across calls. Per-call ordering is sufficient.

#### B0.3 Hard invariants

- **INV1 (HARD).** A backup unreachable for arbitrary duration imposes **zero growing cost** on its primary — no unbounded buffers, no growing scan time, no memory pressure on the primary's sidecar.
- **INV2.** Single-owner: a backup never promotes; the primary at INVITE time owns its calls' authoritative state for life. (See memory `project_call_partition_invariant`.)
- **INV3.** Idempotent apply: re-delivering an entry whose `gen ≤ local-gen` is a no-op.
- **INV4.** Boot recovery completes within **30 s P99** wall-clock from pod start to `WorkerReadiness.markReady(true)`, including SCAN-based bootstrap of `bak:{self}:` from every alive peer.

#### B0.4 Architecture sections the design doc must answer

For each, the doc enumerates options, picks one, and documents the rejected alternatives:

- **Storage layout** per worker. How are primary calls, backup calls, and per-call gen tracked. Do change-tracking primitives live alongside call bodies or in a dedicated structure.
- **Steady-state propagation primitive.** Bounded by construction (INV1). Trade-offs: latency, throughput, memory ceiling, behaviour when backup falls behind.
- **Watermark tracking.** Where each puller stores its last-applied-gen per (peer, partition); how it survives puller restart; how it recovers from corruption.
- **Boot recovery path.** SCAN-based bootstrap that satisfies G2 (changed-or-not) AND fits inside INV4 (30 s P99). Pacing strategy. Order of peers. Concurrency.
- **Steady-state catch-up vs SCAN fallback.** When does a puller decide it has fallen behind the steady-state window and must SCAN. What does the watermark look like during the SCAN.
- **Failure handling matrix.** Peer disappears mid-stream; peer never returns; primary's own restart while backup unreachable; backup's own restart while primary unreachable; both restart simultaneously.
- **Observability hooks.** Metric taxonomy with names + label sets, satisfying G6. Log levels and structure.
- **Test taxonomy.** Mapping each invariant + goal to a fake-clock or live test that proves it. Including:
  - INV1 test: backup pod down for ≥ 1 h, observe primary sidecar memory bounded across the window.
  - INV4 test: pod restart under maximal call-set, time from pod-start to ready ≤ 30 s P99.
  - G2 test: primary briefly down (< 30 s), then restart, mid-call traffic continues without 481.
  - G5 test: backup down 5 min, primary keeps processing calls; on backup return, backup catches up without primary trace.
  - G3 test: under steady traffic, replication lag stays ≤ 1 s.

#### B0.5 Sign-off gate

The design doc is reviewed and signed off before any code in B1 is written. The sign-off explicitly confirms each goal, non-goal, and invariant is addressed; and that each test in B0.4's test taxonomy has a clear shape.

### B1. Implement per the design

Scope and breakdown deferred to the design doc. Expected to be a multi-slice commit chain mirroring the original `data-replication slice 1..7` rhythm.

### B2. Cutover and legacy removal

After B1 is green:

- Delete the `ZADD propagate:{peer}` paths in [src/replication/AtomicWriter.ts](../../src/replication/AtomicWriter.ts).
- Delete [src/replication/PropagateStream.ts](../../src/replication/PropagateStream.ts), [src/replication/ReplLog.ts](../../src/replication/ReplLog.ts), [src/replication/ReplPuller.ts](../../src/replication/ReplPuller.ts) (or rewrite per design — to be determined in B0).
- Replace [src/replication/ReadyGate.ts](../../src/replication/ReadyGate.ts) and [src/cache/ReclaimRunner.ts](../../src/cache/ReclaimRunner.ts) per the design's boot-recovery path.
- Update [docs/replication/call-cache-backup.md](../replication/call-cache-backup.md) to point at the new design or merge into it.

---

## Items dropped from the previous plan

- Original P1 replication #13-18 (propagate trim, pull-stuck detection, 35s timeout, full-resync trigger, peer-rediscovery, "stall must not take worker out of rotation") — superseded by Track B. The peer-rediscovery item is restated as a constraint inside B0.4's failure-handling matrix.
- Original P0 #5, #6 (verification items "confirm fibers stay alive" / "confirm replies arrive vs ignored") — these become the **outcome** of A2, not items to land.

## Items deferred from the previous plan

- Original P1 probe #7-12 — handled by Track A.A3, gated on A2 evidence.
- Original P2 #19-24 (docs + ndjson event log + /debug/probe + replication-queue-drain test) — re-evaluate after Track B B0 sign-off; some become obsolete with the redesign, some remain useful.
- Original P3 #25-29 — re-evaluate after Tracks A and B land.

---

## Verification

- **Track A.A2:** rerun the 1 h chaos with seed `1778260136090` after A1 lands. Read the log stream. The classification of failure mode (fiber-exit / send-no-recv / recv-no-flip / flip-no-route) is the verification — A3's specific work item is chosen from the result.
- **Track B.B0:** the design doc is the deliverable; sign-off is by user review.
- **Track B.B1+B2:** verification details deferred to the design doc's test taxonomy section (B0.4).

## Critical files

**Track A:**

- [src/sip-front-proxy/health/HealthProbe.ts](../../src/sip-front-proxy/health/HealthProbe.ts) — probe send/recv WARN, miss WARN, fiber-supervision WARN.
- [src/sip-front-proxy/registry/kubernetes.ts](../../src/sip-front-proxy/registry/kubernetes.ts) — `HealthChange` WARN around resolved-health flips.
- [src/main.ts](../../src/main.ts) — pull-loop fiber-supervision WARN (lines 471-479).
- Mirror logging in any simulated `WorkerRegistryControl` adapter under [src/sip-front-proxy/registry/](../../src/sip-front-proxy/registry/) so fake-stack tests retain parity.

**Track B (in scope; specifics decided inside B0):**

- [`docs/replication/redesign-call-cache-backup.md`](../replication/redesign-call-cache-backup.md) (NEW — written in B0).
- [src/replication/AtomicWriter.ts](../../src/replication/AtomicWriter.ts), [src/replication/PropagateStream.ts](../../src/replication/PropagateStream.ts), [src/replication/ReplLog.ts](../../src/replication/ReplLog.ts), [src/replication/ReplPuller.ts](../../src/replication/ReplPuller.ts), [src/replication/ReadyGate.ts](../../src/replication/ReadyGate.ts), [src/cache/ReclaimRunner.ts](../../src/cache/ReclaimRunner.ts).
- [src/main.ts](../../src/main.ts) `runReplicationConsumer` (lines 343-394).
- [src/cache/PartitionRef.ts](../../src/cache/PartitionRef.ts) (PropagateDirection model — may survive or be replaced).

## Reusable code already in tree

- The fake-stack test harness pattern in [tests/support/k8sFakeStack.ts](../../tests/support/k8sFakeStack.ts) and [tests/scenarios/](../../tests/scenarios/) — Track B's test taxonomy should reuse it.
- `parseCallRef` / `partitionOf` / `roleOf` / `replicaPeerOf` in [src/cache/PartitionRef.ts](../../src/cache/PartitionRef.ts) — the (wPri, wBak, self) derivation is independent of the streaming primitive and survives the redesign.
- The `WorkerReadiness` markReady contract in [src/cache/WorkerReadiness.ts](../../src/cache/WorkerReadiness.ts) — Track B keeps the existing `false-during-recovery → true-once-at-end` shape.

## Note on the "why is replication growing" question

The growth mechanism is identified: `ZADD propagate:{peer}` with no compensating `ZREM`, sliding TTL refreshed by every write. Whether or not this growth is the **proximate** trigger of the 17:25:39 cliff is something Track A.A2's logging may help answer; either way, the redesign eliminates the growth by construction (mandated by INV1). No further investigation of the existing growth path is needed.
