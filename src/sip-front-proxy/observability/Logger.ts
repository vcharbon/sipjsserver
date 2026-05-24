/**
 * Proxy structured logging — PR6.
 *
 * The codebase already uses `Effect.log{Info,Warn,Error,…}`. This module
 * adds a thin annotation helper so every routing-decision log carries the
 * canonical correlation fields (callId, method, decision, target, strategy)
 * without each call site having to remember to thread them.
 *
 * No exporter setup here: Effect's default logger renders annotated logs
 * as a key=value sequence appended to the message, which is parseable
 * downstream. When the deploy needs JSON, set
 * `EFFECT_LOG_FORMAT=structured` (Effect honors this) — the annotations
 * appear under the `annotations` field of the JSON record.
 *
 * Usage:
 *
 *   yield* ProxyLogger.routingDecision({
 *     callId: "abc@host",
 *     method: "INVITE",
 *     decision: "select_new",
 *     strategy: "LoadBalancer",
 *     target: "10.0.1.0:5060",
 *     message: "forwarded INVITE to worker",
 *   })
 *
 * The implementation is a function map — `withLogSpan` style is overkill
 * for one log entry per request, and `Effect.annotateLogs` already does
 * the right thing for the recurring `Call-ID` correlation pattern.
 */

import { Effect, Layer, ServiceMap } from "effect"
import type { RoutingDecisionKind } from "./Metrics.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RoutingDecisionLog {
  readonly callId: string
  readonly method: string
  readonly decision: RoutingDecisionKind
  readonly strategy: string
  /** "host:port" of the chosen target, or "n/a" when no target was picked. */
  readonly target: string
  /** Free-form human-readable message. */
  readonly message: string
}

export interface RoutingErrorLog {
  readonly callId: string
  readonly method: string
  readonly strategy: string
  readonly reason: string
}

export interface ProxyLoggerApi {
  /** Info-level routing-decision log with full annotation set. */
  readonly routingDecision: (log: RoutingDecisionLog) => Effect.Effect<void>
  /** Warn-level rejection / unknown-state log. */
  readonly routingWarning: (log: RoutingErrorLog) => Effect.Effect<void>
  /**
   * Wrap an effect with the standard call-correlation annotations. Useful
   * when several log lines fire from inside the same routing handler and
   * each one should carry the same `callId` / `method` context.
   */
  readonly withCallCorrelation: <A, E, R>(
    callId: string,
    method: string,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>
}

export class ProxyLogger extends ServiceMap.Service<ProxyLogger, ProxyLoggerApi>()(
  "@sipjsserver/sip-front-proxy/ProxyLogger"
) {
  static readonly Default: Layer.Layer<ProxyLogger> = Layer.sync(
    ProxyLogger,
    () => buildApi()
  )
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function buildApi(): ProxyLoggerApi {
  const baseAnnotations = (log: RoutingDecisionLog | RoutingErrorLog) => ({
    "sip.callid": log.callId,
    "sip.method": log.method,
    "routing.strategy": log.strategy,
  })

  // Demoted to logDebug 2026-05-20 — fires per routed message (~3.9k records/s
  // observed at 10 CAPS legit + 1 CAPS abuse). All annotated fields are
  // already covered by `sip_proxy_messages_total`,
  // `sip_proxy_routing_decisions_total`, `sip_proxy_routing_duration_seconds`.
  const routingDecision = (log: RoutingDecisionLog): Effect.Effect<void> =>
    Effect.logDebug(log.message).pipe(
      Effect.annotateLogs({
        ...baseAnnotations(log),
        "routing.decision": log.decision,
        "worker.target": log.target,
      })
    )

  const routingWarning = (log: RoutingErrorLog): Effect.Effect<void> =>
    Effect.logWarning(log.reason).pipe(
      Effect.annotateLogs({
        ...baseAnnotations(log),
      })
    )

  const withCallCorrelation = <A, E, R>(
    callId: string,
    method: string,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.annotateLogs({
        "sip.callid": callId,
        "sip.method": method,
      })
    )

  return {
    routingDecision,
    routingWarning,
    withCallCorrelation,
  }
}
