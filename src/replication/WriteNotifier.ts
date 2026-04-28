/**
 * WriteNotifier — in-process Hub broadcasting AtomicWriter peer-bearing
 * write events to local subscribers (notably ReplLog's long-poll
 * handlers).
 *
 * Slice 3 deliverable. Spec §7.4 calls this out explicitly:
 *
 *   "Server-side, a write on the primary fires an in-process Effect
 *    `Hub` notification that the open `/replog` handler is subscribed
 *    to. New entries land on subscriber connections within milliseconds."
 *
 * Why a service rather than a global PubSub
 * -----------------------------------------
 * AtomicWriter is the producer (one publish per successful peer-bearing
 * write, the seq + epoch pair the Lua script returned); ReplLog is the
 * consumer. Wrapping the underlying PubSub in a service lets:
 *
 *   - `AtomicWriter.memoryLayerFromStore(...)` yield* the notifier from
 *     its layer scope and wire publish into the post-write hook;
 *   - `ReplLog` subscribe through the same service tag without leaking
 *     the PubSub object to either side;
 *   - tests provide a `noopLayer` when they don't care about notifications
 *     (the existing 800+ fake-stack tests fall into this bucket).
 */

import { Effect, Layer, PubSub, ServiceMap, Stream } from "effect"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Emitted by AtomicWriter on every successful peer-bearing write
 * (put / refresh / delete). The `seq`/`epoch` pair is what the Lua
 * script returned (or what the memory layer simulated). `owner` is
 * the worker N that owns the writes — long-poll subscribers tagged
 * with `caller=Y` only care about notifications where `peer === Y`.
 */
export interface WriteNotification {
  readonly owner: string
  readonly peer: string
  readonly callRef: string
  readonly seq: number
  readonly epoch: number
}

export interface WriteNotifierApi {
  /** Publish a notification. No-op when no subscribers are attached. */
  readonly publish: (n: WriteNotification) => Effect.Effect<void>

  /**
   * Scoped subscription returning a Stream of every notification
   * published while the scope is open. Backpressure: drops on
   * subscribers slower than the publisher (sliding strategy).
   */
  readonly subscribe: Stream.Stream<WriteNotification>
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class WriteNotifier extends ServiceMap.Service<
  WriteNotifier,
  WriteNotifierApi
>()("@sipjsserver/replication/WriteNotifier") {
  /**
   * Real notifier backed by a sliding PubSub. The sliding strategy
   * means a slow consumer never blocks the writer — the oldest
   * un-consumed entries are dropped under backpressure. Long-poll
   * consumers that fall behind reconnect via the Slice 4 ReplPuller's
   * resume mechanism (epoch+lastSeq), so dropped notifications are
   * harmless (they get re-discovered on reconnect's backlog drain).
   */
  static readonly layer: Layer.Layer<WriteNotifier> = Layer.effect(
    WriteNotifier,
    Effect.gen(function* () {
      const hub = yield* PubSub.sliding<WriteNotification>(1024)
      const subscribe = Stream.fromPubSub(hub)
      return {
        publish: (n) => PubSub.publish(hub, n).pipe(Effect.asVoid),
        subscribe,
      }
    })
  )

  /**
   * No-op notifier for tests that don't exercise ReplLog. `subscribe`
   * yields an empty stream so any naive subscriber simply terminates
   * with no input.
   */
  static readonly noopLayer: Layer.Layer<WriteNotifier> = Layer.succeed(
    WriteNotifier,
    {
      publish: () => Effect.void,
      subscribe: Stream.empty,
    }
  )
}
