/**
 * call-shape: all-expected-received — every leg/alice declared by the
 * ServiceCase must appear in the run as a whole.
 *
 * This is a cross-call rule because in multi-call scenarios each leg/
 * alice belongs to one specific call's recording, not all of them. The
 * rule scans every recording and only complains if a declared agent
 * never produced its initial INVITE anywhere in the run.
 *
 * INVITE detection works off raw bytes: YAML fixtures never populate
 * the `parsed` field, and the start line of an INVITE is unambiguous.
 */

import type { CrossCallRule, RuleViolation } from "../types.js"

export const allExpectedReceivedRule: CrossCallRule = {
  name: "call-shape.all-expected-received",
  family: "cross-call",
  description: "Every ServiceCase leg/alice INVITE must appear somewhere in the run",
  evaluate({ recordings, serviceCase }) {
    const violations: RuleViolation[] = []
    if (!serviceCase) return violations

    const isInvite = (raw: string): boolean => raw.startsWith("INVITE ")

    for (const leg of serviceCase.legs) {
      const matched = recordings.some((rec) =>
        rec.entries.some((e) => {
          if (e.kind !== "message") return false
          if (e.direction !== "received") return false
          if (e.to !== leg.name) return false
          return isInvite(e.raw)
        })
      )
      if (!matched) {
        violations.push({
          message: `Expected INVITE arriving at leg "${leg.name}" was never received`,
        })
      }
    }
    for (const alice of serviceCase.alices) {
      const matched = recordings.some((rec) =>
        rec.entries.some((e) => {
          if (e.kind !== "message") return false
          if (e.direction !== "sent") return false
          if (e.from !== alice.name) return false
          return isInvite(e.raw)
        })
      )
      if (!matched) {
        violations.push({
          message: `Expected INVITE sent by alice "${alice.name}" was never observed`,
        })
      }
    }
    return violations
  },
}
