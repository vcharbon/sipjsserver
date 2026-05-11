/**
 * Rule `rfc.rportEcho` — RFC 3581 §4.
 *
 * When a UAC includes `;rport` (no value) in the top Via of a request,
 * the server processing that request MUST set the parameter's value to
 * the source port of the request when sending the response. Empty or
 * absent `rport` on the matching response is a server violation —
 * harmless on loopback but fatal behind NAT.
 *
 * Detection: per agent, every sent request whose top Via carries
 * `;rport` no-value is paired by branch with the correlated response;
 * the response's top Via must show `;rport=<numeric>`.
 */

import type { PerCallRule, RuleViolation } from "../types.js"
import { eventsByAgent, readRport } from "./_replay.js"

export const rportEchoRule: PerCallRule = {
  name: "rfc.rportEcho",
  family: "rfc",
  description: "RFC 3581 §4: server must echo `;rport=<source-port>` on responses",
  evaluate(ctx) {
    const violations: RuleViolation[] = []
    const byAgent = eventsByAgent(ctx.recording)

    for (const [agent, events] of byAgent.entries()) {
      // Sent requests whose top Via had `;rport` (no value) — index by branch.
      const sentRportByBranch = new Map<string, { method: string; idx: number }>()

      for (const ev of events) {
        if (ev.kind === "sent" && ev.msg.type === "request") {
          const topVia = ev.msg.getHeader("via")[0]
          const info = readRport(topVia.params)
          if (info.present && info.value === undefined) {
            const branch = topVia.branch
            if (branch) sentRportByBranch.set(branch, { method: ev.msg.method, idx: ev.idx })
          }
          continue
        }
        if (ev.kind !== "received" || ev.msg.type !== "response") continue
        const branch = ev.msg.getHeader("via")[0].branch
        if (!branch) continue
        const sent = sentRportByBranch.get(branch)
        if (!sent) continue
        const respRport = readRport(ev.msg.getHeader("via")[0].params)
        if (!respRport.present) {
          violations.push({
            message:
              `[rfc.rportEcho] agent=${agent}: response ${ev.msg.status} to ${sent.method} ` +
              `(branch ${branch}) dropped the rport parameter the request advertised — ` +
              `RFC 3581 §4 requires the server to echo rport=<source-port>`,
            entryIndex: ev.idx,
            details: { agent, status: ev.msg.status, method: sent.method, branch },
          })
          continue
        }
        if (respRport.value === undefined) {
          violations.push({
            message:
              `[rfc.rportEcho] agent=${agent}: response ${ev.msg.status} to ${sent.method} ` +
              `(branch ${branch}) keeps an empty rport parameter — ` +
              `RFC 3581 §4 requires the server to set it to the source port`,
            entryIndex: ev.idx,
            details: { agent, status: ev.msg.status, method: sent.method, branch },
          })
        }
      }
    }

    return violations
  },
}
