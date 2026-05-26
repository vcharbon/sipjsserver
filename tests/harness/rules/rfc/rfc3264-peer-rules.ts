/**
 * RFC 3264 (Offer/Answer Model with SDP) peer rules — single-message
 * validators that strict-parse SDP bodies on every sent message.
 *
 * Cross-message rules for RFC 3264 (glare prevention, per-stream
 * offer/answer pairing, re-offer monotonicity, etc.) will land in
 * `rfc3264-cross-message-rules.ts` once the planned `_offer-answer.ts`
 * helper is extracted.
 *
 * Inventory: docs/rfc/RFC3264.md
 */

import { Effect, Result } from "effect"
import { createCustomParser } from "../../../../src/sip/parsers/custom/index.js"
import type { SipMessage } from "../../../../src/sip/types.js"
import { ALL_UA_ROLES, type UaRole } from "../../../../src/sip/SignalingNetwork.js"
import type { PeerAuditRule } from "../../../../src/sip/SignalingNetwork.contracts.js"

const UAC_ONLY: ReadonlySet<UaRole> = new Set<UaRole>(["uac"])

const LENIENT_PARSER = createCustomParser({ wireGrammar: false })

const tryParse = (raw: Buffer): SipMessage | null => {
  const res = LENIENT_PARSER.parse(raw)
  return Result.isSuccess(res) ? res.success : null
}

// RFC 3264 §5 caps session-version growth to 2^62 - 1 to leave headroom
// before signed-int64 rollover. JS doubles can only represent integers
// up to 2^53 - 1 losslessly; we strict-parse against MAX_SAFE_INTEGER
// which is the tighter (and observable) bound for anything emitted on
// the wire from this codebase.
const SDP_INTEGER_MAX = Number.MAX_SAFE_INTEGER

const TEXT_DECODER = new TextDecoder()

interface SdpCheckFailure {
  readonly label: string
}

/**
 * Lenient SDP-grammar walker. Returns the first concrete failure
 * label or `null` when the body satisfies the regression-only checks:
 *   - has v=0, o=, s=, t= session-level lines
 *   - exactly one session description (one v=0)
 *   - o=: 6 tokens; sess-id and sess-version are non-negative integers
 *     that fit Number.MAX_SAFE_INTEGER
 *   - each m= block has a c= (either session-level or before next m=)
 *     and a port token in the m= line
 *   - every a=ptime:N has N > 0
 */
const checkSdp = (body: Uint8Array): SdpCheckFailure | null => {
  if (body.byteLength === 0) return null
  const text = TEXT_DECODER.decode(body)
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0)

  const vLines = lines.filter((l) => l.startsWith("v="))
  if (vLines.length === 0) return { label: "missing v= line" }
  if (vLines.length > 1) {
    return { label: `${vLines.length} session descriptions (v= lines) — exactly one required` }
  }
  if (vLines[0] !== "v=0") return { label: `unexpected v= value '${vLines[0]}' (expected v=0)` }

  const oLine = lines.find((l) => l.startsWith("o="))
  if (oLine === undefined) return { label: "missing o= line" }
  if (lines.find((l) => l.startsWith("s=")) === undefined) return { label: "missing s= line" }
  if (lines.find((l) => l.startsWith("t=")) === undefined) return { label: "missing t= line" }

  const oTokens = oLine.slice(2).trim().split(/\s+/)
  if (oTokens.length < 6) {
    return { label: `o= line has ${oTokens.length} tokens (expected 6: username sess-id sess-version nettype addrtype unicast-address)` }
  }
  const sessId = oTokens[1]!
  const sessVersion = oTokens[2]!
  if (!/^\d+$/.test(sessId)) {
    return { label: `o= sess-id '${sessId}' is not a non-negative integer` }
  }
  if (!/^\d+$/.test(sessVersion)) {
    return { label: `o= sess-version '${sessVersion}' is not a non-negative integer` }
  }
  const sessIdNum = Number.parseInt(sessId, 10)
  if (!Number.isFinite(sessIdNum) || sessIdNum > SDP_INTEGER_MAX) {
    return { label: `o= sess-id '${sessId}' exceeds Number.MAX_SAFE_INTEGER (signed-int64 bound)` }
  }
  const sessVersionNum = Number.parseInt(sessVersion, 10)
  if (!Number.isFinite(sessVersionNum) || sessVersionNum > SDP_INTEGER_MAX) {
    return { label: `o= sess-version '${sessVersion}' exceeds Number.MAX_SAFE_INTEGER (signed-int64 bound)` }
  }

  // Walk m= blocks. A c= line at session level (before the first m=)
  // satisfies the c=-presence requirement for every m= block; otherwise
  // each m= block needs its own c= before the next m= boundary.
  let sessionLevelC = false
  let inMedia = false
  let currentMediaHasC = false
  let currentMediaName = ""
  for (const line of lines) {
    if (line.startsWith("m=")) {
      if (inMedia && !currentMediaHasC && !sessionLevelC) {
        return { label: `m=${currentMediaName} block has no c= line and no session-level c=` }
      }
      const mTokens = line.slice(2).trim().split(/\s+/)
      if (mTokens.length < 3) {
        return { label: `m= line '${line}' has fewer than 3 tokens (expected: media port proto fmt...)` }
      }
      const portTok = mTokens[1]!
      if (!/^\d+$/.test(portTok)) {
        return { label: `m= line port '${portTok}' is not a non-negative integer` }
      }
      inMedia = true
      currentMediaHasC = false
      currentMediaName = mTokens[0]!
      continue
    }
    if (!inMedia && line.startsWith("c=")) sessionLevelC = true
    if (inMedia && line.startsWith("c=")) currentMediaHasC = true
    if (line.startsWith("a=ptime:")) {
      const raw = line.slice("a=ptime:".length).trim()
      const n = Number.parseInt(raw, 10)
      if (!Number.isFinite(n) || n <= 0) {
        return { label: `a=ptime:${raw} is not > 0` }
      }
    }
  }
  if (inMedia && !currentMediaHasC && !sessionLevelC) {
    return { label: `m=${currentMediaName} block has no c= line and no session-level c=` }
  }
  return null
}

/**
 * RFC3264-MUST-003/-004/-005/-006/-012/-027 — `rfc.sdpBodyParseable`.
 *
 * RFC 3264 §5-6 + RFC 4566 grammar: every SDP body carried in a sent
 * SIP message MUST conform to the offer/answer grammar. Concretely:
 *   - M-003/-004: valid SDP syntax, exactly one session description.
 *   - M-005: o= sess-id fits a signed 64-bit integer (checked against
 *     Number.MAX_SAFE_INTEGER — the tighter bound observable in JS).
 *   - M-006: o= sess-version fits the same bound; the §5 "initial
 *     version < 2^62-1" sanity bound is subsumed.
 *   - M-012: every a=ptime:N MUST have N > 0.
 *   - M-027: per media stream, a c= line MUST be present (session-level
 *     or inside the media block) and the m= line MUST carry a port.
 *
 * Regression-only: the parser is intentionally lenient and fires only
 * on clearly malformed SDP. Bodies that fail to UTF-8 decode are
 * skipped — the parser already rejects undecodable wire bytes.
 */
const isSdpBody = (msg: SipMessage): boolean => {
  if (!msg.hasBody() || msg.body.byteLength === 0) return false
  const ctValues = msg.getHeader("content-type")
  // ctValues may be `string` or `string[]` depending on the parser path.
  const flat = Array.isArray(ctValues) ? ctValues : [ctValues]
  for (const v of flat) {
    if (typeof v !== "string") continue
    if (/^application\/sdp\b/i.test(v.trim())) return true
  }
  return false
}

export const rfcSdpBodyParseable: PeerAuditRule = {
  name: "rfc.sdpBodyParseable",
  subject: ALL_UA_ROLES,
  check: (events) =>
    Effect.sync(() => {
      const violations: string[] = []
      for (const ev of events) {
        if (ev.tag !== "send.called") continue
        const msg = tryParse(ev.msg)
        if (msg === null) continue
        if (!isSdpBody(msg)) continue
        const failure = checkSdp(msg.body)
        if (failure === null) continue
        const callId = msg.getHeader("call-id")
        violations.push(
          `Sent SDP body fails RFC 3264/4566 grammar check: ${failure.label} ` +
            `(callId ${callId}) — RFC 3264 §5-6 / ` +
            `RFC3264-MUST-003/-004/-005/-006/-012/-027`,
        )
      }
      return violations
    }),
}

/**
 * RFC3264-MUST-051 — `rfc.c0PortNonZero`.
 *
 * RFC 3264 §8.4: an SDP that uses the legacy "hold" idiom `c=0.0.0.0`
 * MUST NOT also have `m=… 0 …` (port 0) for that media stream — the
 * combination produces an ambiguous "held AND rejected" state.
 *
 * Walks each sent body's SDP lines: a session-level `c=IN IP4 0.0.0.0`
 * (or IPv6 unspecified `::`) applies to every m= block without its own
 * c=; a media-level c= overrides session-level. Fires when the
 * applicable c= for a given m= block is unspecified-address AND the
 * m= port is zero.
 *
 * Regression-only: narrow legacy idiom check; trips if a fixture emits
 * both c=0.0.0.0 and m= port=0 for the same stream.
 */
export const rfcC0PortNonZero: PeerAuditRule = {
  name: "rfc.c0PortNonZero",
  subject: UAC_ONLY,
  check: (events) =>
    Effect.sync(() => {
      const violations: string[] = []
      for (const ev of events) {
        if (ev.tag !== "send.called") continue
        const msg = tryParse(ev.msg)
        if (msg === null) continue
        if (!msg.hasBody()) continue
        if (msg.body.byteLength === 0) continue
        const text = TEXT_DECODER.decode(msg.body)
        const lines = text.split(/\r?\n/).filter((l) => l.length > 0)

        let sessionLevelUnspecified = false
        let inMedia = false
        let hasOwnCLine = false
        let currentMediaUnspecified = false
        let currentMediaType = ""
        let currentMediaPortZero = false

        const flushCurrentMedia = (): void => {
          if (!inMedia) return
          const applicable =
            currentMediaUnspecified ||
            (!hasOwnCLine && sessionLevelUnspecified)
          if (applicable && currentMediaPortZero) {
            const callId = msg.getHeader("call-id")
            violations.push(
              `SDP body has c=0.0.0.0 and m=${currentMediaType} port=0 ` +
                `simultaneously (callId ${callId}) — ` +
                `RFC 3264 §6 / RFC3264-MUST-051`,
            )
          }
        }

        for (const line of lines) {
          if (line.startsWith("m=")) {
            if (inMedia) flushCurrentMedia()
            const mTokens = line.slice(2).trim().split(/\s+/)
            if (mTokens.length < 3) {
              inMedia = false
              continue
            }
            inMedia = true
            hasOwnCLine = false
            currentMediaUnspecified = false
            currentMediaType = mTokens[0]!
            currentMediaPortZero = mTokens[1] === "0"
            continue
          }
          if (line.startsWith("c=")) {
            const cVal = line.slice(2).trim()
            const isUnspecified =
              /^IN\s+IP4\s+0\.0\.0\.0\b/i.test(cVal) ||
              /^IN\s+IP6\s+::\b/i.test(cVal)
            if (inMedia) {
              hasOwnCLine = true
              currentMediaUnspecified = isUnspecified
            } else {
              sessionLevelUnspecified = isUnspecified
            }
          }
        }
        if (inMedia) flushCurrentMedia()
      }
      return violations
    }),
}

/**
 * RFC 3264 peer rules pack. Grows as each §5 / §6 / §8 peer rule lands.
 */
export const rfc3264PeerRules: ReadonlyArray<PeerAuditRule> = [
  rfcSdpBodyParseable,
  rfcC0PortNonZero,
]
