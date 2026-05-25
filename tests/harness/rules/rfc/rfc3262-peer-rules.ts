/**
 * RFC 3262 (PRACK / 100rel) peer rules — single-message validators.
 *
 * Cross-message rules for RFC 3262 (offer/answer model, glare, RSeq
 * monotonicity, etc.) live in `rfc3262-cross-message-rules.ts` when
 * they land.
 *
 * Inventory: docs/rfc/RFC3262.md
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

const tokenizeOptionTags = (raw: string): string[] =>
  raw.split(",").map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0)

/**
 * RFC3262-MUST-017 — `rfc.no100relRequireOnNonInvite`.
 *
 * RFC 3262 §4 (L292-293): "A Require header with the value 100rel
 * MUST NOT be present in any requests excepting INVITE, although
 * extensions to SIP may allow its usage with other request methods."
 *
 * Inspects every sent request on the peer's bind; if the method is
 * not INVITE and the request carries `Require: 100rel` (in any of
 * potentially multiple Require header rows), flags a violation.
 */
export const rfcNo100relRequireOnNonInvite: PeerAuditRule = {
  name: "rfc.no100relRequireOnNonInvite",
  subject: ALL_UA_ROLES,
  check: (events) =>
    Effect.sync(() => {
      const violations: string[] = []
      for (const ev of events) {
        if (ev.tag !== "send.called") continue
        const msg = tryParse(ev.msg)
        if (msg === null) continue
        if (msg.type !== "request") continue
        if (msg.method === "INVITE") continue
        const requireValues = msg.getHeader("require")
        let has100rel = false
        for (const value of requireValues) {
          if (tokenizeOptionTags(value).includes("100rel")) {
            has100rel = true
            break
          }
        }
        if (has100rel) {
          violations.push(
            `${msg.method} request carries Require: 100rel — only INVITE may ` +
              `(RFC 3262 §4 / RFC3262-MUST-017)`,
          )
        }
      }
      return violations
    }),
}

/**
 * RFC 3262 peer rules pack. Grows as each §3/§4 / §5 peer rule lands.
 */
export const rfc3262PeerRules: ReadonlyArray<PeerAuditRule> = [
  rfcNo100relRequireOnNonInvite,
]
