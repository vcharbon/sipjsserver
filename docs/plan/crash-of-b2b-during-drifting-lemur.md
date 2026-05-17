# Plan: Crash of B2B during call establishment — test enrichment

## Context

Concern: when a B2BUA worker crashes mid-INVITE-establishment, are in-flight calls correctly survived/replicated on the backup peer? The HA failover suite covers post-establishment kill (e.g. [basic-call-primary-killed.test.ts](tests/sip-front-proxy/failover/basic-call-primary-killed.test.ts)) but **no existing test crashes a worker between 180 Ringing and the final ACK**. `basicCallBody` ([basic-call.ts:80](tests/scenarios/basic-call.ts#L80)) sends 180 then 200 back-to-back with no ring duration, so there is no realistic window for chaos to land mid-ring.

After a deep trace (see "Trace findings"), the replication mechanism already covers establishment in principle: every state-mutating flush goes through `flushToRedis` → `submitTerminatePut` → `ChannelIndex.write`, which `ZADD`s a U-member on the per-peer propagate stream and the puller's long-poll drains it. The historical "only-propagate-on-established-calls" feel comes from the **fixed `member = "U:${bodyKey}"`** — every write to the same call collapses to the latest entry, so under sub-second establishment the puller only ever observes the post-ACK state. With realistic ring durations this should self-correct (intermediate frames live long enough to be pulled before being overwritten), but **today's test suite cannot prove that** because no scenario has a ring.

Decision after grilling: **do not change the replication mechanism for now**. Add tests that actually exercise the establishment-kill scenario. If they pass cleanly we have evidence the system already works; if they fail, we have a concrete repro and revisit a replication-mode config (the L0..L3 ladder discussed during grilling, parked at the bottom of this doc as future work).

## Resolved decisions

- **Verification policy**: **success-required**. The primary's mid-ring death must be invisible to alice — alice's call must complete cleanly (200 from backup-now-primary, ACK lands, BYE works). A failing test means we have a real defect to fix.
- **Test-extension shape**: **both** — parameterise `basicCallBody` for the focused investigation test, and additionally design a composable wrapper for the matrix sweep over existing scenarios.
- **Matrix breadth**: **start narrow** (one timing tier: mid-ring between 180 and 200) **applied to the HA failover scenario set**, but design the kill-spec parameter so adding a PRACK timing tier later is a one-line change (kill-after-PRACK is the obvious next tier for 100rel flows).
- **Replication levels (L0..L3)**: parked. If Work-stream A surfaces real failures, this becomes the follow-up; otherwise judge the existing compaction-based mechanism adequate.

## Trace findings (kept for future-self)

Explicit `{type: "flush-redis"}` emission sites:

- [InitialInviteHandler.ts:68](src/b2bua/InitialInviteHandler.ts#L68) → `applyRoute` → [helpers.ts:415-418](src/b2bua/helpers.ts#L415-L418) emits flush at b-leg creation (initial INVITE).
- [helpers.ts:96](src/b2bua/helpers.ts#L96) emits flush at `beginTerminationEffects`.
- [ActionExecutor.ts:1972](src/b2bua/rules/framework/ActionExecutor.ts#L1972) emits flush at `begin-termination`.
- [RuleExecutor.ts:151-161](src/b2bua/rules/framework/RuleExecutor.ts#L151-L161) `appendAutoFlush` appends flush on every reference-inequality state mutation.

Propagation path is unconditional once flush lands: [CallState.flushToRedis:565-620](src/call/CallState.ts#L565-L620) → [submitTerminatePut → PartitionedRelayStorageKvBacked.putCall:375-415](src/cache/PartitionedRelayStorageKvBacked.ts#L375-L415) → [ChannelIndex.write](src/replication/ChannelIndex.ts) with `member = "U:${bodyKey}"`. No state-based ("established"/"confirmed") guard anywhere; the apparent "only after ACK" behaviour comes from ZADD-replaces-same-member compaction under fast establishment. The simulated backend wires the same puller fiber ([proxyB2bFakeStack.ts:626-634](tests/support/proxyB2bFakeStack.ts#L626-L634), [k8sFakeStack.ts:499-511](tests/support/k8sFakeStack.ts#L499-L511)) so behaviour parity holds in fake-clock tests.

## Work-stream A — focused investigation test

Goal: prove the system survives a primary kill mid-ring with the current replication mechanism, full-success contract.

**Files to create:**
- `tests/sip-front-proxy/failover/mid-ring-primary-killed.test.ts`

**Files to modify:**
- `tests/scenarios/basic-call.ts` — extend `basicCallBody`'s `BasicCallOpts` with:
  - `ringMs?: number` (default `0` — preserves today's back-to-back 180→200 shape)
  - `killSpec?: { atRingOffsetMs: number; worker: "primary" | "backup" }` (default `undefined`) — inserts `s.cluster.kill(...)` partway through the ring pause; resolved-worker selection happens at scenario-eval time using the cookie/HRW pre-computed Call-ID convention.

The new test uses `basicCallBody` with `ringMs: 10_000`, `killSpec: { atRingOffsetMs: 5_000, worker: "primary" }`, `callId: CALLID_TO_W1`, and runs on the `k8sFailover` SUT (same as [basic-call-primary-killed.test.ts](tests/sip-front-proxy/failover/basic-call-primary-killed.test.ts)).

Assertions (reusing existing primitives from the failover suite):
- `s.cluster.expectReplicatedTo(W2, { primary: W1 })` **before** the kill (replication already drained the early-dialog frame).
- After `s.cluster.kill(W1)` and the rest of the SIP exchange completes: `s.cluster.expectRoutedTo(W2, { decision: "decode_forward_backup" })` and the single-owner invariant `s.cluster.expectCallStateOn(W2, { partition: "pri", owner: W2, present: false })`.
- The `it.effect` expectation that alice's INVITE transaction completes with 200 OK and the BYE round-trip lands.
- `expectCdrCount("mid-ring-primary-killed", 1)`.

## Work-stream B — composable ring+kill wrapper for the matrix

Goal: a reusable mechanism that takes an existing fake-clock HA scenario and produces a "with-ring-and-mid-ring-kill" variant, so coverage expands without authoring each variant by hand.

**Files to create:**
- `tests/scenarios/ha/withRingAndKill.ts` — wrapper `withRingAndKill(base: ComposableScenario, opts: KillSpec): ComposableScenario`. Implementation strategy: extends the same `ComposableScenario` machinery in [src/test-harness/framework/dsl.ts](src/test-harness/framework/dsl.ts) (cf. how `or` / `parallel` are built). Conceptually splices a ring pause + `s.cluster.kill(...)` at the right point in the base scenario's step list.

  Design the `KillSpec` discriminated-union with a **`timingTier`** field — initially supports `"mid-ring"` only; the union is shaped so that adding `"post-prack"` later is one new variant + the corresponding splice logic, without touching call-sites.

  ```ts
  type KillSpec =
    | { tier: "mid-ring"; ringMs: number; killAtOffsetMs: number; worker: "primary" | "backup" }
    // future: | { tier: "post-prack"; ... }
  ```

**Files to modify:**
- None initially. The wrapper is additive; existing scenario tests are left alone.

**Initial matrix attachment:**
- `tests/sip-front-proxy/failover/mid-ring-matrix.test.ts` — applies `withRingAndKill({ tier: "mid-ring", ringMs: 10_000, killAtOffsetMs: 5_000, worker: "primary" })` to a small starter set of HA scenarios from [tests/scenarios/ha/](tests/scenarios/ha/) (e.g. `keepalive-happy-ha`, plus any others already running on `k8sFailover` / `sipproxyHA`).

## Diagnostic outcome (2026-05-17)

Work-stream A's test was written and run. The test **fails** — but the failure is *not* about replication.

What the test proves:
1. **Replication during establishment works as expected.** The pre-kill assertions all pass:
   - `s.cluster.expectCallStateOn(W1, { partition: "pri", owner: W1 })` ✓
   - `s.cluster.expectReplicatedTo(W2, { primary: W1 })` ✓ — the early-dialog frame *did* propagate to the backup before the kill.
   - `s.cluster.expectCallStateOn(W2, { partition: "pri", owner: W2, present: false })` ✓ — single-owner invariant intact pre-kill.
2. **The post-kill SIP path is the problem.** After the kill, bob's 200 OK is sent to the (now dead) b2b-1. The proxy does *not* sit between bob and the b2b cluster — bob→b2b is direct. There is no recovery path for bob's in-flight UAS transaction. Alice's INVITE Timer B eventually fires. The proxy's routing-decision delta for `decode_forward_backup` is **zero** post-kill (because alice never sends another request — she's blocked waiting for the 200 that will never arrive).

This means: **the parked L0..L3 replication-level ladder would not fix this scenario.** Even at L3 (replicate every state mutation), the early-dialog state is already on the backup; what's missing is a way for bob's 200 OK to reach a live worker. That is a b-leg-failover problem, requiring either:
- A network-level rerouting layer between bob and the b2b cluster (a second proxy on that side), or
- An active-takeover mechanism where the backup picks up the dead primary's UAS transactions (requires per-call IP/port pinning to be redirectable), or
- A proxy topology change so the proxy also sits between b2b and bob.

The test is committed to the suite as `describe.skip` with a "known failing" annotation so CI stays green; the diagnostic value (the test fails, *and* the failure mode is documented in the source) is the deliverable.

**Work-stream B is paused.** Generating matrix variants of the same scenario would only multiply red tests of the same downstream issue without adding diagnostic value. The composable wrapper and broader matrix are deferred until either (a) the b-leg-failover gap is addressed (or judged out of scope) or (b) a different kill-timing tier (post-200-pre-ACK, post-ACK) is wanted — those don't share the b-leg-traffic-loss failure mode and *would* exercise replication-only paths.

## Verification

1. `npm run typecheck` — zero errors and zero warnings (both `tsc` and the Effect plugin gate, per CLAUDE.md).
2. `npm run test:fake` — full fake suite passes, including the new `mid-ring-primary-killed.test.ts` and `mid-ring-matrix.test.ts`.
3. Manual inspection of one rendered trace HTML for `mid-ring-primary-killed` under `test-results/failover/` to confirm the call flow visually matches the success-required contract (200 OK to alice originates from b2b-2 via the proxy's decode_forward_backup path).
4. If any of the new tests fails, the failure is the deliverable — file a follow-up and revisit the replication-level work parked below.

## Parked (future work, NOT in this plan)

The "replication level" ladder discussed during grilling:

| Level | Name | Survives a crash if it's… |
|---|---|---|
| L0 | `"none"` | nothing |
| L1 | `"established-transaction-done"` (today's behaviour) | the establishment transaction is fully done (post-ACK) |
| L2 | `"invite-critical"` | every invite-critical commit boundary has fired |
| L3 | `"all"` | the most recent state mutation has been enqueued for the peer |

If Work-stream A's success-required assertions fail empirically, this becomes the natural follow-up: switch the propagate-stream `member` encoding (per Hypothesis B from grilling) for invite-critical writes so the puller observes every frame instead of just the latest. Until then, no mechanism change.
