import type { Rule } from "../types.js"
import { serviceCaseFieldChecksRule } from "./field-checks.js"

export const serviceCaseRules: ReadonlyArray<Rule> = [
  serviceCaseFieldChecksRule,
]
