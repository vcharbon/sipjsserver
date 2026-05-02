/**
 * REFER allow-path e2e suite (slice 5).
 *
 * Drives the simulated B2BUA through the C-leg lifecycle from REFER
 * authorisation up to (but not including) re-INVITEs. Slices 6/7 add the
 * c-realigning and a-realigning phases on top of this foundation.
 *
 * Runs against both SUT topologies (`b2bonly`, `proxy+b2b`); reports
 * land under `test-results/fake-clock/<sut>/`.
 */

import { describe, it } from "@effect/vitest"
import { afterAll } from "vitest"
import {
  referAllowHappy,
  referAllowC486,
  referAllowC603,
  referAllowCNoAnswer,
  referAllowCMultiple18x,
} from "../../scenarios/refer-allow.js"
import { createSimulatedRunner, flushIndexReport } from "../../support/harness.js"
import { ALL_SUTS, DEFAULT_APPLICABLE_SUTS } from "../../../src/test-harness/framework/types.js"

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
  describe(`E2E (fake clock) — REFER allow path (C leg lifecycle) — ${sut}`, () => {
    const run = createSimulatedRunner({ outputDir: OUTPUT_DIR, sut })

    if (referAllowHappy.appliesTo(sut)) {
      it.effect(
        "Happy: REFER → 202 → NOTIFY 100/180 active → C 200 → ACK → NOTIFY 200 terminated",
        () => run(referAllowHappy.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (referAllowC486.appliesTo(sut)) {
      it.effect(
        "C rejects 486 Busy Here → NOTIFY 486 terminated",
        () => run(referAllowC486.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (referAllowC603.appliesTo(sut)) {
      it.effect(
        "C rejects 603 Declined → NOTIFY 603 terminated",
        () => run(referAllowC603.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (referAllowCNoAnswer.appliesTo(sut)) {
      it.effect(
        "C no-answer: NOTIFY 408 terminated after no-answer timer",
        () => run(referAllowCNoAnswer.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (referAllowCMultiple18x.appliesTo(sut)) {
      it.effect(
        "Multiple 18x from C dedup: 180 → 183 → 180 → duplicate 180 → 3 NOTIFYs",
        () => run(referAllowCMultiple18x.toScenario()),
        { timeout: 30_000 },
      )
    }
  })
}
