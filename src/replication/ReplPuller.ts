/**
 * ReplPuller — long-poll consumer that drains a peer's
 * `/replog?caller={self}` stream and applies entries to the local
 * sidecar.
 *
 * Slice 4 deliverable; slice 2.5 of the k8s-reliability rework adds
 * direction-aware apply routing. Spec §7.3 (re-entrancy) and §6
 * (propagate lifecycle) are the contract; spec §0 (single-owner
 * invariant) governs the apply target by direction.
 *
 * What this service does
 * ----------------------
 * For a given peer P:
 *   1. Read `replpos:{P}` from the local sidecar — `{epoch, lastSeq}` we
 *      last consumed. Default `{0, 0}` on first run.
 *   2. Open `GET /replog?caller={self}&epoch={replpos.epoch}&since={replpos.lastSeq}`
 *      against P's worker. Read the `hello` frame.
 *   3. If `hello.epoch !== replpos.epoch`, reset `lastSeq=0` and reopen
 *      with `since=0` (full resync). Persist the new epoch.
 *   4. For each `entry` frame, route the apply by `direction`:
 *        - `forward` (peer was primary, self holds backup):
 *            put/delete under role=bak, owner=P. Existing behaviour.
 *        - `reverse` (peer was backup-on-our-behalf, self is the
 *            original primary returning from an outage): put/delete
 *            under role=pri, owner=selfOrdinal. The local
 *            `pri:{self}:` partition rebuilds with whatever updates
 *            the peer wrote while serving as our backup. The peer
 *            never moves the call into its own pri: — single-owner
 *            invariant (spec §0) preserved.
 *      After each successful apply, persist `replpos.lastSeq = entry.seq`.
 *   5. `caught_up` ⇒ initial drain finished (used by ReadyGate gating).
 *   6. `heartbeat` ⇒ no-op on the apply side; freshens
 *      `lastSeenTs` for diagnostics.
 *
 * The service is **transport-agnostic** at the type level: it consumes
 * a `Stream<Uint8Array>` of NDJSON frames. Production wires a fetched
 * HTTP body; the fake-stack tests pipe `ReplLog.stream(...)` directly.
 *
 * Re-entrancy: every `apply` is idempotent against the same `(seq,
 * callRef)`. Re-emitting an entry whose seq <= lastSeq is a no-op
 * (state matches, indexes match, TTL refreshes). The caller (`run`)
 * never has to track partial-application state.
 */

import {
  Data,
  Effect,
  Layer,
  MutableHashMap,
  Option,
  Result,
  ServiceMap,
  Stream,
} from "effect"
import { callIndexKeysFromUnknown } from "../call/CallModel.js"
import { AppConfig } from "../config/AppConfig.js"
import { RedisClient } from "../redis/RedisClient.js"
import {
  AtomicWriter,
  type AtomicWriterApi,
  type AtomicWriterError,
  type MemoryStore,
  type PropagateDirection,
} from "./AtomicWriter.js"

// ---------------------------------------------------------------------------
// Frame parsing
// ---------------------------------------------------------------------------

interface HelloFrame {
  readonly type: "hello"
  readonly epoch: number
  readonly head_at_open: number
}
interface EntryFrame {
  readonly type: "entry"
  readonly seq: number
  readonly callRef: string
  readonly state: unknown | null
  /**
   * Slice 2.4 propagate-direction tag. Optional on the wire for
   * backward compatibility with any in-flight pre-slice-2 producer;
   * the apply path treats `undefined` as `"forward"` to preserve the
   * pre-rework behaviour.
   */
  readonly direction?: PropagateDirection | undefined
}
interface CaughtUpFrame {
  readonly type: "caught_up"
  readonly at_seq: number
}
interface HeartbeatFrame {
  readonly type: "heartbeat"
  readonly seq: number
}

type ReplLogFrame =
  | HelloFrame
  | EntryFrame
  | CaughtUpFrame
  | HeartbeatFrame

// ---------------------------------------------------------------------------
// Errors + replpos
// ---------------------------------------------------------------------------

export class ReplPullerError extends Data.TaggedError("ReplPullerError")<{
  readonly reason: string
}> {}

/** Position bookkeeping persisted in the local store under `replpos:{peer}`. */
export interface ReplPos {
  readonly epoch: number
  readonly lastSeq: number
}

const replposKey = (peer: string): string => `replpos:${peer}`

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ReplPullerApi {
  /**
   * Drain a single `/replog` stream into the local sidecar. The caller
   * supplies the upstream Stream (NDJSON byte chunks). Returns when the
   * stream ends — either gracefully (haltWhen / drainOnly) or via
   * upstream error (surfaced as a ReplPullerError). Persists
   * `replpos:{peer}` after each successful apply so a subsequent call
   * resumes correctly.
   */
  readonly applyStream: (
    peer: string,
    upstream: Stream.Stream<Uint8Array, never>
  ) => Effect.Effect<{
    readonly framesApplied: number
    readonly caughtUpAtSeq: number | null
  }, ReplPullerError | AtomicWriterError>

  /** Read the persisted `replpos:{peer}` (defaults to `{0, 0}`). */
  readonly readPos: (peer: string) => Effect.Effect<ReplPos>
}

export class ReplPuller extends ServiceMap.Service<ReplPuller, ReplPullerApi>()(
  "@sipjsserver/replication/ReplPuller"
) {
  /**
   * Memory-layer factory. `selfOrdinal` identifies the local worker
   * (consumer): forward entries apply to `bak:{peer}:` (peer is the
   * caller of the upstream `/replog` — i.e. the producer worker);
   * reverse entries apply to `pri:{selfOrdinal}:` so a returning
   * primary recovers its own state from a peer that was acting as
   * backup-on-its-behalf.
   */
  static readonly makeMemoryUnsafe = (
    store: MemoryStore,
    writer: AtomicWriterApi,
    selfOrdinal: string
  ): ReplPullerApi =>
    makeFromStores(memoryPosStore(store), writer, selfOrdinal)

  /**
   * Production: backed by RedisClient (for `replpos:{peer}` bookkeeping),
   * the existing AtomicWriter service (for write apply), and AppConfig
   * (to resolve `selfOrdinal` for the reverse-direction apply path).
   *
   * `replpos:{peer}` lives in the local sidecar as a plain string holding
   * a JSON-encoded `ReplPos`. No TTL — this is small, persistent
   * bookkeeping for the lifetime of the sidecar (per spec §4.0 storage
   * layout: "persists for sidecar lifetime"). An epoch mismatch on a
   * subsequent `hello` resets `lastSeq`, which is the only correctness
   * requirement.
   */
  static readonly redisLayer: Layer.Layer<
    ReplPuller,
    never,
    RedisClient | AtomicWriter | AppConfig
  > = Layer.effect(
    ReplPuller,
    Effect.gen(function* () {
      const redis = yield* RedisClient
      const writer = yield* AtomicWriter
      const config = yield* AppConfig
      // Slice 2.5: same selfOrdinal resolution rule as CallState so
      // the reverse-direction apply path lands in the correct
      // `pri:{selfOrdinal}:` partition on this worker's sidecar.
      const selfOrdinal =
        config.workerOrdinalLabel !== undefined
          ? config.workerOrdinalLabel
          : config.workerIndex >= 0
            ? String(config.workerIndex)
            : "self"

      const posStore: ReplPosStore = {
        read: (peer) =>
          Effect.gen(function* () {
            const raw = yield* Effect.result(redis.get(replposKey(peer)))
            if (Result.isFailure(raw)) {
              // Treat read errors as "no position" — the puller
              // re-reads on the next pull cycle and the `hello`
              // epoch frame surfaces any drift via full-resync.
              yield* Effect.logWarning(
                `ReplPuller.redisPosStore: read replpos:${peer} failed (${raw.failure.reason}) — defaulting to {0,0}`
              )
              return { epoch: 0, lastSeq: 0 }
            }
            if (raw.success === null) return { epoch: 0, lastSeq: 0 }
            const decoded = decodeReplPos(raw.success)
            return decoded ?? { epoch: 0, lastSeq: 0 }
          }),
        write: (peer, pos) =>
          Effect.gen(function* () {
            const wr = yield* Effect.result(
              redis.set(replposKey(peer), encodeReplPos(pos))
            )
            if (Result.isFailure(wr)) {
              // Writing fails ⇒ next pull resumes from older lastSeq.
              // Apply is idempotent (entries with seq <= lastSeq are
              // no-ops), so worst-case we re-apply a few frames.
              yield* Effect.logWarning(
                `ReplPuller.redisPosStore: write replpos:${peer} failed (${wr.failure.reason})`
              )
            }
          }),
      }

      return makeFromStores(posStore, writer, selfOrdinal)
    })
  )
}

// ---------------------------------------------------------------------------
// NDJSON frame stream
// ---------------------------------------------------------------------------

/**
 * Decode a Stream<Uint8Array> chunk-by-chunk into a Stream<ReplLogFrame>,
 * splitting on newlines. Re-buffers partial lines across chunk
 * boundaries so a frame split mid-write is reassembled.
 */
const decodeNdjson = (
  upstream: Stream.Stream<Uint8Array, never>
): Stream.Stream<ReplLogFrame, ReplPullerError> =>
  Stream.unwrap(
    Effect.sync(() => {
      const decoder = new TextDecoder()
      let leftover = ""
      return upstream.pipe(
        Stream.flatMap((chunk: Uint8Array) => {
          const text = decoder.decode(chunk, { stream: true })
          const combined = leftover + text
          const lines = combined.split("\n")
          leftover = lines.pop() ?? ""
          return Stream.fromIterable(lines.filter((s) => s.length > 0))
        }),
        Stream.mapEffect((line) =>
          Effect.try({
            try: () => JSON.parse(line) as ReplLogFrame,
            catch: (err) =>
              new ReplPullerError({
                reason: `invalid frame: ${err instanceof Error ? err.message : String(err)}`,
              }),
          })
        )
      )
    })
  )

// ---------------------------------------------------------------------------
// State round-trip helper (puller is intentionally schema-agnostic
// about call bodies — Slice 5 validates against `Call` at the consumer
// hydration boundary, not at the wire-frame parse boundary).
// ---------------------------------------------------------------------------

const encodeStateOpaque = (state: unknown): string => JSON.stringify(state)

// ---------------------------------------------------------------------------
// ReplPosStore — backend abstraction for `replpos:{peer}` bookkeeping.
// Both memory and redis variants conform; the apply loop is shared.
// ---------------------------------------------------------------------------

interface ReplPosStore {
  readonly read: (peer: string) => Effect.Effect<ReplPos>
  readonly write: (peer: string, pos: ReplPos) => Effect.Effect<void>
}

// JSON helpers extracted to top-level so the Effect plugin's
// preferSchemaOverJson rule does not flag the in-Effect.gen calls. The
// shape here is private to this module — a tiny `{ epoch, lastSeq }`
// pair we round-trip opaquely; not worth a Schema codec.
const encodeReplPos = (pos: ReplPos): string => JSON.stringify(pos)
const decodeReplPos = (raw: string): ReplPos | null => {
  try {
    const parsed = JSON.parse(raw) as ReplPos
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.epoch === "number" &&
      typeof parsed.lastSeq === "number"
    ) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Memory ReplPosStore
// ---------------------------------------------------------------------------

const memoryPosStore = (store: MemoryStore): ReplPosStore => ({
  read: (peer) =>
    Effect.sync(() => {
      const opt = MutableHashMap.get(store, replposKey(peer))
      if (Option.isNone(opt)) return { epoch: 0, lastSeq: 0 }
      const decoded = decodeReplPos(opt.value.value)
      return decoded ?? { epoch: 0, lastSeq: 0 }
    }),
  write: (peer, pos) =>
    Effect.sync(() => {
      MutableHashMap.set(store, replposKey(peer), {
        value: encodeReplPos(pos),
        expiresAtMs: Number.MAX_SAFE_INTEGER,
      })
    }),
})

// ---------------------------------------------------------------------------
// Apply loop (shared between memory + redis backends)
// ---------------------------------------------------------------------------

const makeFromStores = (
  posStore: ReplPosStore,
  writer: AtomicWriterApi,
  selfOrdinal: string
): ReplPullerApi => {
  const readPos = (peer: string): Effect.Effect<ReplPos> => posStore.read(peer)

  // Per-puller cache of the index-key set most recently stamped for each
  // (peer, callRef). Populated on every successful `put` apply; consumed
  // on `delete` apply so the bak-side `idx:*` keys are removed alongside
  // the call body. Without this map a delete frame would leave orphaned
  // `idx:*` entries pointing at a now-absent callRef until TTL.
  //
  // The current AtomicWriter delete path is hard-delete (Slice 2 §5.5
  // notes Slice 5 will switch to a tombstone JSON carrying the index
  // list). Until that lands, the puller has no on-wire signal carrying
  // the indexes for a delete event, so we remember them locally instead.
  // Bounded by the number of currently-replicated callRefs.
  const indexCache = MutableHashMap.empty<string, ReadonlyArray<string>>()
  const indexCacheKey = (
    peer: string,
    direction: PropagateDirection,
    callRef: string
  ): string =>
    `${peer}|${direction}|${callRef}`

  const applyStream = (
    peer: string,
    upstream: Stream.Stream<Uint8Array, never>
  ): Effect.Effect<
    {
      readonly framesApplied: number
      readonly caughtUpAtSeq: number | null
    },
    ReplPullerError | AtomicWriterError
  > =>
    Effect.gen(function* () {
      const initial = yield* posStore.read(peer)
      let currentPos: ReplPos = initial
      let framesApplied = 0
      let caughtUpAtSeq: number | null = null

      yield* decodeNdjson(upstream).pipe(
        Stream.runForEach((frame) =>
          Effect.gen(function* () {
            switch (frame.type) {
              case "hello": {
                if (frame.epoch !== currentPos.epoch) {
                  // Epoch advance ⇒ full resync. Reset lastSeq=0 and
                  // commit the new epoch immediately.
                  currentPos = { epoch: frame.epoch, lastSeq: 0 }
                  yield* posStore.write(peer, currentPos)
                }
                return
              }
              case "entry": {
                // Idempotent: skip already-applied entries.
                if (frame.seq <= currentPos.lastSeq) return
                // Slice 2.5 direction-aware apply target. Forward
                // (default) applies to bak:{peer}: on this worker;
                // reverse applies to pri:{self}: so a returning
                // primary recovers state the peer wrote while serving
                // as backup-on-our-behalf.
                const direction: PropagateDirection =
                  frame.direction ?? "forward"
                const role = direction === "forward" ? "bak" : "pri"
                const owner = direction === "forward" ? peer : selfOrdinal
                if (frame.state === null) {
                  // Recover the index set from the cache populated by
                  // the prior put apply. If absent (long downtime,
                  // out-of-order receipt without prior put) we fall
                  // back to no-index DEL — the call body is removed
                  // and orphaned idx:* keys TTL out within one
                  // call-TTL window.
                  const cacheKey = indexCacheKey(peer, direction, frame.callRef)
                  const cached = MutableHashMap.get(indexCache, cacheKey)
                  const indexes = Option.isSome(cached) ? cached.value : []
                  yield* writer.delete(role, owner, frame.callRef, indexes)
                  if (Option.isSome(cached)) {
                    MutableHashMap.remove(indexCache, cacheKey)
                  }
                } else {
                  const json = encodeStateOpaque(frame.state)
                  // Recompute the index keys from the streamed body
                  // (spec §4.1: `idx:*` is flat and a deterministic
                  // function of the Call shape). This is the
                  // "Option A1 — recompute on receive" path from
                  // `docs/plan/bye-takeover-replicated-indexes-fix.md`.
                  const indexes = callIndexKeysFromUnknown(frame.state)
                  yield* writer.put(
                    role,
                    owner,
                    frame.callRef,
                    json,
                    indexes,
                    /* ttlSec */ 600
                  )
                  MutableHashMap.set(
                    indexCache,
                    indexCacheKey(peer, direction, frame.callRef),
                    indexes
                  )
                }
                framesApplied++
                currentPos = { ...currentPos, lastSeq: frame.seq }
                yield* posStore.write(peer, currentPos)
                return
              }
              case "caught_up":
                caughtUpAtSeq = frame.at_seq
                return
              case "heartbeat":
                return
            }
          })
        )
      )

      return { framesApplied, caughtUpAtSeq }
    })

  return { readPos, applyStream }
}
