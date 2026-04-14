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
 *   - OverloadController (shared with CallControlClient and UdpTransport)
 *   - CallStateCache (Redis / in-memory)
 *   - CallLimiter (Redis / mock)
 *   - CallControlClient (HTTP / mock)
 *   - TracingService (OTel / noop)
 *   - CdrWriter (file / noop)
 */

import { Effect, Layer } from "effect"
import { SipRouter, describeEvent, type HandlerRegistry } from "../sip/SipRouter.js"
import { TransactionLayer } from "../sip/TransactionLayer.js"
import { CallState } from "../call/CallState.js"
import { TimerService } from "../call/TimerService.js"
import { SipParser } from "../sip/Parser.js"
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

/** Noop fallback — if the rule chain doesn't handle an event, return the call unchanged. */
const noopFallback: HandlerRegistry["inDialog"] = (ctx) =>
  Effect.logWarning(
    `[rule-fallback] Unhandled ${describeEvent(ctx.event)} callRef=${ctx.callRef} state=${ctx.call.state}`
  ).pipe(
    Effect.as({ call: ctx.call, outbound: [], effects: [] }),
  )

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
