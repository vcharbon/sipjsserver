/**
 * RFC 3261 peer rules — single-message validators authored against the
 * SignalingNetwork audit framework.
 *
 * This pack carries rules introduced by Phase 2 of the RFC verification
 * plan ([docs/RFC_Verification.md](../../../../docs/RFC_Verification.md)).
 * Legacy RFC 3261 validators reachable through the per-check generic
 * factory live in `starter-peer-rules.ts`; new rules that don't map
 * cleanly to a `ValidationCheckName` belong here.
 *
 * Cross-message rules for RFC 3261 (dialog-state, route set, etc.) live
 * in `rfc3261-cross-message-rules.ts` once they land.
 *
 * Inventory: docs/rfc/RFC3261.md
 */

import { Effect, Result } from "effect"
import { createCustomParser } from "../../../../src/sip/parsers/custom/index.js"
import type { SipMessage } from "../../../../src/sip/types.js"
import { ALL_UA_ROLES } from "../../../../src/sip/SignalingNetwork.js"
import type { PeerAuditRule } from "../../../../src/sip/SignalingNetwork.contracts.js"

const LENIENT_PARSER = createCustomParser({ wireGrammar: false })

const tryParse = (raw: Buffer): SipMessage | null => {
  const res = LENIENT_PARSER.parse(raw)
  return Result.isSuccess(res) ? res.success : null
}

/**
 * RFC3261-MUST-016 — `rfc.noToTagOnInitialRequest`.
 *
 * RFC 3261 §8.1.1.2 (L2006): "A request outside of a dialog MUST NOT
 * contain a To tag; the tag in the To field of a request identifies
 * the peer of the dialog."
 *
 * Peer-rule heuristic for "outside of a dialog" from a single bind's
 * vantage: the first event observed on this bind for a given Call-ID
 * is the dialog-initiating point from this peer's side. If that event
 * is a SENT REQUEST carrying a To-tag, we have an initial request
 * outside any dialog with a tag — a clear M-016 violation.
 *
 * Subsequent same-Call-ID requests (re-INVITE, BYE, REFER, NOTIFY) are
 * by definition in-dialog from this bind's perspective (we've seen
 * something for that Call-ID already), so a To-tag is legitimate.
 * Requests sent on a Call-ID we first observed via inbound traffic
 * (Bob's BYE after receiving Alice's INVITE) are also in-dialog.
 *
 * CANCEL is not specifically guarded here: the legacy `rfc.tags`
 * (RFC3261-MUST-017) cross-correlates CANCEL tag semantics against
 * the matching INVITE, so this rule deliberately stays out of that
 * lane.
 */
export const rfcNoToTagOnInitialRequest: PeerAuditRule = {
  name: "rfc.noToTagOnInitialRequest",
  subject: ALL_UA_ROLES,
  check: (events) =>
    Effect.sync(() => {
      const violations: string[] = []
      const seenCallIds = new Set<string>()
      for (const ev of events) {
        if (ev.tag === "send.called") {
          const msg = tryParse(ev.msg)
          if (msg === null) continue
          const callId = msg.getHeader("call-id")
          if (callId === undefined || callId === "") continue
          const firstForCallId = !seenCallIds.has(callId)
          seenCallIds.add(callId)
          if (msg.type !== "request") continue
          if (!firstForCallId) continue
          const toTag = msg.getHeader("to").tag
          if (toTag !== undefined && toTag !== "") {
            violations.push(
              `${msg.method} request outside any dialog carries To-tag=${toTag} ` +
                `(RFC 3261 §8.1.1.2 / RFC3261-MUST-016)`,
            )
          }
          continue
        }
        if (ev.tag === "messages.streamItem") {
          const msg = tryParse(ev.envelope.raw)
          if (msg === null) continue
          const callId = msg.getHeader("call-id")
          if (callId === undefined || callId === "") continue
          seenCallIds.add(callId)
        }
      }
      return violations
    }),
}

/**
 * RFC 3261 peer rules pack. Grows as each §8 / §12 / §16 peer rule lands.
 */
export const rfc3261PeerRules: ReadonlyArray<PeerAuditRule> = [
  rfcNoToTagOnInitialRequest,
]
