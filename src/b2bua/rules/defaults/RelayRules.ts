/**
 * Default relay rules — relay-bye, relay-ack, relay-options, relay-reinvite, relay-prack.
 *
 * These are always-active rules that implement the standard B2BUA relay behavior.
 * They match SIP requests and relay them to the peer leg via the ActionExecutor.
 */

import { Effect, Schema } from "effect"
import type { RuleDefinition } from "../framework/RuleDefinition.js"

// ── relay-options (priority 924) ──────────────────────────────────────────

/** Respond 200 OK to in-dialog OPTIONS. */
export const relayOptionsRule: RuleDefinition<undefined, undefined> = {
  id: "relay-options",
  name: "Relay OPTIONS",
  alwaysActive: true,
  defaultPriority: 924,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  matches: (ctx) =>
    ctx.event.type === "sip" &&
    ctx.event.message.type === "request" &&
    ctx.event.message.method === "OPTIONS",

  init: () => undefined,

  handle: () =>
    Effect.succeed({
      actions: [{ type: "respond", status: 200, reason: "OK" }],
      state: undefined,
    }),
}

// ── relay-bye (priority 912) ──────────────────────────────────────────────

/** Respond 200 to BYE sender, relay BYE to peer, terminate call. */
export const relayByeRule: RuleDefinition<undefined, undefined> = {
  id: "relay-bye",
  name: "Relay BYE",
  alwaysActive: true,
  defaultPriority: 912,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  matches: (ctx) =>
    ctx.event.type === "sip" &&
    ctx.event.message.type === "request" &&
    ctx.event.message.method === "BYE",

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

  matches: (ctx) =>
    ctx.event.type === "sip" &&
    ctx.event.message.type === "request" &&
    ctx.event.message.method === "ACK",

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
export const relayReinviteRule: RuleDefinition<undefined, undefined> = {
  id: "relay-reinvite",
  name: "Relay re-INVITE",
  alwaysActive: true,
  defaultPriority: 918,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  matches: (ctx) =>
    ctx.event.type === "sip" &&
    ctx.event.message.type === "request" &&
    ctx.event.message.method === "INVITE",

  init: () => undefined,

  handle: () =>
    Effect.succeed({
      actions: [{ type: "relay-to-peer" as const }],
      state: undefined,
    }),
}

// ── relay-prack (priority 921) ────────────────────────────────────────────

/** Relay PRACK to peer leg. */
export const relayPrackRule: RuleDefinition<undefined, undefined> = {
  id: "relay-prack",
  name: "Relay PRACK",
  alwaysActive: true,
  defaultPriority: 921,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  matches: (ctx) =>
    ctx.event.type === "sip" &&
    ctx.event.message.type === "request" &&
    ctx.event.message.method === "PRACK",

  init: () => undefined,

  handle: () =>
    Effect.succeed({
      actions: [{ type: "relay-to-peer" as const }],
      state: undefined,
    }),
}
