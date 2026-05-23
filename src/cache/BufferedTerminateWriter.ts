/**
 * BufferedTerminateWriter — non-blocking terminate-path Redis I/O
 * (Phase 4 of docs/plan/2026-05-15-StructuralEffectGuarantees-moth.md).
 *
 * Wraps `PartitionedRelayStorage` so call-eviction effects can submit
 * `deleteCall` and the terminate-path `putCall` to a bounded queue and
 * return immediately. A pool of N drainer fibers consumes the queue
 * and calls the underlying storage. A stalled Redis can no longer pin
 * the SipRouter consumer fiber on call eviction.
 *
 * Drop-on-overload is NOT acceptable for state writes — losing a
 * deleteCall leaks a stale entry until orphan-sweep / TTL. The
 * fallthrough path: if the queue is full, run the underlying call
 * directly inside `Effect.timeout(storageDropFallbackMs)`. Worst case
 * is a stale Redis entry recovered by orphan-sweep / TTL.
 *
 * Admission `putCall` and hot-dialog `flushToRedis` stay on the direct
 * `PartitionedRelayStorage` interface — back-pressure on those paths
 * is desirable.
 */

import { Duration, Effect, Layer, Queue, ServiceMap } from "effect"
import { AppConfig } from "../config/AppConfig.js"
import { MetricsRegistry } from "../observability/MetricsRegistry.js"
import {
  PartitionedRelayStorage,
  type PartitionRole,
  type PartitionedRelayWriteOptions,
  StorageError,
} from "./PartitionedRelayStorage.js"

interface DeleteJob {
  readonly kind: "delete"
  readonly role: PartitionRole
  readonly owner: string
  readonly callRef: string
  readonly indexes: ReadonlyArray<string>
  readonly opts: PartitionedRelayWriteOptions | undefined
}

interface PutJob {
  readonly kind: "put"
  readonly role: PartitionRole
  readonly owner: string
  readonly callRef: string
  readonly body: Buffer
  readonly indexes: ReadonlyArray<string>
  readonly ttlSec: number
  readonly callGen: number | undefined
  readonly opts: PartitionedRelayWriteOptions | undefined
}

type Job = DeleteJob | PutJob

export interface BufferedTerminateWriterApi {
  /** Enqueue a terminate-path `deleteCall`. Never fails. */
  readonly submitTerminateDelete: (
    role: PartitionRole,
    owner: string,
    callRef: string,
    indexes: ReadonlyArray<string>,
    opts?: PartitionedRelayWriteOptions,
  ) => Effect.Effect<void>

  /** Enqueue a terminate-path `putCall`. Never fails. */
  readonly submitTerminatePut: (
    role: PartitionRole,
    owner: string,
    callRef: string,
    body: Buffer,
    indexes: ReadonlyArray<string>,
    ttlSec: number,
    /**
     * Per-call content version forwarded into the body's :gen sidecar.
     * Optional for test-only callers; production passes
     * `bumped._topology.gen ?? 0`.
     */
    callGen?: number,
    opts?: PartitionedRelayWriteOptions,
  ) => Effect.Effect<void>
}

export class BufferedTerminateWriter extends ServiceMap.Service<
  BufferedTerminateWriter,
  BufferedTerminateWriterApi
>()("@sipjsserver/cache/BufferedTerminateWriter") {
  /**
   * Production layer: bounded queue + N drainer fibers. When
   * `storageBufferQueueMax === 0`, returns a passthrough that calls
   * the underlying storage directly (fake-clock opt-out).
   */
  static readonly layer: Layer.Layer<
    BufferedTerminateWriter,
    never,
    PartitionedRelayStorage | AppConfig | MetricsRegistry
  > = Layer.effect(
    BufferedTerminateWriter,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const storage = yield* PartitionedRelayStorage
      const registry = yield* MetricsRegistry

      const queueMax = config.storageBufferQueueMax
      const drainerCount = Math.max(1, config.storageBufferDrainers)
      const fallbackTimeout = Duration.millis(config.storageDropFallbackMs)

      const runJob = (job: Job): Effect.Effect<void, StorageError> => {
        // `exactOptionalPropertyTypes` requires the typed `opts?` parameter
        // to be omitted (not `undefined`) when absent. Build the call
        // through a conditional so the compile-time signature lines up.
        if (job.kind === "delete") {
          return job.opts !== undefined
            ? storage.deleteCall(job.role, job.owner, job.callRef, job.indexes, job.opts)
            : storage.deleteCall(job.role, job.owner, job.callRef, job.indexes)
        }
        const callGenArg = job.callGen ?? 0
        return job.opts !== undefined
          ? storage.putCall(job.role, job.owner, job.callRef, job.body, job.indexes, job.ttlSec, callGenArg, job.opts)
          : storage.putCall(job.role, job.owner, job.callRef, job.body, job.indexes, job.ttlSec, callGenArg)
      }

      if (queueMax <= 0) {
        registry.storageBuffer = {
          fallthroughTotal: () => 0,
          fallthroughErrorTotal: () => 0,
          queueDepth: () => 0,
          queueCapacity: 0,
          drainerCount: 0,
        }
        // Passthrough — terminate paths run inline against storage and
        // surface StorageError as a logged warning (mirrors the prod
        // fallthrough path so callers see consistent behaviour).
        const direct = (job: Job): Effect.Effect<void> =>
          runJob(job).pipe(
            Effect.catchTag("PartitionedRelayStorageError", (e) =>
              Effect.logWarning(
                `BufferedTerminateWriter (passthrough) ${job.kind} failed for ${job.callRef}: ${e.reason}`,
              ),
            ),
          )
        return {
          submitTerminateDelete: (role, owner, callRef, indexes, opts) =>
            direct({ kind: "delete", role, owner, callRef, indexes, opts }),
          submitTerminatePut: (role, owner, callRef, body, indexes, ttlSec, callGen, opts) =>
            direct({ kind: "put", role, owner, callRef, body, indexes, ttlSec, callGen, opts }),
        }
      }

      const queue = yield* Queue.bounded<Job>(queueMax)
      let fallthroughTotal = 0
      let fallthroughErrorTotal = 0

      registry.storageBuffer = {
        fallthroughTotal: () => fallthroughTotal,
        fallthroughErrorTotal: () => fallthroughErrorTotal,
        queueDepth: () => Queue.sizeUnsafe(queue),
        queueCapacity: queueMax,
        drainerCount,
      }

      const layerScope = yield* Effect.scope
      for (let i = 0; i < drainerCount; i++) {
        yield* Effect.forkIn(
          Effect.forever(
            Effect.gen(function* () {
              const job = yield* Queue.take(queue)
              yield* runJob(job).pipe(
                Effect.catchTag("PartitionedRelayStorageError", (e) =>
                  Effect.logError(
                    `BufferedTerminateWriter drainer: ${job.kind} failed for ${job.callRef}: ${e.reason}`,
                  ),
                ),
              )
            }),
          ),
          layerScope,
        )
      }

      // Submit: try to enqueue; on full, fall through to a direct,
      // bounded call. Falling through is logged + counted but never
      // fails — caller sees Effect<void>.
      const submit = (job: Job): Effect.Effect<void> =>
        Effect.gen(function* () {
          const accepted = Queue.offerUnsafe(queue, job)
          if (accepted) return

          fallthroughTotal++
          yield* runJob(job).pipe(
            Effect.catchTag("PartitionedRelayStorageError", (e) => {
              fallthroughErrorTotal++
              return Effect.logError(
                `BufferedTerminateWriter fallthrough ${job.kind} failed for ${job.callRef}: ${e.reason}`,
              )
            }),
            Effect.timeoutOrElse({
              duration: fallbackTimeout,
              orElse: () =>
                Effect.gen(function* () {
                  fallthroughErrorTotal++
                  yield* Effect.logError(
                    `BufferedTerminateWriter fallthrough ${job.kind} timed out for ${job.callRef}`,
                  )
                }),
            }),
          )
        })

      yield* Effect.logInfo(
        `BufferedTerminateWriter initialized (queueMax=${queueMax}, drainers=${drainerCount})`,
      )

      return {
        submitTerminateDelete: (role, owner, callRef, indexes, opts) =>
          submit({ kind: "delete", role, owner, callRef, indexes, opts }),
        submitTerminatePut: (role, owner, callRef, body, indexes, ttlSec, callGen, opts) =>
          submit({ kind: "put", role, owner, callRef, body, indexes, ttlSec, callGen, opts }),
      }
    }),
  )
}
