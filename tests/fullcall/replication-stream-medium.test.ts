/**
 * Replication-stream medium-tier test — real Redis + real HTTP.
 *
 * Validates two production code paths end-to-end against a real
 * `RedisClient` and a real `NodeHttpServer`:
 *
 *   1. /replog (long-lived delta): drain N data frames, assert count,
 *      uniqueness, monotonic (gen, counter); measure heap delta and
 *      throughput.
 *
 *   2. /bootstrap (one-shot snapshot): drain N data frames + terminal
 *      Noop, assert the same callRef set, measure heap delta and
 *      throughput.
 *
 * Why this lives outside the fast inner loop: 100k entries against a
 * real Redis and a real HTTP socket is slow by design — it's the smoke
 * test for the OOM regression that drove the May 2026 paginate rewrite,
 * and the cheapest way to assert "no per-tick finalizer leak" is to
 * actually run enough ticks for a leak to show.
 *
 * Gates:
 *   - `TEST_TIER` must be `medium` or `long` (cf. vitest.config.ts, TEST_MODE=live branch).
 *   - `REDIS_URL` must point at a reachable Redis (default
 *     `redis://localhost:6379`); test self-skips if connect fails.
 *   - `global.gc` must be available — invoke with `node --expose-gc`
 *     (see the `test:medium` npm script).
 *
 * Tunables (env):
 *   - `MEDIUM_REPLICATION_ENTRIES` — default 100_000.
 *   - `MEDIUM_REPLICATION_HEAP_LIMIT_MB` — default 50.
 *   - `MEDIUM_REPLICATION_THROUGHPUT_FLOOR` — frames/sec, default 50_000.
 */

import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import {
  Cause,
  Effect,
  Fiber,
  Layer,
  Option,
  Scope,
  Stream,
} from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http"
import { createServer } from "node:http"
import { ChannelIndex } from "../../src/replication/ChannelIndex.js"
import {
  addReplLogRoutes,
  ReplLogServer,
} from "../../src/replication/ReplLogServer.js"
import {
  makeBootstrapStream,
  makePullerOpenStream,
} from "../../src/replication/PullerHttpTransport.js"
import { streamNdjsonLines } from "../../src/replication/NdjsonStream.js"
import { bodyBuf } from "../support/codecHelpers.js"
import { PeerEndpointResolver } from "../../src/cache/PeerEndpointResolver.js"
import { WorkerOrdinal } from "../../src/cache/PeerCachePort.js"
import { KvBackend } from "../../src/storage/KvBackend.js"
import { makeKvBackedFromBackend } from "../../src/cache/PartitionedRelayStorageKvBacked.js"
import { makeRedisOps, type RedisOps } from "../../src/redis/RedisClient.js"
import type {
  DataFrame,
  PullFrame,
} from "../../src/replication/ReplicationProtocol.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TIER = process.env.TEST_TIER ?? "short"
const TIER_ENABLED = TIER === "medium" || TIER === "long"
const GC_AVAILABLE = typeof globalThis.gc === "function"
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379"
const ENTRIES = Number(process.env.MEDIUM_REPLICATION_ENTRIES ?? 100_000)
const HEAP_LIMIT_BYTES =
  Number(process.env.MEDIUM_REPLICATION_HEAP_LIMIT_MB ?? 50) * 1024 * 1024
const THROUGHPUT_FLOOR =
  Number(process.env.MEDIUM_REPLICATION_THROUGHPUT_FLOOR ?? 50_000)
const SELF = "worker-A-medium"
const PEER = "worker-B-medium"
const GEN = 1

const PREFIX = `repl-medium-${process.pid}-${Date.now()}`
const PREFIX_WITH_COLON = `${PREFIX}:`

// ---------------------------------------------------------------------------
// Server stack — real Redis, real NodeHttpServer on an ephemeral port.
// ---------------------------------------------------------------------------

/**
 * Bring up RedisOps lazily inside an Effect so the test can self-skip
 * if Redis is unreachable. The ops live in a Scope; teardown deletes
 * every key under PREFIX.
 *
 * `makeRedisOps` converts connection failures into defects via
 * `Effect.die`, so its public error channel is `never`. We deliberately
 * use `catchCause` here to opt in to handling the defect — the medium
 * tier is conditional on Redis being reachable and we want a quiet
 * skip, not a crash, when it isn't.
 */
const acquireRedis = (): Effect.Effect<
  RedisOps | null,
  never,
  Scope.Scope
> =>
  makeRedisOps(REDIS_URL, PREFIX, "medium-replication-test").pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        console.warn(
          `[medium-replication] Redis unreachable at ${REDIS_URL}: ${Cause.pretty(cause)} — skipping.`
        )
        return null
      })
    )
  )

const buildServerLayer = (redis: RedisOps) => {
  const kv = KvBackend.makeRedisUnsafe(redis, PREFIX_WITH_COLON)
  const storage = makeKvBackedFromBackend(
    kv,
    {
      // Bootstrap only needs `scanByPrefix` for the bak partition scan;
      // bodySet / bodyExpire are wired to the same Redis ops the rest
      // of the kv backend uses. Post-msgpackr-migration the bodyOps
      // split into `bodySetBuffer` (binary Call bodies) and
      // `bodySetString` (UTF-8 index entries); both route to ioredis's
      // overloaded `setex`.
      bodySetBuffer: (key, value, ttlSec) =>
        redis
          .setexBuffer(key, ttlSec, value)
          .pipe(Effect.mapError((e) => ({ _tag: "KvError", reason: e.reason }) as never)),
      bodySetString: (key, value, ttlSec) =>
        redis
          .setex(key, ttlSec, value)
          .pipe(Effect.mapError((e) => ({ _tag: "KvError", reason: e.reason }) as never)),
      bodyExpire: (key, ttlSec) =>
        redis
          .expire(key, ttlSec)
          .pipe(Effect.mapError((e) => ({ _tag: "KvError", reason: e.reason }) as never)),
      scanByPrefix: (prefix) =>
        Stream.paginate("0" as string, (cursor) =>
          Effect.gen(function* () {
            const fullPattern = `${PREFIX_WITH_COLON}${prefix}*`
            const [nextCursor, keys] = yield* Effect.tryPromise({
              try: () =>
                redis.raw.scan(cursor, "MATCH", fullPattern, "COUNT", 200),
              catch: (e) =>
                ({ _tag: "KvError", reason: String(e) }) as never,
            })
            const entries = yield* Effect.tryPromise({
              try: async () => {
                if ((keys as ReadonlyArray<string>).length === 0) return []
                const pipe = redis.raw.pipeline()
                for (const k of keys as ReadonlyArray<string>) {
                  pipe.getBuffer(k)
                  pipe.ttl(k)
                }
                const results = (await pipe.exec()) as Array<
                  [Error | null, unknown]
                >
                const out: Array<{
                  readonly key: string
                  readonly value: Buffer
                  readonly ttlSec: number
                }> = []
                const localKeys = (keys as ReadonlyArray<string>).map((k) =>
                  k.startsWith(PREFIX_WITH_COLON)
                    ? k.slice(PREFIX_WITH_COLON.length)
                    : k
                )
                for (let i = 0; i < localKeys.length; i++) {
                  const [, value] = results[i * 2]!
                  const [, ttl] = results[i * 2 + 1]!
                  if (!Buffer.isBuffer(value)) continue
                  const ttlSec = typeof ttl === "number" && ttl > 0 ? ttl : 0
                  out.push({ key: localKeys[i]!, value, ttlSec })
                }
                return out
              },
              catch: (e) =>
                ({ _tag: "KvError", reason: String(e) }) as never,
            })
            yield* Effect.yieldNow
            return [
              entries,
              nextCursor === "0"
                ? Option.none<string>()
                : Option.some(nextCursor as string),
            ] as const
          })
        ),
    },
    { self: SELF, gen: GEN }
  )
  const replServer = ReplLogServer.makeUnsafe(kv, storage, {
    self: SELF,
    gen: GEN,
    noopIntervalMs: 50,
  })
  const channel = ChannelIndex.make(
    { self: SELF, peer: PEER, gen: GEN },
    kv
  )

  const RoutesLayer = HttpRouter.use((router) => addReplLogRoutes(router))
  const ServerLayer = HttpRouter.serve(RoutesLayer).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 })),
    Layer.provide(Layer.succeed(ReplLogServer, replServer))
  )

  return { ServerLayer, channel }
}

const boundPort = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer
  const addr = server.address
  if (addr._tag !== "TcpAddress") {
    return yield* Effect.die(new Error("expected TcpAddress"))
  }
  return addr.port
})

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe.skipIf(!TIER_ENABLED)(
  "Replication streams — medium-tier (real Redis + real HTTP)",
  () => {
    it.live(
      "drains N entries via /replog and /bootstrap; heap stable; throughput floor met",
      () =>
        Effect.gen(function* () {
          if (!GC_AVAILABLE) {
            console.warn(
              "[medium-replication] global.gc unavailable — invoke with --expose-gc; skipping."
            )
            return
          }
          const redis = yield* acquireRedis()
          if (redis === null) return

          // Teardown — registered before any work so it runs even on
          // assertion failure.
          yield* Effect.addFinalizer(() =>
            Effect.tryPromise({
              try: async () => {
                const keys = await redis.raw.keys(`${PREFIX_WITH_COLON}*`)
                if (keys.length > 0) await redis.raw.del(...keys)
              },
              catch: () => undefined,
            }).pipe(Effect.ignore)
          )

          const { ServerLayer, channel } = buildServerLayer(redis)

          // Inject N entries on the (A→B) channel with partition="bak"
          // so bodies land at `bak:B:call:{X}` (visible to /bootstrap)
          // AND the channel `propagate:A->B` carries them (visible to
          // /replog).
          const writeStart = Date.now()
          yield* Effect.forEach(
            range(ENTRIES),
            (i) =>
              channel.write({
                entryGen: GEN,
                partition: "bak",
                callRef: `call-${i}`,
                bodyValue: bodyBuf({
                  i,
                  __writtenAtMs: Date.now(),
                }),
                bodyTtlSec: 3600,
                indexes: [],
              }),
            { concurrency: 64, discard: true }
          )
          const writeMs = Date.now() - writeStart
          console.log(
            `[medium-replication] wrote ${ENTRIES} entries in ${writeMs}ms ` +
              `(${Math.round((ENTRIES / writeMs) * 1000)}/s)`
          )

          yield* Effect.gen(function* () {
            const port = yield* boundPort
            const httpClient = yield* HttpClient.HttpClient
            const resolver: PeerEndpointResolver["Service"] = {
              resolve: (peer) =>
                peer === (SELF as unknown as WorkerOrdinal)
                  ? Effect.succeed(`http://127.0.0.1:${port}`)
                  : Effect.fail({
                      _tag: "PeerEndpointResolveError",
                      peer,
                      reason: "unknown_peer",
                    } as never),
            }

            // ---- Phase A — /replog ----------------------------------
            const replogStats = yield* runReplogPhase({
              source: SELF,
              self: PEER,
              client: httpClient,
              resolver,
              expected: ENTRIES,
            })
            assertHeapStable(replogStats, "replog")
            assertThroughputFloor(replogStats, "replog")
            expect(replogStats.dataFrames).toBe(ENTRIES)
            expect(replogStats.uniqueCallRefs).toBe(ENTRIES)
            expect(replogStats.monotonic).toBe(true)

            // ---- Phase B — /bootstrap -------------------------------
            const bootstrapStats = yield* runBootstrapPhase({
              source: SELF,
              self: PEER,
              client: httpClient,
              resolver,
              expected: ENTRIES,
            })
            assertHeapStable(bootstrapStats, "bootstrap")
            assertThroughputFloor(bootstrapStats, "bootstrap")
            expect(bootstrapStats.dataFrames).toBe(ENTRIES)
            expect(bootstrapStats.uniqueCallRefs).toBe(ENTRIES)
            expect(bootstrapStats.sawTerminalNoop).toBe(true)
          }).pipe(
            Effect.provide(ServerLayer),
            Effect.provide(FetchHttpClient.layer)
          )
        }).pipe(Effect.scoped),
      { timeout: 600_000 }
    )
  }
)

// ---------------------------------------------------------------------------
// Phase runners
// ---------------------------------------------------------------------------

interface PhaseStats {
  readonly dataFrames: number
  readonly uniqueCallRefs: number
  readonly monotonic: boolean
  readonly sawTerminalNoop: boolean
  readonly elapsedMs: number
  readonly heapDeltaBytes: number
}

const runReplogPhase = (args: {
  readonly source: string
  readonly self: string
  readonly client: HttpClient.HttpClient
  readonly resolver: PeerEndpointResolver["Service"]
  readonly expected: number
}): Effect.Effect<PhaseStats> =>
  Effect.gen(function* () {
    const openStream = makePullerOpenStream({
      self: args.self,
      source: args.source,
      client: args.client,
      resolver: args.resolver,
    })
    const heapBefore = snapshotHeap()
    const t0 = Date.now()

    let dataFrames = 0
    const seen = new Set<string>()
    let monotonic = true
    let lastGen = -1
    let lastCounter = -1
    let sawNoop = false

    // The replog stream is infinite. Take frames until we've seen
    // `expected` data frames and at least one Noop heartbeat (the
    // Noop marks "caught up", so we know the server has nothing
    // more to emit immediately).
    const stream = openStream({ sinceGen: 0, sinceCounter: 0, chunkSize: 1000 })
    yield* streamNdjsonLines(stream).pipe(
      Stream.takeWhile(() => dataFrames < args.expected || !sawNoop),
      Stream.runForEach((frame: PullFrame) =>
        Effect.sync(() => {
          if (frame._tag === "Data") {
            dataFrames++
            seen.add(frame.callRef)
            if (
              frame.gen < lastGen ||
              (frame.gen === lastGen && frame.counter <= lastCounter)
            ) {
              monotonic = false
            }
            lastGen = frame.gen
            lastCounter = frame.counter
          } else {
            sawNoop = true
          }
        })
      ),
      Effect.orDie
    )

    const elapsedMs = Date.now() - t0
    const heapAfter = snapshotHeap()
    return {
      dataFrames,
      uniqueCallRefs: seen.size,
      monotonic,
      sawTerminalNoop: sawNoop,
      elapsedMs,
      heapDeltaBytes: heapAfter - heapBefore,
    }
  })

const runBootstrapPhase = (args: {
  readonly source: string
  readonly self: string
  readonly client: HttpClient.HttpClient
  readonly resolver: PeerEndpointResolver["Service"]
  readonly expected: number
}): Effect.Effect<PhaseStats> =>
  Effect.gen(function* () {
    const stream = makeBootstrapStream({
      self: args.self,
      source: args.source,
      client: args.client,
      resolver: args.resolver,
    })
    const heapBefore = snapshotHeap()
    const t0 = Date.now()

    let dataFrames = 0
    const seen = new Set<string>()
    let sawHead = false

    yield* stream.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event._tag === "Entry") {
            dataFrames++
            const frame: DataFrame = event.frame
            seen.add(frame.callRef)
          } else {
            sawHead = true
          }
        })
      ),
      Effect.orDie
    )

    const elapsedMs = Date.now() - t0
    const heapAfter = snapshotHeap()
    return {
      dataFrames,
      uniqueCallRefs: seen.size,
      // bootstrap data frames carry gen=0,counter=0 sentinels by design,
      // so "monotonic" is not meaningful for this phase.
      monotonic: true,
      sawTerminalNoop: sawHead,
      elapsedMs,
      heapDeltaBytes: heapAfter - heapBefore,
    }
  })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const range = (n: number): ReadonlyArray<number> => {
  const out = new Array<number>(n)
  for (let i = 0; i < n; i++) out[i] = i
  return out
}

const snapshotHeap = (): number => {
  globalThis.gc!()
  globalThis.gc!()
  return process.memoryUsage().heapUsed
}

const assertHeapStable = (stats: PhaseStats, label: string): void => {
  if (stats.heapDeltaBytes >= HEAP_LIMIT_BYTES) {
    throw new Error(
      `[medium-replication:${label}] heap grew by ${Math.round(
        stats.heapDeltaBytes / 1024 / 1024
      )}MB — over ${Math.round(HEAP_LIMIT_BYTES / 1024 / 1024)}MB limit ` +
        `(${stats.dataFrames} frames, ${stats.elapsedMs}ms)`
    )
  }
  console.log(
    `[medium-replication:${label}] heap delta: ${Math.round(
      stats.heapDeltaBytes / 1024 / 1024
    )}MB`
  )
}

const assertThroughputFloor = (stats: PhaseStats, label: string): void => {
  const fps = (stats.dataFrames / stats.elapsedMs) * 1000
  console.log(
    `[medium-replication:${label}] throughput: ${Math.round(fps)} frames/s ` +
      `(${stats.dataFrames} frames in ${stats.elapsedMs}ms)`
  )
  if (fps < THROUGHPUT_FLOOR) {
    throw new Error(
      `[medium-replication:${label}] throughput ${Math.round(fps)}/s ` +
        `below floor ${THROUGHPUT_FLOOR}/s`
    )
  }
}

// Keep imports referenced under stricter tsconfig variants.
void Fiber.interrupt
void Scope.Scope
