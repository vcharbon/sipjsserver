/**
 * Stage 4 of docs/plan/to-review-and-properly-swift-moler.md:
 *
 * The platform must refuse to start when `TERMINATING_TIMEOUT_MS` is
 * not large enough to cover `keepaliveIntervalSec*1000 + 60000`.
 * Otherwise a routine silent interval gets mistaken for "call is dead"
 * and the orphan sweep purges live dialogs (the 2026-05-15 cascade).
 */

import { describe, expect, test } from "vitest"
import { TERMINATING_TIMEOUT_MS } from "../../src/call/timer-helpers.js"
import { validateTerminatingTimeoutConsistency } from "../../src/config/AppConfig.js"
import type { AppConfigData } from "../../src/config/AppConfig.js"

function minimalCfg(overrides: Partial<AppConfigData>): AppConfigData {
  // Validator only reads `keepaliveIntervalSec`. Any cast through `as`
  // keeps this test independent of churn in unrelated config fields.
  return overrides as unknown as AppConfigData
}

describe("AppConfig — terminating-timeout consistency validator", () => {
  test("passes when TERMINATING_TIMEOUT_MS exceeds keepaliveIntervalSec*1000 + 60_000", () => {
    // Floor at TERMINATING_TIMEOUT_MS - 60_001 (in seconds) gives the
    // largest passing keepalive interval.
    const maxPassingSec = Math.floor((TERMINATING_TIMEOUT_MS - 60_001) / 1000)
    expect(() =>
      validateTerminatingTimeoutConsistency(
        minimalCfg({ keepaliveIntervalSec: maxPassingSec }),
      ),
    ).not.toThrow()
  })

  test("rejects when keepaliveIntervalSec is too high relative to the safety constant", () => {
    // Force the constraint violation by going well above the floor.
    const violatingSec = Math.ceil(TERMINATING_TIMEOUT_MS / 1000) + 1
    expect(() =>
      validateTerminatingTimeoutConsistency(
        minimalCfg({ keepaliveIntervalSec: violatingSec }),
      ),
    ).toThrowError(/TERMINATING_TIMEOUT_MS .* must exceed/)
  })

  test("rejects exact equality (validator uses strict greater-than via the +60s margin)", () => {
    // Pick the boundary: keepaliveIntervalSec*1000 + 60_000 === TERMINATING_TIMEOUT_MS.
    // Requires TERMINATING_TIMEOUT_MS - 60_000 to be divisible by 1000 in seconds.
    const boundarySec = (TERMINATING_TIMEOUT_MS - 60_000) / 1000
    if (!Number.isInteger(boundarySec)) return // skip when constant doesn't align
    expect(() =>
      validateTerminatingTimeoutConsistency(
        minimalCfg({ keepaliveIntervalSec: boundarySec }),
      ),
    ).toThrowError(/must exceed/)
  })
})
