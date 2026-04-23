/**
 * FeatureActivations validator (SplitServiceLogic.md §D11 / B.3).
 *
 * Enforces the canonical invariants that the Schema can't express on its own:
 *
 *   1. `platform.maxDurationSec` must be > 0 and ≤ the platform ceiling.
 *   2. `platform.keepalive.intervalSec` and `.maxMissed` must be > 0.
 *   3. Optional arms (refer, relayFirst18xTo180, noAnswerTimeoutSec,
 *      callLimiters) — sanity bounds only; absent arms mean "disabled."
 *
 * Every failure is a `CallDecisionError(kind: "semantic-violation")`. The
 * caller (adapter) upgrades this into the ADT tier that drives SIP response
 * + metric + log level.
 */

import {
  CallDecisionError,
  type CallDecisionMethod,
} from "../schemas/errors.js"
import type { FeatureActivations } from "../schemas/features.js"

export interface ValidateFeaturesOptions {
  /** Upper cap (seconds) — platform refuses `maxDurationSec` above this. */
  readonly platformMaxDurationCapSec: number
}

export function validateFeatureActivations(
  adapterName: string,
  method: CallDecisionMethod,
  features: FeatureActivations,
  options: ValidateFeaturesOptions,
): CallDecisionError | null {
  const platform = features.platform
  if (platform.maxDurationSec <= 0) {
    return mkError(
      adapterName,
      method,
      `platform.maxDurationSec must be > 0 (got ${platform.maxDurationSec})`,
    )
  }
  if (platform.maxDurationSec > options.platformMaxDurationCapSec) {
    return mkError(
      adapterName,
      method,
      `platform.maxDurationSec (${platform.maxDurationSec}s) exceeds platform ceiling ${options.platformMaxDurationCapSec}s`,
    )
  }
  if (platform.keepalive.intervalSec <= 0) {
    return mkError(
      adapterName,
      method,
      `platform.keepalive.intervalSec must be > 0 (got ${platform.keepalive.intervalSec})`,
    )
  }
  if (platform.keepalive.maxMissed <= 0) {
    return mkError(
      adapterName,
      method,
      `platform.keepalive.maxMissed must be > 0 (got ${platform.keepalive.maxMissed})`,
    )
  }

  if (features.noAnswerTimeoutSec !== undefined && features.noAnswerTimeoutSec <= 0) {
    return mkError(
      adapterName,
      method,
      `noAnswerTimeoutSec must be > 0 (got ${features.noAnswerTimeoutSec})`,
    )
  }
  if (features.refer?.maxChainDepth !== undefined && features.refer.maxChainDepth < 0) {
    return mkError(
      adapterName,
      method,
      `refer.maxChainDepth must be ≥ 0 (got ${features.refer.maxChainDepth})`,
    )
  }
  if (features.callLimiters !== undefined) {
    for (const entry of features.callLimiters) {
      if (entry.limit <= 0) {
        return mkError(
          adapterName,
          method,
          `callLimiter "${entry.id}" limit must be > 0 (got ${entry.limit})`,
        )
      }
    }
  }
  return null
}

function mkError(adapterName: string, method: CallDecisionMethod, detail: string): CallDecisionError {
  return new CallDecisionError({
    kind: "semantic-violation",
    adapterName,
    method,
    detail,
    cause: { reason: "feature-activations" },
  })
}
