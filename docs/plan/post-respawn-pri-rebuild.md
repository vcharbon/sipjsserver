# Wire ReclaimRunner into worker boot — fix post-respawn pri-partition rebuild gap

## Status: PROPOSAL — awaiting user direction on design choice

## Context

Slice B′ (the fake-clock diagnostic in
[docs/plan/what-s-actually-failing-during-indexed-origami.md](what-s-actually-failing-during-indexed-origami.md))
surfaced a real, reproducible failure mode that is **distinct from event 5**:

> Worker A killed → quiet calls (primary=A) sit in `bak:A:` on B unmodified →
> A respawns → A's `pri:A:` is empty for those calls → first BYE post-respawn
> returns 481.

Phase-7 of the diagnostic test ([tests/sip-front-proxy/failover/replication-gap-mini.test.ts](../../tests/sip-front-proxy/failover/replication-gap-mini.test.ts))
sees 20/20 phase-1 BYEs fail with 481 right after `cluster.respawn(W1)`.

`expectLagSeqZero` PASSES at both pre-kill and post-respawn settle points —
the propagate stream has nothing pending. The bug is structurally at a
different layer: the propagate stream only carries entries B *wrote* on
A's behalf during the outage. Calls B never touched generate no
reverse-direction entries, so A's ReadyGate drain finds nothing for them.

## Root cause

**`ReclaimRunner` already exists ([src/cache/ReclaimRunner.ts](../../src/cache/ReclaimRunner.ts))
and was designed for exactly this case** — startup-time scan of every peer's
`bak:{self}:call:*` partition into local `pri:{self}:`. ReadyGate's own
documentation calls it out as the "safety net for entries that fell out of
the propagate window."

The runner is **never wired into the boot path.** A `grep -rn ReclaimRunner`
across `src/main.ts`, `bin/`, `src/cluster/`, `src/b2bua/`, and
`tests/support/` finds zero usages. The implementation exists; the
integration was never landed.

## Fix proposal

Two design choices to decide before coding.

### Decision 1 — Order vs ReadyGate

ReadyGate's `Layer` instantiates a stream-based propagate drain at boot.
ReclaimRunner is a scan-based recovery. They overlap (both populate
`pri:{self}:` from peer state) but with different latency / completeness
profiles:

- ReadyGate's drain: sub-second, but only covers entries actively in
  `propagate:{self}` (i.e. peers wrote on this worker's behalf during the
  outage).
- ReclaimRunner's scan: bounded by per-peer `scan` cost, covers
  *every* `bak:{self}:call:*` entry on each peer.

**Three orderings:**

- **(a) Replace ReadyGate's drain with ReclaimRunner.** Simpler — one
  recovery path. Loses the sub-second drain for the most common case
  (calls peers were actively serving). Probably wrong choice.
- **(b) Run ReadyGate's drain first, then ReclaimRunner.** Two-phase
  boot. Drain catches the active calls fast; scan catches the quiet
  ones. Slightly longer boot but bounded. **Recommended.**
- **(c) Run them in parallel.** Fastest boot. Risk of write contention
  on `pri:{self}:` (both writers may race on the same callRef). The
  per-call atomicity in `AtomicWriter` plus the gen-compare in
  ReclaimRunner ([line 254-263](../../src/cache/ReclaimRunner.ts) — the
  scan path "drops entries whose primary segment does not match self"
  + "newer-gen wins") handles concurrency, but reasoning gets harder.
  Not recommended unless boot latency is a hard constraint.

**Recommendation: (b).** Sequential. Land ReadyGate first as today, then
ReclaimRunner as a follow-up step that completes before
`WorkerReadiness.markReady(true)` flips. Both must complete (or both
must hit their max-duration ceiling) before the pod becomes K8s-Ready.

### Decision 2 — Where to wire it

Per [src/main.ts:330](../../src/main.ts), `ReplicationLayer` is built from
`ReadyGate.layer()` and `markReady(true)` is called after the gate
finishes. Two integration points:

- **(α) Inside `main.ts`** — the boot procedure already runs `gate.run`
  inline; add `reclaim.run` after it, gate `markReady(true)` on both.
  **Recommended.**
- **(β) As an internal step of `ReadyGate.run`** — `ReadyGate.run`
  invokes `ReclaimRunner.run` before flipping `markReady(true)`.
  Tighter coupling; requires ReclaimRunner in ReadyGate's layer
  dependencies. Cleaner from caller's perspective but conflates two
  recovery primitives.

**Recommendation: (α).** Keep ReadyGate focused on the propagate drain;
let main.ts orchestrate the two-phase boot. Easier to disable
ReclaimRunner via config later if needed.

### Decision 3 — Single-node mode (no K8s)

[src/main.ts:494-503](../../src/main.ts) explicitly skips ReadyGate when
`K8S_NAMESPACE` is unset and just calls `markReady(true)`. ReclaimRunner
makes no sense in that mode either — there are no peers to scan. Keep
the same skip.

## Test coverage

The diagnostic test [replication-gap-mini.test.ts](../../tests/sip-front-proxy/failover/replication-gap-mini.test.ts)
is currently `it.effect.fails`. After this fix it should pass cleanly.

- Remove `.fails` (or reverse to `it.effect`).
- Acceptance unchanged: zero 481s across all 40 BYEs in phase 5 + phase 7.
- Re-run `npm run test:fake` to confirm no regressions.

The fake-stack `k8sFakeStack` layer needs ReclaimRunner wired into its
post-respawn lifecycle. The current `cluster.respawn(...)` rebuilds the
worker's stack but doesn't currently re-run ReclaimRunner. Find the
respawn path in [tests/support/k8sFakeStack.ts](../../tests/support/k8sFakeStack.ts) and ensure
the new wiring is invoked there too.

## Production verification

- `npm run typecheck` — zero errors / zero warnings.
- `npm run test` (fake stack + short-tier live) — must be clean.
- The diagnostic test going from `.fails` → green is the load-bearing signal.

## Risks

- **ReclaimRunner is unused code.** Wiring it might surface latent bugs in
  `PeerCachePort.scan`, the gen-compare, or the storage write path under
  the new call sequence. Each surfaced bug is a fix; budget time.
- **Boot latency.** Adding ReclaimRunner adds time before
  `markReady(true)`. Bounded by its `maxDuration` (default unknown — need
  to read). Acceptable if ≤ 5 s under steady-state.
- **Race with the propagate stream.** While ReclaimRunner is running, the
  ReplPuller is also live and may apply incoming forward entries. Both
  write through `AtomicWriter` so atomicity is fine, but verify the
  gen-compare logic correctly handles a concurrent-direction write.

## Next step

Pick one cell from each of Decision 1, 2, 3 (recommendations: **b / α /
keep-skip**), and I'll implement.

If you want a different cut, name it and I'll reshape.
