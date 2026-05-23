/**
 * ReplicationProtocol — wire types and length-prefixed-msgpack codec
 * for the `/replog` long-lived stream.
 *
 * Two frame types only:
 *   - `Data` — a single state mutation. Carries `(gen, counter)` plus
 *     the partition / op / callRef and the body bytes. `body` is `null`
 *     when the source's tombstone body has TTL'd before the puller
 *     drained it.
 *   - `Noop` — heartbeat + caught-up signal. Carries `(gen, counter)`
 *     where `counter` is the source channel's current head. Receivers
 *     flip `everCaughtUp = true` on the first noop received per fiber
 *     incarnation.
 *
 * Frames are emitted in strictly ascending `(gen, counter)` order. The
 * puller's apply rule is mechanical: apply iff `(F.gen, F.counter) >
 * (watermark.gen, watermark.counter)`. There is no hello, head, or
 * gen_mismatch frame — gen rollover is naturally handled because new-gen
 * tuples sort above old-gen tuples regardless of the new counter value.
 *
 * Wire format (post-msgpackr-migration):
 *
 *   ┌─────────────────────────┬───────────────────────────────────┐
 *   │ 4-byte BE uint32 length │ msgpack-encoded payload (`length`)│
 *   └─────────────────────────┴───────────────────────────────────┘
 *
 * The payload is a msgpack map with the shape:
 *   { type: "data" | "noop",
 *     gen, counter,
 *     [op, partition, callRef, body, body_ttl_remaining_sec],   ← data only
 *     latency_ms }
 *
 * `body` is the msgpack-encoded Call body (a nested Buffer / bin field
 * inside the outer map) — preserved opaquely on the puller side so the
 * primary's msgpack-bytes pass through to the backup without re-encoding.
 *
 * Design ref: [docs/plan/grill-me-on-the-spicy-lark.md](../../docs/plan/grill-me-on-the-spicy-lark.md) §Wire Protocol.
 * Codec choice rationale: [docs/adr/0008-msgpackr-call-codec.md](../../docs/adr/0008-msgpackr-call-codec.md).
 */

import { Data } from "effect"
import { Encoder } from "msgpackr"
import { mpUnpack, readStampedWrittenAtMs, stripStampedPrefix } from "../call/CallCodec.js"
import { callIndexKeysFromUnknown } from "../call/CallModel.js"
import {
  KvBackend,
  type PulledEntry,
} from "../storage/KvBackend.js"
import type { Partition } from "./ChannelIndex.js"

// ---------------------------------------------------------------------------
// Frame types
// ---------------------------------------------------------------------------

export type Op = "create" | "update" | "delete"

export interface DataFrame {
  readonly _tag: "Data"
  /**
   * The entry's stored `entryGen` (per Story 7d). `0` for mirror
   * entries written by a puller's apply path; the writer's
   * incarnation gen for originating writes. Lex-ordered with
   * `counter` for the puller's apply gate; cycle-break is structural.
   */
  readonly gen: number
  /** Per-bucket monotonic counter at write time. */
  readonly counter: number
  readonly op: Op
  readonly partition: Partition
  readonly callRef: string
  /**
   * Raw msgpack-encoded Call body (the same bytes the originator wrote
   * to its primary Redis), or `null` for two cases: (a) the stored
   * body slot was empty AND the receiver should treat the call as
   * deleted, or (b) the originator emitted a D-member (delete) — in
   * both cases the receiver applies an implicit DEL.
   *
   * After commit 4 the peer apply path NEVER decodes this — it writes
   * the bytes through to local storage opaquely, gating on `callGen`
   * and using `indexes` directly.
   */
  readonly body: Buffer | null
  /**
   * Time-remaining for the body, computed at server emission time
   * (PTTL on Redis; `expiresAtMs - nowMs` on memory). Receivers pass
   * this to their local `bodySet` so the local copy expires at the
   * same wall-clock as the source's — recovery via cold-pull doesn't
   * extend the source's intended expiry. `0` means already-expired
   * (treated as implicit DEL upstream by the puller).
   */
  readonly body_ttl_remaining_sec: number
  readonly latency_ms: number
  /**
   * Per-call content version stamped by the originator
   * (`bumped._topology.gen` at flush time). The peer's apply gate
   * uses this in commit 4 to skip stale UPDATEs without decoding
   * the body. `0` when the originator's topology was absent
   * (legacy in-memory-only path).
   */
  readonly callGen: number
  /**
   * Index keys derived from the call at originator-flush time
   * (`callIndexKeys(call)`). Stamped on BOTH UPDATE and DELETE frames
   * so the peer's apply path can write / remove them without
   * maintaining its own `(source, callRef) → indexes` cache. Each
   * entry is the bare key suffix (e.g. `"leg:abc|tag1"`); the apply
   * path prefixes with `"idx:"`.
   */
  readonly indexes: ReadonlyArray<string>
}

export interface NoopFrame {
  readonly _tag: "Noop"
  readonly gen: number
  readonly counter: number
  readonly latency_ms: number
}

export type PullFrame = DataFrame | NoopFrame

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ProtocolError extends Data.TaggedError("ProtocolError")<{
  readonly reason: string
}> {}

// ---------------------------------------------------------------------------
// Tuple ordering
// ---------------------------------------------------------------------------

/**
 * Lexicographic compare on `(gen, counter)`. The puller's apply rule —
 * "apply iff `(F.gen, F.counter) > watermark`" — uses this exclusively;
 * gen rollover is naturally handled because new-gen tuples sort above
 * old-gen tuples regardless of where the new counter resets.
 *
 * Returns -1 / 0 / 1 in the standard sort-comparator shape.
 */
export const compareGenCounter = (
  a: { readonly gen: number; readonly counter: number },
  b: { readonly gen: number; readonly counter: number }
): -1 | 0 | 1 => {
  if (a.gen < b.gen) return -1
  if (a.gen > b.gen) return 1
  if (a.counter < b.counter) return -1
  if (a.counter > b.counter) return 1
  return 0
}

// ---------------------------------------------------------------------------
// Codec — msgpackr-backed, schemaless. Same Encoder config as
// `src/call/CallCodec.ts` (records off, undefined preserved) so an
// outer DataFrame map and an inner Call body both round-trip through
// the same encoder semantics. Records-mode would be ~5× faster on this
// shape but is NOT backward-compatible at decode time; see
// CallCodec.ts for the rolling-upgrade constraint.
// ---------------------------------------------------------------------------

const encoder = new Encoder({
  useRecords: false,
  copyBuffers: true,
  encodeUndefinedAsNil: false,
})

// ---------------------------------------------------------------------------
// Fix #5 — hand-written envelope encoder.
//
// The envelope shape is fixed (9 keys for Data, 4 for Noop). msgpackr's
// generic `writePlainObject` re-emits every key name from scratch on
// each pack — at thousands of frames/sec this dominates wire-encode
// CPU (~6 % of total in the post-codec-migration profile).
//
// We pre-encode the key-name fixstr bytes at module load and concat
// them with per-frame value bytes. Output is standard msgpack — the
// existing `encoder.unpack` reads it verbatim, and so does any
// pre-Fix-#5 worker. No rolling-upgrade hazard (unlike the
// `useRecords: true` path which silently corrupts at the decoder when
// a fresh records-mode decoder sees a non-records buffer; see
// `CallCodec.ts` for the original investigation).
// ---------------------------------------------------------------------------

// fixstr key prefixes — msgpack `0xa0 | len`, ASCII bytes.
const encFixstrKey = (key: string): Buffer => {
  const bytes = Buffer.from(key, "utf8")
  if (bytes.length >= 32) {
    // None of the envelope keys are this long; future schema growth
    // would force a switch to str8/str16.
    throw new Error(`envelope key "${key}" exceeds fixstr length`)
  }
  return Buffer.concat([Buffer.from([0xa0 | bytes.length]), bytes])
}

const KEY_TYPE = encFixstrKey("type")
const KEY_GEN = encFixstrKey("gen")
const KEY_COUNTER = encFixstrKey("counter")
const KEY_OP = encFixstrKey("op")
const KEY_PARTITION = encFixstrKey("partition")
const KEY_CALLREF = encFixstrKey("callRef")
const KEY_BODY = encFixstrKey("body")
const KEY_BODY_TTL = encFixstrKey("body_ttl_remaining_sec")
const KEY_LATENCY = encFixstrKey("latency_ms")
const KEY_CALLGEN = encFixstrKey("callGen")
const KEY_INDEXES = encFixstrKey("indexes")

// Pre-encoded `"type"` values. type fixstr `0xa4 + 4 bytes`.
const VAL_TYPE_DATA = Buffer.from([0xa4, 0x64, 0x61, 0x74, 0x61]) // "data"
const VAL_TYPE_NOOP = Buffer.from([0xa4, 0x6e, 0x6f, 0x6f, 0x70]) // "noop"

// Pre-encoded partition values (always one of two literal strings).
const VAL_PARTITION_PRI = Buffer.from([0xa3, 0x70, 0x72, 0x69])
const VAL_PARTITION_BAK = Buffer.from([0xa3, 0x62, 0x61, 0x6b])

// Pre-encoded op values (always one of three literal strings).
const VAL_OP_CREATE = Buffer.from([0xa6, 0x63, 0x72, 0x65, 0x61, 0x74, 0x65])
const VAL_OP_UPDATE = Buffer.from([0xa6, 0x75, 0x70, 0x64, 0x61, 0x74, 0x65])
const VAL_OP_DELETE = Buffer.from([0xa6, 0x64, 0x65, 0x6c, 0x65, 0x74, 0x65])
const VAL_NIL = Buffer.from([0xc0])

// Map16 header `0xde + count BE16`. Both envelope shapes are < 16
// fields, which would fit fixmap (`0x80 | count`) too, but map16 is
// chosen for forward-compatibility with the existing decoder and to
// keep the prefix shape uniform.
const MAP_HEADER_11 = Buffer.from([0xde, 0x00, 0x0b])
const MAP_HEADER_4 = Buffer.from([0xde, 0x00, 0x04])

const encUint = (n: number): Buffer => {
  if (n >= 0 && n <= 0x7f && Number.isInteger(n)) {
    return Buffer.from([n])
  }
  if (n >= 0 && n <= 0xff && Number.isInteger(n)) {
    return Buffer.from([0xcc, n])
  }
  if (n >= 0 && n <= 0xffff && Number.isInteger(n)) {
    const b = Buffer.alloc(3)
    b[0] = 0xcd
    b.writeUInt16BE(n, 1)
    return b
  }
  if (n >= 0 && n <= 0xffff_ffff && Number.isInteger(n)) {
    const b = Buffer.alloc(5)
    b[0] = 0xce
    b.writeUInt32BE(n >>> 0, 1)
    return b
  }
  // 53-bit safe int via uint64 BE (writer ensures non-negative finite ints).
  if (Number.isInteger(n) && n >= 0) {
    const b = Buffer.alloc(9)
    b[0] = 0xcf
    const hi = Math.floor(n / 0x1_0000_0000)
    const lo = n >>> 0
    b.writeUInt32BE(hi, 1)
    b.writeUInt32BE(lo, 5)
    return b
  }
  // Fallback to float64 for non-integer / negative — should not arise
  // on the envelope shape but keeps the writer total over `number`.
  const b = Buffer.alloc(9)
  b[0] = 0xcb
  b.writeDoubleBE(n, 1)
  return b
}

const encString = (s: string): Buffer => {
  const bytes = Buffer.from(s, "utf8")
  if (bytes.length <= 31) {
    return Buffer.concat([Buffer.from([0xa0 | bytes.length]), bytes])
  }
  if (bytes.length <= 0xff) {
    return Buffer.concat([Buffer.from([0xd9, bytes.length]), bytes])
  }
  if (bytes.length <= 0xffff) {
    const hdr = Buffer.alloc(3)
    hdr[0] = 0xda
    hdr.writeUInt16BE(bytes.length, 1)
    return Buffer.concat([hdr, bytes])
  }
  const hdr = Buffer.alloc(5)
  hdr[0] = 0xdb
  hdr.writeUInt32BE(bytes.length, 1)
  return Buffer.concat([hdr, bytes])
}

const encBinaryOrNil = (buf: Buffer | null): Buffer => {
  if (buf === null) return VAL_NIL
  if (buf.length <= 0xff) {
    return Buffer.concat([Buffer.from([0xc4, buf.length]), buf])
  }
  if (buf.length <= 0xffff) {
    const hdr = Buffer.alloc(3)
    hdr[0] = 0xc5
    hdr.writeUInt16BE(buf.length, 1)
    return Buffer.concat([hdr, buf])
  }
  const hdr = Buffer.alloc(5)
  hdr[0] = 0xc6
  hdr.writeUInt32BE(buf.length, 1)
  return Buffer.concat([hdr, buf])
}

const encOp = (op: Op): Buffer => {
  if (op === "create") return VAL_OP_CREATE
  if (op === "update") return VAL_OP_UPDATE
  return VAL_OP_DELETE
}

const encStringArray = (arr: ReadonlyArray<string>): Buffer => {
  const parts: Array<Buffer> = []
  // Array header — fixarray (<= 15), array16, or array32.
  if (arr.length <= 15) {
    parts.push(Buffer.from([0x90 | arr.length]))
  } else if (arr.length <= 0xffff) {
    const hdr = Buffer.alloc(3)
    hdr[0] = 0xdc
    hdr.writeUInt16BE(arr.length, 1)
    parts.push(hdr)
  } else {
    const hdr = Buffer.alloc(5)
    hdr[0] = 0xdd
    hdr.writeUInt32BE(arr.length, 1)
    parts.push(hdr)
  }
  for (const s of arr) parts.push(encString(s))
  return Buffer.concat(parts)
}

const encPartition = (p: Partition): Buffer =>
  p === "pri" ? VAL_PARTITION_PRI : VAL_PARTITION_BAK

/** 4-byte big-endian length prefix builder. */
const writeUint32BE = (n: number): Buffer => {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(n >>> 0, 0)
  return buf
}

/**
 * Encode a frame as length-prefixed msgpack bytes. The output is one
 * self-contained chunk — Stream callers concatenate without delimiters.
 */
export const encodeFrame = (frame: PullFrame): Buffer => {
  if (frame._tag === "Data") {
    const payload = Buffer.concat([
      MAP_HEADER_11,
      KEY_TYPE, VAL_TYPE_DATA,
      KEY_GEN, encUint(frame.gen),
      KEY_COUNTER, encUint(frame.counter),
      KEY_OP, encOp(frame.op),
      KEY_PARTITION, encPartition(frame.partition),
      KEY_CALLREF, encString(frame.callRef),
      KEY_BODY, encBinaryOrNil(frame.body),
      KEY_BODY_TTL, encUint(frame.body_ttl_remaining_sec),
      KEY_LATENCY, encUint(frame.latency_ms),
      KEY_CALLGEN, encUint(frame.callGen),
      KEY_INDEXES, encStringArray(frame.indexes),
    ])
    return Buffer.concat([writeUint32BE(payload.length), payload])
  }
  const payload = Buffer.concat([
    MAP_HEADER_4,
    KEY_TYPE, VAL_TYPE_NOOP,
    KEY_GEN, encUint(frame.gen),
    KEY_COUNTER, encUint(frame.counter),
    KEY_LATENCY, encUint(frame.latency_ms),
  ])
  return Buffer.concat([writeUint32BE(payload.length), payload])
}

/**
 * Decode one msgpack payload Buffer into a `PullFrame`. Length-prefix
 * framing is handled by `BinaryFrameStream` — this helper expects a
 * single self-contained msgpack value.
 *
 * Throws `ProtocolError` for malformed payloads or unknown frame types.
 */
export const decodeFrame = (payload: Buffer): PullFrame => {
  let obj: Record<string, unknown>
  try {
    const decoded = encoder.unpack(payload) as unknown
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new ProtocolError({
        reason: `frame payload is not an object (got ${typeof decoded})`,
      })
    }
    obj = decoded as Record<string, unknown>
  } catch (err) {
    if (err instanceof ProtocolError) throw err
    throw new ProtocolError({
      reason: err instanceof Error ? err.message : String(err),
    })
  }

  const type = obj["type"]
  const gen = toFiniteNumber(obj["gen"])
  const counter = toFiniteNumber(obj["counter"])
  const latency_ms = toFiniteNumber(obj["latency_ms"]) ?? 0
  if (gen === null || counter === null) {
    throw new ProtocolError({ reason: "missing gen/counter" })
  }
  if (type === "noop") {
    return { _tag: "Noop", gen, counter, latency_ms }
  }
  if (type === "data") {
    const op = obj["op"]
    const partition = obj["partition"]
    const callRef = obj["callRef"]
    if (
      (op !== "create" && op !== "update" && op !== "delete") ||
      (partition !== "pri" && partition !== "bak") ||
      typeof callRef !== "string"
    ) {
      throw new ProtocolError({
        reason: "data frame missing/invalid op/partition/callRef",
      })
    }
    const body_ttl_remaining_sec =
      toFiniteNumber(obj["body_ttl_remaining_sec"]) ?? 0
    const rawBody = obj["body"]
    const body: Buffer | null =
      rawBody === null || rawBody === undefined
        ? null
        : Buffer.isBuffer(rawBody)
          ? rawBody
          : rawBody instanceof Uint8Array
            ? Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength)
            : null
    const callGen = toFiniteNumber(obj["callGen"]) ?? 0
    const rawIndexes = obj["indexes"]
    const indexes: ReadonlyArray<string> = Array.isArray(rawIndexes)
      ? rawIndexes.filter((s): s is string => typeof s === "string")
      : []
    return {
      _tag: "Data",
      gen,
      counter,
      op,
      partition,
      callRef,
      body,
      body_ttl_remaining_sec,
      latency_ms,
      callGen,
      indexes,
    }
  }
  throw new ProtocolError({ reason: `unknown frame type "${String(type)}"` })
}

const toFiniteNumber = (raw: unknown): number | null => {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

// ---------------------------------------------------------------------------
// Member parsing — derive the parts of a `data` frame from a KvBackend
// member string + body. The member format `${op}:${partition}:${owner}:call:${callRef}`
// is enforced by `ChannelIndex` and `KvBackend.memberOf`.
// ---------------------------------------------------------------------------

export interface MemberParts {
  readonly op: Op
  readonly partition: Partition
  readonly callRef: string
}

/**
 * Parse a KvBackend member string into its component parts.
 *
 *   "U:pri:worker-A:call:abc"  → { op: "update", partition: "pri", callRef: "abc" }
 *   "D:bak:worker-B:call:xyz"  → { op: "delete", partition: "bak", callRef: "xyz" }
 *
 * Returns `null` if the member is malformed (programming bug upstream
 * — `ChannelIndex` should never produce one).
 */
export const parseMember = (member: string): MemberParts | null => {
  const bodyKey = KvBackend.bodyKeyFromMember(member)
  if (bodyKey === null) return null
  const opTag = member[0]
  const op: Op = opTag === "D" ? "delete" : "update"
  // bodyKey = `${partition}:${owner}:call:${callRef}`
  const firstColon = bodyKey.indexOf(":")
  if (firstColon < 1) return null
  const partition = bodyKey.slice(0, firstColon)
  if (partition !== "pri" && partition !== "bak") return null
  const callMarkerIdx = bodyKey.indexOf(":call:", firstColon + 1)
  if (callMarkerIdx === -1) return null
  const callRef = bodyKey.slice(callMarkerIdx + ":call:".length)
  if (callRef.length === 0) return null
  return { op, partition, callRef }
}

/**
 * Build a `DataFrame` from a `KvBackend.PulledEntry`. Per Story 7d
 * the entry carries its own `entryGen` (the bucket it was written
 * under — `0` for mirrors, writer's incarnation gen for originating
 * writes), which becomes the frame's `gen`. The body Buffer from
 * storage passes through opaquely — `latency_ms` is derived from the
 * `__writtenAtMs` field inside the encoded body (set by
 * `CallState.flushToRedis` before encode).
 *
 * `latency_ms` is set from the body's `__writtenAtMs` field if
 * present and decodable; otherwise `0`. The wire field is always
 * present so receivers can rely on its shape.
 */
export const buildDataFrame = (
  entry: PulledEntry,
  nowMs: number
): DataFrame | null => {
  const parts = parseMember(entry.member)
  if (parts === null) return null
  // callGen comes from the entry's `:gen` sidecar (read at pull time by
  // channelPullBatch). When the sidecar is missing — pre-sidecar entries
  // or a TTL race — we fall back to a body decode. The indexes still
  // require a body decode (no `:idx` sidecar today); that decode also
  // supplies the writtenAtMs latency_ms metric.
  const metadata = entry.body !== null ? extractBodyMetadata(entry.body) : null
  const writtenAtMs = metadata?.writtenAtMs ?? null
  const latency_ms = writtenAtMs !== null ? Math.max(0, nowMs - writtenAtMs) : 0
  const callGen = entry.callGen ?? metadata?.callGen ?? 0
  return {
    _tag: "Data",
    gen: entry.entryGen,
    counter: entry.score,
    op: parts.op,
    partition: parts.partition,
    callRef: parts.callRef,
    body: entry.body,
    body_ttl_remaining_sec: entry.body_ttl_remaining_sec,
    latency_ms,
    callGen,
    indexes: metadata?.indexes ?? [],
  }
}

interface BodyMetadata {
  readonly writtenAtMs: number | null
  readonly callGen: number
  readonly indexes: ReadonlyArray<string>
}

/**
 * Extract callGen, indexes, and writtenAtMs from a body Buffer in one
 * decode. writtenAtMs may come from the binary stamp prefix without
 * decoding; callGen + indexes always require a body decode (transitional
 * — commit 4 reads them from a sidecar instead).
 */
const extractBodyMetadata = (body: Buffer): BodyMetadata => {
  // writtenAtMs fast path: binary prefix; if absent, fall through to a
  // body decode that also yields callGen + indexes.
  const stamped = readStampedWrittenAtMs(body)
  try {
    const obj = mpUnpack(stripStampedPrefix(body)) as unknown
    if (typeof obj !== "object" || obj === null) {
      return { writtenAtMs: stamped, callGen: 0, indexes: [] }
    }
    const objRec = obj as Record<string, unknown>
    const writtenAtMs =
      stamped !== null ? stamped : toFiniteNumber(objRec["__writtenAtMs"])
    const topology = objRec["_topology"]
    const callGen =
      topology !== null && typeof topology === "object"
        ? (toFiniteNumber(
            (topology as Record<string, unknown>)["gen"],
          ) ?? 0)
        : 0
    const indexes = callIndexKeysFromUnknown(obj)
    return { writtenAtMs, callGen, indexes }
  } catch {
    return { writtenAtMs: stamped, callGen: 0, indexes: [] }
  }
}
