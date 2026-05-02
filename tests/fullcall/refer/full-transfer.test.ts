/**
 * REFER full-transfer e2e suite (slice 7).
 *
 * Drives REFER → c-realigning → a-realigning → merge(a, c) to completion, and
 * the rollback paths when A rejects, glares, or hangs up on the a-realign
 * re-INVITE, or fails to answer it within 32 s.
 *
 * Runs against both SUT topologies (`b2bonly`, `proxy+b2b`).
 */

import { describe, it } from "@effect/vitest"
import { afterAll } from "vitest"
import {
  referAllowFullHappy,
  referAllowFullARejectRealign,
  referAllowFullAGlareReinvite,
  referAllowFullABye,
  referAllowFullATimeout,
} from "../../scenarios/refer-full-transfer.js"
import { createSimulatedRunner, expectNoCdr, flushIndexReport } from "../../support/harness.js"
import { ALL_SUTS, DEFAULT_APPLICABLE_SUTS } from "../../../src/test-harness/framework/types.js"

// FIXME(test-framework): pending re-INVITE on alice + 24h sweep retransmits
// generate "unexpected message" failures. The B2BUA cleanup is correct.
expectNoCdr("refer-allow-full-a-bye-during-a-realign")
expectNoCdr("refer-allow-full-a-reinvite-timeout")

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
  describe(`E2E (fake clock) — REFER full transfer (re-INVITE A + merge) — ${sut}`, () => {
    const run = createSimulatedRunner({ outputDir: OUTPUT_DIR, sut })

    if (referAllowFullHappy.appliesTo(sut)) {
      it.effect(
        "Happy: re-INVITE C → 200 → re-INVITE A → 200 → merge(a, c)",
        () => run(referAllowFullHappy.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (referAllowFullARejectRealign.appliesTo(sut)) {
      it.effect(
        "A rejects re-INVITE 488 → rollback (BYE a, b, c)",
        () => run(referAllowFullARejectRealign.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (referAllowFullAGlareReinvite.appliesTo(sut)) {
      it.effect(
        "A glare re-INVITE during a-realigning → 491",
        () => run(referAllowFullAGlareReinvite.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (referAllowFullABye.appliesTo(sut)) {
      it.effect(
        "A BYEs while a-realign re-INVITE outstanding → teardown",
        () => run(referAllowFullABye.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (referAllowFullATimeout.appliesTo(sut)) {
      it.effect(
        "re-INVITE A timeout (33s TestClock) → rollback",
        () => run(referAllowFullATimeout.toScenario()),
        { timeout: 60_000 },
      )
    }
  })
}
