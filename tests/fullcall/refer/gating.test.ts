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
 *
 * Runs against both SUT topologies (`b2bonly`, `proxy+b2b`).
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
} from "../../scenarios/refer-gating.js"
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
  describe(`E2E (fake clock) — REFER Regime-1 transparency + Regime-2 gating — ${sut}`, () => {
    const run = createSimulatedRunner({ outputDir: OUTPUT_DIR, sut })

    if (referGatingAReinviteRefAuthorizing.appliesTo(sut)) {
      it.effect(
        "A re-INVITE during refer-authorizing → relay to B",
        () => run(referGatingAReinviteRefAuthorizing.toScenario()),
        { timeout: 60_000 },
      )
    }
    if (referGatingAReinviteCRinging.appliesTo(sut)) {
      it.effect(
        "A re-INVITE during c-ringing → relay to B",
        () => run(referGatingAReinviteCRinging.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (referGatingAReinviteCRealigning.appliesTo(sut)) {
      it.effect(
        "A re-INVITE during c-realigning → 491",
        () => run(referGatingAReinviteCRealigning.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (referGatingAInfoRefAuthorizing.appliesTo(sut)) {
      it.effect(
        "A INFO during refer-authorizing → relay to B",
        () => run(referGatingAInfoRefAuthorizing.toScenario()),
        { timeout: 60_000 },
      )
    }
    if (referGatingAInfoCRinging.appliesTo(sut)) {
      it.effect(
        "A INFO during c-ringing → relay to B",
        () => run(referGatingAInfoCRinging.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (referGatingBInfoRefAuthorizing.appliesTo(sut)) {
      it.effect(
        "B INFO during refer-authorizing → relay to A",
        () => run(referGatingBInfoRefAuthorizing.toScenario()),
        { timeout: 60_000 },
      )
    }
    if (referGatingSecondReferCRinging.appliesTo(sut)) {
      it.effect(
        "Second REFER during c-ringing → 491",
        () => run(referGatingSecondReferCRinging.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (referGatingSecondReferCRealigning.appliesTo(sut)) {
      it.effect(
        "Second REFER during c-realigning → 491",
        () => run(referGatingSecondReferCRealigning.toScenario()),
        { timeout: 30_000 },
      )
    }
  })
}
