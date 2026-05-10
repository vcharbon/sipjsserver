/**
 * Two-worker harness for NS-suite scenarios.
 *
 * Boilerplate-reducer for the common shape of NS1/NS2/NS4/NS6/NS10/NS14
 * tests: two workers (A and B), each with their own KvBackend +
 * outgoing ChannelIndex to the other peer, plus convenience builders
 * for puller fibers wired through `makeEchoApply`.
 *
 * The DSL is intentionally thin — each test writes its own scenario in
 * Effect.gen using the harness's primitives. This is the
 * `scenarioDsl.ts` referenced in
 * docs/plan/grill-me-on-the-spicy-lark.md §D9-NS, scoped to the
 * minimum needed by Slice 7's NS scenarios.
 */

import {
  Effect,
  Fiber,
  MutableHashMap,
  MutableRef,
  Stream,
} from "effect"
import { ChannelIndex, type ChannelIndexApi } from "../../src/replication/ChannelIndex.js"
import { makeReplicationApply } from "../../src/replication/EchoApply.js"
import {
  initialPeerView,
  PullerTransportError,
  runPullerFiber,
  type DataFrame,
  type PeerView,
} from "../../src/replication/PullerFiber.js"
import { buildPullStream } from "../../src/replication/ReplLogServer.js"
import {
  KvBackend,
  type KvBackendApi,
  type MemoryStoreEntry,
} from "../../src/storage/KvBackend.js"

export interface Worker {
  readonly self: string
  readonly peer: string
  readonly gen: number
  readonly store: MutableHashMap.MutableHashMap<string, MemoryStoreEntry>
  readonly kv: KvBackendApi
  readonly outgoing: ChannelIndexApi
}

export const makeWorker = (args: {
  readonly self: string
  readonly peer: string
  readonly gen: number
  readonly store?: MutableHashMap.MutableHashMap<string, MemoryStoreEntry>
}): Worker => {
  const store =
    args.store ?? MutableHashMap.empty<string, MemoryStoreEntry>()
  const kv = KvBackend.makeMemoryUnsafe(store)
  const outgoing = ChannelIndex.make(
    { self: args.self, peer: args.peer, gen: args.gen },
    kv
  )
  return {
    self: args.self,
    peer: args.peer,
    gen: args.gen,
    store,
    kv,
    outgoing,
  }
}

/**
 * Build a `Stream<Uint8Array>` factory closing over `source`'s outgoing
 * channel — the puller invokes this once per Connecting cycle.
 */
export const openStreamOf = (
  source: Worker,
  noopIntervalMs = 5
): ((args: {
  readonly sinceGen: number
  readonly sinceCounter: number
  readonly chunkSize: number
}) => Stream.Stream<Uint8Array, PullerTransportError>) => {
  return (args) =>
    buildPullStream({
      channel: source.outgoing,
      serverGen: source.gen,
      initialSince: { gen: args.sinceGen, counter: args.sinceCounter },
      chunkSize: args.chunkSize,
      noopIntervalMs,
    })
}

export interface PullerHandle {
  readonly viewRef: MutableRef.MutableRef<PeerView>
  readonly fiber: Fiber.Fiber<void>
  readonly capture: ReadonlyArray<DataFrame>
  readonly stop: Effect.Effect<void>
}

/**
 * Fork a puller fiber on `consumer` that pulls from `source`. Apply
 * is local-only — no mirror echo is written.
 *
 * `capture` accumulates every applied DataFrame for assertion.
 */
export const forkPuller = (args: {
  readonly source: Worker
  readonly consumer: Worker
  readonly bodyTtlSec?: number
  readonly noopIntervalMs?: number
  readonly initialBackoffMs?: number
}): Effect.Effect<PullerHandle> =>
  Effect.gen(function* () {
    const viewRef = MutableRef.make(initialPeerView(args.source.self))
    const captureBuf: Array<DataFrame> = []
    const echo = makeReplicationApply({
      bodyTtlSec: args.bodyTtlSec ?? 60,
      localKv: args.consumer.kv,
      self: args.consumer.self,
      source: args.source.self,
    })
    const fiber = yield* Effect.forkChild(
      runPullerFiber({
        peer: args.source.self,
        viewRef,
        openStream: openStreamOf(args.source, args.noopIntervalMs ?? 5),
        applyFrame: (f) =>
          Effect.gen(function* () {
            captureBuf.push(f)
            yield* echo(f).pipe(Effect.orDie)
          }),
        chunkSize: 100,
        initialBackoffMs: args.initialBackoffMs ?? 50,
      })
    )
    return {
      viewRef,
      fiber,
      get capture() {
        return captureBuf
      },
      stop: Fiber.interrupt(fiber),
    }
  })

/**
 * Real-clock poll until `predicate()` returns true; bounded at `maxMs`.
 * Used by the NS suite's it.live tests to wait for the puller to
 * propagate state without coordinating with TestClock.
 */
export const waitFor = (
  predicate: () => boolean,
  maxMs = 3000
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = Date.now() + maxMs
    while (!predicate()) {
      if (Date.now() > deadline) {
        return yield* Effect.die(
          new Error(
            `waitFor: predicate did not become true within ${maxMs}ms`
          )
        )
      }
      yield* Effect.sleep("5 millis")
    }
  })

/**
 * Wipe a worker's storage in-place. Used by NS5/NS7/NS8 — and the
 * future "process restart" scenarios — to model a sidecar Redis flush
 * without disposing the MutableHashMap reference (so callers can
 * re-bind a fresh KvBackend on top of the cleared store).
 */
export const wipeStore = (
  store: MutableHashMap.MutableHashMap<string, MemoryStoreEntry>
): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const [k] of store) MutableHashMap.remove(store, k)
  })
