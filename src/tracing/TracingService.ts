/**
 * TracingService — per-call OpenTelemetry tracing for the SIP B2BUA.
 *
 * Creates a nested span hierarchy per call:
 *   root (call.lifecycle)
 *     → processing spans (sip.recv.*, timer.*)
 *       → send spans (sip.send.*)
 *       → span events (route_decision, overload_shed, …)
 *
 * Supports:
 *   - Head-based sampling with per-call override via X-Full-Trace-Sample-Rate
 *   - Hybrid tombstone spans for non-sampled calls (call.started + call.ended)
 *   - Configurable header scrubbing for raw SIP payloads
 *   - Always-sampled error spans for unroutable/parse-error messages
 *
 * Trace context (traceId, rootSpanId, sampled) is stored on the Call record
 * for reconstructing parent context across separate dispatchMessage invocations.
 */

import { Effect, Layer, ServiceMap, Tracer } from "effect"
import { randomBytes } from "node:crypto"
import { AppConfig } from "../config/AppConfig.js"
import type { Call } from "../call/CallModel.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a random 32-hex-char trace ID. */
const randomTraceId = (): string => randomBytes(16).toString("hex")

/** Generate a random 16-hex-char span ID. */
const randomSpanId = (): string => randomBytes(8).toString("hex")

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TracingService extends ServiceMap.Service<
  TracingService,
  {
    /**
     * Make a sampling decision for a new call.
     * @param overrideRate — value from X-Full-Trace-Sample-Rate header, or undefined.
     *   When defined and in [0.0, 1.0], replaces the global rate for this call's coin flip.
     */
    readonly decideSampling: (overrideRate: number | undefined) => boolean

    /**
     * Run an effect inside a new root span for a call's lifecycle.
     * Returns the effect's result plus traceId and spanId for storage on the Call record.
     *
     * - sampled=true:  creates a real root span with attributes
     * - sampled=false: emits a short-lived "call.started" tombstone span and
     *   runs the effect unwrapped (no parent span propagation)
     */
    readonly withRootSpan: <A, E, R>(opts: {
      readonly name: string
      readonly sampled: boolean
      readonly attributes: Record<string, unknown>
      readonly effect: Effect.Effect<A, E, R>
    }) => Effect.Effect<
      { readonly result: A; readonly traceId: string; readonly spanId: string },
      E,
      R
    >

    /**
     * Run an effect inside a processing span (child of root).
     * Processing spans represent a single handler invocation (recv/timer event).
     * No-ops (runs the effect unwrapped) if the call is not sampled.
     */
    readonly withProcessingSpan: <A, E, R>(opts: {
      readonly call: Call
      readonly name: string
      readonly attributes: Record<string, unknown>
      readonly effect: Effect.Effect<A, E, R>
    }) => Effect.Effect<A, E, R>

    /**
     * Emit a send span (child of the current processing span).
     * Opens and closes immediately — zero-duration marker for an outbound message.
     * Must be called within a withProcessingSpan scope for correct parenting.
     * No-ops if the call is not sampled.
     */
    readonly emitSendSpan: (opts: {
      readonly call: Call
      readonly name: string
      readonly attributes: Record<string, unknown>
    }) => Effect.Effect<void>

    /**
     * Emit a "call.ended" tombstone span for a non-sampled call at teardown.
     * Uses the traceId stored on the Call record to link with the "call.started" tombstone.
     * Includes duration and final status as attributes.
     */
    readonly emitTombstone: (opts: {
      readonly call: Call
      readonly durationMs: number
      readonly finalStatus: string
    }) => Effect.Effect<void>

    /**
     * Run an effect inside a standalone always-sampled span.
     * Used for parse errors and unroutable messages that have no associated call.
     */
    readonly withErrorSpan: <A, E, R>(
      name: string,
      attributes: Record<string, unknown>,
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E, R>

    /**
     * Emit span events on the current span. Must be called within a
     * withProcessingSpan or withRootSpan scope.
     */
    readonly emitSpanEvents: (
      events: ReadonlyArray<{ readonly name: string; readonly attributes?: Record<string, unknown> }>
    ) => Effect.Effect<void>

    /**
     * Scrub sensitive headers from a raw SIP message string.
     * Replaces values of configured headers (case-insensitive) with [REDACTED].
     */
    readonly scrubMessage: (raw: string) => string
  }
>()("@sipjsserver/TracingService") {
  static readonly layer = Layer.effect(
    TracingService,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const globalSampleRate = config.traceSampleRate
      const tombstoneEnabled = config.traceTombstoneEnabled

      // Build case-insensitive regex for scrubbing
      const scrubPattern =
        config.scrubHeaders.length > 0
          ? new RegExp(
              `^(${config.scrubHeaders.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}):\\s*.*$`,
              "gmi"
            )
          : undefined

      // ── decideSampling ──────────────────────────────────────────────
      const decideSampling = (overrideRate: number | undefined): boolean => {
        const rate =
          overrideRate !== undefined && overrideRate >= 0 && overrideRate <= 1
            ? overrideRate
            : globalSampleRate
        return Math.random() < rate
      }

      // ── withRootSpan ────────────────────────────────────────────────
      const withRootSpan = <A, E, R>(opts: {
        readonly name: string
        readonly sampled: boolean
        readonly attributes: Record<string, unknown>
        readonly effect: Effect.Effect<A, E, R>
      }): Effect.Effect<
        { readonly result: A; readonly traceId: string; readonly spanId: string },
        E,
        R
      > => {
        if (opts.sampled) {
          // Use Effect.withSpan (public API) to create a root span.
          // Effect.currentSpan retrieves traceId/spanId for storage on Call record.
          return Effect.gen(function* () {
            const span = yield* Effect.orDie(Effect.currentSpan)
            const result = yield* opts.effect
            return { result, traceId: span.traceId, spanId: span.spanId }
          }).pipe(
            Effect.withSpan(opts.name, { root: true, kind: "server", attributes: opts.attributes })
          )
        }

        // Non-sampled path: optionally emit a short-lived "call.started" tombstone
        // and run the inner effect without span context.
        const traceId = randomTraceId()
        const spanId = randomSpanId()

        if (tombstoneEnabled) {
          const tombstoneAttrs = {
            ...opts.attributes,
            "sip.tombstone": true
          }
          const tombstone = Effect.void.pipe(
            Effect.withSpan("call.started", { root: true, kind: "server", attributes: tombstoneAttrs })
          )
          return Effect.flatMap(
            tombstone,
            () =>
              Effect.map(opts.effect, (result) => ({
                result,
                traceId,
                spanId
              }))
          )
        }

        return Effect.map(opts.effect, (result) => ({
          result,
          traceId,
          spanId
        }))
      }

      // ── withProcessingSpan ──────────────────────────────────────────
      const withProcessingSpan = <A, E, R>(opts: {
        readonly call: Call
        readonly name: string
        readonly attributes: Record<string, unknown>
        readonly effect: Effect.Effect<A, E, R>
      }): Effect.Effect<A, E, R> => {
        if (
          opts.call.sampled !== true ||
          opts.call.traceId === undefined ||
          opts.call.rootSpanId === undefined
        ) {
          return opts.effect
        }
        const parent = Tracer.externalSpan({
          traceId: opts.call.traceId,
          spanId: opts.call.rootSpanId,
          sampled: true
        })
        return opts.effect.pipe(
          Effect.withSpan(opts.name, { parent, attributes: opts.attributes })
        )
      }

      // ── emitSendSpan ────────────────────────────────────────────────
      const emitSendSpan = (opts: {
        readonly call: Call
        readonly name: string
        readonly attributes: Record<string, unknown>
      }): Effect.Effect<void> => {
        if (opts.call.sampled !== true) {
          return Effect.void
        }
        // Create a zero-duration child span under the current processing span.
        // Effect.withSpan auto-parents under whatever span is in the current context.
        return Effect.void.pipe(
          Effect.withSpan(opts.name, { attributes: opts.attributes })
        )
      }

      // ── emitTombstone ───────────────────────────────────────────────
      const emitTombstone = (opts: {
        readonly call: Call
        readonly durationMs: number
        readonly finalStatus: string
      }): Effect.Effect<void> => {
        if (!tombstoneEnabled || opts.call.traceId === undefined) {
          return Effect.void
        }
        const parent = Tracer.externalSpan({
          traceId: opts.call.traceId,
          spanId: opts.call.rootSpanId ?? randomSpanId(),
          sampled: true
        })
        return Effect.void.pipe(
          Effect.withSpan("call.ended", {
            parent,
            attributes: {
              "sip.call_ref": opts.call.callRef,
              "sip.tombstone": true,
              "sip.duration_ms": opts.durationMs,
              "sip.final_status": opts.finalStatus
            }
          })
        )
      }

      // ── withErrorSpan ───────────────────────────────────────────────
      const withErrorSpan = <A, E, R>(
        name: string,
        attributes: Record<string, unknown>,
        effect: Effect.Effect<A, E, R>
      ): Effect.Effect<A, E, R> =>
        effect.pipe(
          Effect.withSpan(name, { root: true, kind: "server", attributes })
        )

      // ── emitSpanEvents ──────────────────────────────────────────────
      const emitSpanEvents = (
        events: ReadonlyArray<{
          readonly name: string
          readonly attributes?: Record<string, unknown>
        }>
      ): Effect.Effect<void> => {
        if (events.length === 0) return Effect.void
        return Effect.gen(function* () {
          const span = yield* Effect.catch(
            Effect.map(Effect.currentSpan, (s): Tracer.Span | undefined => s),
            (): Effect.Effect<Tracer.Span | undefined> => Effect.void as Effect.Effect<Tracer.Span | undefined>
          )
          if (span === undefined) return
          const now = BigInt(Date.now()) * 1_000_000n // ns
          for (const evt of events) {
            span.event(evt.name, now, evt.attributes)
          }
        })
      }

      // ── scrubMessage ────────────────────────────────────────────────
      const scrubMessage = (raw: string): string => {
        if (scrubPattern === undefined) return raw
        // Reset regex state (global flag)
        scrubPattern.lastIndex = 0
        return raw.replace(scrubPattern, (_match, headerName: string) => `${headerName}: [REDACTED]`)
      }

      return {
        decideSampling,
        withRootSpan,
        withProcessingSpan,
        emitSendSpan,
        emitTombstone,
        withErrorSpan,
        emitSpanEvents,
        scrubMessage
      }
    })
  )
}
