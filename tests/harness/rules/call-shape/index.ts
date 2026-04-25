import type { Rule } from "../types.js"
import { allExpectedReceivedRule } from "./all-expected-received.js"
import { noUnexpectedRule } from "./no-unexpected.js"

export const callShapeRules: ReadonlyArray<Rule> = [
  noUnexpectedRule,
  allExpectedReceivedRule,
]
