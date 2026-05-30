/**
 * relayFirst18xTo180 — PolicyModule for hiding forking/failover from the caller.
 *
 * When activated by the HTTP routing response (relay_first_18x_to_180: true,
 * or `"drop-sdp"` / `"keep-sdp"` / `"fake-prack"`), this policy:
 *   1. Transforms the first 18x from any b-leg into a bare 180 (no SDP, no 100rel)
 *   2. Suppresses all subsequent 18x messages across all b-legs
 *   3. On 200 OK, forces the a-facing To-tag to match the one from the first 180
 *      (hiding failover from the caller)
 *
 * The `fake-prack` strategy adds:
 *   4. Cache bob's reliable-1xx SDP per b-leg dialog (gated on `Require: 100rel`).
 *   5. Locally answer bob's UPDATE with a skeleton-fit SDP derived from alice's
 *      INVITE offer; reject 488 when no codec intersection exists.
 *   6. Locally answer alice's early-dialog UPDATE with a 200 OK no body
 *      (alice has no committed SDP from bob to re-offer).
 *   7. Substitute the cached b-leg SDP into the 200 OK INVITE relayed to alice
 *      so she sees a coherent offer/answer at confirmation time.
 *
 * Rules are module-private — only the PolicyModule export is public.
 * Guard is applied by createRuleRegistry at registration time.
 *
 * Each rule uses `defineRule({...})`, so handler bodies see a `ctx` whose
 * event/message are already narrowed by the match — no `as SipResponse`
 * casts and no `?? ""` defaults on `parsed.to.tag`.
 */

import { Effect, Schema } from "effect"
import { defineRule, type RuleAction } from "../framework/RuleDefinition.js"
import { definePolicyModule } from "../framework/PolicyModule.js"
import type { SipResponse } from "../../../sip/types.js"
import { getHeader, getHeaders, newTag } from "../../../sip/MessageHelpers.js"
import { splitTopLevelCommas } from "../../../sip/parsers/custom/structured-headers.js"
import { H, removeH } from "../framework/actions/factories.js"
import type { HeaderName, HeaderUpdate } from "../framework/actions/types.js"
import { buildAnswerFromOffer } from "../../../sip/SdpAnswerFromOffer.js"

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * RFC 3262: a reliable 1xx carries `Require: 100rel` and a numeric `RSeq`.
 * RSeq is not in the eagerly-parsed mandatory fields, so we still parse the
 * raw header value here — `Number.isFinite` guards a malformed peer payload,
 * not a parser invariant.
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

// ── Shared state (module-private) ─────────────────────────────────────────

const PolicyState = Schema.Struct({
  /** Whether the first 18x has been relayed as 180 to the caller. */
  firstRelayed: Schema.Boolean,
  /** The a-facing To-tag generated on the first 18x — reused on 200 OK. */
  storedATag: Schema.optional(Schema.String),
})
type PolicyState = typeof PolicyState.Type

const STATE_KEY = "relayFirst18x_to_180"

// ── suppress-18x (module-private) ──────────────────────────
//
// Runs BEFORE relay-provisional (900). On first 18x: pre-generate a-facing
// tag, seed tag mapping, relay as bare 180. On subsequent 18x: suppress
// relay but still record CDR.

const suppress18x = defineRule({
  id: "suppress-18x",
  name: "Suppress 18x -> 180",
  alwaysActive: true,
  stateKey: STATE_KEY,
  stateSchema: PolicyState,
  paramsSchema: Schema.Undefined,

  // Identical match signature to relay-provisional; overrides claims its slot
  // whenever this policy module is active on the call.
  overrides: "relay-provisional",
  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: "1xx",
    direction: "from-b",
  },

  init: () => ({ firstRelayed: false }),

  handle: (ctx, state) => {
    const resp = ctx.event.message
    const bTag = resp.getHeader("to").tag
    const rseq = reliableRseq(resp)
    const inviteCSeq = resp.getHeader("cseq").seq
    const strategy = ctx.call.features?.relayFirst18xTo180?.strategy

    // Reliable 1xx → B2BUA must PRACK the b-leg itself (RFC 3262 §3-4).
    // alice never sees the reliable provisional (downgraded to bare 180 with
    // Require/RSeq stripped), so she will never send a PRACK to relay; the
    // B2BUA acks locally to stop UAS retransmissions.
    const prackAction: RuleAction | undefined =
      rseq !== undefined
        ? { type: "send-prack-to-leg", legId: ctx.sourceLeg.legId,
            rseq, inviteCSeq, bTag }
        : undefined

    // fake-prack only: cache bob's SDP per dialog when 100rel is in play.
    // Gated on rseq presence per the contract — without 100rel bob will
    // repeat his SDP in 200 OK so caching adds nothing.
    const cacheAction: RuleAction | undefined =
      strategy === "fake-prack" && rseq !== undefined && resp.body.byteLength > 0
        ? { type: "cache-sdp-on-leg-dialog",
            legId: ctx.sourceLeg.legId, bTag, body: resp.body }
        : undefined

    if (state.firstRelayed) {
      // Subsequent 18x — suppress relay, still PRACK if reliable
      const actions: RuleAction[] = []
      if (prackAction) actions.push(prackAction)
      if (cacheAction) actions.push(cacheAction)
      actions.push({
        type: "add-cdr-event" as const, eventType: "provisional" as const,
        legId: ctx.sourceLeg.legId, statusCode: resp.status,
      })
      return Effect.succeed({ actions, state })
    }

    // First 18x — pre-generate a-facing tag, relay as bare 180
    const aFacingTag = newTag()

    const actions: RuleAction[] = [
      { type: "add-tag-mapping", aTag: aFacingTag,
        bLegId: ctx.sourceLeg.legId, bTag },
      { type: "relay-to-peer", transform: {
        status: 180, reason: "Ringing",
        bodyUpdate: { kind: "drop" },
        headerUpdates: new Map<HeaderName, HeaderUpdate>([
          [H["Content-Type"], removeH()],
          [H.Require, removeH()],
          [H.RSeq, removeH()],
        ]),
      }},
      { type: "add-cdr-event", eventType: "provisional" as const,
        legId: ctx.sourceLeg.legId, statusCode: resp.status },
    ]
    if (prackAction) actions.push(prackAction)
    // Cache MUST run after relay-to-peer — relayResponseMsg creates the
    // early dialog from the 1xx; cache-sdp-on-leg-dialog needs that dialog
    // to exist to find it by bTag.
    if (cacheAction) actions.push(cacheAction)

    return Effect.succeed({
      actions,
      state: { firstRelayed: true, storedATag: aFacingTag },
    })
  },
})

// ── force-tag-consistency (module-private) ─────────────────
//
// Composes with confirm-dialog (903). On 200 OK INVITE from b-leg:
// pre-seeds the tag mapping with the stored a-facing tag so that
// confirm-dialog's findByBTag() finds it and reuses it instead of
// generating a new tag. This makes the 200 OK To-tag match the 180.

const forceTagConsistency = defineRule({
  id: "force-tag-consistency",
  name: "Force Tag Consistency on 200 OK",
  alwaysActive: true,
  stateKey: STATE_KEY,
  stateSchema: PolicyState,
  paramsSchema: Schema.Undefined,

  composesWith: "confirm-dialog",

  // Same match signature as confirm-dialog — composition layers this rule
  // before the base rule rather than overriding it.
  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: "2xx",
    direction: "from-b",
  },

  init: () => ({ firstRelayed: false }),

  handle: (ctx, state) => {
    const resp = ctx.event.message
    const bTag = resp.getHeader("to").tag
    const strategy = ctx.call.features?.relayFirst18xTo180?.strategy

    const actions: RuleAction[] = []

    // Existing behavior: pre-seed tag mapping so confirm-dialog reuses the
    // stored a-facing tag (hides forking/failover identity from alice).
    if (state.storedATag) {
      actions.push({ type: "add-tag-mapping" as const, aTag: state.storedATag,
        bLegId: ctx.sourceLeg.legId, bTag })
    }

    // fake-prack only: stage the winning b-leg dialog's cached SDP into
    // call.policyUpdateBody so the response relay path substitutes it
    // into the 200 OK forwarded to alice. Folded into this rule (rather
    // than a sibling composer of confirm-dialog) because the registry
    // forbids two policy-module rules with identical match descriptors at
    // equal specificity composing the same base.
    if (strategy === "fake-prack") {
      const dialog = ctx.sourceLeg.dialogs.find((d) => d.sip.remoteTag === bTag)
        ?? ctx.sourceLeg.dialogs[0]
      const cached = dialog?.ext.cachedSdp
      if (cached !== undefined && cached.byteLength > 0) {
        actions.push({ type: "set-policy-update-body" as const, body: cached })
      } else if (resp.body.byteLength === 0) {
        // No cache AND bob's 200 OK has no body — surface a CDR marker so
        // operators can see why alice's call may break (no SDP at confirm).
        actions.push({ type: "add-cdr-event" as const, eventType: "provisional" as const,
          legId: ctx.sourceLeg.legId, statusCode: 200,
          reason: "fake-prack:200-ok-no-sdp" })
      }
      // else: bob repeated SDP in 200 OK → relay it as-is (no substitution).
    }

    if (actions.length === 0) return Effect.void
    return Effect.succeed({ actions, state })
  },
})

// ── absorb-prack-200 (module-private) ──────────────────────
//
// Runs BEFORE relay-non-invite-200 (927). The B2BUA synthesizes PRACK toward
// the b-leg when it absorbs a reliable 1xx (alice never saw it, so alice
// won't generate the PRACK). Bob's 200 OK for that B2BUA-originated PRACK
// must not be relayed to alice — absorb it here.

const absorbPrack200 = defineRule({
  id: "absorb-prack-200",
  name: "Absorb 200 OK for B2BUA-synthesized PRACK",
  alwaysActive: true,
  stateKey: STATE_KEY,
  stateSchema: PolicyState,
  paramsSchema: Schema.Undefined,

  // PRACK 2xx from b-leg — cseqMethod: "PRACK" beats relay-non-invite-200's
  // array by specificity, so this wins automatically when the policy is active.
  match: {
    kind: "response",
    cseqMethod: "PRACK",
    statusClass: "2xx",
    direction: "from-b",
  },

  init: () => ({ firstRelayed: false }),

  handle: (ctx, state) =>
    Effect.succeed({
      actions: [
        { type: "add-cdr-event" as const, eventType: "provisional" as const,
          legId: ctx.sourceLeg.legId, statusCode: 200 },
      ],
      state,
    }),
})

// ── fake-prack: handle UPDATE from b-leg locally ──────────────────────────
//
// Under `fake-prack`, alice never sees bob's SDP until 200 OK. If bob sends
// UPDATE with a re-offer in the early dialog, we cannot relay it (alice has
// no committed bob-SDP to negotiate against). The B2BUA answers locally
// using a skeleton-fit SDP derived from alice's INVITE offer; on no codec
// intersection we reject 488. Either way, the cached SDP for this dialog
// is replaced with bob's UPDATE offer so alice's eventual 200 OK reflects
// bob's latest state.
//
// The default `relay-update` rule is overridden when this rule fires —
// specificity wins (cseqMethod equivalent + direction-from-b + filter).

const fakePrackHandleUpdateFromB = defineRule({
  id: "fake-prack-handle-update-from-b",
  name: "Fake-PRACK: locally answer b-leg UPDATE",
  alwaysActive: true,
  stateKey: STATE_KEY,
  stateSchema: PolicyState,
  paramsSchema: Schema.Undefined,

  overrides: "relay-update",
  match: {
    kind: "request",
    method: "UPDATE",
    direction: "from-b",
    filter: (ctx) =>
      ctx.call.features?.relayFirst18xTo180?.strategy === "fake-prack",
  },

  init: () => ({ firstRelayed: false }),

  handle: (ctx, state) => {
    const req = ctx.event.message
    const updateBody = req.body
    const bTag = req.getHeader("from").tag ?? ""

    // UPDATE with no body: just respond 200 OK locally, nothing to cache.
    if (updateBody.byteLength === 0) {
      return Effect.succeed({
        actions: [
          { type: "respond" as const, status: 200, reason: "OK" },
        ],
        state,
      })
    }

    const aliceBody = ctx.call.aLegInvite.body
    const result = buildAnswerFromOffer(updateBody, aliceBody, {
      localIp: ctx.config.sipLocalIp,
      nowMs: ctx.nowMs,
    })

    if (result._tag === "ok") {
      return Effect.succeed({
        actions: [
          { type: "respond" as const, status: 200, reason: "OK",
            body: result.body, contentType: "application/sdp" },
          { type: "cache-sdp-on-leg-dialog" as const,
            legId: ctx.sourceLeg.legId, bTag, body: updateBody },
        ],
        state,
      })
    }

    // no-common-codec or no-alice-sdp → 488. Cache untouched.
    return Effect.succeed({
      actions: [
        { type: "respond" as const, status: 488, reason: "Not Acceptable Here" },
      ],
      state,
    })
  },
})

// ── fake-prack: handle UPDATE from alice locally ──────────────────────────
//
// Under `fake-prack`, alice has no committed bob-SDP to base an UPDATE
// re-offer on. If alice sends UPDATE in the early dialog (rare but
// possible if her stack tries to refresh session timers / SDP), respond
// 200 OK with no body locally — do NOT forward to bob.
//
// Restricted to early state (call not yet bridged); after merge, normal
// in-dialog UPDATE relay applies.

const fakePrackHandleUpdateFromA = defineRule({
  id: "fake-prack-handle-update-from-a",
  name: "Fake-PRACK: locally answer a-leg early-dialog UPDATE",
  alwaysActive: true,
  stateKey: STATE_KEY,
  stateSchema: PolicyState,
  paramsSchema: Schema.Undefined,

  overrides: "relay-update",
  match: {
    kind: "request",
    method: "UPDATE",
    direction: "from-a",
    legState: ["trying", "early"],
    filter: (ctx) =>
      ctx.call.features?.relayFirst18xTo180?.strategy === "fake-prack",
  },

  init: () => ({ firstRelayed: false }),

  handle: (_ctx, state) =>
    Effect.succeed({
      actions: [
        { type: "respond" as const, status: 200, reason: "OK" },
      ],
      state,
    }),
})

// ── Single export: the PolicyModule ───────────────────────────────────────

export const relayFirst18xTo180 = definePolicyModule({
  // Applicable only for THIS module's own early-media strategies. The
  // `promote-pem-to-200` strategy is owned by the promote18xPemTo200 service
  // (which seeds its own `ext["promote-pem"]`), so this module's rules must be
  // inactive there — otherwise `suppress-18x` would compete with PEM's
  // promotion. The two are mutually exclusive by strategy.
  id: "relayFirst18x_to_180",
  guard: (ctx) => {
    const strategy = ctx.call.features?.relayFirst18xTo180?.strategy
    return strategy !== undefined && strategy !== "promote-pem-to-200"
  },
  rules: [
    suppress18x,
    forceTagConsistency,
    absorbPrack200,
    fakePrackHandleUpdateFromB,
    fakePrackHandleUpdateFromA,
  ],
})
