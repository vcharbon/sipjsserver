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
import { cancelCall } from "../scenarios/cancel.js"
import { prackCall } from "../scenarios/prack.js"
import { prackForkingCall } from "../scenarios/prack-forking.js"
import { cancelCrossing200Ok } from "../scenarios/cancel-200ok-crossing.js"
import { callerHangup, calleeHangup } from "../scenarios/bye-directions.js"
import { aliceReInvite, bobReInvite, crossingReInvite } from "../scenarios/reinvite.js"
import { explicitRouteCall, failoverWithHeaders } from "../scenarios/shared-port.js"
import { suppress18xBasic, suppress18xFailoverNoAnswer, suppress18xFailoverReject, suppress18xDisabled } from "../scenarios/suppress-18x.js"
import { unknownDialogReject } from "../scenarios/indialog-unknown-reject.js"
import { indialogOptions } from "../scenarios/indialog-options.js"
import { indialogInfo } from "../scenarios/indialog-info.js"
import { delayedOfferFailure } from "../scenarios/delayed-offer-failure.js"
import { retransmit200 } from "../scenarios/retransmit-200.js"
import { keepaliveHappy } from "../scenarios/keepalive-happy.js"
import { keepalive481 } from "../scenarios/keepalive-481.js"
import { createSimulatedRunner, flushIndexReport } from "../support/harness.js"
import { ALL_SUTS } from "./framework/types.js"

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
  })
}

// ---------------------------------------------------------------------------
// Legacy single-SUT block — scenarios not yet migrated to the SUT matrix.
// Run on b2bonly only. Migrate one at a time; once a scenario is matrix-
// ready, move its `it.effect(...)` into the loop above.
// ---------------------------------------------------------------------------

describe("E2E (fake clock) — simulated backend", () => {
  const run = createSimulatedRunner({ outputDir: OUTPUT_DIR })

  it.effect("call rejection (403)", () => run(callReject.toScenario()), { timeout: 30_000 })
  it.effect("CANCEL during early dialog", () => run(cancelCall.toScenario()), { timeout: 30_000 })
  it.effect("CANCEL ↔ 200 OK crossing", () => run(cancelCrossing200Ok.toScenario()), { timeout: 30_000 })
  it.effect("PRACK flow", () => run(prackCall.toScenario()), { timeout: 30_000 })
  it.effect("PRACK forking flow", () => run(prackForkingCall.toScenario()), { timeout: 30_000 })
  it.effect("caller hangup (composed)", () => run(callerHangup.toScenario()), { timeout: 30_000 })
  it.effect("callee hangup (composed)", () => run(calleeHangup.toScenario()), { timeout: 30_000 })
  it.effect("re-INVITE from caller (SDP in ACK)", () => run(aliceReInvite.toScenario()), { timeout: 30_000 })
  it.effect("re-INVITE from callee", () => run(bobReInvite.toScenario()), { timeout: 30_000 })
  it.effect("crossing re-INVITEs (glare → 491)", () => run(crossingReInvite.toScenario()), { timeout: 30_000 })

  // suppress-18x policy tests
  it.effect("suppress-18x: basic (183→180, suppression, 200 OK)", () => run(suppress18xBasic.toScenario()), { timeout: 30_000 })
  it.effect("suppress-18x: failover no-answer (tag consistency)", () => run(suppress18xFailoverNoAnswer.toScenario()), { timeout: 30_000 })
  it.effect("suppress-18x: failover reject (tag consistency)", () => run(suppress18xFailoverReject.toScenario()), { timeout: 30_000 })
  it.effect("suppress-18x: disabled (normal 180 relay)", () => run(suppress18xDisabled.toScenario()), { timeout: 30_000 })
  it.effect("in-dialog unknown dialog → 481 reject", () => run(unknownDialogReject.toScenario()), { timeout: 30_000 })
  it.effect("in-dialog OPTIONS relayed end-to-end (payload preserved, both directions)", () => run(indialogOptions.toScenario()), { timeout: 30_000 })
  it.effect("in-dialog INFO relayed end-to-end (DTMF payload, both directions)", () => run(indialogInfo.toScenario()), { timeout: 30_000 })
  it.effect("delayed-offer-failure: missing SDP answer in ACK", () => run(delayedOfferFailure.toScenario()), { timeout: 30_000 })

  // Coverage-driven scenarios for rules that were previously never fired
  // under the fake-clock harness: retransmit-200, keepalive, handle-481.
  it.effect("retransmit-200: duplicate 200 OK on confirmed leg → re-ACK only", () => run(retransmit200.toScenario()), { timeout: 30_000 })
  it.effect("keepalive: OPTIONS to both legs, two cycles (TestClock 15 min)", () => run(keepaliveHappy.toScenario()), { timeout: 30_000 })
  it.effect("keepalive + 481: bob rejects OPTIONS → begin-termination BYEs alice", () => run(keepalive481.toScenario()), { timeout: 30_000 })
})

// ---------------------------------------------------------------------------
// Simulated backend tests — shared-port demuxing (separate B2BUA instance)
// ---------------------------------------------------------------------------

describe("E2E (fake clock) — simulated backend (shared-port)", () => {
  const run = createSimulatedRunner({
    sipPort: 15090,
    httpPort: 13032,
    outputDir: OUTPUT_DIR,
  })

  it.effect("explicit routing via X-Api-Call", () => run(explicitRouteCall.toScenario()), { timeout: 30_000 })
  it.effect("failover with update_headers (bob1 reject → bob2)", () => run(failoverWithHeaders.toScenario()), { timeout: 30_000 })
})
