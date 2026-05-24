/**
 * Validator: TERMINATING_TIMEOUT_MS must be ≥ 1 s.
 *
 * Pre-2026-05-23 contract: validator gated against
 * `keepaliveIntervalSec*1000 + 60_000` to prevent an OPTIONS keepalive
 * gap from being mistaken for a stuck terminating call (always-refresh
 * contract). That contract was replaced by the per-leg refresh budget
 * (Fix A1) — keepalive cadence no longer constrains the timeout, so
 * the validator now only enforces a sanity floor (1 s).
 *
 * See `validateTerminatingTimeoutConsistency` for the rationale.
 */

import { describe, expect, test } from "vitest"
import { TERMINATING_TIMEOUT_MS } from "../../src/call/timer-helpers.js"
import { validateTerminatingTimeoutConsistency } from "../../src/config/AppConfig.js"
import type { AppConfigData } from "../../src/config/AppConfig.js"

function minimalCfg(overrides: Partial<AppConfigData>): AppConfigData {
  return overrides as unknown as AppConfigData
}

describe("AppConfig — terminating-timeout consistency validator", () => {
  test("passes for the current constant regardless of keepaliveIntervalSec", () => {
    // Constant is currently 32 s (SIP retransmission absorption window).
    // The validator is now keepalive-independent.
    expect(TERMINATING_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000)
    expect(() =>
      validateTerminatingTimeoutConsistency(minimalCfg({ keepaliveIntervalSec: 30 })),
    ).not.toThrow()
    expect(() =>
      validateTerminatingTimeoutConsistency(minimalCfg({ keepaliveIntervalSec: 900 })),
    ).not.toThrow()
    expect(() =>
      validateTerminatingTimeoutConsistency(minimalCfg({ keepaliveIntervalSec: 86_400 })),
    ).not.toThrow()
  })
})
