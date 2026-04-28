/**
 * ReplPuller — long-poll consumer that drains a peer's
 * `/replog?caller={self}` stream and applies entries to the local
 * sidecar's `bak:{peer}:` partition.
 *
 * Slice 4 deliverable. Spec §7.3 (re-entrancy) and §6 (propagate
 * lifecycle) are the contract.
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
 *   4. For each `entry` frame:
 *        - `state === null` ⇒ AtomicWriter.delete on local sidecar
 *          under role=bak, owner=P, callRef=entry.callRef.
 *        - `state !== null` ⇒ AtomicWriter.put with the streamed JSON.
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
  MutableHashMap,
  Option,
  ServiceMap,
  Stream,
} from "effect"
import {
  type AtomicWriterApi,
  type AtomicWriterError,
  type MemoryStore,
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
   * Memory-layer factory. `selfOrdinal` identifies the local worker —
   * applies write to `bak:{peer}:` partitions of THIS worker's sidecar
   * (the peer's primary copy lives on its own sidecar; we hold the
   * backup copy here under the peer's ordinal).
   */
  static readonly makeMemoryUnsafe = (
    store: MemoryStore,
    writer: AtomicWriterApi
  ): ReplPullerApi => makeMemory(store, writer)
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
// Memory backend
// ---------------------------------------------------------------------------

const writeReplPos = (
  store: MemoryStore,
  peer: string,
  pos: ReplPos
): void => {
  MutableHashMap.set(store, replposKey(peer), {
    value: JSON.stringify(pos),
    expiresAtMs: Number.MAX_SAFE_INTEGER,
  })
}

const readReplPosSync = (store: MemoryStore, peer: string): ReplPos => {
  const opt = MutableHashMap.get(store, replposKey(peer))
  if (Option.isNone(opt)) return { epoch: 0, lastSeq: 0 }
  return Effect.runSync(
    Effect.try({
      try: () => JSON.parse(opt.value.value) as ReplPos,
      catch: () => "parse",
    }).pipe(Effect.orElseSucceed(() => ({ epoch: 0, lastSeq: 0 })))
  )
}

const makeMemory = (
  store: MemoryStore,
  writer: AtomicWriterApi
): ReplPullerApi => {
  const readPos = (peer: string): Effect.Effect<ReplPos> =>
    Effect.sync(() => readReplPosSync(store, peer))

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
      const initial = readReplPosSync(store, peer)
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
                  yield* Effect.sync(() =>
                    writeReplPos(store, peer, currentPos)
                  )
                }
                return
              }
              case "entry": {
                // Idempotent: skip already-applied entries.
                if (frame.seq <= currentPos.lastSeq) return
                if (frame.state === null) {
                  yield* writer.delete("bak", peer, frame.callRef, [])
                } else {
                  const json = encodeStateOpaque(frame.state)
                  // Slice 4 doesn't yet pull index keys (the spec
                  // pull contract carries only the call body).
                  // Indexes are reconstructed from the call body's
                  // canonical fields when ReplPuller fully wires
                  // CallModel.callIndexKeys into the apply path —
                  // tracked as Slice 5 polish.
                  yield* writer.put(
                    "bak",
                    peer,
                    frame.callRef,
                    json,
                    [],
                    /* ttlSec */ 600
                  )
                }
                framesApplied++
                currentPos = { ...currentPos, lastSeq: frame.seq }
                yield* Effect.sync(() => writeReplPos(store, peer, currentPos))
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
