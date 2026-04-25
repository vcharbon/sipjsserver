/**
 * RFC 3264 / 3262 offer/answer state tracker for the e2e harness.
 *
 * Scope: **global across the scenario**, keyed primarily by the `x-offer-id`
 * nonce stamped into the SDP by `sdpOffer()`. Using the nonce rather than
 * Call-ID is intentional — a B2BUA creates two independent dialogs (different
 * Call-IDs on the a-leg and b-leg) but relays the SDP body unchanged, so the
 * same offer/answer exchange is observable on both sides with the same nonce.
 *
 * Classification comes from the body (`classifySdp`):
 *   - "offer"  → records a new PendingOffer (answered=false).
 *   - "answer" → finds the matching PendingOffer and flips `answered=true`.
 *                Answers re-emitted across messages (e.g. the same SDP in
 *                183 and 200 OK — see RFC 3262 §5 / RFC 3264 §5) do NOT open
 *                a new exchange; the second observation is tolerated as a
 *                re-emission of the already-answered offer.
 *
 * Dialog-connected gate (per Call-ID): before a dialog reaches 200-OK-to-
 * INVITE, an answer may appear without a matching offer (e.g. 488 with SDP).
 * The gate is checked BEFORE the 200-OK-INVITE itself updates the flag, so
 * the transitional message is still within the "early dialog" window.
 */

import type { SipMessage } from "../../../src/sip/types.js"
import { classifySdp } from "../helpers/sdp.js"

export interface PendingOffer {
  readonly party: string
  readonly callId: string
  readonly cseqNum: number
  readonly cseqMethod: string
  readonly nonce: string
  readonly port: number
  readonly stepIndex: number
  answered: boolean
}

export class OfferAnswerTracker {
  private readonly pending: PendingOffer[] = []
  private readonly connectedCallIds: Set<string> = new Set()

  markConnected(callId: string): void {
    this.connectedCallIds.add(callId)
  }

  observe(
    msg: SipMessage,
    party: string,
    stepIndex: number,
    skip: boolean
  ): string[] {
    const body = msg.body
    if (!body || body.byteLength === 0) return []
    const sdp = classifySdp(body)
    if (sdp.kind === "unclassified") return []

    const callId = msg.parsed.callId
    const cseqNum = msg.parsed.cseq.seq
    const cseqMethod = msg.parsed.cseq.method.toUpperCase()
    const is2xxInvite =
      msg.type === "response" &&
      msg.status >= 200 &&
      msg.status < 300 &&
      cseqMethod === "INVITE"

    // Opt-out: don't track this message's SDP at all. The connected flag is
    // still updated so downstream messages see an accurate dialog state.
    if (skip) {
      if (is2xxInvite && callId) this.connectedCallIds.add(callId)
      return []
    }

    if (sdp.kind === "offer") {
      this.pending.push({
        party, callId, cseqNum, cseqMethod,
        nonce: sdp.nonce, port: sdp.port, stepIndex,
        answered: false,
      })
      if (is2xxInvite && callId) this.connectedCallIds.add(callId)
      return []
    }

    // sdp.kind === "answer"
    const errors: string[] = []
    const connectedBeforeThisMsg = this.connectedCallIds.has(callId)

    if (sdp.nonce) {
      // Strict nonce match: the answer claims to answer a specific offer.
      const offer = this.pending.find((p) => p.nonce === sdp.nonce)
      if (offer) {
        if (sdp.port !== offer.port + 1) {
          errors.push(
            `SDP answer port ${sdp.port} does not match offer port ${offer.port} + 1 ` +
            `(nonce=${sdp.nonce}) — the answer was not derived from the offer it claims to answer`
          )
        }
        offer.answered = true
      } else if (connectedBeforeThisMsg) {
        errors.push(
          `SDP answer carries nonce="${sdp.nonce}" which does not match any observed offer — RFC 3264 §5`
        )
      }
    } else {
      // Blind answer (no nonce): match against any offer from a different
      // party. Prefer an unanswered offer; tolerate when only answered
      // offers exist (re-emission of the same SDP across 18x / 200).
      const unanswered = this.pending.find((p) => p.party !== party && !p.answered)
      if (unanswered) {
        unanswered.answered = true
      } else {
        const alreadyAnswered = this.pending.find((p) => p.party !== party && p.answered)
        if (!alreadyAnswered && connectedBeforeThisMsg) {
          errors.push(
            `SDP answer without matching offer (party=${party}, callId=${callId}): ` +
            `no pending offers — RFC 3264 §5`
          )
        }
      }
    }

    if (is2xxInvite && callId) this.connectedCallIds.add(callId)
    return errors
  }

  /**
   * Return offers that were never answered. Deduplicates by nonce so a
   * single unanswered exchange observed on multiple legs reports once.
   */
  danglingOffers(): PendingOffer[] {
    const out: PendingOffer[] = []
    const seenNonces = new Set<string>()
    for (const p of this.pending) {
      if (p.answered) continue
      if (p.nonce) {
        if (seenNonces.has(p.nonce)) continue
        seenNonces.add(p.nonce)
      }
      out.push(p)
    }
    return out
  }
}

