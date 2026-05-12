/**
 * E2E test suite — fake clock (TestClock) variants.
 *
 * All tests in this file run under @effect/vitest's TestClock so virtual
 * time is advanced by `pause()` steps. The B2BUA runs in-process inside
 * the same Effect runtime and shares the same TestClock — pauses become
 * effectively instant.
 *
 * If a scenario needs real wall-clock behaviour (live UDP, real Redis
 * timing windows, peer-to-peer agents) put it in `e2e-real-clock.test.ts`.
 */

import { describe, it } from "@effect/vitest"
import { afterAll } from "vitest"
import { basicCall } from "../scenarios/basic-call.js"
import { routeSetPropagation } from "../scenarios/route-set-propagation.js"
import { callReject } from "../scenarios/call-reject.js"
import {
  rejectWithReasonHeader,
  reject302WithContact,
  reject403WithContactPassesThrough,
} from "../scenarios/reject-with-headers.js"
import {
  bLegFromOverridePersistsToBye,
  bLegToOverridePersistsToBye,
  bLegBothOverridePersistsToBye,
  bLegFromOverrideTagStripped,
} from "../scenarios/from-to-override.js"
import { cancelCall } from "../scenarios/cancel.js"
import { prackCall } from "../scenarios/prack.js"
import { prackForkingCall } from "../scenarios/prack-forking.js"
import { cancelCrossing200Ok } from "../scenarios/cancel-200ok-crossing.js"
import { callerHangup, calleeHangup } from "../scenarios/bye-directions.js"
import { aliceReInvite, bobReInvite, crossingReInvite } from "../scenarios/reinvite.js"
import { suppress18xBasic, suppress18xFailoverNoAnswer, suppress18xFailoverReject, suppress18xDisabled } from "../scenarios/suppress-18x.js"
import {
  fakePrackBasic,
  fakePrackMultiple18x,
  fakePrackUpdateHappy,
  fakePrackUpdateCodecMismatch,
  fakePrackForking,
  fakePrackFailover,
  fakePrackDelayedOfferFallback,
  fakePrackNoPolicyControl,
} from "../scenarios/fake-prack.js"
import {
  promotePemHappyNoResync,
  promotePemResyncSdpChanged,
  promotePemBFailsPostPromote,
  promotePemResyncFailedByA,
  promotePemABYEDuringWindow,
  promotePemNoPolicyControl,
  promotePemForkingResync,
  promotePemInDialogRejection,
} from "../scenarios/promote-pem-to-200.js"
import { unknownDialogReject } from "../scenarios/indialog-unknown-reject.js"
import { indialogOptions } from "../scenarios/indialog-options.js"
import { indialogInfo } from "../scenarios/indialog-info.js"
import { delayedOfferFailure } from "../scenarios/delayed-offer-failure.js"
import { retransmit200 } from "../scenarios/retransmit-200.js"
import { keepaliveHappy } from "../scenarios/keepalive-happy.js"
import { keepalive481 } from "../scenarios/keepalive-481.js"
import {
  keepaliveViaProxy,
  keepaliveMissingOutboundProxyRegressionGuard,
} from "../scenarios/keepalive-via-proxy.js"
import { twoCallsRoutedToTwoWorkers } from "../scenarios/ha/two-calls-routed-to-two-workers.js"
import { haKeepaliveHappy } from "../scenarios/ha/keepalive-happy-ha.js"
import { haKeepaliveTimeout } from "../scenarios/ha/keepalive-timeout-ha.js"
import { registerHappyPath } from "../scenarios/registrar/register-happy-path.js"
import { deregisterViaExpiresZero } from "../scenarios/registrar/deregister-via-expires-zero.js"
import { ttlExpiryUnderTestClock } from "../scenarios/registrar/ttl-expiry-under-testclock.js"
import { extCallToCoreDestination } from "../scenarios/registrar/ext-call-to-core-destination.js"
import { coreCallToRegisteredExt } from "../scenarios/registrar/core-call-to-registered-ext.js"
import {
  createSimulatedRunner,
  expectCdrCount,
  flushIndexReport,
  skipCdrCheck,
} from "../support/harness.js"
import { ALL_SUTS } from "../../src/test-harness/framework/types.js"

// ── Per-scenario CDR-check overrides ────────────────────────────────────────
//
// suppress-18x-failover-reject exercises the 503-then-failover path. After
// the underlying B2BUA cleanup bug fix (routeFailureRule now sets
// byeDisposition="rejected" on the failed leg), the call cleanly transitions
// to "terminated" and writes its single CDR.
expectCdrCount("suppress-18x-failover-reject", 1)

// Multi-worker SUTs share a single CdrWriter buffer across all workers
// (sipproxyHAFakeStackLayer / k8sFakeStackLayer wire the same
// `CdrWriter.sharedTestLayer(buffer)` into every b2bua and merge it at the
// outer scope). For these SUTs we use `expectCdrCount` to declare the
// expected total CDR count across the cluster.
//
// `two-calls-routed-to-two-workers` creates 2 distinct calls (one per
// worker). Both go through full BYE round-trip → 2 CDR records aggregated
// across both workers via `CdrWriter.sharedTestLayer(buffer)`.
expectCdrCount("two-calls-routed-to-two-workers", 2)

// HA keepalive scenarios — each runs 2 calls, each call's primary
// emits one CDR → 2 records per scenario. Per-test fabric / buffer
// isolation in `createSimulatedRunner` (harness.ts) keeps these
// counts per-scenario rather than cumulative across the describe.
expectCdrCount("ha-keepalive-happy", 2)
expectCdrCount("ha-keepalive-timeout", 2)

// registrarFrontProxy is a pure SIP proxy (no B2BUA, no CallState, no
// CdrWriter in scope). Harness skip is the only sound option.
skipCdrCheck("register-happy-path")
skipCdrCheck("deregister-via-expires-zero")
skipCdrCheck("ttl-expiry-under-testclock")
skipCdrCheck("ext-call-to-core-destination")
skipCdrCheck("core-call-to-registered-ext")

const OUTPUT_DIR = "test-results/fake-clock"

afterAll(() => {
  flushIndexReport(OUTPUT_DIR)
  // SUT-matrix subdirs each accumulate their own results; flush per-SUT.
  for (const sut of ALL_SUTS) {
    flushIndexReport(`${OUTPUT_DIR}/${sut}`)
  }
})

// ---------------------------------------------------------------------------
// SUT matrix — scenarios that run unchanged against b2bonly *and* proxy+b2b.
// Reports land under test-results/fake-clock/<sut>/<scenario>.{txt,html}.
// ---------------------------------------------------------------------------

for (const sut of ALL_SUTS) {
  describe(`E2E (fake clock) — ${sut}`, () => {
    const run = createSimulatedRunner({ outputDir: OUTPUT_DIR, sut })

    if (basicCall.appliesTo(sut)) {
      it.effect("basic call", () => run(basicCall.toScenario()), { timeout: 30_000 })
    }
    if (routeSetPropagation.appliesTo(sut)) {
      it.effect("route-set propagation", () => run(routeSetPropagation.toScenario()), { timeout: 30_000 })
    }
    if (callReject.appliesTo(sut)) {
      it.effect("call rejection (403)", () => run(callReject.toScenario()), { timeout: 30_000 })
    }
    if (rejectWithReasonHeader.appliesTo(sut)) {
      it.effect("reject (403) carries consumer-supplied Reason header (RFC 3326)", () => run(rejectWithReasonHeader.toScenario()), { timeout: 30_000 })
    }
    if (reject302WithContact.appliesTo(sut)) {
      it.effect("reject (302) carries consumer-supplied Contact header (redirect)", () => run(reject302WithContact.toScenario()), { timeout: 30_000 })
    }
    if (reject403WithContactPassesThrough.appliesTo(sut)) {
      it.effect("reject (403) passes consumer Contact through (no family gating)", () => run(reject403WithContactPassesThrough.toScenario()), { timeout: 30_000 })
    }
    if (bLegFromOverridePersistsToBye.appliesTo(sut)) {
      it.effect("b-leg From override persists to BYE (RFC 3261 §12.2.1.1)", () => run(bLegFromOverridePersistsToBye.toScenario()), { timeout: 30_000 })
    }
    if (bLegToOverridePersistsToBye.appliesTo(sut)) {
      it.effect("b-leg To override persists to BYE (RFC 3261 §12.2.1.1)", () => run(bLegToOverridePersistsToBye.toScenario()), { timeout: 30_000 })
    }
    if (bLegBothOverridePersistsToBye.appliesTo(sut)) {
      it.effect("b-leg From AND To override persist to BYE", () => run(bLegBothOverridePersistsToBye.toScenario()), { timeout: 30_000 })
    }
    if (bLegFromOverrideTagStripped.appliesTo(sut)) {
      it.effect("b-leg From override with consumer-supplied tag — tag is stripped", () => run(bLegFromOverrideTagStripped.toScenario()), { timeout: 30_000 })
    }
    if (cancelCall.appliesTo(sut)) {
      it.effect("CANCEL during early dialog", () => run(cancelCall.toScenario()), { timeout: 30_000 })
    }
    if (callerHangup.appliesTo(sut)) {
      it.effect("caller hangup (composed)", () => run(callerHangup.toScenario()), { timeout: 30_000 })
    }
    if (calleeHangup.appliesTo(sut)) {
      it.effect("callee hangup (composed)", () => run(calleeHangup.toScenario()), { timeout: 30_000 })
    }
    if (retransmit200.appliesTo(sut)) {
      it.effect("retransmit-200: duplicate 200 OK on confirmed leg → re-ACK only", () => run(retransmit200.toScenario()), { timeout: 30_000 })
    }
    if (cancelCrossing200Ok.appliesTo(sut)) {
      it.effect("CANCEL ↔ 200 OK crossing", () => run(cancelCrossing200Ok.toScenario()), { timeout: 30_000 })
    }
    if (prackCall.appliesTo(sut)) {
      it.effect("PRACK flow", () => run(prackCall.toScenario()), { timeout: 30_000 })
    }
    if (prackForkingCall.appliesTo(sut)) {
      it.effect("PRACK forking flow", () => run(prackForkingCall.toScenario()), { timeout: 30_000 })
    }
    if (aliceReInvite.appliesTo(sut)) {
      it.effect("re-INVITE from caller (SDP in ACK)", () => run(aliceReInvite.toScenario()), { timeout: 30_000 })
    }
    if (bobReInvite.appliesTo(sut)) {
      it.effect("re-INVITE from callee", () => run(bobReInvite.toScenario()), { timeout: 30_000 })
    }
    if (crossingReInvite.appliesTo(sut)) {
      it.effect("crossing re-INVITEs (glare → 491)", () => run(crossingReInvite.toScenario()), { timeout: 30_000 })
    }
    if (suppress18xBasic.appliesTo(sut)) {
      it.effect("suppress-18x: basic (183→180, suppression, 200 OK)", () => run(suppress18xBasic.toScenario()), { timeout: 30_000 })
    }
    if (suppress18xFailoverNoAnswer.appliesTo(sut)) {
      it.effect("suppress-18x: failover no-answer (tag consistency)", () => run(suppress18xFailoverNoAnswer.toScenario()), { timeout: 30_000 })
    }
    if (suppress18xFailoverReject.appliesTo(sut)) {
      it.effect("suppress-18x: failover reject (tag consistency)", () => run(suppress18xFailoverReject.toScenario()), { timeout: 30_000 })
    }
    if (suppress18xDisabled.appliesTo(sut)) {
      it.effect("suppress-18x: disabled (normal 180 relay)", () => run(suppress18xDisabled.toScenario()), { timeout: 30_000 })
    }
    if (fakePrackBasic.appliesTo(sut)) {
      it.effect("fake-prack: basic (originated PRACK + cached SDP at 200)", () => run(fakePrackBasic.toScenario()), { timeout: 30_000 })
    }
    if (fakePrackMultiple18x.appliesTo(sut)) {
      it.effect("fake-prack: multiple reliable 18x (one PRACK each, latest cache wins)", () => run(fakePrackMultiple18x.toScenario()), { timeout: 30_000 })
    }
    if (fakePrackUpdateHappy.appliesTo(sut)) {
      it.effect("fake-prack: UPDATE happy (skeleton-fit answer + cache advances)", () => run(fakePrackUpdateHappy.toScenario()), { timeout: 30_000 })
    }
    if (fakePrackUpdateCodecMismatch.appliesTo(sut)) {
      it.effect("fake-prack: UPDATE codec mismatch (488)", () => run(fakePrackUpdateCodecMismatch.toScenario()), { timeout: 30_000 })
    }
    if (fakePrackForking.appliesTo(sut)) {
      it.effect("fake-prack: forking (independent caches; loser cancelled)", () => run(fakePrackForking.toScenario()), { timeout: 30_000 })
    }
    if (fakePrackFailover.appliesTo(sut)) {
      it.effect("fake-prack: failover (b1 cache discarded)", () => run(fakePrackFailover.toScenario()), { timeout: 30_000 })
    }
    if (fakePrackDelayedOfferFallback.appliesTo(sut)) {
      it.effect("fake-prack: delayed-offer fallback (Supported:100rel stripped)", () => run(fakePrackDelayedOfferFallback.toScenario()), { timeout: 30_000 })
    }
    if (fakePrackNoPolicyControl.appliesTo(sut)) {
      it.effect("fake-prack: no policy control (default end-to-end PRACK)", () => run(fakePrackNoPolicyControl.toScenario()), { timeout: 30_000 })
    }
    if (promotePemHappyNoResync.appliesTo(sut)) {
      it.effect("promote-pem-to-200: happy (SDP unchanged → no resync)", () => run(promotePemHappyNoResync.toScenario()), { timeout: 30_000 })
    }
    if (promotePemResyncSdpChanged.appliesTo(sut)) {
      it.effect("promote-pem-to-200: resync (SDP changed → re-INVITE A; in-dialog resumes)", () => run(promotePemResyncSdpChanged.toScenario()), { timeout: 30_000 })
    }
    if (promotePemBFailsPostPromote.appliesTo(sut)) {
      it.effect("promote-pem-to-200: B fails post-promote (BYE A with Reason)", () => run(promotePemBFailsPostPromote.toScenario()), { timeout: 30_000 })
    }
    if (promotePemResyncFailedByA.appliesTo(sut)) {
      it.effect("promote-pem-to-200: A 488s resync re-INVITE (BYE both legs)", () => run(promotePemResyncFailedByA.toScenario()), { timeout: 30_000 })
    }
    if (promotePemABYEDuringWindow.appliesTo(sut)) {
      it.effect("promote-pem-to-200: A BYE during window (CANCEL B)", () => run(promotePemABYEDuringWindow.toScenario()), { timeout: 30_000 })
    }
    if (promotePemNoPolicyControl.appliesTo(sut)) {
      it.effect("promote-pem-to-200: no policy control (default 18x relay)", () => run(promotePemNoPolicyControl.toScenario()), { timeout: 30_000 })
    }
    if (promotePemForkingResync.appliesTo(sut)) {
      it.effect("promote-pem-to-200: forking — resync to winning fork", () => run(promotePemForkingResync.toScenario()), { timeout: 30_000 })
    }
    if (promotePemInDialogRejection.appliesTo(sut)) {
      it.effect("promote-pem-to-200: in-dialog rejection (491/488) during window", () => run(promotePemInDialogRejection.toScenario()), { timeout: 30_000 })
    }
    if (unknownDialogReject.appliesTo(sut)) {
      it.effect("in-dialog unknown dialog → 481 reject", () => run(unknownDialogReject.toScenario()), { timeout: 30_000 })
    }
    if (indialogOptions.appliesTo(sut)) {
      it.effect("in-dialog OPTIONS relayed end-to-end (payload preserved, both directions)", () => run(indialogOptions.toScenario()), { timeout: 30_000 })
    }
    if (indialogInfo.appliesTo(sut)) {
      it.effect("in-dialog INFO relayed end-to-end (DTMF payload, both directions)", () => run(indialogInfo.toScenario()), { timeout: 30_000 })
    }
    if (delayedOfferFailure.appliesTo(sut)) {
      it.effect("delayed-offer-failure: missing SDP answer in ACK", () => run(delayedOfferFailure.toScenario()), { timeout: 30_000 })
    }
    if (keepaliveHappy.appliesTo(sut)) {
      it.effect("keepalive: OPTIONS to both legs, two cycles (TestClock 15 min)", () => run(keepaliveHappy.toScenario()), { timeout: 30_000 })
    }
    if (keepalive481.appliesTo(sut)) {
      it.effect("keepalive + 481: bob rejects OPTIONS → begin-termination BYEs alice", () => run(keepalive481.toScenario()), { timeout: 30_000 })
    }
    if (keepaliveViaProxy.appliesTo(sut)) {
      it.effect(
        "keepalive: in-dialog OPTIONS travels via proxy on both legs (regression for k8s endurance)",
        () => run(keepaliveViaProxy.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (keepaliveMissingOutboundProxyRegressionGuard.appliesTo(sut)) {
      const runMissing = createSimulatedRunner({
        outputDir: OUTPUT_DIR,
        sut,
        simulateMissingOutboundProxy: true,
      })
      it.effect(
        "keepalive: missing B2B_OUTBOUND_PROXY → b-leg OPTIONS goes worker-direct (bug-presence guard)",
        () => runMissing(keepaliveMissingOutboundProxyRegressionGuard.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (twoCallsRoutedToTwoWorkers.appliesTo(sut)) {
      // sipproxyHA-only: two alice→bob calls with pre-computed Call-IDs
      // hashing to distinct workers; mixed BYE direction (alice / bob).
      // Higher timeout because the 5s OPTIONS settle pause is virtual but
      // still walks the test scheduler twice.
      it.effect(
        "HA: two calls routed to two workers (alice-BYE + bob-BYE)",
        () => run(twoCallsRoutedToTwoWorkers.toScenario()),
        { timeout: 60_000 },
      )
    }
    if (haKeepaliveHappy.appliesTo(sut)) {
      // sipproxyHA-only: two long calls (one per worker), each survives
      // multiple successful B2BUA-keepalive cycles (15 min each, virtual)
      // before BYE. Exercises tombstone propagation on a call that has
      // accumulated several replicated `_topology.gen` bumps.
      it.effect(
        "HA: long call with successful keepalive cycles → BYE → tombstone",
        () => run(haKeepaliveHappy.toScenario()),
        { timeout: 120_000 },
      )
    }
    if (haKeepaliveTimeout.appliesTo(sut)) {
      // sipproxyHA-only: two long calls, each survives several successful
      // keepalive cycles, then loses one leg (alice stops answering).
      // `keepaliveTimeoutRule` fires and BYEs the responsive peer (bob).
      // Exercises the bye_timeout disposition's tombstone path on HA.
      it.effect(
        "HA: long call with keepalive timeout → BYE to responsive peer",
        () => run(haKeepaliveTimeout.toScenario()),
        { timeout: 120_000 },
      )
    }
    if (registerHappyPath.appliesTo(sut)) {
      // registrarFrontProxy-only: Alice REGISTERs and gets a 200 OK
      // with default Expires=3600.
      it.effect(
        "registrar: REGISTER happy path (200 OK with Contact + Expires)",
        () => run(registerHappyPath.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (deregisterViaExpiresZero.appliesTo(sut)) {
      // registrarFrontProxy-only: REGISTER → re-REGISTER Expires=0 →
      // core-side INVITE for alice gets 404.
      it.effect(
        "registrar: deregister via Expires=0 (core INVITE → 404)",
        () => run(deregisterViaExpiresZero.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (ttlExpiryUnderTestClock.appliesTo(sut)) {
      // registrarFrontProxy-only: REGISTER → TestClock.adjust(3601s) →
      // core-side INVITE for alice gets 404 from the lazy-expiry sweep.
      it.effect(
        "registrar: TTL expiry under TestClock (core INVITE → 404)",
        () => run(ttlExpiryUnderTestClock.toScenario()),
        { timeout: 60_000 },
      )
    }
    if (extCallToCoreDestination.appliesTo(sut)) {
      // registrarFrontProxy-only: Alice (ext) → INVITE → proxy →
      // bobCore (hardcoded at coreDestination) → 200/ACK/BYE/200.
      // Exercises the headline ext→core forwarding path.
      it.effect(
        "registrar: ext→core call (alice → proxy → bobCore@coreDestination)",
        () => run(extCallToCoreDestination.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (coreCallToRegisteredExt.appliesTo(sut)) {
      // registrarFrontProxy-only: bobExt registers → aliceCore (core)
      // INVITE for sip:bob → proxy registrar lookup → bobExt → 200/
      // ACK/BYE/200. Exercises the headline core→ext forwarding path.
      it.effect(
        "registrar: core→ext call (aliceCore → proxy registrar lookup → bobExt)",
        () => run(coreCallToRegisteredExt.toScenario()),
        { timeout: 30_000 },
      )
    }
  })
}

// ---------------------------------------------------------------------------
// Legacy single-SUT block — scenarios not yet migrated to the SUT matrix.
// Run on b2bonly only. Migrate one at a time; once a scenario is matrix-
// ready, move its `it.effect(...)` into the loop above.
// ---------------------------------------------------------------------------

// All scenarios run on both b2bonly and proxy+b2b via the SUT matrix
// above. The previous "shared-port" describe block (explicit-route-call,
// failover-with-headers) has been retired — once a real front proxy is
// available, those tests will be re-implemented as a "test agent proxy +
// register" topology rather than ad-hoc port-shifting.
