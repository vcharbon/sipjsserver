/**
 * @vcharbon/sipjs/b2bua — public surface.
 *
 * Curated re-exports for embedding the full B2BUA in a consumer's app
 * with a custom `CallDecisionEngine` (HTTP backend or otherwise).
 * Rule customization is OUT of scope for v1 — the rule registry is
 * fixed at module load time inside `B2buaCore`.
 *
 * Quick start (the consumer wires their own per-call decision logic):
 *
 * ```ts
 * import { Effect, Layer } from "effect"
 * import {
 *   b2buaEmbeddedLayer,
 *   CallDecisionEngine,
 *   SipRouter,
 *   handlers,
 * } from "@vcharbon/sipjs/b2bua"
 *
 * const myCallDecision = Layer.succeed(CallDecisionEngine, {
 *   newCall: (req) => Effect.succeed({
 *     action: "route" as const,
 *     destination: { host: "10.0.1.5", port: 5060 },
 *   }),
 *   callFailure: (req) => Effect.succeed({ action: "terminate" as const }),
 *   callRefer:   (req) => Effect.succeed({ action: "reject" as const,
 *                                          reject_code: 403 }),
 * })
 *
 * const program = Effect.gen(function* () {
 *   const router = yield* SipRouter
 *   yield* router.start(handlers)        // blocks forever
 * }).pipe(Effect.provide(b2buaEmbeddedLayer({
 *   callDecision: myCallDecision,
 *   config: { sipLocalPort: 5070 },
 * })))
 *
 * Effect.runFork(program)
 * ```
 */

// Embedded factory + defaults
export {
  b2buaEmbeddedLayer,
  defaultEmbeddedAppConfig,
} from "./embedded.js"
export type { B2buaEmbeddedOptions } from "./embedded.js"

// Core layer + handlers (for advanced consumers wiring their own deps)
export { B2buaCoreLayer, handlers, ruleRegistry, buildHandlers } from "./B2buaCore.js"

// SipRouter — the entry point for `router.start(handlers)`
export { SipRouter } from "../sip/SipRouter.js"
export type { HandlerRegistry } from "../sip/SipRouter.js"

// Call-decision contract — the consumer-implemented seam
export { CallDecisionEngine } from "../decision/CallDecisionEngine.js"
export {
  CallDecisionError,
  CallDecisionErrorKind,
  CallDecisionMethod,
  isTransient,
  newCallSipStatus,
} from "../decision/schemas/errors.js"
export type {
  NewCallRequest,
  CallFailureRequest,
  CallReferRequest,
  FailureDetail,
} from "../decision/schemas/requests.js"
export type {
  NewCallResponse,
  NewCallRouteResponse,
  NewCallRejectResponse,
  CallFailureResponse,
  CallFailureFailoverResponse,
  CallFailureTerminateResponse,
  CallReferResponse,
} from "../decision/schemas/responses.js"

// AppConfig — for consumers building partial overrides
export { AppConfig, AppConfigData } from "../config/AppConfig.js"

// Layer-level seams the consumer may want to override
export { CallLimiter } from "../call/CallLimiter.js"
export { PartitionedRelayStorage } from "../cache/PartitionedRelayStorage.js"
export { CdrWriter } from "../cdr/CdrWriter.js"
export { TracingService } from "../tracing/TracingService.js"
export { OverloadController } from "./OverloadController.js"
export { DrainingState } from "./DrainingState.js"
export { UdpTransport } from "../sip/UdpTransport.js"
export { MetricsRegistry } from "../observability/MetricsRegistry.js"
