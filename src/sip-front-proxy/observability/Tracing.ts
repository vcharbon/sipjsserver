/**
 * Proxy tracing — PR6.
 *
 * One span per inbound message: `sip-front-proxy.route`. The B2BUA's
 * `src/tracing/TracingService.ts` is the prior art; this file mirrors its
 * shape (sampling helper + span builders) without depending on it (the
 * proxy package's ESLint rule bans imports outside `effect` + `src/sip/**`,
 * and `TracingService` lives under `src/tracing/**` which would be banned
 * once the sweep widens).
 *
 * Sampling. Head-based: we coin-flip per inbound message at `sampleRate`
 * (default 10 %). Sub-spans inherit the decision through Effect's tracer
 * context. No fancy sampler — at proxy scale we want a constant cost per
 * message, and per-call coverage is delegated to the worker's
 * `TracingService` which already implements the override-rate header
 * machinery.
 *
 * Attributes (PR6 spec §3.5):
 *   - `sip.method`           uppercased SIP method or "RESPONSE"
 *   - `sip.callid`           Call-ID
 *   - `routing.strategy`     strategy name (LoadBalancer / ForwardAll / …)
 *   - `routing.decision`     same enum as the metrics `RoutingDecisionKind`
 *   - `worker.target`        host:port of the chosen downstream (or "n/a")
 *
 * The OpenTelemetry SDK is wired at the bin/proxy.ts boundary, not here —
 * the proxy may run with no exporter (dev) and we don't want this file to
 * pull `@effect/opentelemetry` into the unit-test fake stack.
 */

import { Effect, ServiceMap, Layer } from "effect"
import type { RoutingDecisionKind } from "./Metrics.js"

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export interface RouteSpanAttributes {
  readonly method: string
  readonly callId: string
  readonly strategy: string
  readonly decision: RoutingDecisionKind
  readonly workerTarget: string
}

export interface ProxyTracingApi {
  /**
   * Run an effect inside a proxy route span. Sampling decision is taken
   * inside (Math.random < sampleRate). When unsampled the inner effect is
   * run unwrapped (no parent span, no overhead).
   *
   * Attributes are passed in eagerly — the caller already knows the
   * decision/target by the time it wraps the send. If the routing path
   * exits early (drop / no target), the caller still wraps the synthesized
   * reply so traces don't lose those messages.
   */
  readonly withRouteSpan: <A, E, R>(
    attrs: RouteSpanAttributes,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>

  /** Current effective sample rate, 0..1. Useful for the metrics dashboard. */
  readonly sampleRate: number
}

export class ProxyTracing extends ServiceMap.Service<ProxyTracing, ProxyTracingApi>()(
  "@sipjsserver/sip-front-proxy/ProxyTracing"
) {
  /**
   * Default Layer reads `PROXY_TRACE_SAMPLE_RATE` from the environment
   * (a number in `[0, 1]`). Falls back to 0.1 (10 %).
   */
  static readonly Default: Layer.Layer<ProxyTracing> = Layer.sync(
    ProxyTracing,
    () => makeApi(parseEnvSampleRate(process.env["PROXY_TRACE_SAMPLE_RATE"]))
  )

  /** Build a layer with an explicit sample rate (tests). */
  static readonly layer = (sampleRate: number): Layer.Layer<ProxyTracing> =>
    Layer.sync(ProxyTracing, () => makeApi(clampSampleRate(sampleRate)))
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_SAMPLE_RATE = 0.1

const clampSampleRate = (raw: number): number => {
  if (!Number.isFinite(raw)) return DEFAULT_SAMPLE_RATE
  if (raw < 0) return 0
  if (raw > 1) return 1
  return raw
}

const parseEnvSampleRate = (raw: string | undefined): number => {
  if (raw === undefined || raw.length === 0) return DEFAULT_SAMPLE_RATE
  const parsed = Number.parseFloat(raw)
  return clampSampleRate(parsed)
}

const buildAttributes = (attrs: RouteSpanAttributes): Record<string, string> => ({
  "sip.method": attrs.method,
  "sip.callid": attrs.callId,
  "routing.strategy": attrs.strategy,
  "routing.decision": attrs.decision,
  "worker.target": attrs.workerTarget,
})

function makeApi(sampleRate: number): ProxyTracingApi {
  const sample = (): boolean => Math.random() < sampleRate

  const withRouteSpan = <A, E, R>(
    attrs: RouteSpanAttributes,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> => {
    if (!sample()) return effect
    return effect.pipe(
      Effect.withSpan("sip-front-proxy.route", {
        kind: "server",
        attributes: buildAttributes(attrs),
      })
    )
  }

  return {
    withRouteSpan,
    sampleRate,
  }
}
