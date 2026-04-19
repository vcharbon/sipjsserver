/**
 * REFER full-transfer e2e suite (slice 7).
 *
 * Drives REFER → c-realigning → a-realigning → merge(a, c) to completion, and
 * the rollback paths when A rejects, glares, or hangs up on the a-realign
 * re-INVITE, or fails to answer it within 32 s.
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
import { createSimulatedRunner, flushIndexReport } from "../../support/harness.js"

const OUTPUT_DIR = "test-results/fake-clock"

afterAll(() => {
  flushIndexReport(OUTPUT_DIR)
})

describe("E2E (fake clock) — REFER full transfer (re-INVITE A + merge)", () => {
  const run = createSimulatedRunner({
    sipPort: 15064,
    httpPort: 13006,
    outputDir: OUTPUT_DIR,
  })

  it.effect(
    "Happy: re-INVITE C → 200 → re-INVITE A → 200 → merge(a, c)",
    () => run(referAllowFullHappy.toScenario()),
    { timeout: 30_000 },
  )

  it.effect(
    "A rejects re-INVITE 488 → rollback (BYE a, b, c)",
    () => run(referAllowFullARejectRealign.toScenario()),
    { timeout: 30_000 },
  )

  it.effect(
    "A glare re-INVITE during a-realigning → 491",
    () => run(referAllowFullAGlareReinvite.toScenario()),
    { timeout: 30_000 },
  )

  it.effect(
    "A BYEs while a-realign re-INVITE outstanding → teardown",
    () => run(referAllowFullABye.toScenario()),
    { timeout: 30_000 },
  )

  it.effect(
    "re-INVITE A timeout (33s TestClock) → rollback",
    () => run(referAllowFullATimeout.toScenario()),
    { timeout: 60_000 },
  )
})
