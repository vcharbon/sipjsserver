/**
 * REFER reject-path e2e suite (slice 4).
 *
 * Each test drives the simulated B2BUA through one reject branch of the
 * TransferRules chain. The suite runs under fake clock so `refer-http-timeout`
 * and `refer-subscription-expiry` timers can be advanced deterministically.
 *
 * Coverage results land in `test-results/fake-clock/index.html` — the same
 * output directory as `e2e-fake-clock.test.ts` — so the rule-coverage section
 * accumulates across both files.
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

const OUTPUT_DIR = "test-results/fake-clock"

afterAll(() => {
  flushIndexReport(OUTPUT_DIR)
})

describe("E2E (fake clock) — REFER reject paths", () => {
  // Dedicated SIP/HTTP ports so this file runs in parallel with the main
  // fake-clock suite without port collisions.
  const run = createSimulatedRunner({
    sipPort: 15061,
    httpPort: 13003,
    outputDir: OUTPUT_DIR,
  })

  it.effect(
    "REFER → HTTP reject 403: 202 + NOTIFY 100 active + NOTIFY 403 terminated",
    () => run(referRejectHttp403.toScenario()),
    { timeout: 30_000 },
  )

  it.effect(
    "REFER → HTTP hangs: 202 + NOTIFY 100, after 60s NOTIFY 500 terminated",
    () => run(referHttpTimeout.toScenario()),
    { timeout: 30_000 },
  )

  it.effect(
    "REFER with Replaces= → 501 Not Implemented",
    () => run(referReplacesRejected.toScenario()),
    { timeout: 30_000 },
  )

  it.effect(
    "REFER out-of-dialog (unknown Call-ID) → 481",
    () => run(referOutOfDialog.toScenario()),
    { timeout: 30_000 },
  )

  it.effect(
    "Second REFER during refer-authorizing → 491",
    () => run(referSecondDuringAuthorizing.toScenario()),
    { timeout: 30_000 },
  )
})
