/**
 * Rule `rfc.sdpOriginContinuity` — RFC 3264 §8 / RFC 4566 §5.2.
 *
 * Within a single SIP session, the SDP `o=` line of each party MUST be
 * stable in its `(username, sess-id, nettype, addrtype, addr)` tuple
 * across every SDP that party emits. The `sess-version` MUST increment
 * by exactly 1 if any other field of the SDP changed, OR remain equal
 * if the SDP body is byte-identical.
 *
 * This catches:
 *   - Bob's re-INVITE offer carrying `o=test 1 1` after his answer
 *     established `o=test 2 2` (sess-id and version regression).
 *   - Alice's 200 OK answer to Bob's re-INVITE keeping `o=test 2 2`
 *     while the m= port changed (version not bumped).
 *
 * Detection runs per agent on **sent** SDP-bearing messages (the SDP
 * the agent put on the wire) so each party's o= history is judged
 * against itself.
 */

import type { PerCallRule, RuleViolation } from "../types.js"
import { eventsByAgent, parseSdpOrigin, type ParsedSdpOrigin } from "./_replay.js"

export const sdpOriginContinuityRule: PerCallRule = {
  name: "rfc.sdpOriginContinuity",
  family: "rfc",
  description: "RFC 3264 §8 / RFC 4566 §5.2: SDP origin tuple stable, version monotonic",
  evaluate(ctx) {
    const violations: RuleViolation[] = []
    const byAgent = eventsByAgent(ctx.recording)

    for (const [agent, events] of byAgent.entries()) {
      // Per Call-ID history of this agent's emissions.
      const history = new Map<string, ParsedSdpOrigin & { rawDigest: string }>()

      for (const ev of events) {
        if (ev.kind !== "sent") continue
        if (ev.msg.body.byteLength === 0) continue
        const origin = parseSdpOrigin(ev.msg.body)
        if (!origin) continue
        const callId = ev.msg.parsed.callId
        if (!callId) continue
        const prior = history.get(callId)
        if (!prior) {
          history.set(callId, { ...origin, rawDigest: origin.bodyDigestExcludingOrigin })
          continue
        }

        const tupleStable =
          prior.username === origin.username &&
          prior.sessionId === origin.sessionId &&
          prior.nettype === origin.nettype &&
          prior.addrtype === origin.addrtype &&
          prior.unicastAddress === origin.unicastAddress

        if (!tupleStable) {
          violations.push({
            message:
              `[rfc.sdpOriginContinuity] agent=${agent}: SDP origin tuple changed ` +
              `within session — prior "${prior.rawOriginLine}", new "${origin.rawOriginLine}" — ` +
              `RFC 4566 §5.2 / RFC 3264 §8`,
            entryIndex: ev.idx,
            details: { agent, prior: prior.rawOriginLine, current: origin.rawOriginLine },
          })
          // Refresh the history with the new tuple so we don't avalanche.
          history.set(callId, { ...origin, rawDigest: origin.bodyDigestExcludingOrigin })
          continue
        }

        const bodyChanged = prior.rawDigest !== origin.bodyDigestExcludingOrigin
        const versionDelta = origin.sessionVersion - prior.sessionVersion
        if (bodyChanged && versionDelta !== 1) {
          violations.push({
            message:
              `[rfc.sdpOriginContinuity] agent=${agent}: SDP body changed but ` +
              `sess-version went from ${prior.sessionVersion} to ${origin.sessionVersion} ` +
              `(expected exactly +1) — RFC 3264 §8`,
            entryIndex: ev.idx,
            details: { agent, priorVersion: prior.sessionVersion, currentVersion: origin.sessionVersion },
          })
        } else if (!bodyChanged && versionDelta !== 0) {
          violations.push({
            message:
              `[rfc.sdpOriginContinuity] agent=${agent}: SDP body unchanged but ` +
              `sess-version went from ${prior.sessionVersion} to ${origin.sessionVersion} ` +
              `(expected unchanged for byte-identical SDP) — RFC 4566 §5.2`,
            entryIndex: ev.idx,
            details: { agent, priorVersion: prior.sessionVersion, currentVersion: origin.sessionVersion },
          })
        } else if (versionDelta < 0) {
          violations.push({
            message:
              `[rfc.sdpOriginContinuity] agent=${agent}: SDP sess-version went ` +
              `backwards (${prior.sessionVersion} → ${origin.sessionVersion}) — RFC 4566 §5.2`,
            entryIndex: ev.idx,
            details: { agent, priorVersion: prior.sessionVersion, currentVersion: origin.sessionVersion },
          })
        }

        history.set(callId, { ...origin, rawDigest: origin.bodyDigestExcludingOrigin })
      }
    }

    return violations
  },
}
