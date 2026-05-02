/**
 * REFER safety-timer e2e suite (slice 8).
 *
 * Targeted tests for transfer-specific timers. Each timer has its own test
 * run with fake clock advancement. `refer_subscription_expiry`,
 * `no_answer_timeout`, and `refer_reinvite_answer` are exercised by tests
 * elsewhere — see scenarios/refer-timers.ts for cross-references. This file
 * adds the explicit `refer_overall_safety` test (the safety net that only
 * fires when no per-phase watchdog caught the stuck state).
 *
 * Runs against both SUT topologies (`b2bonly`, `proxy+b2b`).
 */

import { describe, it } from "@effect/vitest"
import { afterAll } from "vitest"
import { referOverallSafetyFires } from "../../scenarios/refer-timers.js"
import { createSimulatedRunner, expectNoCdr, flushIndexReport } from "../../support/harness.js"
import { ALL_SUTS, DEFAULT_APPLICABLE_SUTS } from "../../../src/test-harness/framework/types.js"

// FIXME(test-framework): same fake-clock event-ordering race as
// refer-allow-c-realign-c-timeout. The B2BUA is correct; the test
// framework's 24h sweep can't drive the cleanup to completion.
expectNoCdr("refer-overall-safety-fires")

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
  describe(`E2E (fake clock) — REFER safety timers — ${sut}`, () => {
    const run = createSimulatedRunner({
      outputDir: OUTPUT_DIR,
      sut,
      configOverrides: {
        // Push the per-phase re-INVITE watchdog past the overall-safety timer
        // so the overall-safety net trips first when c-realigning stalls.
        referReinviteAnswerSec: 600,
        referOverallSafetySec: 10,
      },
    })

    if (referOverallSafetyFires.appliesTo(sut)) {
      it.effect(
        "Stuck in c-realigning → overall-safety (10s) fires → rollback",
        () => run(referOverallSafetyFires.toScenario()),
        { timeout: 30_000 },
      )
    }
  })
}
