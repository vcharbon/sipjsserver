/**
 * BufferedUdpEndpoint — wraps any `UdpEndpoint` (real `dgram` or simulated)
 * so that `send` is non-blocking and per-peer-isolated.
 *
 * Motivation
 * ──────────
 * The old `UdpEndpoint.send` directly invoked `dgram.send` (or the simulated
 * equivalent). For a hostname destination, `dgram.send` calls `dns.lookup`
 * which blocks the libuv threadpool for ~5 s on `EAI_AGAIN`. With a
 * sequential ingress consumer this wedges every subsequent packet on the
 * same endpoint. See `docs/past-issues/2026-05-14-kindlab-dns-dos.md`.
 *
 * Design
 * ──────
 * One bounded queue + one drainer fiber per destination key `(host, port)`.
 *   - `send` is pure enqueue — never blocks, never fails, returns immediately.
 *   - The drainer fiber calls `inner.send(buf, port, host)`. If the inner
 *     send blocks for 5 s on DNS, only THAT peer's fiber waits; sends to
 *     other peers continue unaffected. SendError outcomes are swallowed
 *     into a counter — SIP UDP retransmits handle loss.
 *   - Per-peer queue cap: drop-newest on overflow (matches kernel UDP).
 *   - Idle reclamation: a peer that hasn't made progress (no successful
 *     drain) for `idleTtlMs` is reclaimed — drainer interrupted, queue
 *     ended, entry removed.
 *   - Max-peers ceiling: a hard cap on entry count. On the new-peer path,
 *     if at cap the configured `PeerEvictionStrategy.selectVictim` picks
 *     one to evict before insertion.
 *
 * The wrapper is fabric-agnostic: same code wraps `dgram` in production and
 * the simulated in-memory fabric in tests. Tests for the wrapper itself
 * mount it over a hand-rolled stub `UdpEndpoint`.
 */

import { Cause, Clock, Effect, MutableHashMap, Option, Queue, Scope } from "effect"
import * as Fiber from "effect/Fiber"
import type { UdpEndpoint } from "./SignalingNetwork.js"

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

export interface BufferedSendCounters {
  enqueued: number
  droppedQueueFull: number
  droppedEvictedWithQueue: number
  innerSendErrors: number
  reclaimedIdle: number
  reclaimedCap: number
}

export const makeBufferedSendCounters = (): BufferedSendCounters => ({
  enqueued: 0,
  droppedQueueFull: 0,
  droppedEvictedWithQueue: 0,
  innerSendErrors: 0,
  reclaimedIdle: 0,
  reclaimedCap: 0,
})

// ---------------------------------------------------------------------------
// Eviction strategy
// ---------------------------------------------------------------------------

export interface PeerMetadata {
  readonly lastProgressMs: number
  readonly queueDepth: number
}

export interface PeerEvictionStrategy {
  readonly name: string
  readonly selectVictim: (
    peers: Iterable<readonly [string, PeerMetadata]>,
    now: number,
  ) => string | null
}

/** Default: evict the peer whose last successful drain is oldest. */
export const idleLruStrategy: PeerEvictionStrategy = {
  name: "idle-lru",
  selectVictim: (peers, _now) => {
    let oldestKey: string | null = null
    let oldestMs = Infinity
    for (const [k, m] of peers) {
      if (m.lastProgressMs < oldestMs) {
        oldestMs = m.lastProgressMs
        oldestKey = k
      }
    }
    return oldestKey
  },
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BufferedUdpEndpointOpts {
  /** Per-peer queue capacity. Overflow drops newest. */
  readonly perPeerQueueMax: number
  /** A peer with no successful drain within this window is reclaimed. */
  readonly idleTtlMs: number
  /** Hard ceiling on total peer entries. Exceeding triggers eviction. */
  readonly maxPeers: number
  /** Cadence of the idle-reclamation sweeper. */
  readonly sweepIntervalMs: number
  /** Default `idleLruStrategy`. */
  readonly evictionStrategy?: PeerEvictionStrategy
  /** Caller-owned counters, so they can be wired to the metrics server. */
  readonly counters?: BufferedSendCounters
  /**
   * Optional hook the wrapper invokes when an item is enqueued (`+1`) and
   * when the drainer finishes calling `inner.send` (`-1`). The test
   * harness wires this to the simulated network's `inFlight` counter so
   * `pumpAll` waits for buffered packets to drain before declaring
   * quiescence. Production layers leave this `undefined`.
   */
  readonly pendingWorkDelta?: (delta: number) => void
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SendItem {
  readonly buf: Buffer
  readonly port: number
  readonly host: string
}

interface PeerState {
  readonly queue: Queue.Queue<SendItem, Cause.Done>
  readonly fiber: Fiber.Fiber<void>
  lastProgressMs: number
}

const peerKey = (host: string, port: number): string => `${host}:${port}`

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

export interface BufferedUdpEndpoint extends UdpEndpoint {
  /** Active peer count — exposed for tests and metrics. */
  readonly peerCount: () => number
  /** Counters used by the wrapper. */
  readonly bufferedCounters: BufferedSendCounters
}

export const wrapEndpoint = (
  inner: UdpEndpoint,
  opts: BufferedUdpEndpointOpts,
): Effect.Effect<BufferedUdpEndpoint, never, Scope.Scope> =>
  Effect.gen(function* () {
    const counters = opts.counters ?? makeBufferedSendCounters()
    const strategy = opts.evictionStrategy ?? idleLruStrategy
    const peers = MutableHashMap.empty<string, PeerState>()

    // Capture the wrapper's scope so per-peer drainer fibers live as long
    // as the wrapper, not as long as the `send` call that lazily spawned
    // them. See docs/typescript-effect.md "Provide scoped layers at the
    // outermost effect".
    const layerScope = yield* Effect.scope

    const pendingWorkDelta = opts.pendingWorkDelta ?? ((_: number) => undefined)

    const reclaim = (key: string, reason: "idle" | "cap"): Effect.Effect<void> =>
      Effect.gen(function* () {
        const peer = Option.getOrUndefined(MutableHashMap.get(peers, key))
        if (peer === undefined) return
        const depth = Queue.sizeUnsafe(peer.queue)
        yield* Effect.sync(() => {
          MutableHashMap.remove(peers, key)
          // End the queue: the drainer fiber's `Stream.fromQueue` will
          // complete cleanly. Interrupt still kills any in-flight inner
          // send (DNS or socket op).
          Queue.endUnsafe(peer.queue)
        })
        yield* Fiber.interrupt(peer.fiber)
        counters.droppedEvictedWithQueue += depth
        // Items dropped on eviction won't make it through the drainer's
        // `pendingWorkDelta(-1)`; decrement here so external in-flight
        // tracking stays balanced.
        if (depth > 0) pendingWorkDelta(-depth)
        if (reason === "idle") counters.reclaimedIdle++
        else counters.reclaimedCap++
      })

    // Drainer pulls items one at a time via `Queue.take` so `Queue.sizeUnsafe`
    // accurately reflects items not yet picked up. `Stream.fromQueue` would
    // chunk items off the queue eagerly — at reclaim time the queue would
    // read empty even with items in flight. The forever loop exits on queue
    // end (the take fails with Cause.Done) or via Fiber.interrupt.
    const drainerLoop = (key: string, queue: Queue.Queue<SendItem, Cause.Done>): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          const result = yield* Effect.result(Queue.take(queue))
          if (result._tag === "Failure") return
          const item = result.success
          yield* inner.send(item.buf, item.port, item.host).pipe(
            Effect.catchTag("SendError", (err) =>
              Effect.sync(() => {
                counters.innerSendErrors++
              }).pipe(
                Effect.tap(() =>
                  Effect.logWarning(
                    `[BufferedUdpEndpoint] inner send to ${item.host}:${item.port} failed: ${err.message}`,
                  ),
                ),
              ),
            ),
          )
          pendingWorkDelta(-1)
          const now = yield* Clock.currentTimeMillis
          const peer = Option.getOrUndefined(MutableHashMap.get(peers, key))
          if (peer !== undefined) peer.lastProgressMs = now
        }
      })

    const offerOrDrop = (peer: PeerState, item: SendItem): void => {
      const accepted = Queue.offerUnsafe(peer.queue, item)
      if (accepted) {
        counters.enqueued++
        pendingWorkDelta(1)
      } else {
        counters.droppedQueueFull++
      }
    }

    const send = (buf: Buffer, port: number, host: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const key = peerKey(host, port)
        const existing = Option.getOrUndefined(MutableHashMap.get(peers, key))
        if (existing !== undefined) {
          offerOrDrop(existing, { buf, port, host })
          return
        }

        // New peer — enforce cap first.
        if (MutableHashMap.size(peers) >= opts.maxPeers) {
          const now = yield* Clock.currentTimeMillis
          const snapshot: Array<readonly [string, PeerMetadata]> = []
          for (const [k, s] of peers) {
            snapshot.push([
              k,
              { lastProgressMs: s.lastProgressMs, queueDepth: Queue.sizeUnsafe(s.queue) },
            ])
          }
          const victimKey = strategy.selectVictim(snapshot, now)
          if (victimKey !== null) {
            yield* reclaim(victimKey, "cap")
          }
        }

        const queue = yield* Queue.bounded<SendItem, Cause.Done>(opts.perPeerQueueMax)
        const now = yield* Clock.currentTimeMillis
        const fiber = yield* Effect.forkIn(drainerLoop(key, queue), layerScope)
        const state: PeerState = { queue, fiber, lastProgressMs: now }
        yield* Effect.sync(() => MutableHashMap.set(peers, key, state))
        offerOrDrop(state, { buf, port, host })
      })

    // Idle sweep — `Effect.sleep` so TestClock drives it deterministically.
    yield* Effect.forkIn(
      Effect.forever(
        Effect.gen(function* () {
          yield* Effect.sleep(`${opts.sweepIntervalMs} millis`)
          const now = yield* Clock.currentTimeMillis
          const expired: string[] = []
          for (const [k, peer] of peers) {
            if (now - peer.lastProgressMs > opts.idleTtlMs) {
              expired.push(k)
            }
          }
          for (const k of expired) yield* reclaim(k, "idle")
        }),
      ),
      layerScope,
    )

    return {
      localAddress: inner.localAddress,
      send,
      messages: inner.messages,
      poll: inner.poll,
      take: inner.take,
      queueDepth: inner.queueDepth,
      queueMax: inner.queueMax,
      counters: inner.counters,
      peerCount: () => MutableHashMap.size(peers),
      bufferedCounters: counters,
    } satisfies BufferedUdpEndpoint
  })
