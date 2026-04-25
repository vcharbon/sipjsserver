/**
 * Rule registry — exports every rule as a flat array.
 */

import type { Rule } from "./types.js"
import { rfcRules } from "./rfc/index.js"
import { callShapeRules } from "./call-shape/index.js"
import { serviceCaseRules } from "./service-case/index.js"
import { crossCallRules } from "./cross-call/index.js"

export const allRules: ReadonlyArray<Rule> = [
  ...rfcRules,
  ...callShapeRules,
  ...serviceCaseRules,
  ...crossCallRules,
]
