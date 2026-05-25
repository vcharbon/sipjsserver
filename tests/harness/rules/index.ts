/**
 * Rule registry — exports every rule as a flat array.
 *
 * The RFC pack moved off the recording-driven RuleEngine to
 * `SignalingNetwork.scopedAudit` (see
 * `tests/harness/rules/rfc/starter-peer-rules.ts` +
 * `cross-message-rules.ts`). The remaining call-shape / service-case /
 * cross-call families still flow through `RuleEngine` via
 * `tests/harness/runner.ts` until Slice 14 collapses the runner.
 */

import type { Rule } from "./types.js"
import { callShapeRules } from "./call-shape/index.js"
import { serviceCaseRules } from "./service-case/index.js"
import { crossCallRules } from "./cross-call/index.js"

export const allRules: ReadonlyArray<Rule> = [
  ...callShapeRules,
  ...serviceCaseRules,
  ...crossCallRules,
]
