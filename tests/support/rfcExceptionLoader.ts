/**
 * Filters `RFC_EXCEPTIONS` (the central declared exemptions list) down
 * to those that apply to the currently-running vitest test, and
 * enforces the "DUT can never be exempted" invariant.
 *
 * Used by `stackLayer({ mode: "fake", ... })` at layer-build time. Live
 * mode skips this — exemptions only apply to the audited fake stack.
 *
 * See: docs/plan/extending-sip-rfc-test-temporal-jellyfish.md (Phase 0 §3)
 */

import { expect } from "vitest"
import type {
  RfcException as ScopedAuditRfcException,
} from "../../src/sip/SignalingNetwork.contracts.js"
import type { RfcException } from "../harness/rules/rfc/exceptions.js"

const NO_TEST_PATH = "<<no-test-path-resolved>>"

/**
 * Resolve the current vitest `testPath` from the global `expect`
 * state. Returns a sentinel when called outside a test context.
 */
function currentTestPath(): string {
  try {
    const state = expect.getState()
    return state.testPath ?? NO_TEST_PATH
  } catch {
    return NO_TEST_PATH
  }
}

export interface ResolveOptions {
  /**
   * The DUT bind key (`"ip:port"`). Any exception entry whose
   * `peerBindKey` equals this string throws at resolution time.
   */
  readonly dutBindKey: string
}

/**
 * Returns the subset of `RFC_EXCEPTIONS` that apply to the current
 * test, transformed into the shape `ScopedAuditOptions.exceptions`
 * expects. Throws if any matched entry names the DUT bind.
 */
export function resolveRfcExceptions(
  entries: ReadonlyArray<RfcException>,
  opts: ResolveOptions,
): ReadonlyArray<ScopedAuditRfcException> {
  const path = currentTestPath()
  const out: ScopedAuditRfcException[] = []
  for (const e of entries) {
    if (!path.endsWith(e.testPath)) continue
    if (!e.justification || e.justification.trim().length === 0) {
      throw new Error(
        `RFC exception for ${e.testPath} / ${e.ruleName} is missing a justification`,
      )
    }
    if (e.peerBindKey !== undefined && e.peerBindKey === opts.dutBindKey) {
      throw new Error(
        `RFC exception for ${e.testPath} / ${e.ruleName} names the DUT bind ` +
          `(${opts.dutBindKey}) as its peer. DUT cannot be exempted; if DUT is ` +
          `the violator, it's a real B2BUA bug — open a precursor plan.`,
      )
    }
    out.push({
      ruleName: e.ruleName,
      peerBindKey: e.peerBindKey,
      justification: e.justification,
    })
  }
  return out
}
