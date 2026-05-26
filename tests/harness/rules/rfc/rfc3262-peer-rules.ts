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
import { ALL_UA_ROLES, type UaRole } from "../../../../src/sip/SignalingNetwork.js"
import type { PeerAuditRule } from "../../../../src/sip/SignalingNetwork.contracts.js"

const UAS_ONLY: ReadonlySet<UaRole> = new Set<UaRole>(["uas"])

const RSEQ_MAX = 2147483647 // 2^31 - 1

const LENIENT_PARSER = createCustomParser({ wireGrammar: false })

const tryParse = (raw: Buffer): SipMessage | null => {
  const res = LENIENT_PARSER.parse(raw)
  return Result.isSuccess(res) ? res.success : null
}

const tokenizeOptionTags = (raw: string): string[] =>
  raw.split(",").map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0)

const hasOptionTag = (values: ReadonlyArray<string>, tag: string): boolean => {
  for (const v of values) {
    if (tokenizeOptionTags(v).includes(tag)) return true
  }
  return false
}

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
 * RFC3262-MUST-003 / -007 / -008 — `rfc.reliable1xxHeaders`.
 *
 * RFC 3262 §3:
 *   - M-003 (L142): "A UAS MUST NOT attempt to send a 100 (Trying)
 *     response reliably." → sent 100 must not carry `RSeq` or
 *     `Require: 100rel`.
 *   - M-007 (L188-189): a reliable 1xx "MUST contain a Require header
 *     field containing the option tag 100rel, and MUST include an RSeq
 *     header field".
 *   - M-008 (L189-191): "The value of the header field for the first
 *     reliable provisional response in a transaction MUST be between 1
 *     and 2**31 - 1."
 *
 * Inspects every sent response on the UAS's bind:
 *   - status == 100: violation if `RSeq` is present or `Require:` lists
 *     `100rel`.
 *   - 101 ≤ status < 200 with `Require: 100rel` (the §3 reliability
 *     signal): `RSeq` MUST be present and the parsed value MUST fit
 *     `[1, 2^31 - 1]`.
 *
 * RSeq is not in the typed `SipHeaderTypes` registry, so
 * `getHeader("rseq")` returns `ReadonlyArray<string>` and the numeric
 * value is recovered via `parseInt(value.trim(), 10)`.
 */
export const rfcReliable1xxHeaders: PeerAuditRule = {
  name: "rfc.reliable1xxHeaders",
  subject: UAS_ONLY,
  check: (events) =>
    Effect.sync(() => {
      const violations: string[] = []
      for (const ev of events) {
        if (ev.tag !== "send.called") continue
        const msg = tryParse(ev.msg)
        if (msg === null) continue
        if (msg.type !== "response") continue
        const status = msg.status
        if (status < 100 || status >= 200) continue
        const rseqValues = msg.getHeader("rseq")
        const requireValues = msg.getHeader("require")
        const hasRseq = rseqValues.length > 0
        const has100rel = hasOptionTag(requireValues, "100rel")
        if (status === 100) {
          if (hasRseq) {
            violations.push(
              `100 (Trying) response carries RSeq — RFC 3262 §3 forbids ` +
                `reliable 100 (RFC3262-MUST-003 / RFC3262-MUST-007)`,
            )
          }
          if (has100rel) {
            violations.push(
              `100 (Trying) response carries Require: 100rel — RFC 3262 §3 ` +
                `forbids reliable 100 (RFC3262-MUST-003)`,
            )
          }
          continue
        }
        // 101-199: reliable 1xx is signalled by Require: 100rel.
        if (!has100rel) continue
        if (!hasRseq) {
          violations.push(
            `Reliable ${status} response carries Require: 100rel but no ` +
              `RSeq header — RFC 3262 §3 (RFC3262-MUST-007)`,
          )
          continue
        }
        const rseq = parseInt(rseqValues[0]!.trim(), 10)
        if (!Number.isFinite(rseq) || rseq < 1 || rseq > RSEQ_MAX) {
          violations.push(
            `Reliable ${status} response RSeq=${rseqValues[0]} outside ` +
              `[1, 2^31-1] — RFC 3262 §3 (RFC3262-MUST-008)`,
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
  rfcReliable1xxHeaders,
]
