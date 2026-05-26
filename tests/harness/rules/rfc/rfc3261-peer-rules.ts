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
import { ALL_UA_ROLES, type UaRole } from "../../../../src/sip/SignalingNetwork.js"
import type { PeerAuditRule } from "../../../../src/sip/SignalingNetwork.contracts.js"
import { extractRouteUri, routeIsLoose } from "./_dialog-model.js"

const PROXY_ONLY: ReadonlySet<UaRole> = new Set<UaRole>(["proxy"])

const LENIENT_PARSER = createCustomParser({ wireGrammar: false })

const tryParse = (raw: Buffer): SipMessage | null => {
  const res = LENIENT_PARSER.parse(raw)
  return Result.isSuccess(res) ? res.success : null
}

const tokenizeOptionTags = (raw: string): string[] =>
  raw.split(",").map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0)

const hasOptionTag = (values: ReadonlyArray<string>): boolean => {
  for (const v of values) {
    if (tokenizeOptionTags(v).length > 0) return true
  }
  return false
}

const topBranch = (msg: SipMessage): string | undefined =>
  msg.getHeader("via")[0]?.branch

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
// Methods that can legitimately initiate a transaction *outside* a dialog.
// Anything else (BYE, ACK, UPDATE, INFO, PRACK, CANCEL) is intrinsically
// in-dialog and a To-tag is expected; firing on those would be noise (a
// test-fixture artifact, not a real M-016 violation).
const DIALOG_INITIATING_METHODS: ReadonlySet<string> = new Set<string>([
  "INVITE",
  "REGISTER",
  "SUBSCRIBE",
  "OPTIONS",
  "REFER",
  "MESSAGE",
  "PUBLISH",
  "NOTIFY",
])

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
          if (!DIALOG_INITIATING_METHODS.has(msg.method)) continue
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
 * RFC3261-MUST-034 — `rfc.noRequireOnCancelOrAck`.
 *
 * RFC 3261 §8.2.2.3 (L2639-2641): "Require and Proxy-Require MUST NOT
 * be used in a SIP CANCEL request, or in an ACK request sent for a
 * non-2xx response. These header fields MUST be ignored if they are
 * present."
 *
 * Sent CANCEL: any presence of Require/Proxy-Require is a violation.
 *
 * Sent ACK: only violates if it acknowledges a non-2xx response.
 * Per RFC 3261 §17.1.1.3 the ACK for a non-2xx final is generated by
 * the client transaction and shares the INVITE's top Via branch (and
 * Call-ID); an ACK for a 2xx is a fresh transaction with a new branch.
 * Heuristic: scan prior events on this bind for a received response
 * with matching Call-ID + top-Via branch; if found and status ∈
 * [300, 699], the ACK is for a non-2xx. If no match is found the ACK
 * is presumed to be for a 2xx (different branch by spec) and we skip
 * — keeps the peer rule self-contained without dragging in
 * cross-message transaction-correlation infrastructure.
 *
 * Coverage note: the positive unit test exercises only the CANCEL
 * branch (one wire fixture, dead-simple to author). ACK-for-non-2xx
 * coverage is regression-only here because setting it up needs the
 * peer harness to first receive a 4xx/5xx/6xx response with a known
 * branch, which is more boilerplate than the existing test shape
 * accommodates.
 */
export const rfcNoRequireOnCancelOrAck: PeerAuditRule = {
  name: "rfc.noRequireOnCancelOrAck",
  subject: ALL_UA_ROLES,
  check: (events) =>
    Effect.sync(() => {
      const violations: string[] = []
      // (callId, branch) -> response status for inbound responses on this bind.
      const receivedResponseStatus = new Map<string, number>()
      const key = (callId: string, branch: string): string => `${callId}${branch}`
      for (const ev of events) {
        if (ev.tag === "messages.streamItem") {
          const msg = tryParse(ev.envelope.raw)
          if (msg === null) continue
          if (msg.type !== "response") continue
          const callId = msg.getHeader("call-id")
          if (callId === undefined || callId === "") continue
          const branch = topBranch(msg)
          if (branch === undefined || branch === "") continue
          receivedResponseStatus.set(key(callId, branch), msg.status)
          continue
        }
        if (ev.tag !== "send.called") continue
        const msg = tryParse(ev.msg)
        if (msg === null) continue
        if (msg.type !== "request") continue
        if (msg.method !== "CANCEL" && msg.method !== "ACK") continue
        const require = msg.getHeader("require")
        const proxyRequire = msg.getHeader("proxy-require")
        const carriesRequire = hasOptionTag(require) || hasOptionTag(proxyRequire)
        if (!carriesRequire) continue
        if (msg.method === "CANCEL") {
          violations.push(
            `CANCEL request carries Require/Proxy-Require — forbidden by ` +
              `RFC 3261 §8.2.2.3 / RFC3261-MUST-034`,
          )
          continue
        }
        // ACK branch: only flag when correlatable to a non-2xx response.
        const callId = msg.getHeader("call-id")
        const branch = topBranch(msg)
        if (callId === undefined || callId === "" || branch === undefined || branch === "") continue
        const status = receivedResponseStatus.get(key(callId, branch))
        if (status === undefined) continue
        if (status >= 300 && status <= 699) {
          violations.push(
            `ACK for non-2xx response (status=${status}) carries ` +
              `Require/Proxy-Require — forbidden by RFC 3261 §8.2.2.3 / RFC3261-MUST-034`,
          )
        }
      }
      return violations
    }),
}

/**
 * RFC3261-MUST-045 — `rfc.cancelCseqMethod`.
 *
 * RFC 3261 §9.1 (L2983): "the method part of the CSeq header field
 * MUST have a value of CANCEL".
 *
 * Sent CANCEL whose CSeq method part is not "CANCEL" is a violation.
 * Narrowly scoped: the CSeq number-equality aspect is enforced by the
 * legacy `rfc.cseq` rule.
 *
 * Note: the strict parser (extract-fields.ts) already rejects any
 * inbound or outbound message whose request method != CSeq method —
 * so this rule is defense-in-depth for code paths that construct a
 * SipMessage outside the parser (e.g. internal builders that bypass
 * `extractRequestFields`). It never fires on wire-path messages.
 */
export const rfcCancelCseqMethod: PeerAuditRule = {
  name: "rfc.cancelCseqMethod",
  subject: ALL_UA_ROLES,
  check: (events) =>
    Effect.sync(() => {
      const violations: string[] = []
      for (const ev of events) {
        if (ev.tag !== "send.called") continue
        const msg = tryParse(ev.msg)
        if (msg === null) continue
        if (msg.type !== "request") continue
        if (msg.method !== "CANCEL") continue
        const cseqMethod = msg.getHeader("cseq").method
        if (cseqMethod !== "CANCEL") {
          violations.push(
            `CANCEL request carries CSeq method=${cseqMethod} (expected CANCEL) ` +
              `— RFC 3261 §9.1 / RFC3261-MUST-045`,
          )
        }
      }
      return violations
    }),
}

/**
 * RFC3261-MUST-113 — `rfc.strictRouteShuffleOnSend`.
 *
 * RFC 3261 §16.6 step 6.b (L5763-5778): when a proxy forwards a request
 * whose Route set's first URI lacks `;lr` (strict route), it MUST:
 *   1. push the current Request-URI to the BOTTOM of the Route list, and
 *   2. lift the first Route URI into the Request-URI (dropping it from
 *      the Route list).
 *
 * From a single outbound message we cannot replay the pre-swap state.
 * Instead, the rule flags the structural indicator: an outbound request
 * whose topmost Route value is still strict-route (lacks `;lr`). That
 * either means the §16.6 swap never ran (violation) or — rarely — the
 * proxy's next hop happens to itself be a strict-route target that
 * survives the swap. Either case is worth surfacing; the rule ships
 * regression-only and the maintainer triages if it ever fires.
 *
 * Subject is `{proxy}` only per the manifest.
 */
export const rfcStrictRouteShuffleOnSend: PeerAuditRule = {
  name: "rfc.strictRouteShuffleOnSend",
  subject: PROXY_ONLY,
  check: (events) =>
    Effect.sync(() => {
      const violations: string[] = []
      for (const ev of events) {
        if (ev.tag !== "send.called") continue
        const msg = tryParse(ev.msg)
        if (msg === null) continue
        if (msg.type !== "request") continue
        const routes = msg.getHeader("route")
        if (routes.length === 0) continue
        const firstUri = extractRouteUri(routes[0]!)
        if (routeIsLoose(firstUri)) continue
        violations.push(
          `Sent ${msg.method} request still carries strict-route topmost ` +
            `Route entry — §16.6 step 6 swap may not have run ` +
            `(RFC3261-MUST-113)`,
        )
      }
      return violations
    }),
}

/**
 * RFC 3261 peer rules pack. Grows as each §8 / §12 / §16 peer rule lands.
 */
export const rfc3261PeerRules: ReadonlyArray<PeerAuditRule> = [
  rfcNoToTagOnInitialRequest,
  rfcNoRequireOnCancelOrAck,
  rfcCancelCseqMethod,
  rfcStrictRouteShuffleOnSend,
]
