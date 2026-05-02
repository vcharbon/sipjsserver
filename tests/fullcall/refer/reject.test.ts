/**
 * REFER reject-path e2e suite (slice 4).
 *
 * Each test drives the simulated B2BUA through one reject branch of the
 * TransferRules chain. The suite runs under fake clock so `refer-http-timeout`
 * and `refer-subscription-expiry` timers can be advanced deterministically.
 *
 * Runs against both SUT topologies (`b2bonly`, `proxy+b2b`); reports
 * land under `test-results/fake-clock/<sut>/`.
 */

import { describe, it } from "@effect/vitest"
import { afterAll } from "vitest"
import {
  referRejectHttp403,
  referHttpTimeout,
  referReplacesRejected,
  referOutOfDialog,
  referSecondDuringAuthorizing,
} from "../../scenarios/refer-reject.js"
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
  describe(`E2E (fake clock) — REFER reject paths — ${sut}`, () => {
    const run = createSimulatedRunner({ outputDir: OUTPUT_DIR, sut })

    if (referRejectHttp403.appliesTo(sut)) {
      it.effect(
        "REFER → HTTP reject 403: 202 + NOTIFY 100 active + NOTIFY 403 terminated",
        () => run(referRejectHttp403.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (referHttpTimeout.appliesTo(sut)) {
      it.effect(
        "REFER → HTTP hangs: 202 + NOTIFY 100, after 60s NOTIFY 500 terminated",
        () => run(referHttpTimeout.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (referReplacesRejected.appliesTo(sut)) {
      it.effect(
        "REFER with Replaces= → 501 Not Implemented",
        () => run(referReplacesRejected.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (referOutOfDialog.appliesTo(sut)) {
      it.effect(
        "REFER out-of-dialog (unknown Call-ID) → 481",
        () => run(referOutOfDialog.toScenario()),
        { timeout: 30_000 },
      )
    }
    if (referSecondDuringAuthorizing.appliesTo(sut)) {
      it.effect(
        "Second REFER during refer-authorizing → 491",
        () => run(referSecondDuringAuthorizing.toScenario()),
        { timeout: 30_000 },
      )
    }
  })
}
