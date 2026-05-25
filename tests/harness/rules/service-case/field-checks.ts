/**
 * service-case: field-checks — runs each ServiceCase-declared check
 * (eq | regex) against the appropriate recorded message.
 *
 * Vocabulary (per Q5/Q10):
 *   - alice.checks.inviteTo / inviteFrom / inviteRuri → asserted on the
 *     INVITE alice sent (received by the DUT, observed at alice's wire
 *     as `direction: sent` from alice).
 *   - leg.checks.inviteTo / inviteFrom / inviteRuri → asserted on the
 *     INVITE the leg received from the DUT.
 *   - inviteHeaders/responseHeaders → check named header values.
 *
 * The matching uses parsed messages where available; YAML fixtures
 * (rule self-tests) parse on demand via SipParser.
 */

import { Effect } from "effect"
import { SipParser } from "../../../../src/sip/Parser.js"
import { getHeader } from "../../../../src/sip/MessageHelpers.js"
import type { SipMessage } from "../../../../src/sip/types.js"
import type {
  PerCallRule,
  RuleTrace,
  RuleTraceMessage,
  RuleViolation,
} from "../types.js"
import { applyCheck, type Check } from "../../service-case/types.js"

function parsedOf(e: RuleTraceMessage): SipMessage | null {
  if (e.parsed) return e.parsed
  const eff = Effect.gen(function* () {
    const parser = yield* SipParser
    return yield* parser.parse(Buffer.from(e.raw, "utf8"))
  }).pipe(Effect.provide(SipParser.layer), Effect.result)
  const result = Effect.runSync(eff)
  if (result._tag === "Failure") return null
  return result.success
}

function findInvite(
  rec: RuleTrace,
  direction: "sent" | "received",
  agent: string
): { msg: SipMessage; idx: number } | null {
  for (let i = 0; i < rec.entries.length; i++) {
    const e = rec.entries[i]!
    if (e.kind !== "message") continue
    if (e.direction !== direction) continue
    if (direction === "sent" && e.from !== agent) continue
    if (direction === "received" && e.to !== agent) continue
    const msg = parsedOf(e)
    if (!msg) continue
    if (msg.type === "request" && msg.method === "INVITE") {
      return { msg, idx: i }
    }
  }
  return null
}

function applyOptional(
  check: Check | undefined,
  value: string | undefined,
  label: string,
  violations: RuleViolation[]
): void {
  if (!check) return
  if (value === undefined) {
    violations.push({ message: `${label}: header missing` })
    return
  }
  const err = applyCheck(check, value, label)
  if (err) violations.push({ message: err })
}

export const serviceCaseFieldChecksRule: PerCallRule = {
  name: "service-case.field-checks",
  family: "service-case",
  description: "Apply ServiceCase-declared eq/regex checks to labelled messages",
  evaluate(ctx) {
    const violations: RuleViolation[] = []
    const sc = ctx.serviceCase
    if (!sc) return violations

    for (const alice of sc.alices) {
      const found = findInvite(ctx.recording, "sent", alice.name)
      if (!found) continue
      const msg = found.msg
      if (msg.type !== "request") continue
      const checks = alice.checks
      if (!checks) continue
      applyOptional(checks.inviteRuri, msg.uri, `alice[${alice.name}].inviteRuri`, violations)
      applyOptional(checks.inviteTo, getHeader(msg.headers, "to"), `alice[${alice.name}].inviteTo`, violations)
      applyOptional(checks.inviteFrom, getHeader(msg.headers, "from"), `alice[${alice.name}].inviteFrom`, violations)
    }

    for (const leg of sc.legs) {
      const found = findInvite(ctx.recording, "received", leg.name)
      if (!found) continue
      const msg = found.msg
      if (msg.type !== "request") continue
      const checks = leg.checks
      if (!checks) continue
      applyOptional(checks.inviteRuri, msg.uri, `leg[${leg.name}].inviteRuri`, violations)
      applyOptional(checks.inviteTo, getHeader(msg.headers, "to"), `leg[${leg.name}].inviteTo`, violations)
      applyOptional(checks.inviteFrom, getHeader(msg.headers, "from"), `leg[${leg.name}].inviteFrom`, violations)
      if (checks.inviteHeaders) {
        for (const [name, check] of Object.entries(checks.inviteHeaders)) {
          applyOptional(check, getHeader(msg.headers, name), `leg[${leg.name}].inviteHeaders.${name}`, violations)
        }
      }
    }

    return violations
  },
}
