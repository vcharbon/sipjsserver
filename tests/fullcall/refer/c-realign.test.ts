/**
 * REFER c-realigning phase e2e suite (slice 6).
 *
 * Covers the B2BUA-originated re-INVITE on C carrying A's SDP and the
 * resulting phase transition to `a-realigning`. Slice 7 adds the re-INVITE
 * A exchange — this slice stops once the B2BUA has ACKed C's 200 for the
 * re-INVITE (or rolled back on failure).
 *
 * Runs against both SUT topologies (`b2bonly`, `proxy+b2b`).
 */

import { describe, it } from "@effect/vitest"
import { afterAll } from "vitest"
import {
  referAllowCRealignHappy,
  referAllowCRealignCReject488,
  referAllowCRealignCTimeout,
  referAllowCRealignCGlare,
  referAllowCRealignBNonBye,
} from "../../scenarios/refer-c-realign.js"
import { createSimulatedRunner, expectNoCdr, flushIndexReport } from "../../support/harness.js"
import { ALL_SUTS, DEFAULT_APPLICABLE_SUTS } from "../../../src/test-harness/framework/types.js"

// FIXME(test-framework): pending re-INVITE on charlie + 24h sweep produces a
// fake-clock event-ordering race that prevents 2/3 BYE 200 OK responses from
// resolving the legs. The B2BUA itself is correct — see scenario FIXME for
// the detailed analysis. Once the fake-clock queue ordering is fixed,
// switch to expectCdrCount(name, 1).
expectNoCdr("refer-allow-c-realign-c-timeout")

const OUTPUT_DIR = "test-results/fake-clock"

afterAll(() => {
  flushIndexReport(OUTPUT_DIR)
  for (const sut of ALL_SUTS) {
    flushIndexReport(`${OUTPUT_DIR}/${sut}`)
  }
})

// REFER scenarios apply only to legacy SUTs (b2bonly, proxy+b2b);
// sipproxyHA is reserved for HA scenarios.
for (const sut of DEFAULT_APPLICABLE_SUTS) {
  describe(`E2E (fake clock) — REFER c-realigning phase — ${sut}`, () => {
    const run = createSimulatedRunner({ outputDir: OUTPUT_DIR, sut })

    if (referAllowCRealignHappy.appliesTo(sut)) {
      it.effect(
        "Happy: re-INVITE C with A's SDP → 200 → ACK → phase a-realigning",
        () => run(referAllowCRealignHappy.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (referAllowCRealignCReject488.appliesTo(sut)) {
      it.effect(
        "C rejects re-INVITE 488 → rollback (BYE a, b, c)",
        () => run(referAllowCRealignCReject488.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (referAllowCRealignCTimeout.appliesTo(sut)) {
      it.effect(
        "re-INVITE C timeout (32s TestClock) → rollback",
        () => run(referAllowCRealignCTimeout.toScenario()),
        { timeout: 60_000 },
      )
    }
    if (referAllowCRealignCGlare.appliesTo(sut)) {
      it.effect(
        "C glare re-INVITE during c-realigning → 491",
        () => run(referAllowCRealignCGlare.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (referAllowCRealignBNonBye.appliesTo(sut)) {
      it.effect(
        "B non-BYE during c-realigning → 481",
        () => run(referAllowCRealignBNonBye.toScenario()),
        { timeout: 30_000 },
      )
    }
  })
}
