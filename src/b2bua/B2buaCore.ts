/**
 * B2buaCore — single source of truth for B2BUA handler wiring and layer composition.
 *
 * All entry points (standalone main, cluster worker, e2e tests) import from here.
 * This eliminates the maintenance trap of duplicated rule registries and layer
 * compositions that silently diverge.
 *
 * ## Handler registry
 *
 * `handlers` is the immutable HandlerRegistry used by SipRouter.start().
 * Rule registration (built-in + policy modules) happens exactly once at module
 * load time.
 *
 * ## Core layer
 *
 * `B2buaCoreLayer` composes the common B2BUA services. Callers provide the
 * environment-specific dependencies (transport, persistence, call control, etc.).
 *
 * **Provides:** SipRouter, TransactionLayer, CallState, TimerService, SipParser
 *
 * **Requires (caller must provide):**
 *   - AppConfig
 *   - UdpTransport (real UDP / IPC / mock queue)
 *   - OverloadController (shared with CallDecisionEngine adapters and UdpTransport)
 *   - CallStateCache (Redis / in-memory)
 *   - CallLimiter (Redis / mock)
 *   - CallDecisionEngine (HTTP reference adapter / mock)
 *   - TracingService (OTel / noop)
 *   - CdrWriter (file / noop)
 */

import { Effect, Layer } from "effect"
import { SipRouter, describeEvent, type HandlerRegistry } from "../sip/SipRouter.js"
import { TransactionLayer } from "../sip/TransactionLayer.js"
import { CallState } from "../call/CallState.js"
import { TimerService } from "../call/TimerService.js"
import { SipParser } from "../sip/Parser.js"
import { newTag } from "../sip/MessageHelpers.js"
import { generateResponse } from "../sip/generators.js"
import { buildCallContact } from "./stack-identity.js"
import { handleInitialInvite } from "./InitialInviteHandler.js"
import { createRuleRegistry, type RuleRegistry } from "./rules/framework/RuleRegistry.js"
import { executeRules } from "./rules/framework/RuleExecutor.js"
import { defaultRules } from "./rules/defaults/index.js"
import { relayFirst18xTo180 } from "./rules/custom/relayFirst18xTo180.js"

// ---------------------------------------------------------------------------
// Handler registry (single source of truth)
// ---------------------------------------------------------------------------

/** Canonical production rule registry. Exported so the e2e harness (coverage
 *  tracking) and the rule-kill mutation script can build wrapped variants.
 *  Production code paths MUST use {@link handlers} — not this directly. */
export const ruleRegistry: RuleRegistry = createRuleRegistry(defaultRules, [relayFirst18xTo180])

/**
 * Default-deny fallback — runs when no rule matches.
 *
 * For an in-dialog SIP request, silently dropping is the worst possible
 * default (the sender's transaction times out instead of getting a clear
 * answer). Instead we respond 501 Not Implemented (RFC 3261 §21.5.2)
 * so the UAC knows the method is not supported on this dialog.
 *
 * Exceptions:
 *   - ACK: no response allowed (RFC 3261 §17.1, end-to-end, stateless).
 *   - Responses: responses without a matching transaction are dropped
 *     (RFC 3261 §17.2); we just log.
 *   - Non-SIP events (timer/cancelled/timeout): log only.
 */
const noopFallback: HandlerRegistry["inDialog"] = (ctx) => Effect.gen(function* () {
  yield* Effect.logWarning(
    `[rule-fallback] Unhandled ${describeEvent(ctx.event)} callRef=${ctx.callRef} state=${ctx.call.state}`
  )

  if (ctx.event.type !== "sip") {
    return { call: ctx.call, outbound: [], effects: [] }
  }

  const msg = ctx.event.message
  if (msg.type !== "request" || msg.method === "ACK") {
    return { call: ctx.call, outbound: [], effects: [] }
  }

  const contact = buildCallContact({
    localIp: ctx.config.sipLocalIp,
    localPort: ctx.config.sipLocalPort,
    callRef: ctx.callRef,
    leg: ctx.leg.legId,
    isEmergency: ctx.call.emergency === true,
  })
  const response = generateResponse(msg, 501, "Not Implemented", {
    toTag: newTag(),
    contact,
  })
  return {
    call: ctx.call,
    outbound: [{
      message: response,
      destination: { host: ctx.event.rinfo.address, port: ctx.event.rinfo.port },
      label: `respond 501 (unhandled ${msg.method})`,
      legId: ctx.leg.legId,
    }],
    effects: [],
  }
})

/** Build a HandlerRegistry from any rule registry. Tests wrap the production
 *  registry with tracking / mutation transforms and call this to get their
 *  own handlers. */
export function buildHandlers(registry: RuleRegistry): HandlerRegistry {
  return {
    initialInvite: handleInitialInvite,
    inDialog: executeRules(registry, noopFallback),
  }
}

export const handlers: HandlerRegistry = buildHandlers(ruleRegistry)

// ---------------------------------------------------------------------------
// Core B2BUA layer
// ---------------------------------------------------------------------------

export const B2buaCoreLayer = SipRouter.layer.pipe(
  Layer.provideMerge(TransactionLayer.layer),
  Layer.provideMerge(CallState.layer),
  Layer.provideMerge(TimerService.layer),
  Layer.provideMerge(SipParser.layer),
)
