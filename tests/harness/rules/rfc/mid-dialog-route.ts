/**
 * Rule `rfc.midDialogRoute` — RFC 3261 §12.2.1.1, §16.12.
 *
 * In-dialog requests sent by an agent must respect the route set
 * established at dialog creation:
 *
 *   - Loose routing (first entry has `;lr`): emit `Route:` headers in
 *     dialog order; Request-URI = remote target.
 *   - Strict routing (first entry has no `;lr`): Request-URI = first
 *     route URI (params stripped); Route = rest + remote target.
 *
 * Bob's outbound re-INVITE in the proxy+B2B trace omits the `Route:`
 * header even though his ACK and BYE on the same dialog include it —
 * this rule flags that inconsistency mechanically.
 *
 * Scope: per-agent **sent** in-dialog requests (not initial INVITE,
 * not CANCEL).
 */

import type { PerCallRule, RuleViolation } from "../types.js"
import {
  advanceDialogModel,
  emptyDialogModel,
  eventsByAgent,
  extractRouteUri,
  getAllHeaderValues,
  isInDialogRequest,
  routeIsLoose,
} from "./_replay.js"

export const midDialogRouteRule: PerCallRule = {
  name: "rfc.midDialogRoute",
  family: "rfc",
  description: "RFC 3261 §12.2.1.1: in-dialog request route set must be honoured",
  evaluate(ctx) {
    const violations: RuleViolation[] = []
    const byAgent = eventsByAgent(ctx.recording)

    for (const [agent, events] of byAgent.entries()) {
      const m = emptyDialogModel()

      for (const ev of events) {
        if (ev.kind === "sent" && ev.msg.type === "request") {
          const msg = ev.msg
          if (msg.method === "CANCEL" || msg.method === "ACK") {
            advanceDialogModel(m, ev)
            continue
          }
          if (
            msg.method === "INVITE" &&
            !m.initialInviteSentBranch &&
            !m.initialInviteReceivedBranch
          ) {
            advanceDialogModel(m, ev)
            continue
          }
          if (!isInDialogRequest(msg, m)) {
            advanceDialogModel(m, ev)
            continue
          }
          if (m.routeSet.length === 0) {
            advanceDialogModel(m, ev)
            continue
          }

          const sentRoutes = getAllHeaderValues(msg.headers, "route")
          const firstRoute = m.routeSet[0]!

          if (routeIsLoose(firstRoute)) {
            if (sentRoutes.length === 0) {
              violations.push({
                message:
                  `[rfc.midDialogRoute] agent=${agent}: in-dialog ${msg.method} ` +
                  `omits Route header although the dialog route set is non-empty ` +
                  `(loose, first entry "${firstRoute}") — RFC 3261 §12.2.1.1`,
                entryIndex: ev.idx,
                details: { agent, method: msg.method, expected: m.routeSet, actual: sentRoutes },
              })
            } else if (sentRoutes.length !== m.routeSet.length) {
              violations.push({
                message:
                  `[rfc.midDialogRoute] agent=${agent}: in-dialog ${msg.method} ` +
                  `Route header count ${sentRoutes.length} differs from dialog route ` +
                  `set length ${m.routeSet.length} — RFC 3261 §12.2.1.1`,
                entryIndex: ev.idx,
                details: { agent, method: msg.method, expected: m.routeSet, actual: sentRoutes },
              })
            } else {
              for (let i = 0; i < sentRoutes.length; i++) {
                const expected = extractRouteUri(m.routeSet[i]!)
                const actual = extractRouteUri(sentRoutes[i]!)
                if (expected !== actual) {
                  violations.push({
                    message:
                      `[rfc.midDialogRoute] agent=${agent}: in-dialog ${msg.method} ` +
                      `Route[${i}] URI "${actual}" differs from dialog route set ` +
                      `entry "${expected}" — RFC 3261 §12.2.1.1`,
                    entryIndex: ev.idx,
                    details: { agent, method: msg.method, expected: m.routeSet, actual: sentRoutes },
                  })
                  break
                }
              }
            }
          } else {
            const expectedUri = extractRouteUri(firstRoute)
            if (msg.uri !== expectedUri) {
              violations.push({
                message:
                  `[rfc.midDialogRoute] agent=${agent}: in-dialog ${msg.method} ` +
                  `Request-URI "${msg.uri}" should be first strict route URI ` +
                  `"${expectedUri}" — RFC 3261 §16.12`,
                entryIndex: ev.idx,
                details: { agent, method: msg.method, expectedRequestUri: expectedUri, actualRequestUri: msg.uri },
              })
            }
            const expectedTail = m.routeSet.slice(1).map((r) => extractRouteUri(r))
            const actualTail = sentRoutes.map((r) => extractRouteUri(r))
            // Strict routing appends remote target at the end, so we accept
            // tail = expected || tail = expected + [remoteTarget].
            const matchesExact = expectedTail.length === actualTail.length &&
              expectedTail.every((u, i) => u === actualTail[i])
            const matchesWithTarget = actualTail.length === expectedTail.length + 1 &&
              expectedTail.every((u, i) => u === actualTail[i])
            if (!matchesExact && !matchesWithTarget) {
              violations.push({
                message:
                  `[rfc.midDialogRoute] agent=${agent}: in-dialog ${msg.method} ` +
                  `strict-route Route tail does not match dialog route set ` +
                  `(expected ${JSON.stringify(expectedTail)}, got ${JSON.stringify(actualTail)}) — RFC 3261 §16.12`,
                entryIndex: ev.idx,
                details: { agent, method: msg.method, expectedTail, actualTail },
              })
            }
          }
        }
        advanceDialogModel(m, ev)
      }
    }

    return violations
  },
}
