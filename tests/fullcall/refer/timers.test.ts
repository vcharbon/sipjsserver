/**
 * REFER safety-timer e2e suite (slice 8).
 *
 * Targeted tests for transfer-specific timers. Each timer has its own test
 * run with fake clock advancement. `refer_subscription_expiry`,
 * `no_answer_timeout`, and `refer_reinvite_answer` are exercised by tests
 * elsewhere — see scenarios/refer-timers.ts for cross-references. This file
 * adds the explicit `refer_overall_safety` test (the safety net that only
 * fires when no per-phase watchdog caught the stuck state).
 */

import { describe, it } from "@effect/vitest"
import { afterAll } from "vitest"
import { referOverallSafetyFires } from "../../scenarios/refer-timers.js"
import { createSimulatedRunner, flushIndexReport } from "../../support/harness.js"

const OUTPUT_DIR = "test-results/fake-clock"

afterAll(() => {
  flushIndexReport(OUTPUT_DIR)
})

describe("E2E (fake clock) — REFER safety timers", () => {
  const run = createSimulatedRunner({
    sipPort: 15065,
    httpPort: 13007,
    outputDir: OUTPUT_DIR,
    configOverrides: {
      // Push the per-phase re-INVITE watchdog past the overall-safety timer
      // so the overall-safety net trips first when c-realigning stalls.
      referReinviteAnswerSec: 600,
      referOverallSafetySec: 10,
    },
  })

  it.effect(
    "Stuck in c-realigning → overall-safety (10s) fires → rollback",
    () => run(referOverallSafetyFires.toScenario()),
    { timeout: 30_000 },
  )
})
