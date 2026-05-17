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

## Diagnostic outcome (2026-05-17) — first reading

Work-stream A's test was written and run. The test failed at first — but the failure was *not* about replication.

1. **Replication during establishment works as expected.** Pre-kill assertions all passed: the early-dialog frame *did* propagate to the backup, and the single-owner invariant held.
2. **The post-kill SIP path was the problem.** After the kill, bob's 200 OK was routed (via the LB proxy — bob→b2b is NOT direct in cluster mode, the proxy stamps Record-Route and `b2bOutboundProxy` forces the b-leg through it) to the now-dead primary. The proxy obediently forwarded based on the next-Via address without consulting registry health, and the response was dropped into the void. Alice's INVITE Timer B would eventually fire.

## Correction (2026-05-17, same day)

The first-reading conclusion that this was a "b-leg-bypass" or fundamental topology gap was **wrong**. Re-checking the trace ([test-results/failover/k8sFailover/mid-ring-primary-killed.global.txt](test-results/failover/k8sFailover/mid-ring-primary-killed.global.txt) lines 890-918) confirmed the b-leg traffic goes through the proxy as designed. The actual bug was localised to the proxy's response-routing path: [ProxyCore.ts:handleResponseImpl](src/sip-front-proxy/ProxyCore.ts) popped the topmost Via and forwarded to the next Via's address with **no registry health check** on the destination worker. The registry was in scope but used only for request-path source classification.

## Fix landed (2026-05-17)

Two related changes shipped to address the gap:

1. **Boot-time validation gate**: `validateClusterModeOutboundProxy` in [src/config/AppConfig.ts](src/config/AppConfig.ts) — a worker booted with `CLUSTER_WORKERS > 0` but no `B2B_OUTBOUND_PROXY` now refuses to start. Without this, a misconfigured cluster worker would silently send b-leg traffic direct to bob, bypassing the proxy and its failover-aware routing. Test: [tests/config/AppConfig-cluster-mode-outbound-proxy-validation.test.ts](tests/config/AppConfig-cluster-mode-outbound-proxy-validation.test.ts).

2. **Reverse-path failover in the proxy**: `handleResponseImpl` ([src/sip-front-proxy/ProxyCore.ts](src/sip-front-proxy/ProxyCore.ts)) now mirrors the request-path `decode_forward_backup` pattern. Before forwarding a response:
   - Look up the destination worker in the registry by `(host, port)`.
   - If found AND `health !== "alive"`, parse the proxy's own Record-Route entry (echoed by the downstream UAS per RFC 3261 §16.6 step 4), call `strategy.decodeStickiness` on its cookie params, and reroute to the cookie's `w_bak`.
   - If no usable backup is decodable (missing Record-Route or `forwardBackup` not yielded), drop the response with a metric (`responseDroppedDeadWorker`) and a `warn` log — visible failure instead of silent loss.
   - New counters: `responseReroutedToBackup`, `responseDroppedDeadWorker`.

With both changes in place, [tests/sip-front-proxy/failover/mid-ring-primary-killed.test.ts](tests/sip-front-proxy/failover/mid-ring-primary-killed.test.ts) passes (un-skipped). The full `npm run test:fake` suite is green (202 files, 1299 tests pass; 3 files / 8 tests skipped — pre-existing skips, not introduced by this work).

**Work-stream B (matrix wrapper) status**: still deferred. Now that the mid-ring tier works end-to-end, extending to other tiers (post-200-pre-ACK, post-PRACK on 100rel flows) is straightforward future work and the composable wrapper would pay off — but not in scope of this plan.

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
