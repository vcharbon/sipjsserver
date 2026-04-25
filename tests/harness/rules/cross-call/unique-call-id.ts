/**
 * cross-call: unique-call-id — sanity check that every recording in
 * a multi-call run was bucketed under a distinct logical Call-ID.
 *
 * Multi-call runs rely on Call-ID demux (see recording-extractor.ts):
 * if two calls collide on Call-ID the recordings would merge silently
 * and other rules would behave strangely. This rule fires when that
 * happens.
 */

import type { CrossCallRule, RuleViolation } from "../types.js"

export const uniqueCallIdRule: CrossCallRule = {
  name: "cross-call.unique-call-id",
  family: "cross-call",
  description: "Each recording in a multi-call run must have a distinct Call-ID",
  evaluate({ recordings }) {
    const violations: RuleViolation[] = []
    const seen = new Map<string, number>()
    for (const r of recordings) {
      const prev = seen.get(r.callId)
      if (prev !== undefined) {
        violations.push({
          message: `Call-ID "${r.callId}" appears in multiple recordings (count=${prev + 1})`,
        })
        seen.set(r.callId, prev + 1)
      } else {
        seen.set(r.callId, 1)
      }
    }
    return violations
  },
}
