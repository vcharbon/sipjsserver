/**
 * RedisClient service — ioredis wrapped in an Effect scoped Layer.
 *
 * Connection is established on layer creation and closed on shutdown.
 *
 * Two services live in this module-area:
 *
 *   - `RedisClient`        — the per-pod sidecar Redis used by the call-context
 *                            cache (`PartitionedRelayStorage`, replication
 *                            machinery). Sub-millisecond writes on the SIP
 *                            hot path. See `LimiterRedisClient` for the
 *                            cluster-shared counterpart used by the call
 *                            limiter.
 *   - `LimiterRedisClient` — defined in `./LimiterRedisClient.ts`, points at
 *                            a shared cluster Redis so concurrent-call counts
 *                            are global rather than per-pod.
 *
 * Both services share the same `RedisOps` shape, built by `makeRedisOps`.
 */

import IoRedis from "ioredis"
import { Effect, Layer, Schema, Scope, ServiceMap } from "effect"
import { AppConfig } from "../config/AppConfig.js"

const RedisConstructor = IoRedis.default
type RedisInstance = InstanceType<typeof RedisConstructor>

/**
 * Per-connection ioredis options the call sites care about. Kept as a
 * structural subset so we don't depend on ioredis internal types — only
 * the knobs we actively configure are exposed.
 *
 * `lazyConnect: true` is enforced unconditionally inside `makeRedisOps`;
 * callers MUST NOT override it (the layer's acquire path drives the
 * initial connect explicitly).
 */
export interface RedisConnectionOptions {
  /** Per-command timeout in ms. Fails the command with `RedisError` on expiry. */
  readonly commandTimeout?: number
  /** When false, commands issued while disconnected reject immediately instead of buffering until reconnect. */
  readonly enableOfflineQueue?: boolean
  /** Max ioredis internal retries per command. Bound this so a single command can't exceed its commandTimeout via retry loop. */
  readonly maxRetriesPerRequest?: number
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class RedisError extends Schema.TaggedErrorClass<RedisError>()(
  "RedisError",
  { reason: Schema.String }
) {}

// ---------------------------------------------------------------------------
// Operation surface (shared by RedisClient and LimiterRedisClient)
// ---------------------------------------------------------------------------

export interface RedisOps {
  readonly get: (key: string) => Effect.Effect<string | null, RedisError>
  /**
   * Binary variant of `get` — returns the raw bytes (Buffer) without
   * UTF-8 decoding. Used by the msgpackr-backed call-body read path:
   * `client.getBuffer(key)`. Returning a Buffer through a `string`-typed
   * `get` would mojibake any byte outside ASCII.
   */
  readonly getBuffer: (key: string) => Effect.Effect<Buffer | null, RedisError>
  readonly set: (key: string, value: string) => Effect.Effect<void, RedisError>
  readonly setex: (key: string, ttl: number, value: string) => Effect.Effect<void, RedisError>
  /**
   * Binary variant of `setex` — writes a `Buffer` value without
   * stringifying. ioredis sends Buffer values as raw bytes over the
   * wire when passed directly. Used by msgpack-encoded call bodies.
   */
  readonly setexBuffer: (key: string, ttl: number, value: Buffer) => Effect.Effect<void, RedisError>
  readonly del: (...keys: Array<string>) => Effect.Effect<number, RedisError>
  readonly exists: (key: string) => Effect.Effect<boolean, RedisError>
  readonly incr: (key: string) => Effect.Effect<number, RedisError>
  readonly decr: (key: string) => Effect.Effect<number, RedisError>
  readonly expire: (key: string, ttl: number) => Effect.Effect<void, RedisError>
  readonly eval: (script: string, keys: Array<string>, args: Array<string | number>) => Effect.Effect<unknown, RedisError>
  /**
   * Binary variant of `eval` — accepts string-or-Buffer ARGV (so the
   * caller can pass msgpack-encoded bodies as Lua argv) and returns
   * the entire Lua response as Buffers. The Lua return for
   * `CHANNEL_PULL_BATCH_LUA` mixes numbers, strings, and binary
   * bodies; callers coerce numbers via `Number(buf.toString())` and
   * leave bodies as-is.
   */
  readonly evalBuffer: (script: string, keys: Array<string>, args: Array<string | number | Buffer>) => Effect.Effect<unknown, RedisError>
  readonly pipeline: (commands: Array<[string, ...Array<string | number>]>) => Effect.Effect<Array<[Error | null, unknown]>, RedisError>
  readonly scanKeys: (pattern: string) => Effect.Effect<Array<string>, RedisError>
  readonly raw: RedisInstance
}

/**
 * Acquire an ioredis connection and return the wrapped operation surface.
 * Used by both `RedisClient.layer` and `LimiterRedisClient.layer` —
 * everything below the URL/prefix selection is identical.
 */
export const makeRedisOps = (
  url: string,
  prefix: string,
  label: string,
  options: RedisConnectionOptions = {}
): Effect.Effect<RedisOps, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Capture parent runtime services so the ioredis event listeners
    // (sync Node callbacks) can emit Effect.logWarning lines on the
    // worker's logger. Redis connect/reconnect/error events are rare
    // and load-bearing for failover diagnostics — they MUST surface.
    const parentServices = yield* Effect.services<never>()
    const client: RedisInstance = yield* Effect.acquireRelease(
      Effect.callback<RedisInstance>((resume) => {
        const redis = new RedisConstructor(url, {
          lazyConnect: true,
          ...options,
        })
        redis.connect()
          .then(() => resume(Effect.succeed(redis)))
          .catch((err: unknown) => resume(Effect.die(err)))
      }),
      (redis) =>
        Effect.sync(() => {
          redis.disconnect()
        })
    )

    // Wire ioredis lifecycle events to WARN-level logs. ioredis handles
    // its own auto-reconnect; we surface every transition so any
    // production blip is visible in worker logs without needing TRACE.
    client.on("connect", () => {
      Effect.runForkWith(parentServices)(
        Effect.logWarning(`Redis (${label}): TCP connect to ${url}`)
      )
    })
    client.on("ready", () => {
      Effect.runForkWith(parentServices)(
        Effect.logWarning(`Redis (${label}): ready (handshake complete)`)
      )
    })
    client.on("error", (err: Error) => {
      Effect.runForkWith(parentServices)(
        Effect.logWarning(`Redis (${label}): error — ${err.message}`)
      )
    })
    client.on("close", () => {
      Effect.runForkWith(parentServices)(
        Effect.logWarning(`Redis (${label}): connection closed`)
      )
    })
    client.on("reconnecting", (delayMs: number) => {
      Effect.runForkWith(parentServices)(
        Effect.logWarning(
          `Redis (${label}): reconnecting in ${delayMs}ms`
        )
      )
    })
    client.on("end", () => {
      Effect.runForkWith(parentServices)(
        Effect.logWarning(
          `Redis (${label}): connection ended (no further reconnects)`
        )
      )
    })

    yield* Effect.logInfo(`Redis (${label}) connected to ${url}`)

    const pk = (key: string) => `${prefix}:${key}`

    const wrapErr = (err: unknown): RedisError =>
      new RedisError({ reason: err instanceof Error ? err.message : String(err) })

    const get = Effect.fnUntraced(function* (key: string) {
      return yield* Effect.tryPromise({
        try: () => client.get(pk(key)),
        catch: wrapErr
      })
    })

    const getBuffer = Effect.fnUntraced(function* (key: string) {
      return yield* Effect.tryPromise({
        try: () => client.getBuffer(pk(key)),
        catch: wrapErr
      })
    })

    const set = Effect.fnUntraced(function* (key: string, value: string) {
      yield* Effect.tryPromise({
        try: () => client.set(pk(key), value),
        catch: wrapErr
      })
    })

    const setex = Effect.fnUntraced(function* (key: string, ttl: number, value: string) {
      yield* Effect.tryPromise({
        try: () => client.setex(pk(key), ttl, value),
        catch: wrapErr
      })
    })

    const setexBuffer = Effect.fnUntraced(function* (key: string, ttl: number, value: Buffer) {
      yield* Effect.tryPromise({
        try: () => client.setex(pk(key), ttl, value),
        catch: wrapErr
      })
    })

    const del = Effect.fnUntraced(function* (...keys: Array<string>) {
      return yield* Effect.tryPromise({
        try: () => client.del(...keys.map(pk)),
        catch: wrapErr
      })
    })

    const exists = Effect.fnUntraced(function* (key: string) {
      const result = yield* Effect.tryPromise({
        try: () => client.exists(pk(key)),
        catch: wrapErr
      })
      return result === 1
    })

    const incr = Effect.fnUntraced(function* (key: string) {
      return yield* Effect.tryPromise({
        try: () => client.incr(pk(key)),
        catch: wrapErr
      })
    })

    const decr = Effect.fnUntraced(function* (key: string) {
      return yield* Effect.tryPromise({
        try: () => client.decr(pk(key)),
        catch: wrapErr
      })
    })

    const expire = Effect.fnUntraced(function* (key: string, ttl: number) {
      yield* Effect.tryPromise({
        try: () => client.expire(pk(key), ttl),
        catch: wrapErr
      })
    })

    const evalCmd = Effect.fnUntraced(function* (
      script: string,
      keys: Array<string>,
      args: Array<string | number>
    ) {
      return yield* Effect.tryPromise({
        try: () => client.eval(script, keys.length, ...keys.map(pk), ...args),
        catch: wrapErr
      })
    })

    const evalBuffer = Effect.fnUntraced(function* (
      script: string,
      keys: Array<string>,
      args: Array<string | number | Buffer>
    ) {
      // ioredis exposes the EVAL command but does not surface
      // `evalBuffer` directly. `callBuffer` is the binary-reply
      // primitive — invoke it with the same wire shape ioredis would
      // produce for `eval` (script, numKeys, keys..., argv...).
      return yield* Effect.tryPromise({
        try: () =>
          client.callBuffer(
            "EVAL",
            script,
            String(keys.length),
            ...keys.map(pk),
            ...args,
          ),
        catch: wrapErr
      })
    })

    const pipeline = Effect.fnUntraced(function* (
      commands: Array<[string, ...Array<string | number>]>
    ) {
      const pipe = client.pipeline()
      for (const [cmd, ...cmdArgs] of commands) {
        ;(pipe as any)[cmd](...cmdArgs)
      }
      const results = yield* Effect.tryPromise({
        try: () => pipe.exec(),
        catch: wrapErr
      })
      return (results ?? []) as Array<[Error | null, unknown]>
    })

    const scanKeys = Effect.fnUntraced(function* (pattern: string) {
      return yield* Effect.tryPromise({
        try: async () => {
          const keys: string[] = []
          let cursor = "0"
          do {
            const [nextCursor, batch] = await client.scan(cursor, "MATCH", pk(pattern), "COUNT", 100)
            cursor = nextCursor
            keys.push(...batch)
          } while (cursor !== "0")
          // Strip prefix from returned keys
          const prefixLen = prefix.length + 1 // "prefix:"
          return keys.map((k) => k.slice(prefixLen))
        },
        catch: wrapErr
      })
    })

    return { get, getBuffer, set, setex, setexBuffer, del, exists, incr, decr, expire, eval: evalCmd, evalBuffer, pipeline, scanKeys, raw: client } satisfies RedisOps
  })

// ---------------------------------------------------------------------------
// Service interface — sidecar Redis (call context, replication)
// ---------------------------------------------------------------------------

export class RedisClient extends ServiceMap.Service<
  RedisClient,
  RedisOps
>()("@sipjsserver/RedisClient") {
  static readonly layer = Layer.effect(
    RedisClient,
    Effect.gen(function* () {
      const config = yield* AppConfig
      return yield* makeRedisOps(config.redisUrl, config.redisKeyPrefix, "sidecar")
    })
  )
}
