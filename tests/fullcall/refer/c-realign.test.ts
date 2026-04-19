/**
 * REFER c-realigning phase e2e suite (slice 6).
 *
 * Covers the B2BUA-originated re-INVITE on C carrying A's SDP and the
 * resulting phase transition to `a-realigning`. Slice 7 adds the re-INVITE
 * A exchange — this slice stops once the B2BUA has ACKed C's 200 for the
 * re-INVITE (or rolled back on failure).
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
import { createSimulatedRunner, flushIndexReport } from "../../support/harness.js"

const OUTPUT_DIR = "test-results/fake-clock"

afterAll(() => {
  flushIndexReport(OUTPUT_DIR)
})

describe("E2E (fake clock) — REFER c-realigning phase", () => {
  const run = createSimulatedRunner({
    sipPort: 15063,
    httpPort: 13005,
    outputDir: OUTPUT_DIR,
  })

  it.effect(
    "Happy: re-INVITE C with A's SDP → 200 → ACK → phase a-realigning",
    () => run(referAllowCRealignHappy.toScenario()),
    { timeout: 30_000 },
  )

  it.effect(
    "C rejects re-INVITE 488 → rollback (BYE a, b, c)",
    () => run(referAllowCRealignCReject488.toScenario()),
    { timeout: 30_000 },
  )

  it.effect(
    "re-INVITE C timeout (32s TestClock) → rollback",
    () => run(referAllowCRealignCTimeout.toScenario()),
    { timeout: 60_000 },
  )

  it.effect(
    "C glare re-INVITE during c-realigning → 491",
    () => run(referAllowCRealignCGlare.toScenario()),
    { timeout: 30_000 },
  )

  it.effect(
    "B non-BYE during c-realigning → 481",
    () => run(referAllowCRealignBNonBye.toScenario()),
    { timeout: 30_000 },
  )
})
