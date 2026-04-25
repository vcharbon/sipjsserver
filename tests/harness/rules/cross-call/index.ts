import type { Rule } from "../types.js"
import { uniqueCallIdRule } from "./unique-call-id.js"
import { limiterConcurrencyRule } from "./limiter-concurrency.js"

export const crossCallRules: ReadonlyArray<Rule> = [
  uniqueCallIdRule,
  limiterConcurrencyRule,
]
