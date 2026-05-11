/**
 * Rule `rfc.recordRoutePlacement` — RFC 3261 §12.1.1, §12.2.2.
 *
 * Two combined checks on responses:
 *
 *   (a) `Record-Route` MUST NOT appear on a 100 Trying — 100 is not
 *       dialog-creating (no To-tag) so reflecting Record-Route there
 *       is vestigial and confusing for downstream parsers.
 *   (b) `Record-Route` MUST NOT appear on a mid-dialog response (a
 *       response correlated with a sent in-dialog request) — the route
 *       set is locked at dialog establishment.
 *
 * Catches the proxy hygiene findings in
 * [docs/todos/FIXME-missingControlInSipTest.md](../../../../docs/todos/FIXME-missingControlInSipTest.md)
 * and review item C2 of the bob↔proxy callflow analysis.
 */

import type { PerCallRule, RuleViolation } from "../types.js"
import { eventsByAgent, getAllHeaderValues } from "./_replay.js"

export const recordRoutePlacementRule: PerCallRule = {
  name: "rfc.recordRoutePlacement",
  family: "rfc",
  description: "RFC 3261 §12.1.1 / §12.2.2: Record-Route placement on responses",
  evaluate(ctx) {
    const violations: RuleViolation[] = []
    const byAgent = eventsByAgent(ctx.recording)

    for (const [agent, events] of byAgent.entries()) {
      // Track each sent request's branch + whether it was an initial INVITE.
      // Sent requests with a To-tag are mid-dialog (re-INVITE / BYE / etc.).
      const sentByBranch = new Map<
        string,
        { method: string; isInDialog: boolean; idx: number }
      >()

      for (const ev of events) {
        if (ev.kind === "sent" && ev.msg.type === "request") {
          const branch = ev.msg.getHeader("via")[0].branch
          if (branch) {
            const hasToTag = ev.msg.getHeader("to").tag !== undefined
            sentByBranch.set(branch, {
              method: ev.msg.method,
              isInDialog: hasToTag,
              idx: ev.idx,
            })
          }
          continue
        }
        if (ev.kind !== "received" || ev.msg.type !== "response") continue

        const rr = getAllHeaderValues(ev.msg.headers, "record-route")
        if (rr.length === 0) continue

        // (a) 100 Trying with Record-Route.
        if (ev.msg.status === 100) {
          violations.push({
            message:
              `[rfc.recordRoutePlacement] agent=${agent}: 100 Trying carries ` +
              `Record-Route header(s) — 100 is not dialog-creating, ` +
              `Record-Route is vestigial here per RFC 3261 §12.1.1. Found: ${rr[0]}`,
            entryIndex: ev.idx,
            details: { agent, status: ev.msg.status, recordRoute: rr },
          })
          continue
        }

        // (b) Mid-dialog response with Record-Route.
        const branch = ev.msg.getHeader("via")[0].branch
        const sent = branch ? sentByBranch.get(branch) : undefined
        if (sent && sent.isInDialog) {
          violations.push({
            message:
              `[rfc.recordRoutePlacement] agent=${agent}: ${ev.msg.status} response ` +
              `to in-dialog ${sent.method} carries Record-Route — route set is ` +
              `fixed at dialog establishment per RFC 3261 §12.2.2. Found: ${rr[0]}`,
            entryIndex: ev.idx,
            details: { agent, status: ev.msg.status, method: sent.method, recordRoute: rr },
          })
        }
      }
    }

    return violations
  },
}
