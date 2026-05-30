/**
 * promote18xPemTo200 — callflow service for the `promote-pem-to-200` strategy.
 *
 * When activated (the `relayFirst18xTo180` strategy `"promote-pem-to-200"`
 * seeds the service's `call.ext["promote-pem"]` slice in applyRoute), this
 * service promotes the first `183 Session Progress + SDP + P-Early-Media` from
 * any b-leg fork into a synthetic `200 OK INVITE` toward Alice. Used for
 * callers (typically constrained handsets) that only emit DTMF after their
 * INVITE is confirmed.
 *
 * The service owns a typed call-ext slice (`PemCallExt`); rules read the
 * decoded slice and return an updated slice (the framework re-encodes it into
 * `Call.ext["promote-pem"]`). There is no per-leg ext and no phase machine —
 * `windowOpen`/`promoted` booleans gate the rules.
 *
 * Behavioural envelope (see docs/plan/18x-pem-to-200ok-glistening-biscuit.md):
 *
 *   1. First matching 183 — convert to 200 OK on the a-leg, mark a-leg
 *      confirmed, locally PRACK b on reliable provisional, set
 *      `{ promoted: true, promotedSdp, windowOpen: true }`.
 *   2. Subsequent 18x from any b-leg fork — drop on the a-side; PRACK b
 *      if reliable.
 *   3. A's ACK to our promoted 200 OK — absorb (b is still in early
 *      dialog; relaying the ACK would land on a phantom 2xx).
 *   4. A's in-dialog requests during the window — re-INVITE/UPDATE → 491,
 *      INFO/MESSAGE → 488. BYE flows through the default handler which
 *      CANCELs the early b-leg.
 *   5. B's eventual 200 OK — confirm the b-leg, merge, suppress the
 *      otherwise-default relay-to-peer (alice already saw 200 OK), and
 *      diff b's SDP against `promotedSdp`. Equivalent → window closes
 *      immediately. Different → emit a B2BUA-originated re-INVITE on the
 *      a-leg with b's SDP and stash its CSeq in `resyncReinviteCSeq`.
 *   6. B's failure post-promote — A is already confirmed, so a 4xx/5xx/6xx
 *      from B cannot be relayed back as a routing failure. Send BYE to A
 *      with `Reason: SIP;cause=<status>;text="<phrase>"` and tear down.
 *   7. The resync re-INVITE response on the a-leg — 2xx → ACK A and clear
 *      the window; 4xx/5xx/6xx → BYE both legs with a diagnostic Reason.
 *
 * Mutually exclusive with the other `relay_first_18x_to_180` strategies
 * (single Schema variant).
 */

import { Effect, Schema } from "effect"
import { defineService } from "../framework/Service.js"
import type { RuleAction } from "../framework/RuleDefinition.js"
import type { SipResponse } from "../../../sip/types.js"
import { getHeader, getHeaders, newTag } from "../../../sip/MessageHelpers.js"
import { splitTopLevelCommas } from "../../../sip/parsers/custom/structured-headers.js"
import { H, replaceH, removeH, custom as customH } from "../framework/actions/factories.js"
import type { HeaderName, HeaderUpdate } from "../framework/actions/types.js"
import { findByBTag } from "../../../call/CallModel.js"
import { sdpMediaEquivalent } from "./_shared/sdpDiff.js"

// ── Service call-ext schema ───────────────────────────────────────────────

/**
 * Per-call state for the `promote-pem-to-200` early-media strategy.
 *
 * `promoted` replaces the former `earlyPromote != null` activation test:
 * the seed (`{ promoted: false, windowOpen: false }`) is the pre-promotion
 * state, and a "clear" resets to it. `promotedSdp` rides as the Encoded
 * base64 string at rest (JSON-safe) and decodes to a `Uint8Array` for the
 * SDP diff.
 */
const PemCallExt = Schema.Struct({
  /** True once the first 183+SDP+PEM has been promoted to 200 OK. */
  promoted: Schema.Boolean,
  /** SDP body sent to alice in the synthetic 200 OK; compared against b's final answer. */
  promotedSdp: Schema.optional(Schema.Uint8ArrayFromBase64),
  /** While true, alice's in-dialog requests (other than BYE) are rejected. */
  windowOpen: Schema.Boolean,
  /** CSeq of an outstanding B2BUA-originated re-INVITE toward alice; set during resync. */
  resyncReinviteCSeq: Schema.optional(Schema.Int),
})

type PemCallExt = typeof PemCallExt.Type

/** Pre-promotion / cleared state. */
const PEM_INITIAL: PemCallExt = { promoted: false, windowOpen: false }

const promotePem = defineService({
  id: "promote-pem",
  callExt: PemCallExt,
})

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * RFC 3261 §13.3.1 / §20.5: 2xx responses to INVITE (and B2BUA-originated
 * re-INVITEs) SHOULD declare which methods the UA accepts. Bob's 183 may
 * not advertise these — we synthesize a 200 OK ourselves, so we own
 * the Allow header on the wire toward alice. The set mirrors the methods
 * the B2BUA actually relays end-to-end (cf. RelayRules.ts) so an alice
 * stack inspecting Allow can trust what it sees.
 */
const B2BUA_ALLOW = "INVITE, ACK, CANCEL, BYE, OPTIONS, UPDATE, INFO, REFER, PRACK, MESSAGE, NOTIFY"

/**
 * RFC 3261 §20.37: Supported lists the option-tags the UA understands.
 * Mirrors the B2BUA's relayable feature set (timer per RFC 4028, replaces
 * per RFC 3891). 100rel is intentionally OMITTED on the synthetic 200 OK —
 * alice never saw a reliable provisional from us; advertising 100rel
 * post-confirmation would let her inject a PRACK with no matching RSeq.
 */
const B2BUA_SUPPORTED_NO_100REL = "timer, replaces"

/**
 * RFC 3262: a reliable 1xx carries `Require: 100rel` and a numeric `RSeq`.
 * Mirrors the helper in relayFirst18xTo180.ts — copy-pasted to keep that
 * module self-contained; the helper is small and the duplication is intentional.
 */
function reliableRseq(resp: SipResponse): number | undefined {
  const require = getHeaders(resp.headers, "require")
  const has100rel = require.some((v) =>
    splitTopLevelCommas(v).some((t) => t.toLowerCase() === "100rel"),
  )
  if (!has100rel) return undefined
  const rseq = getHeader(resp.headers, "rseq")
  if (rseq === undefined) return undefined
  const n = parseInt(rseq.trim(), 10)
  return Number.isFinite(n) ? n : undefined
}

/** True iff the response carries a P-Early-Media header (RFC 5009). */
function hasPEarlyMedia(resp: SipResponse): boolean {
  return getHeader(resp.headers, "p-early-media") !== undefined
}

/** Build a Reason header value from a SIP status (RFC 3326). */
function reasonHeader(status: number, phrase: string | undefined): string {
  const text = (phrase ?? "").replace(/"/g, "")
  return `SIP ;cause=${status};text="${text || "Unspecified"}"`
}

/** Locate the b-leg id of the still-early b-leg the promotion was bound to. */
function pendingBLegId(call: { readonly bLegs: ReadonlyArray<{ readonly legId: string; readonly state: string }> }): string | undefined {
  for (const b of call.bLegs) {
    if (b.state !== "terminated") return b.legId
  }
  return undefined
}

// ── Rule 1: promote-183-pem ──────────────────────────────────────────────
//
// Match: 183 + SDP + P-Early-Media from b-leg, before any earlier promotion.
// Specificity (status:183 + filter) is the highest among any rule that could
// claim a 1xx INVITE response, so this wins by ranking — no `overrides`.

promotePem.rule({
  id: "promote-183-pem",
  name: "Promote 183+SDP+PEM to 200 OK on a-leg",

  match: {
    kind: "response",
    cseqMethod: "INVITE",
    status: 183,
    direction: "from-b",
  },
  filter: (ctx, ext) => {
    const resp = ctx.event.message
    if (resp.body.byteLength === 0) return false
    if (!hasPEarlyMedia(resp)) return false
    // Once promoted, subsequent 183s fall through to suppress-post-promote-18x.
    return !ext.promoted
  },

  handle: (ctx, ext) =>
    Effect.sync(() => {
      const resp = ctx.event.message
      const bTag = resp.getHeader("to").tag
      const rseq = reliableRseq(resp)
      const inviteCSeq = resp.getHeader("cseq").seq

      // Pre-generate the a-facing tag and seed tagMap so the relayed 200 OK
      // and any later in-dialog routing pin to one stable identity even if
      // bob's upstream forks subsequently.
      const aFacingTag = newTag()

      const headerUpdates = new Map<HeaderName, HeaderUpdate>([
        [H.Require, removeH()],
        [H.RSeq, removeH()],
        [customH("p-early-media"), removeH()],
        // RFC 3261 §13.3.1 / §20.5 / §20.37: stamp Allow + Supported on
        // the synthetic 200 OK. `replace` (not `inherit`) — bob's 183
        // values, if any, were tailored for the early-media exchange and
        // shouldn't leak into a confirmed-call advertisement.
        [H.Allow, replaceH(B2BUA_ALLOW)],
        [H.Supported, replaceH(B2BUA_SUPPORTED_NO_100REL)],
      ])

      const actions: RuleAction[] = [
        { type: "add-tag-mapping", aTag: aFacingTag, bLegId: ctx.sourceLeg.legId, bTag },
        // Establish the a-leg dialog so alice's ACK + in-dialog flow sees a
        // confirmed UAS dialog. Disposition stays at the leg's default —
        // we are NOT bridged yet (b is still in early state) and must not
        // claim "bridged" until the 200 OK from b arrives.
        { type: "update-leg-state", legId: "a", state: "confirmed" },
        { type: "stamp-dialog-to-tag", legId: "a", toTag: aFacingTag },
        // 183 → 200 OK on the wire toward alice. SDP body passes through
        // the existing relay path; only header manipulations are applied.
        { type: "relay-to-peer", transform: {
          status: 200,
          reason: "OK",
          headerUpdates,
        }},
        { type: "add-cdr-event", eventType: "provisional",
          legId: ctx.sourceLeg.legId, statusCode: 200,
          reason: "promote-pem-to-200" },
      ]

      // Reliable 18x → B2BUA must PRACK b locally (RFC 3262 §3-4); alice
      // never sees the reliable provisional and will never PRACK herself.
      if (rseq !== undefined) {
        actions.push({ type: "send-prack-to-leg", legId: ctx.sourceLeg.legId,
          rseq, inviteCSeq, bTag })
      }

      // Stash the SDP we just sent to alice so b's eventual 200 OK can be
      // diffed against it; flip the window open.
      return { actions, callExt: { ...ext, promoted: true, promotedSdp: resp.body, windowOpen: true } }
    }),
})

// ── Rule 2: suppress-post-promote-18x ────────────────────────────────────
//
// Once promoted, every subsequent 18x from b (any fork, any status) must
// stay on the b-side. The default `relay-provisional` would otherwise
// forward another 18x to alice — confusing because alice already saw 200 OK.
//
// Specificity is statusClass:1xx + filter (=5) which is one above
// relay-provisional (no filter, =4) but below promote-183-pem (status:183 +
// filter, =6). The `overrides` declaration on `suppress-18x` is needed so
// the registry validator skips the equal-specificity column overlap with
// the relayFirst18xTo180 module's `suppress-18x` rule (mutually exclusive
// at the policy-guard level, but the validator works column-only).

promotePem.rule({
  id: "suppress-post-promote-18x",
  name: "Suppress 18x from b after promotion",

  overrides: "suppress-18x",
  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: "1xx",
    direction: "from-b",
  },
  filter: (_ctx, ext) => ext.promoted,

  handle: (ctx) =>
    Effect.sync(() => {
      const resp = ctx.event.message
      const bTag = resp.getHeader("to").tag
      const rseq = reliableRseq(resp)
      const inviteCSeq = resp.getHeader("cseq").seq

      const actions: RuleAction[] = [
        { type: "add-cdr-event", eventType: "provisional",
          legId: ctx.sourceLeg.legId, statusCode: resp.status,
          reason: "promote-pem-to-200:suppressed" },
      ]
      if (rseq !== undefined) {
        actions.push({ type: "send-prack-to-leg", legId: ctx.sourceLeg.legId,
          rseq, inviteCSeq, bTag })
      }
      return { actions }
    }),
})

// ── Rule 3: confirm-after-promote ────────────────────────────────────────
//
// On the eventual 200 OK from a b-leg fork, replicate the structural pieces
// of the default `confirm-dialog` rule (b-leg confirmation, merge, destroy
// other forks, schedule keepalive/duration timers, CDR) — but DO NOT relay
// 200 OK to alice (already sent during promotion) and instead diff b's SDP
// against `promotedSdp`. On mismatch, emit a B2BUA-originated re-INVITE on
// the a-leg.
//
// Specificity adds `legState:[trying,early]` so the registry validator does
// not flag a same-specificity overlap with relayFirst18xTo180's
// `force-tag-consistency` rule (mutually exclusive at the policy-guard
// level).

promotePem.rule({
  id: "confirm-after-promote",
  name: "Confirm b after promote (no relay; SDP diff; maybe re-INVITE A)",

  // Override confirm-dialog so it doesn't run alongside us — we re-emit the
  // pieces we still want and intentionally skip relay-to-peer.
  overrides: "confirm-dialog",
  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: "2xx",
    legState: ["trying", "early"],
    // Excluding `cancelling` keeps cancel-200-crossing as the strict
    // winner when alice's BYE arrived before b's 200 OK (the b-leg
    // disposition flips to `cancelling` then). Excluding `rejected`
    // is equally important — by the time we see a 2xx the leg cannot
    // be `rejected`, but the column narrows specificity above the
    // default confirm-dialog and ahead of cancel-200-crossing.
    legDisposition: ["pending", "bridged"],
    direction: "from-b",
    // `transferPhase: null` carves out the REFER lifecycle (c-ringing /
    // c-realigning / a-realigning) — the dedicated transfer rules own
    // 2xx INVITE responses during those phases.
    transferPhase: null,
  },
  filter: (_ctx, ext) => ext.promoted,

  handle: (ctx, ext) =>
    Effect.sync(() => {
      const resp = ctx.event.message
      const bLeg = ctx.sourceLeg
      const bTag = resp.getHeader("to").tag
      const promotedSdp = ext.promotedSdp!

      // Reuse the a-facing tag we pinned at promotion time. The mapping was
      // pre-seeded in promote-183-pem; on the typical case (winning fork
      // sends 200 OK from the same dialog as the promoting 183) the bTag
      // matches the seeded mapping. On forking (different bTag wins),
      // `findByBTag` returns undefined for the winning bTag — re-seed under
      // the winning bTag using the SAME aTag so alice's identity stays put.
      const existingMapping = findByBTag(ctx.call, bLeg.legId, bTag)
      const seededMapping = ctx.call.tagMap.find((m) => m.bLegId === bLeg.legId)
      const aFacingTag = existingMapping?.aTag ?? seededMapping?.aTag ?? newTag()

      const actions: RuleAction[] = []

      // Confirm b-leg dialog — adopt §12 dialog from the 200 OK + flip
      // leg.state to confirmed/bridged.
      actions.push({ type: "update-leg-state", legId: bLeg.legId,
        state: "confirmed", disposition: "bridged" })
      actions.push({ type: "confirm-dialog", legId: bLeg.legId })

      // Pin the b→a tag mapping (idempotent on duplicate seed).
      if (existingMapping === undefined) {
        actions.push({ type: "add-tag-mapping", aTag: aFacingTag,
          bLegId: bLeg.legId, bTag })
      }

      // Generate ACK to bob locally (no end-to-end ACK relay — alice
      // already ACK'd our synthetic 200 OK long ago).
      actions.push({ type: "ack-leg", legId: bLeg.legId })

      // Bridge a-leg ↔ winning b-leg.
      actions.push({ type: "merge", legA: "a", legB: bLeg.legId })

      // Cancel/destroy losing b-leg forks (CANCEL early, BYE confirmed).
      for (const other of ctx.call.bLegs) {
        if (other.legId !== bLeg.legId && other.state !== "terminated") {
          actions.push({ type: "destroy-leg", legId: other.legId })
        }
      }

      // Cancel no-answer for the winning leg + schedule the standard
      // confirmed-call timers. Mirrors confirmDialogRule.
      actions.push({ type: "cancel-timer", timerId: `no-answer-${ctx.callRef}-${bLeg.legId}` })
      actions.push({ type: "schedule-timer", timerType: "keepalive",
        delaySec: ctx.config.keepaliveIntervalSec })
      actions.push({ type: "schedule-timer", timerType: "global_duration",
        delaySec: ctx.config.callMaxDurationSec })
      if (ctx.call.limiterEntries.length > 0) {
        actions.push({ type: "schedule-timer", timerType: "limiter_refresh",
          delaySec: ctx.config.limiterWindowSeconds })
      }

      actions.push({ type: "add-cdr-event", eventType: "answer",
        legId: bLeg.legId, statusCode: 200 })

      // SDP diff. If b's answer matches what alice already has, the call is
      // bridged silently and the window closes (reset to the initial slice).
      // Otherwise, emit a re-INVITE on the a-leg carrying b's SDP and keep
      // the window open until A's 200 OK to that re-INVITE is ACK'd
      // (handled by resync-reinvite-response).
      if (sdpMediaEquivalent(promotedSdp, resp.body)) {
        return { actions, callExt: PEM_INITIAL }
      }
      // The framework derives the outbound CSeq from the leg's localCSeq +
      // 1 (see executeSendReinvite). Capture the post-bump value here so
      // the resync-response filter can correlate the response.
      const aLegDialog = ctx.call.aLeg.dialogs[0]
      const nextCSeq = (aLegDialog?.sip.localCSeq ?? 0) + 1
      // RFC 3261 §13.3.1 / §20.5 / §20.37: even though this is a
      // re-INVITE within an established dialog, alice's stack may
      // re-evaluate Allow/Supported on every offer. Stamp explicit
      // values so we don't fall to a header-less request.
      const reinviteHeaders = new Map<HeaderName, HeaderUpdate>([
        [H.Allow, replaceH(B2BUA_ALLOW)],
        [H.Supported, replaceH(B2BUA_SUPPORTED_NO_100REL)],
      ])
      actions.push({ type: "send-reinvite", legId: "a",
        bodyUpdate: { kind: "set", value: resp.body },
        headerUpdates: reinviteHeaders })
      actions.push({ type: "add-cdr-event", eventType: "provisional",
        legId: "a", statusCode: 0, reason: "promote-pem-to-200:resync-reinvite" })

      return { actions, callExt: { ...ext, resyncReinviteCSeq: nextCSeq } }
    }),
})

// ── Rule 4: resync-reinvite-response ─────────────────────────────────────
//
// Match the response to OUR re-INVITE on the a-leg. send-reinvite does NOT
// register a pendingPersistentRequest snapshot, so relay-reinvite-response
// will not claim this — but our filter must still distinguish a resync
// response from a stray a-side INVITE response (none normally exist).

promotePem.rule({
  id: "promote-resync-reinvite-response",
  name: "Resync re-INVITE response (2xx → ACK + close window; failure → BYE both)",

  match: {
    kind: "response",
    cseqMethod: "INVITE",
    direction: "from-a",
    // `transferPhase: null` carves out a-realign responses (which a transfer
    // phase owns) and keeps this rule scoped to the post-promote resync only.
    transferPhase: null,
  },
  filter: (ctx, ext) => {
    const cseq = ctx.event.message.getHeader("cseq").seq
    const expected = ext.resyncReinviteCSeq
    return expected !== undefined && cseq === expected
  },

  handle: (ctx) =>
    Effect.sync(() => {
      const resp = ctx.event.message
      // Provisional — keep waiting. Returning undefined leaves the event
      // unclaimed; with no other rule matching from-a INVITE responses,
      // the executor falls through to its noop fallback.
      if (resp.status < 200) {
        return undefined
      }

      if (resp.status < 300) {
        // 2xx — ACK alice, close the window, return to normal flow.
        const actions: RuleAction[] = [
          { type: "ack-leg", legId: "a" },
          { type: "add-cdr-event", eventType: "answer", legId: "a",
            statusCode: resp.status, reason: "promote-pem-to-200:resync-success" },
        ]
        return { actions, callExt: PEM_INITIAL }
      }

      // 3xx/4xx/5xx/6xx — alice and bob now disagree on SDP. BYE both.
      // The Reason rides on every BYE begin-termination emits so both
      // alice and bob can log the upstream resync failure.
      const reason = reasonHeader(resp.status, resp.reason)
      const actions: RuleAction[] = [
        { type: "add-cdr-event", eventType: "reject", legId: "a",
          statusCode: resp.status, reason: `promote-pem-to-200:resync-failed:${reason}` },
        { type: "begin-termination", reason },
      ]
      return { actions, callExt: PEM_INITIAL }
    }),
})

// ── Rule 5: reject A in-dialog re-INVITE/UPDATE during window ────────────

promotePem.rule({
  id: "promote-reject-a-reinvite-update",
  name: "Reject A re-INVITE/UPDATE during promote window with 491",

  // Override the default UPDATE/INVITE relay rules — both have lower
  // specificity (no filter, no direction) so this wins by ranking too,
  // but the explicit override keeps things resilient against future
  // additions.
  overrides: "relay-update",
  match: {
    kind: "request",
    method: ["INVITE", "UPDATE"],
    direction: "from-a",
  },
  filter: (_ctx, ext) => ext.windowOpen,

  handle: () =>
    Effect.succeed({
      actions: [
        { type: "respond" as const, status: 491, reason: "Request Pending" },
      ],
    }),
})

// ── Rule 6: reject A in-dialog INFO/MESSAGE/NOTIFY/REFER during window ──

promotePem.rule({
  id: "promote-reject-a-other-indialog",
  name: "Reject A INFO/MESSAGE/NOTIFY/REFER during promote window with 488",

  overrides: "relay-info",
  match: {
    kind: "request",
    // REFER from-a is already rejected by the default
    // `transfer-reject-a-leg-refer` (501); leaving it out avoids a
    // same-specificity column overlap with that rule. NOTIFY has no
    // default relay rule and falls through to the framework's noop
    // fallback (501), which is also a refusal.
    method: ["INFO", "MESSAGE"],
    direction: "from-a",
  },
  filter: (_ctx, ext) => ext.windowOpen,

  handle: () =>
    Effect.succeed({
      actions: [
        { type: "respond" as const, status: 488, reason: "Not Acceptable Here" },
      ],
    }),
})

// ── Rule 7: absorb A's ACK during promote window ─────────────────────────
//
// Alice will ACK our promoted 200 OK while bob is still in early dialog.
// The default `relay-ack` would forward that ACK to bob, where it would
// race with bob's still-open INVITE transaction. Absorb it locally —
// later, in-dialog ACKs (e.g. for a successful resync re-INVITE) are
// generated by the framework via `ack-leg`, not by alice's stack.

promotePem.rule({
  id: "promote-absorb-a-ack",
  name: "Absorb A ACK during promote window",

  overrides: "relay-ack",
  match: {
    kind: "request",
    method: "ACK",
    direction: "from-a",
  },
  // Until the b-leg is bridged into activePeer, alice's ACK has no
  // valid forwarding target — absorb. Once activePeer is set (after
  // the merge in confirm-after-promote), the default `relay-ack`
  // takes over for any future ACKs.
  filter: (ctx, ext) => ext.promoted && ctx.call.activePeer === null,

  handle: () =>
    Effect.succeed({
      actions: [
        { type: "add-cdr-event" as const, eventType: "provisional",
          legId: "a", statusCode: 0, reason: "promote-pem-to-200:ack-absorbed" },
      ],
    }),
})

// ── Rule 8: B fails post-promote — BYE A with diagnostic Reason ──────────
//
// Override route-failure for the promoted case: the default rule treats
// 4xx/5xx/6xx from b as a route failure that may failover and ultimately
// 4xx alice. But alice is already confirmed — we cannot retract our
// 200 OK. BYE alice with a Reason carrying the original status.

promotePem.rule({
  id: "promote-b-fails-post-promote",
  name: "B fails post-promote → BYE A with Reason",

  overrides: "route-failure",
  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: ["3xx", "4xx", "5xx", "6xx"],
    direction: "from-b",
    // `callState: "active"` mirrors the default `handle-481` rule's column.
    // With matching specificity on this dimension the validator no longer
    // flags an equal-specificity overlap, and our higher overall score
    // (we add `direction` + `filter`) wins for the b-failure-post-promote
    // case while leaving handle-481 to claim 481s on other methods /
    // outside the promotion window.
    callState: "active",
    // `transferPhase: null` keeps the REFER c-leg failure rules
    // (transfer-c-fail-initial / transfer-c-realign-fail) as the strict
    // owners of failure responses inside the transfer lifecycle.
    transferPhase: null,
  },
  filter: (_ctx, ext) => ext.promoted,

  handle: (ctx) =>
    Effect.sync(() => {
      const resp = ctx.event.message
      const bLeg = ctx.sourceLeg
      const reason = reasonHeader(resp.status, resp.reason)

      const actions: RuleAction[] = [
        { type: "add-cdr-event", eventType: "reject", legId: bLeg.legId,
          statusCode: resp.status, reason: `promote-pem-to-200:b-failed:${reason}` },
        // Mark the failed b-leg so begin-termination skips re-BYEing it.
        { type: "terminate-leg", legId: bLeg.legId, byeDisposition: "rejected" as const },
        // begin-termination BYEs the (still-confirmed) a-leg with the
        // upstream cause — the BYE carries `Reason: SIP;cause=<status>;…`.
        { type: "begin-termination", reason },
      ]

      // Suppress unused warnings on the helper if pendingBLegId is unused.
      void pendingBLegId

      return { actions, callExt: PEM_INITIAL }
    }),
})

// ── Single export: the PolicyModule (ext-presence activation) ────────────

export const promote18xPemTo200 = promotePem.toPolicyModule()
