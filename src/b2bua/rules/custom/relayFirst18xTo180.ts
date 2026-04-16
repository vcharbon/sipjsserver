/**
 * relayFirst18xTo180 — PolicyModule for hiding forking/failover from the caller.
 *
 * When activated by the HTTP routing response (relay_first_18x_to_180: true),
 * this policy:
 *   1. Transforms the first 18x from any b-leg into a bare 180 (no SDP, no 100rel)
 *   2. Suppresses all subsequent 18x messages across all b-legs
 *   3. On 200 OK, forces the a-facing To-tag to match the one from the first 180
 *      (hiding failover from the caller)
 *
 * Rules are module-private — only the PolicyModule export is public.
 * Guard is applied by createRuleRegistry at registration time.
 */

import { Effect, Schema } from "effect"
import type { RuleDefinition, RuleAction } from "../framework/RuleDefinition.js"
import { definePolicyModule } from "../framework/PolicyModule.js"
import type { SipResponse } from "../../../sip/types.js"
import { getHeader, getHeaders, newTag } from "../../../sip/MessageFactory.js"

// ── Helpers ───────────────────────────────────────────────────────────────

function cseqMethod(resp: SipResponse): string {
  const h = getHeader(resp.headers, "cseq") ?? ""
  return h.split(/\s+/)[1]?.toUpperCase() ?? "INVITE"
}

function cseqNumber(resp: SipResponse): number {
  const h = getHeader(resp.headers, "cseq") ?? ""
  return parseInt(h.trim().split(/\s+/)[0] ?? "0", 10)
}

/** RFC 3262: reliable 1xx carries Require:100rel and a numeric RSeq. */
function reliableRseq(resp: SipResponse): number | undefined {
  const require = getHeaders(resp.headers, "require")
  const has100rel = require.some((v) =>
    v.toLowerCase().split(",").some((t) => t.trim() === "100rel"),
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

// ── suppress-18x (module-private, priority 850) ──────────────────────────
//
// Runs BEFORE relay-provisional (900). On first 18x: pre-generate a-facing
// tag, seed tag mapping, relay as bare 180. On subsequent 18x: suppress
// relay but still record CDR.

const suppress18x: RuleDefinition<PolicyState, undefined> = {
  id: "suppress-18x",
  name: "Suppress 18x -> 180",
  alwaysActive: true,
  defaultPriority: 850,
  stateKey: STATE_KEY,
  stateSchema: PolicyState,
  paramsSchema: Schema.Undefined,

  // Identical match signature to relay-provisional; overrides: claims its slot
  // whenever this policy module is active on the call.
  overrides: "relay-provisional",
  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: "1xx",
    direction: "from-b",
  },

  matches: (ctx) => {
    if (ctx.event.type !== "sip") return false
    const msg = ctx.event.message
    if (msg.type !== "response") return false
    if (msg.status < 100 || msg.status >= 200) return false
    if (ctx.direction !== "from-b") return false
    return cseqMethod(msg as SipResponse) === "INVITE"
  },

  init: () => ({ firstRelayed: false }),

  handle: (ctx, state) => {
    const resp = (ctx.event as Extract<typeof ctx.event, { type: "sip" }>).message as SipResponse
    const bTag = resp.parsed?.to?.tag ?? ""
    const rseq = reliableRseq(resp)
    const inviteCSeq = cseqNumber(resp)

    // Reliable 1xx → B2BUA must PRACK the b-leg itself (RFC 3262 §3-4).
    // alice never sees the reliable provisional (downgraded to bare 180 with
    // Require/RSeq stripped), so she will never send a PRACK to relay; the
    // B2BUA acks locally to stop UAS retransmissions.
    const prackAction: RuleAction | undefined =
      rseq !== undefined && bTag
        ? { type: "send-prack-to-leg", legId: ctx.sourceLeg.legId,
            rseq, inviteCSeq, bTag }
        : undefined

    if (state.firstRelayed) {
      // Subsequent 18x — suppress relay, still PRACK if reliable
      const actions: RuleAction[] = []
      if (prackAction) actions.push(prackAction)
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
        status: 180, reason: "Ringing", body: null,
        headers: { "Content-Type": null, "Require": null, "RSeq": null },
      }},
      { type: "add-cdr-event", eventType: "provisional" as const,
        legId: ctx.sourceLeg.legId, statusCode: resp.status },
    ]
    if (prackAction) actions.push(prackAction)

    return Effect.succeed({
      actions,
      state: { firstRelayed: true, storedATag: aFacingTag },
    })
  },
}

// ── force-tag-consistency (module-private, priority 851) ─────────────────
//
// Composes with confirm-dialog (903). On 200 OK INVITE from b-leg:
// pre-seeds the tag mapping with the stored a-facing tag so that
// confirm-dialog's findByBTag() finds it and reuses it instead of
// generating a new tag. This makes the 200 OK To-tag match the 180.

const forceTagConsistency: RuleDefinition<PolicyState, undefined> = {
  id: "force-tag-consistency",
  name: "Force Tag Consistency on 200 OK",
  alwaysActive: true,
  defaultPriority: 851,
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

  matches: (ctx) => {
    if (ctx.event.type !== "sip") return false
    const msg = ctx.event.message
    if (msg.type !== "response") return false
    if (msg.status < 200 || msg.status >= 300) return false
    if (ctx.direction !== "from-b") return false
    if (cseqMethod(msg as SipResponse) !== "INVITE") return false
    // Same guards as confirm-dialog — don't compose if confirm-dialog wouldn't match
    if (ctx.sourceLeg.state === "confirmed") return false
    if (ctx.sourceLeg.disposition === "cancelling") return false
    return true
  },

  init: () => ({ firstRelayed: false }),

  handle: (ctx, state) => {
    if (!state.storedATag) return Effect.void

    const resp = (ctx.event as Extract<typeof ctx.event, { type: "sip" }>).message as SipResponse
    const bTag = resp.parsed?.to?.tag ?? ""

    // Pre-seed tag mapping so confirm-dialog reuses our stored a-facing tag
    return Effect.succeed({
      actions: [
        { type: "add-tag-mapping" as const, aTag: state.storedATag,
          bLegId: ctx.sourceLeg.legId, bTag },
      ],
      state,
    })
  },
}

// ── absorb-prack-200 (module-private, priority 920) ──────────────────────
//
// Runs BEFORE relay-non-invite-200 (927). The B2BUA synthesizes PRACK toward
// the b-leg when it absorbs a reliable 1xx (alice never saw it, so alice
// won't generate the PRACK). Bob's 200 OK for that B2BUA-originated PRACK
// must not be relayed to alice — absorb it here.

const absorbPrack200: RuleDefinition<PolicyState, undefined> = {
  id: "absorb-prack-200",
  name: "Absorb 200 OK for B2BUA-synthesized PRACK",
  alwaysActive: true,
  defaultPriority: 920,
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

  matches: (ctx) => {
    if (ctx.event.type !== "sip") return false
    const msg = ctx.event.message
    if (msg.type !== "response") return false
    if (msg.status < 200 || msg.status >= 300) return false
    if (ctx.direction !== "from-b") return false
    return cseqMethod(msg as SipResponse) === "PRACK"
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
}

// ── Single export: the PolicyModule ───────────────────────────────────────

export const relayFirst18xTo180 = definePolicyModule({
  id: "relayFirst18x_to_180",
  guard: (ctx) => ctx.call.policies?.relayFirst18xTo180 === true,
  rules: [suppress18x, forceTagConsistency, absorbPrack200],
})
