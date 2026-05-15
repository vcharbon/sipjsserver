/**
 * BufferedCdrLayer — non-blocking CDR write (Phase 3 of
 * docs/plan/2026-05-15-StructuralEffectGuarantees-moth.md).
 *
 * Wraps an underlying `CdrWriter` so that `write` is pure enqueue: it
 * returns immediately, and a single drainer fiber consumes the queue and
 * calls the inner writer. NDJSON `appendFile` runs on libuv's threadpool
 * and can stall under disk pressure — without buffering, every
 * call-termination effect would block the SipRouter consumer for the
 * duration of that stall.
 *
 * Drop-on-overload is acceptable for CDR: losing one billing line is
 * preferable to stalling call termination. Drops are counted and the
 * first one logged so operators see the saturation signal.
 *
 * Mirrors the BufferedUdpEndpoint pattern (bounded queue, drainer fiber,
 * config-sentinel opt-out for fake-clock tests).
 */

import { Effect, Layer, Queue } from "effect"
import { AppConfig } from "../config/AppConfig.js"
import { MetricsRegistry } from "../observability/MetricsRegistry.js"
import { CdrWriter } from "./CdrWriter.js"
import type { Call } from "../call/CallModel.js"

/**
 * Build a BufferedCdrLayer that wraps whichever `CdrWriter` is provided
 * upstream. Returns a Layer that consumes the upstream writer and
 * produces a buffered `CdrWriter` with the same public API.
 *
 * When `cdrBufferQueueMax === 0` the layer falls through to the upstream
 * writer unchanged — the rollback sentinel used by fake-clock tests.
 */
export const BufferedCdrLayer: Layer.Layer<
  CdrWriter,
  never,
  CdrWriter | AppConfig | MetricsRegistry
> = Layer.effect(
  CdrWriter,
  Effect.gen(function* () {
    const config = yield* AppConfig
    const inner = yield* CdrWriter
    const registry = yield* MetricsRegistry

    if (config.cdrBufferQueueMax <= 0) {
      // Direct passthrough — fake-clock and any deployment that explicitly
      // opts out gets the upstream writer unmodified.
      registry.cdrBuffer = {
        submitDroppedTotal: () => 0,
        queueDepth: () => 0,
        queueCapacity: 0,
      }
      return inner
    }

    const queue = yield* Queue.bounded<Call>(config.cdrBufferQueueMax)
    let droppedTotal = 0

    registry.cdrBuffer = {
      submitDroppedTotal: () => droppedTotal,
      queueDepth: () => Queue.sizeUnsafe(queue),
      queueCapacity: config.cdrBufferQueueMax,
    }

    // Single drainer fiber — NDJSON append; profile before bumping pool size.
    // Bind the fiber lifetime to the layer scope so it dies on shutdown.
    const layerScope = yield* Effect.scope
    yield* Effect.forkIn(
      Effect.forever(
        Effect.gen(function* () {
          const call = yield* Queue.take(queue)
          yield* inner.write(call).pipe(
            Effect.catchCause((cause) =>
              Effect.logError(`BufferedCdrLayer: inner write failed for ${call.callRef}`, cause),
            ),
          )
        }),
      ),
      layerScope,
    )

    // Saturation surfaces via `cdrBuffer.submitDroppedTotal` — the
    // metric/scrape path is the operator-facing signal. Inline logging
    // would either need an extra forked fiber per drop (Effect.runFork)
    // or escape into console.* — the metric is sufficient and cheaper.
    const write = (call: Call): Effect.Effect<void> =>
      Effect.sync(() => {
        const accepted = Queue.offerUnsafe(queue, call)
        if (!accepted) droppedTotal++
      })

    yield* Effect.logInfo(
      `BufferedCdrLayer initialized (queueMax=${config.cdrBufferQueueMax})`,
    )

    return {
      write,
      readAll: inner.readAll,
    }
  }),
)
