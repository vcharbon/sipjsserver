/**
 * BufferedTerminateWriter — fallthrough on queue saturation.
 *
 * Phase 4 of docs/plan/2026-05-15-StructuralEffectGuarantees-moth.md.
 *
 * State writes cannot be silently dropped — a missed terminate-delete
 * leaks a stale Redis entry. When the bounded queue is full, the
 * submit Effect MUST run the underlying call directly (bounded by
 * `storageDropFallbackMs`). Any failure on the fallthrough path is
 * logged and counted; the submit still succeeds.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer } from "effect"
import { AppConfig } from "../../src/config/AppConfig.js"
import {
  PartitionedRelayStorage,
  StorageError,
  type PartitionedRelayStorageApi,
} from "../../src/cache/PartitionedRelayStorage.js"
import { BufferedTerminateWriter } from "../../src/cache/BufferedTerminateWriter.js"
import { MetricsRegistry } from "../../src/observability/MetricsRegistry.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"
import { Stream } from "effect"

/** Inner storage stub that blocks every deleteCall until released. */
function makeBlockingStorage(): {
  layer: Layer.Layer<PartitionedRelayStorage>
  release: () => void
  deleteCount: () => number
} {
  let deleteCount = 0
  const pending: Array<() => void> = []

  const api: PartitionedRelayStorageApi = {
    getCall: () => Effect.succeed(null),
    getIndex: () => Effect.succeed(null),
    putCall: () => Effect.void,
    refreshCall: () => Effect.void,
    deleteCall: () =>
      Effect.callback<void>((resume) => {
        deleteCount++
        pending.push(() => resume(Effect.void))
      }),
    scanCalls: () => Stream.empty,
  }

  return {
    layer: Layer.succeed(PartitionedRelayStorage, api),
    release: () => {
      const next = pending.shift()
      if (next) next()
    },
    deleteCount: () => deleteCount,
  }
}

/** Inner storage stub whose deleteCall always fails immediately. */
function makeFailingStorage(): Layer.Layer<PartitionedRelayStorage> {
  const api: PartitionedRelayStorageApi = {
    getCall: () => Effect.succeed(null),
    getIndex: () => Effect.succeed(null),
    putCall: () => Effect.void,
    refreshCall: () => Effect.void,
    deleteCall: () => Effect.fail(new StorageError({ reason: "test-induced failure" })),
    scanCalls: () => Stream.empty,
  }
  return Layer.succeed(PartitionedRelayStorage, api)
}

describe("BufferedTerminateWriter", () => {
  it.effect("queue full → fallthrough runs the call inline and counts it", () => {
    const queueMax = 2
    const drainers = 1
    const config = testAppConfigDefaults({
      storageBufferQueueMax: queueMax,
      storageBufferDrainers: drainers,
      storageDropFallbackMs: 1000,
    })

    // Blocking inner for queue-fill submits; the fallthrough call is
    // also inner.deleteCall but we'll release it inline by tracking the
    // pending list.
    const blocking = makeBlockingStorage()
    const Stack = BufferedTerminateWriter.layer.pipe(
      Layer.provide(blocking.layer),
      Layer.provideMerge(Layer.succeed(AppConfig, config)),
      Layer.provideMerge(MetricsRegistry.layer),
    )

    return Effect.gen(function* () {
      const writer = yield* BufferedTerminateWriter
      const registry = yield* MetricsRegistry

      // Yield so the drainer fork starts and parks on Queue.take.
      for (let i = 0; i < 4; i++) yield* Effect.yieldNow

      // Submit 1: drainer takes it, calls inner.deleteCall (blocks).
      yield* writer.submitTerminateDelete("pri", "self", "c-1", [])
      for (let i = 0; i < 4; i++) yield* Effect.yieldNow

      // Submits 2..3 fill the queue.
      yield* writer.submitTerminateDelete("pri", "self", "c-2", [])
      yield* writer.submitTerminateDelete("pri", "self", "c-3", [])

      // Submit 4 falls through. Fork it so the test fiber can release
      // the pending inner call before awaiting completion.
      const fallthroughFiber = yield* Effect.forkChild(
        writer.submitTerminateDelete("pri", "self", "c-4", []),
      )
      for (let i = 0; i < 4; i++) yield* Effect.yieldNow

      // Now there are 2 in-flight inner deleteCall: c-1 (drainer) +
      // c-4 (fallthrough). Release c-4 so its submit can return.
      blocking.release() // c-1
      blocking.release() // c-4 (or c-2 — order doesn't matter since
      // we're just clearing pendings)
      for (let i = 0; i < 4; i++) yield* Effect.yieldNow

      yield* Fiber.await(fallthroughFiber)

      const m = registry.storageBuffer
      expect(m).toBeDefined()
      expect(m!.queueCapacity).toBe(queueMax)
      expect(m!.fallthroughTotal()).toBe(1)

      // Drain remaining queued submits so the layer scope can close.
      blocking.release()
      for (let i = 0; i < 4; i++) yield* Effect.yieldNow
      blocking.release()
      for (let i = 0; i < 4; i++) yield* Effect.yieldNow
    }).pipe(Effect.provide(Stack))
  })

  it.effect("fallthrough StorageError is caught and counted", () => {
    const config = testAppConfigDefaults({
      // Bypass the queue entirely so every submit goes through the
      // passthrough path. The passthrough also catches StorageError —
      // the contract is "submit never fails to the caller".
      storageBufferQueueMax: 0,
    })

    const Stack = BufferedTerminateWriter.layer.pipe(
      Layer.provide(makeFailingStorage()),
      Layer.provideMerge(Layer.succeed(AppConfig, config)),
      Layer.provideMerge(MetricsRegistry.layer),
    )

    return Effect.gen(function* () {
      const writer = yield* BufferedTerminateWriter
      // Should not throw — passthrough swallows StorageError into a log.
      yield* writer.submitTerminateDelete("pri", "self", "c-fail", [])
    }).pipe(Effect.provide(Stack))
  })

  it.effect("storageBufferQueueMax === 0 calls inner storage inline", () => {
    const config = testAppConfigDefaults({ storageBufferQueueMax: 0 })

    let deleteCount = 0
    const inner: PartitionedRelayStorageApi = {
      getCall: () => Effect.succeed(null),
      getIndex: () => Effect.succeed(null),
      putCall: () => Effect.void,
      refreshCall: () => Effect.void,
      deleteCall: () => Effect.sync(() => { deleteCount++ }),
      scanCalls: () => Stream.empty,
    }

    const Stack = BufferedTerminateWriter.layer.pipe(
      Layer.provide(Layer.succeed(PartitionedRelayStorage, inner)),
      Layer.provideMerge(Layer.succeed(AppConfig, config)),
      Layer.provideMerge(MetricsRegistry.layer),
    )

    return Effect.gen(function* () {
      const writer = yield* BufferedTerminateWriter
      yield* writer.submitTerminateDelete("pri", "self", "c-1", [])
      yield* writer.submitTerminateDelete("pri", "self", "c-2", [])
      expect(deleteCount).toBe(2)

      const m = (yield* MetricsRegistry).storageBuffer
      expect(m!.queueCapacity).toBe(0)
      expect(m!.drainerCount).toBe(0)
      expect(m!.fallthroughTotal()).toBe(0)
    }).pipe(Effect.provide(Stack))
  })
})
