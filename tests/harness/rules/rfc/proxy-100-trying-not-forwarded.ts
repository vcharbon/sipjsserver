/**
 * Rule `rfc.proxy100TryingNotForwarded` — RFC 3261 §16.7 step 5.
 *
 * A stateful proxy MUST NOT forward 100 Trying upstream — provisional
 * responses other than 100 are forwarded; 100 itself is hop-by-hop and
 * the upstream proxy/UAC's transaction is already in Proceeding from
 * the proxy's own 100.
 *
 * Topology-agnostic detector: if any single agent's `received` view
 * contains more than one 100 Trying correlated to the same INVITE
 * (matched by sent-INVITE branch), the upstream hop forwarded a
 * downstream 100 it should have absorbed.
 */

import type { PerCallRule, RuleViolation } from "../types.js"
import { eventsByAgent } from "./_replay.js"

export const proxy100TryingNotForwardedRule: PerCallRule = {
  name: "rfc.proxy100TryingNotForwarded",
  family: "rfc",
  description: "RFC 3261 §16.7: stateful proxy MUST NOT forward 100 Trying upstream",
  evaluate(ctx) {
    const violations: RuleViolation[] = []
    const byAgent = eventsByAgent(ctx.recording)

    for (const [agent, events] of byAgent.entries()) {
      // Per (callId|cseq) count of received 100 Trying — keyed off the
      // INVITE this agent sent (we are upstream).
      const sentInviteKey = new Map<string, { branch: string; idx: number }>()
      const tryingCountByKey = new Map<string, number>()

      for (const ev of events) {
        if (ev.kind === "sent" && ev.msg.type === "request" && ev.msg.method === "INVITE") {
          const callId = ev.msg.getHeader("call-id")
          const cseq = ev.msg.getHeader("cseq").seq
          const key = `${callId}|${cseq}`
          if (!sentInviteKey.has(key)) {
            sentInviteKey.set(key, { branch: ev.msg.getHeader("via")[0].branch ?? "", idx: ev.idx })
          }
          continue
        }
        if (
          ev.kind === "received" &&
          ev.msg.type === "response" &&
          ev.msg.status === 100 &&
          ev.msg.getHeader("cseq").method === "INVITE"
        ) {
          const callId = ev.msg.getHeader("call-id")
          const cseq = ev.msg.getHeader("cseq").seq
          const key = `${callId}|${cseq}`
          if (!sentInviteKey.has(key)) continue
          const next = (tryingCountByKey.get(key) ?? 0) + 1
          tryingCountByKey.set(key, next)
          if (next === 2) {
            violations.push({
              message:
                `[rfc.proxy100TryingNotForwarded] agent=${agent}: received a second ` +
                `100 Trying for INVITE CSeq=${cseq} Call-ID=${callId} — the stateful ` +
                `proxy on the path forwarded a downstream 100 it should have absorbed ` +
                `per RFC 3261 §16.7 step 5`,
              entryIndex: ev.idx,
              details: { agent, callId, cseq },
            })
          }
        }
      }
    }

    return violations
  },
}
