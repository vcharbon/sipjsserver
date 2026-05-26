/**
 * RFC 3264 cross-message rules. Rules covering offer/answer-model MUSTs
 * from the RFC 3264 inventory whose enforcement spans more than one
 * message land here, separate from the RFC 3261 / RFC 3262 packs. Each
 * rule plugs into the same `CrossMessageRule` interface and
 * `adaptCrossMessageRule` plumbing.
 */

import { Effect } from "effect"
import type { LaneKey } from "../../../../src/test-harness/framework/report-recorder/types.js"
import type { CrossMessageAuditRule } from "../../../../src/sip/SignalingNetwork.contracts.js"
import {
  adaptCrossMessageRule,
  type CrossMessageRule,
  orderedFromSlot,
} from "./cross-message-rules.js"
import {
  extractDirection,
  extractRtpmaps,
  parseSdpBody,
  type SdpDirection,
} from "./_offer-answer.js"

// ---------------------------------------------------------------------------
// rfc.noNewOfferWhileOfferPending
//
// RFC 3264 §5 / RFC3264-MUST-001 + RFC3264-MUST-002: a UA MUST NOT send a
// new SDP offer while it has an unanswered offer from the other side
// (M-001), and MUST NOT send a new offer while its own prior offer is
// unanswered (M-002).
//
// Per-Call-ID per-agent walk in slot insertion order. Maintain
// `pendingOffer: { side, branch }` where `side` is the direction of the
// current outstanding offer ("sent" = our offer awaiting their answer;
// "received" = their offer awaiting our answer). The first message body
// in the session is the offer; the next body on the same transaction
// (correlated by top-Via branch) is the answer.
//
// Trigger:
// - Sent body while `pendingOffer.side === "sent"` → M-002 (own prior
//   offer still pending).
// - Received body while `pendingOffer.side === "received"` → M-001
//   symmetric: peer broke its own MUST, but the rule is symmetric in
//   spec and surfaces the violation as observation.
//
// Clear pending when a body arrives in the opposite direction whose
// top-Via branch matches the pending offer's branch (the answer in the
// same transaction). Bodies on other branches that don't match the
// pending offer fall through the trigger rules above.
//
// Regression-only — current fixtures correctly serialize O/A rounds.
// ---------------------------------------------------------------------------

export const noNewOfferWhileOfferPendingRule: CrossMessageRule = {
  name: "rfc.noNewOfferWhileOfferPending",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          // Single per-Call-ID state per slice — slice identity already
          // partitions per (callId, fromTag, toTag) so a fresh pending
          // tracker per slot is correct.
          let pendingOffer: { side: "sent" | "received"; branch: string } | null = null

          for (const ev of events) {
            const msg = ev.msg
            // Only message-carrying SDP bodies participate in the
            // offer/answer rounds we audit.
            if (msg.body.byteLength === 0) continue
            const sdp = parseSdpBody(msg.body)
            if (sdp === null) continue
            const branch = msg.getHeader("via")[0]?.branch ?? ""

            if (pendingOffer !== null) {
              // Answer arriving on the same transaction (opposite
              // direction, matching branch) clears the pending offer.
              if (
                branch.length > 0 &&
                branch === pendingOffer.branch &&
                ev.kind !== pendingOffer.side
              ) {
                pendingOffer = null
                continue
              }

              if (ev.kind === "sent" && pendingOffer.side === "sent") {
                out.push({
                  bindKey: slot.bindKey,
                  detail:
                    `Sent SDP offer while prior offer (branch ` +
                    `${pendingOffer.branch}) still pending (callId ` +
                    `${slice.callId}) — RFC 3264 §5 / RFC3264-MUST-002`,
                })
                pendingOffer = { side: "sent", branch }
                continue
              }
              if (ev.kind === "received" && pendingOffer.side === "received") {
                out.push({
                  bindKey: slot.bindKey,
                  detail:
                    `Received SDP offer while prior offer (branch ` +
                    `${pendingOffer.branch}) still pending (callId ` +
                    `${slice.callId}) — RFC 3264 §5 / RFC3264-MUST-001`,
                })
                pendingOffer = { side: "received", branch }
                continue
              }
              // Cross-direction body on a different branch: treat as a
              // new offer round. Conservative — the previous round's
              // answer didn't show up in this slot, so we don't claim
              // the new body is "after the answer".
              pendingOffer = { side: ev.kind, branch }
              continue
            }

            pendingOffer = { side: ev.kind, branch }
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.answerMLineCountMatchesOffer
//
// RFC 3264 §6 / RFC3264-MUST-018: the first answer's `m=` line count MUST
// equal the offer's `m=` line count.
//
// Per-Call-ID per-agent walk in slot insertion order. Track the first SDP
// body observed (sent or received) as the offer and record its
// `media.length`. The next SDP body in the opposite direction is the
// answer; fire if its `media.length` differs from the offer's. After the
// answer arrives, stop tracking — re-offers are covered by other rules.
//
// Regression-only — current fixtures preserve m= count across O/A; rule
// trips on add/drop.
// ---------------------------------------------------------------------------

export const answerMLineCountMatchesOfferRule: CrossMessageRule = {
  name: "rfc.answerMLineCountMatchesOffer",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          let offer: { side: "sent" | "received"; count: number } | null = null

          for (const ev of events) {
            const msg = ev.msg
            if (msg.body.byteLength === 0) continue
            const sdp = parseSdpBody(msg.body)
            if (sdp === null) continue

            if (offer === null) {
              offer = { side: ev.kind, count: sdp.media.length }
              continue
            }
            if (ev.kind === offer.side) continue
            if (sdp.media.length !== offer.count) {
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `Answer SDP m= count (${sdp.media.length}) differs from offer m= count ` +
                  `(${offer.count}) (callId ${slice.callId}) — RFC 3264 §6 / RFC3264-MUST-018`,
              })
            }
            break
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.answerTLineEqualsOffer
//
// RFC 3264 §6 / RFC3264-MUST-019: the answer's `t=` line bytes MUST equal
// the offer's `t=` bytes (time bounds preserved across O/A).
//
// Per-Call-ID per-agent walk in slot insertion order. Same offer/answer
// detection as `answerMLineCountMatchesOffer`: first SDP body is the
// offer, the next SDP body in the opposite direction is the answer.
// Compare `tLine` strings; fire on mismatch. Stop after the first answer.
//
// Regression-only — current fixtures preserve t= across O/A; rule trips
// on divergence.
// ---------------------------------------------------------------------------

export const answerTLineEqualsOfferRule: CrossMessageRule = {
  name: "rfc.answerTLineEqualsOffer",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          let offer: { side: "sent" | "received"; tLine: string | null } | null = null

          for (const ev of events) {
            const msg = ev.msg
            if (msg.body.byteLength === 0) continue
            const sdp = parseSdpBody(msg.body)
            if (sdp === null) continue

            if (offer === null) {
              offer = { side: ev.kind, tLine: sdp.tLine }
              continue
            }
            if (ev.kind === offer.side) continue
            if (sdp.tLine !== offer.tLine) {
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `Answer SDP t= line ('${sdp.tLine ?? ""}') differs from offer t= line ` +
                  `('${offer.tLine ?? ""}') (callId ${slice.callId}) — RFC 3264 §6 / RFC3264-MUST-019`,
              })
            }
            break
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.answerMediaTypeMatchesOffer
//
// RFC 3264 §6.1 / RFC3264-MUST-022: per-stream-index pairing — the answer's
// m= media type MUST match the offer's m= media type at the same index
// (audio↔audio, video↔video, etc.).
//
// Per-Call-ID per-agent walk in slot insertion order. Same offer/answer
// detection as the sibling rules: first SDP body is the offer, the next
// SDP body in the opposite direction is the answer. Compare media[i].type
// for every shared index; fire per mismatched slot. Stop after the first
// answer.
//
// Regression-only — current O/A fixtures preserve per-stream media type;
// rule trips on swap.
// ---------------------------------------------------------------------------

export const answerMediaTypeMatchesOfferRule: CrossMessageRule = {
  name: "rfc.answerMediaTypeMatchesOffer",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          let offer: {
            side: "sent" | "received"
            types: ReadonlyArray<string>
          } | null = null

          for (const ev of events) {
            const msg = ev.msg
            if (msg.body.byteLength === 0) continue
            const sdp = parseSdpBody(msg.body)
            if (sdp === null) continue

            if (offer === null) {
              offer = { side: ev.kind, types: sdp.media.map((m) => m.type) }
              continue
            }
            if (ev.kind === offer.side) continue
            const shared = Math.min(offer.types.length, sdp.media.length)
            for (let i = 0; i < shared; i++) {
              const offerType = offer.types[i] ?? ""
              const answerType = sdp.media[i]?.type ?? ""
              if (offerType !== answerType) {
                out.push({
                  bindKey: slot.bindKey,
                  detail:
                    `Answer m=[${i}] media type '${answerType}' does not match offer m=[${i}] type ` +
                    `'${offerType}' (callId ${slice.callId}) — RFC 3264 §6.1 / RFC3264-MUST-022`,
                })
              }
            }
            break
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.directionPairValid
//
// RFC 3264 §6.1 / RFC3264-MUST-023: per-stream direction pairing —
//   offer sendonly  → answer recvonly | inactive
//   offer recvonly  → answer sendonly | inactive
//   offer inactive  → answer inactive
//   offer sendrecv  → answer sendrecv | sendonly | recvonly | inactive
//
// Per-Call-ID per-agent walk in slot insertion order. Same offer/answer
// detection as the sibling rules: first SDP body is the offer, the next
// SDP body in the opposite direction is the answer. For each shared m=
// index, compare offer/answer directions against the matrix; fire per
// invalid pairing slot. Stop after the first answer.
//
// Regression-only — fixtures use valid direction pairs; rule trips on
// invalid pairing (e.g. sendonly→sendonly).
// ---------------------------------------------------------------------------

const ALLOWED_ANSWERS_FOR_OFFER: Record<SdpDirection, ReadonlySet<SdpDirection>> = {
  sendonly: new Set<SdpDirection>(["recvonly", "inactive"]),
  recvonly: new Set<SdpDirection>(["sendonly", "inactive"]),
  inactive: new Set<SdpDirection>(["inactive"]),
  sendrecv: new Set<SdpDirection>(["sendrecv", "sendonly", "recvonly", "inactive"]),
}

export const directionPairValidRule: CrossMessageRule = {
  name: "rfc.directionPairValid",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          let offer: {
            side: "sent" | "received"
            directions: ReadonlyArray<SdpDirection>
          } | null = null

          for (const ev of events) {
            const msg = ev.msg
            if (msg.body.byteLength === 0) continue
            const sdp = parseSdpBody(msg.body)
            if (sdp === null) continue

            if (offer === null) {
              offer = { side: ev.kind, directions: sdp.media.map((m) => extractDirection(m)) }
              continue
            }
            if (ev.kind === offer.side) continue
            const shared = Math.min(offer.directions.length, sdp.media.length)
            for (let i = 0; i < shared; i++) {
              const offerDir = offer.directions[i] ?? "sendrecv"
              const answerMedia = sdp.media[i]
              if (answerMedia === undefined) continue
              const answerDir = extractDirection(answerMedia)
              if (!ALLOWED_ANSWERS_FOR_OFFER[offerDir].has(answerDir)) {
                out.push({
                  bindKey: slot.bindKey,
                  detail:
                    `Answer direction '${answerDir}' invalid for offer direction '${offerDir}' ` +
                    `at m=[${i}] (callId ${slice.callId}) — RFC 3264 §6.1 / RFC3264-MUST-023`,
                })
              }
            }
            break
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.rejectedStreamMinimalAnswer
//
// RFC 3264 §6 / RFC3264-MUST-021: a rejected stream in the answer (port = 0)
// MUST still list at least one media format in the m= line.
//
// Per-Call-ID per-agent walk in slot insertion order. Same offer/answer
// detection as the sibling rules: first SDP body is the offer, the next
// SDP body in the opposite direction is the answer. For each answer m=
// block with `port === 0`, fire if `formats.length === 0`. Stop after the
// first answer.
//
// Regression-only — fixtures preserve format list on rejected streams;
// rule trips on bare m= rejection.
// ---------------------------------------------------------------------------

export const rejectedStreamMinimalAnswerRule: CrossMessageRule = {
  name: "rfc.rejectedStreamMinimalAnswer",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          let offerSide: "sent" | "received" | null = null

          for (const ev of events) {
            const msg = ev.msg
            if (msg.body.byteLength === 0) continue
            const sdp = parseSdpBody(msg.body)
            if (sdp === null) continue

            if (offerSide === null) {
              offerSide = ev.kind
              continue
            }
            if (ev.kind === offerSide) continue
            for (let i = 0; i < sdp.media.length; i++) {
              const m = sdp.media[i]
              if (m === undefined) continue
              if (m.port !== 0) continue
              if (m.formats.length === 0) {
                out.push({
                  bindKey: slot.bindKey,
                  detail:
                    `Rejected stream m=[${i}] (port=0) carries no media format tokens ` +
                    `(callId ${slice.callId}) — RFC 3264 §6 / RFC3264-MUST-021`,
                })
              }
            }
            break
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.reOfferMLineCountMonotonic
//
// RFC 3264 §8 / RFC3264-MUST-042 + RFC3264-MUST-043: across re-offers in the
// same session, the m= line count MUST NOT decrease. Deleted streams keep
// their slot (port=0, not removed). New m= lines appear *below* existing
// ones — structurally enforced by m= slot stability (M-043 covered).
//
// Per-Call-ID per-agent walk in slot insertion order. Track every sent SDP
// body (offers and re-offers from this side). For each consecutive pair
// (prev-offer, new-offer): fire if `new.media.length < prev.media.length`
// — a stream was removed instead of kept-with-port-0.
//
// Regression-only — current re-offers preserve m= slots; rule trips on
// count decrease (stream removal).
// ---------------------------------------------------------------------------

export const reOfferMLineCountMonotonicRule: CrossMessageRule = {
  name: "rfc.reOfferMLineCountMonotonic",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          let prevCount: number | null = null

          for (const ev of events) {
            if (ev.kind !== "sent") continue
            const msg = ev.msg
            if (msg.body.byteLength === 0) continue
            const sdp = parseSdpBody(msg.body)
            if (sdp === null) continue

            const count = sdp.media.length
            if (prevCount !== null && count < prevCount) {
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `Re-offer m= count ${count} decreased from prior offer ${prevCount} — ` +
                  `streams must keep their slot (port=0) (callId ${slice.callId}) — ` +
                  `RFC 3264 §8 / RFC3264-MUST-042`,
              })
            }
            prevCount = count
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.zeroPortPropagation
//
// RFC 3264 §8 / RFC3264-MUST-044: a stream offered with port=0 (disabled
// stream) MUST be marked with port=0 in the answer.
//
// Per-Call-ID per-agent walk in slot insertion order. Same offer/answer
// detection as the sibling rules: first SDP body is the offer, the next
// SDP body in the opposite direction is the answer. For each shared m=
// index, fire if `offer.media[i].port === 0` and
// `answer.media[i].port !== 0`. Stop after the first answer.
//
// Regression-only — fixtures preserve zero-port on rejected streams; rule
// trips on phantom port-assignment.
// ---------------------------------------------------------------------------

export const zeroPortPropagationRule: CrossMessageRule = {
  name: "rfc.zeroPortPropagation",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          let offer: {
            side: "sent" | "received"
            ports: ReadonlyArray<number>
          } | null = null

          for (const ev of events) {
            const msg = ev.msg
            if (msg.body.byteLength === 0) continue
            const sdp = parseSdpBody(msg.body)
            if (sdp === null) continue

            if (offer === null) {
              offer = { side: ev.kind, ports: sdp.media.map((m) => m.port) }
              continue
            }
            if (ev.kind === offer.side) continue
            const shared = Math.min(offer.ports.length, sdp.media.length)
            for (let i = 0; i < shared; i++) {
              const offerPort = offer.ports[i]
              const answerPort = sdp.media[i]?.port
              if (offerPort !== 0) continue
              if (answerPort === undefined) continue
              if (answerPort !== 0) {
                out.push({
                  bindKey: slot.bindKey,
                  detail:
                    `Offer m=[${i}] has port=0 but answer m=[${i}] has port=${answerPort} ` +
                    `(callId ${slice.callId}) — RFC 3264 §8 / RFC3264-MUST-044`,
                })
              }
            }
            break
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.payloadTypeMappingStable
//
// RFC 3264 §8.3.2 / RFC3264-MUST-047: the dynamic payload-type → codec
// mapping (via `a=rtpmap:<pt> <encoding>/<rate>`) MUST NOT change across
// SDP versions in the same session.
//
// Per-Call-ID per-agent walk in slot insertion order. Maintain
// `seenMappings: Map<pt, encoding>` across every sent SDP body. For each
// new SDP version, walk every m-line and call `extractRtpmaps(media)` to
// get this version's PT → encoding map. For each PT in the new map: if
// `seenMappings` already has this PT AND the encoding differs → fire.
// Otherwise add to `seenMappings`.
//
// Regression-only — current re-offers keep payload-type mappings stable;
// rule trips on PT rebind across SDP versions.
// ---------------------------------------------------------------------------

export const payloadTypeMappingStableRule: CrossMessageRule = {
  name: "rfc.payloadTypeMappingStable",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          const seenMappings = new Map<string, string>()

          for (const ev of events) {
            const msg = ev.msg
            if (msg.body.byteLength === 0) continue
            const sdp = parseSdpBody(msg.body)
            if (sdp === null) continue

            for (const media of sdp.media) {
              const rtpmaps = extractRtpmaps(media)
              for (const [pt, enc] of rtpmaps) {
                const prev = seenMappings.get(pt)
                if (prev === undefined) {
                  seenMappings.set(pt, enc)
                  continue
                }
                if (prev !== enc) {
                  out.push({
                    bindKey: slot.bindKey,
                    detail:
                      `Dynamic payload-type ${pt} remapped: was '${prev}' now '${enc}' ` +
                      `(callId ${slice.callId}) — RFC 3264 §8.3.2 / RFC3264-MUST-047`,
                  })
                }
              }
            }
          }
        }
      }
      return out
    }),
}

const sliceTypedRules: ReadonlyArray<CrossMessageRule> = [
  noNewOfferWhileOfferPendingRule,
  answerMLineCountMatchesOfferRule,
  answerTLineEqualsOfferRule,
  answerMediaTypeMatchesOfferRule,
  directionPairValidRule,
  rejectedStreamMinimalAnswerRule,
  reOfferMLineCountMonotonicRule,
  zeroPortPropagationRule,
  payloadTypeMappingStableRule,
]

// Advisory overrides — rules that fire on legitimate B2BUA traffic where
// the heuristic can't cleanly distinguish "B2BUA pattern" from "real
// violation". Mirrors the override tables in
// rfc3261-cross-message-rules.ts / rfc3262-cross-message-rules.ts.
const RFC3264_ADVISORY_OVERRIDES: ReadonlyMap<string, string> = new Map<string, string>([
  [
    "rfc.noNewOfferWhileOfferPending",
    "B2BUA can legitimately emit a new offer on one leg before the prior " +
      "offer's answer is observed on the same leg (the answer arrives on " +
      "the other leg's slice after Call-ID rewrite). Per-slice pendingOffer " +
      "tracker has no cross-leg view. Advisory until subject narrows to " +
      "non-DUT peer binds or rule models cross-leg O/A correlation.",
  ],
  [
    "rfc.directionPairValid",
    "B2BUA may translate SDP direction attributes across legs as part of " +
      "policy (e.g. force `sendrecv` on one leg even when the peer offered " +
      "`inactive` for hold reasons on the other leg). Per-slice direction " +
      "pairing cannot distinguish 'policy translation' from 'genuine " +
      "violation'. Advisory until subject narrows to non-DUT peer binds.",
  ],
  [
    "rfc.zeroPortPropagation",
    "B2BUA anchors media per leg and assigns its own RTP ports — a " +
      "peer-side offer with port=0 (stream disabled) becomes a B2BUA-side " +
      "offer/answer with the B2BUA's anchored port (e.g. 20001). Per-slice " +
      "view can't see the cross-leg port-rewrite. Advisory until subject " +
      "narrows to non-DUT peer binds or the rule models B2BUA media " +
      "anchoring.",
  ],
])

export const rfc3264CrossMessageRules: ReadonlyArray<CrossMessageAuditRule> =
  sliceTypedRules.map((rule) => {
    const advisory = RFC3264_ADVISORY_OVERRIDES.get(rule.name)
    const base = adaptCrossMessageRule(rule)
    if (advisory === undefined) return base
    return { ...base, severityOverride: "advisory", justification: advisory }
  })
