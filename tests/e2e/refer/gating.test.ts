/**
 * REFER Regime-1 transparency + Regime-2 gating e2e suite (slice 9).
 *
 * Verifies the gating matrix:
 *   - Regime 1 (refer-authorizing, c-ringing): A/B re-INVITEs and INFOs relay
 *     transparently through the normal relay-* rules.
 *   - Regime 2 (c-realigning, a-realigning): A re-INVITE returns 491 via the
 *     transfer-a-glare-reinvite rule (extended in slice 9 to cover both
 *     realigning phases).
 *   - Second REFER during any active transfer phase returns 491 via
 *     transfer-reject-second-refer.
 *
 * Rows already covered elsewhere (and omitted here):
 *   - A re-INVITE during a-realigning → 491        (refer-full-transfer.ts)
 *   - B non-BYE during c-realigning  → 481         (refer-c-realign.ts)
 *   - Second REFER during refer-authorizing → 491  (refer-reject.ts)
 */

import { describe, it } from "@effect/vitest"
import { afterAll } from "vitest"
import {
  referGatingAReinviteRefAuthorizing,
  referGatingAReinviteCRinging,
  referGatingAReinviteCRealigning,
  referGatingAInfoRefAuthorizing,
  referGatingAInfoCRinging,
  referGatingBInfoRefAuthorizing,
  referGatingSecondReferCRinging,
  referGatingSecondReferCRealigning,
} from "../scenarios/refer-gating.js"
import { createSimulatedRunner, flushIndexReport } from "../helpers/harness.js"

const OUTPUT_DIR = "test-results/fake-clock"

afterAll(() => {
  flushIndexReport(OUTPUT_DIR)
})

describe("E2E (fake clock) — REFER Regime-1 transparency + Regime-2 gating", () => {
  const run = createSimulatedRunner({
    sipPort: 15066,
    httpPort: 13008,
    outputDir: OUTPUT_DIR,
  })

  it.effect(
    "A re-INVITE during refer-authorizing → relay to B",
    () => run(referGatingAReinviteRefAuthorizing.toScenario()),
    { timeout: 60_000 },
  )

  it.effect(
    "A re-INVITE during c-ringing → relay to B",
    () => run(referGatingAReinviteCRinging.toScenario()),
    { timeout: 30_000 },
  )

  it.effect(
    "A re-INVITE during c-realigning → 491",
    () => run(referGatingAReinviteCRealigning.toScenario()),
    { timeout: 30_000 },
  )

  it.effect(
    "A INFO during refer-authorizing → relay to B",
    () => run(referGatingAInfoRefAuthorizing.toScenario()),
    { timeout: 60_000 },
  )

  it.effect(
    "A INFO during c-ringing → relay to B",
    () => run(referGatingAInfoCRinging.toScenario()),
    { timeout: 30_000 },
  )

  it.effect(
    "B INFO during refer-authorizing → relay to A",
    () => run(referGatingBInfoRefAuthorizing.toScenario()),
    { timeout: 60_000 },
  )

  it.effect(
    "Second REFER during c-ringing → 491",
    () => run(referGatingSecondReferCRinging.toScenario()),
    { timeout: 30_000 },
  )

  it.effect(
    "Second REFER during c-realigning → 491",
    () => run(referGatingSecondReferCRealigning.toScenario()),
    { timeout: 30_000 },
  )
})
