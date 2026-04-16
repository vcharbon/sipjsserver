/**
 * Default relay rules — relay-bye, relay-ack, relay-options, relay-reinvite,
 * relay-prack, relay-info.
 *
 * These are always-active rules that implement the standard B2BUA relay behavior.
 * They match SIP requests and relay them to the peer leg via the ActionExecutor.
 */

import { Effect, Schema } from "effect"
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
  opts: { id: string; name: string; priority: number },
): RuleDefinition<undefined, undefined> {
  return {
    id: opts.id,
    name: opts.name,
    alwaysActive: true,
    defaultPriority: opts.priority,
    stateSchema: Schema.Undefined,
    paramsSchema: Schema.Undefined,

    match: { kind: "request", method },

    init: () => undefined,

    handle: () =>
      Effect.succeed({
        actions: [{ type: "relay-to-peer" as const }],
        state: undefined,
      }),
  }
}

// ── relay-options (priority 924) ──────────────────────────────────────────

/** Relay in-dialog OPTIONS end-to-end (payload-transparent). */
export const relayOptionsRule: RuleDefinition<undefined, undefined> =
  makeTransparentRelayRule("OPTIONS", {
    id: "relay-options",
    name: "Relay OPTIONS",
    priority: 924,
  })

// ── relay-info (priority 925) ─────────────────────────────────────────────

/** Relay in-dialog INFO end-to-end (payload-transparent). */
export const relayInfoRule: RuleDefinition<undefined, undefined> =
  makeTransparentRelayRule("INFO", {
    id: "relay-info",
    name: "Relay INFO",
    priority: 925,
  })

// ── relay-bye (priority 912) ──────────────────────────────────────────────

/** Respond 200 to BYE sender, relay BYE to peer, terminate call. */
export const relayByeRule: RuleDefinition<undefined, undefined> = {
  id: "relay-bye",
  name: "Relay BYE",
  alwaysActive: true,
  defaultPriority: 912,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: { kind: "request", method: "BYE" },

  init: () => undefined,

  handle: (ctx) =>
    Effect.succeed({
      actions: [
        { type: "respond", status: 200, reason: "OK" },
        { type: "terminate-leg", legId: ctx.sourceLeg.legId, byeDisposition: "bye_received" as const },
        { type: "add-cdr-event", eventType: "bye" as const, legId: ctx.sourceLeg.legId },
        { type: "begin-termination" },
      ],
      state: undefined,
    }),
}

// ── relay-ack (priority 915) ──────────────────────────────────────────────

/** Relay ACK to peer leg. */
export const relayAckRule: RuleDefinition<undefined, undefined> = {
  id: "relay-ack",
  name: "Relay ACK",
  alwaysActive: true,
  defaultPriority: 915,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: { kind: "request", method: "ACK" },

  init: () => undefined,

  handle: () =>
    // ActionExecutor resolves the target via activePeer or To-tag fallback
    Effect.succeed({
      actions: [{ type: "relay-to-peer" as const }],
      state: undefined,
    }),
}

// ── relay-reinvite (priority 918) ─────────────────────────────────────────

/** Relay re-INVITE to peer leg. */
export const relayReinviteRule: RuleDefinition<undefined, undefined> =
  makeTransparentRelayRule("INVITE", {
    id: "relay-reinvite",
    name: "Relay re-INVITE",
    priority: 918,
  })

// ── relay-prack (priority 921) ────────────────────────────────────────────

/** Relay PRACK to peer leg. */
export const relayPrackRule: RuleDefinition<undefined, undefined> =
  makeTransparentRelayRule("PRACK", {
    id: "relay-prack",
    name: "Relay PRACK",
    priority: 921,
  })
