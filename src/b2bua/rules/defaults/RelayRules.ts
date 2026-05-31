/**
 * Default relay rules — relay-bye, relay-ack, relay-options, relay-reinvite,
 * relay-prack, relay-info.
 *
 * These are always-active rules that implement the standard B2BUA relay behavior.
 * They match SIP requests and relay them to the peer leg via the ActionExecutor.
 */

import { Effect } from "effect"
import type { RuleDefinition, SipMethod } from "../framework/RuleDefinition.js"

// ── Transparent in-dialog relay factory ───────────────────────────────────
//
// Shared builder for rules that forward a single in-dialog request method
// end-to-end (OPTIONS, INFO, UPDATE, MESSAGE, re-INVITE, PRACK). All payload
// transparency (body, Content-Type, header passthrough) and CSeq/tag
// rewriting is handled by ActionExecutor.relayRequest — these rules only
// declare the match + emit `relay-to-peer`.

export function makeTransparentRelayRule(
  method: SipMethod,
  opts: { id: string; name: string },
): RuleDefinition {
  return {
    id: opts.id,
    name: opts.name,
    alwaysActive: true,

    match: { kind: "request", method },


    handle: () =>
      Effect.succeed({
        actions: [{ type: "relay-to-peer" as const }],
      }),
  }
}

// ── relay-options ─────────────────────────────────────────────────────────

/** Relay in-dialog OPTIONS end-to-end (payload-transparent). */
export const relayOptionsRule: RuleDefinition =
  makeTransparentRelayRule("OPTIONS", {
    id: "relay-options",
    name: "Relay OPTIONS",
  })

// ── relay-info ────────────────────────────────────────────────────────────

/** Relay in-dialog INFO end-to-end (payload-transparent). */
export const relayInfoRule: RuleDefinition =
  makeTransparentRelayRule("INFO", {
    id: "relay-info",
    name: "Relay INFO",
  })

// ── relay-update ──────────────────────────────────────────────────────────

/** Relay in-dialog UPDATE end-to-end (RFC 3311; payload-transparent). */
export const relayUpdateRule: RuleDefinition =
  makeTransparentRelayRule("UPDATE", {
    id: "relay-update",
    name: "Relay UPDATE",
  })

// ── relay-message ─────────────────────────────────────────────────────────

/** Relay in-dialog MESSAGE end-to-end (RFC 3428; payload-transparent). */
export const relayMessageRule: RuleDefinition =
  makeTransparentRelayRule("MESSAGE", {
    id: "relay-message",
    name: "Relay MESSAGE",
  })

// ── relay-bye ──────────────────────────────────────────────

/** Respond 200 to BYE sender, relay BYE to peer, terminate call. */
export const relayByeRule: RuleDefinition = {
  id: "relay-bye",
  name: "Relay BYE",
  alwaysActive: true,

  match: { kind: "request", method: "BYE" },


  handle: (ctx) =>
    Effect.succeed({
      actions: [
        { type: "respond", status: 200, reason: "OK" },
        { type: "terminate-leg", legId: ctx.sourceLeg.legId, byeDisposition: "bye_received" as const },
        { type: "add-cdr-event", eventType: "bye" as const, legId: ctx.sourceLeg.legId },
        { type: "begin-termination" },
      ],
    }),
}

// ── relay-ack ──────────────────────────────────────────────

/** Relay ACK to peer leg. */
export const relayAckRule: RuleDefinition = {
  id: "relay-ack",
  name: "Relay ACK",
  alwaysActive: true,

  match: { kind: "request", method: "ACK" },


  handle: () =>
    // ActionExecutor resolves the target via activePeer or To-tag fallback
    Effect.succeed({
      actions: [{ type: "relay-to-peer" as const }],
    }),
}

// ── relay-reinvite ────────────────────────────────────────────────────────

/** Relay re-INVITE to peer leg. */
export const relayReinviteRule: RuleDefinition =
  makeTransparentRelayRule("INVITE", {
    id: "relay-reinvite",
    name: "Relay re-INVITE",
  })

// ── relay-prack ───────────────────────────────────────────────────────────

/** Relay PRACK to peer leg. */
export const relayPrackRule: RuleDefinition =
  makeTransparentRelayRule("PRACK", {
    id: "relay-prack",
    name: "Relay PRACK",
  })
