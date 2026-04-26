/**
 * Rule `rfc.allowSupportedOnInvite` — RFC 3261 §13.2.1, §20.37.
 *
 * `Allow:` SHOULD be present on 2xx responses to INVITE so the peer
 * knows what methods this UA accepts. `Supported:` SHOULD be present on
 * the same responses (and on re-INVITEs) so the peer knows which
 * extensions can be Required.
 *
 * Strict by default: missing either header on a 2xx-INVITE response or
 * on a re-INVITE request fires a violation. Suites that don't yet emit
 * the headers can opt out via `disableRules`.
 *
 * Scope: received messages (every recorded message is observed by some
 * agent on the wire).
 */

import type { PerCallRule, RuleViolation } from "../types.js"
import { eventsByAgent, getHeaderValue } from "./_replay.js"

export const allowSupportedOnInviteRule: PerCallRule = {
  name: "rfc.allowSupportedOnInvite",
  family: "rfc",
  description: "RFC 3261 §13.2.1 / §20.37: Allow: and Supported: on INVITE 2xx and re-INVITEs",
  evaluate(ctx) {
    const violations: RuleViolation[] = []
    const byAgent = eventsByAgent(ctx.recording)

    for (const [agent, events] of byAgent.entries()) {
      // Track received initial INVITE branch per Call-ID so we can tell a
      // re-INVITE apart at receive time.
      const initialInviteBranchByCallId = new Map<string, string>()

      for (const ev of events) {
        if (ev.kind !== "received") continue
        const msg = ev.msg

        if (msg.type === "request" && msg.method === "INVITE") {
          const callId = msg.parsed.callId
          const branch = msg.parsed.via.branch ?? ""
          const isInitial = !initialInviteBranchByCallId.has(callId)
          if (isInitial) {
            initialInviteBranchByCallId.set(callId, branch)
            continue
          }
          // re-INVITE.
          checkAllowSupported(violations, agent, ev.idx, "re-INVITE", msg.headers)
          continue
        }

        if (
          msg.type === "response" &&
          msg.status >= 200 && msg.status < 300 &&
          msg.parsed.cseq.method === "INVITE"
        ) {
          checkAllowSupported(violations, agent, ev.idx, `${msg.status} OK INVITE`, msg.headers)
        }
      }
    }

    return violations
  },
}

function checkAllowSupported(
  out: RuleViolation[],
  agent: string,
  entryIndex: number,
  label: string,
  headers: ReadonlyArray<{ name: string; value: string }>
): void {
  const allow = getHeaderValue(headers, "allow")
  if (!allow) {
    out.push({
      message:
        `[rfc.allowSupportedOnInvite] agent=${agent}: ${label} missing Allow: ` +
        `header — RFC 3261 §13.2.1 (SHOULD list accepted methods)`,
      entryIndex,
      details: { agent, label, missing: "Allow" },
    })
  }
  const supported = getHeaderValue(headers, "supported")
  if (supported === undefined) {
    out.push({
      message:
        `[rfc.allowSupportedOnInvite] agent=${agent}: ${label} missing Supported: ` +
        `header — RFC 3261 §20.37 (SHOULD list extensions for Require negotiation)`,
      entryIndex,
      details: { agent, label, missing: "Supported" },
    })
  }
}
