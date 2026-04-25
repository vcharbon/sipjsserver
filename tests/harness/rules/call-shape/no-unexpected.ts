/**
 * call-shape: no-unexpected — every recorded message must have been
 * expected by the driver. Migrated from the existing interpreter
 * `checkUnexpectedMessages` sweep, but now post-hoc.
 */

import type { PerCallRule } from "../types.js"

export const noUnexpectedRule: PerCallRule = {
  name: "call-shape.no-unexpected",
  family: "call-shape",
  description: "Every received message must match a driver expect step",
  evaluate(ctx) {
    const violations = []
    for (let i = 0; i < ctx.recording.entries.length; i++) {
      const e = ctx.recording.entries[i]!
      if (e.kind !== "message") continue
      if (e.unexpected) {
        violations.push({
          message: `Unexpected message at entry ${i}: ${e.direction} ${e.from}→${e.to}`,
          entryIndex: i,
        })
      }
    }
    return violations
  },
}
