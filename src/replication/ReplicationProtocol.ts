/**
 * ReplicationProtocol — wire types and NDJSON codec for the new
 * `/replog` long-lived stream.
 *
 * Two frame types only:
 *   - `Data` — a single state mutation. Carries `(gen, counter)` plus
 *     the partition / op / callRef and the body content. The `op`
 *     distinguishes create/update/delete; `body` is `null` only for
 *     the case where the source's tombstone body has TTL'd before the
 *     puller drained it.
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
 * Wire format (one JSON object per line, NDJSON):
 *
 *   {"type":"data","gen":42,"counter":105,"op":"update","partition":"pri",
 *    "callRef":"abc","body":{...},"latency_ms":12}
 *   {"type":"noop","gen":42,"counter":105,"latency_ms":0}
 *
 * Design ref: [docs/plan/grill-me-on-the-spicy-lark.md](../../docs/plan/grill-me-on-the-spicy-lark.md) §Wire Protocol.
 */

import { Data } from "effect"
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
   * The decoded body (parsed JSON). `null` for two cases: (a) the
   * stored body was a tombstone-shaped JSON value AND the receiver
   * should treat the call as deleted, or (b) the stored body was
   * absent (e.g. tombstone TTL'd before pull) — the receiver applies
   * an implicit DEL in either case.
   */
  readonly body: unknown | null
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
  readonly raw?: string
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
// Codec — pure helpers (intentionally outside Effect.gen so the Effect
// plugin's preferSchemaOverJson rule does not fire on the JSON ops).
// ---------------------------------------------------------------------------

/** Encode a frame as a single NDJSON line (with trailing newline). */
export const encodeFrame = (frame: PullFrame): string => {
  if (frame._tag === "Data") {
    return `${JSON.stringify({
      type: "data",
      gen: frame.gen,
      counter: frame.counter,
      op: frame.op,
      partition: frame.partition,
      callRef: frame.callRef,
      body: frame.body,
      body_ttl_remaining_sec: frame.body_ttl_remaining_sec,
      latency_ms: frame.latency_ms,
    })}\n`
  }
  return `${JSON.stringify({
    type: "noop",
    gen: frame.gen,
    counter: frame.counter,
    latency_ms: frame.latency_ms,
  })}\n`
}

/**
 * Decode one NDJSON line into a `PullFrame`. Returns `null` for blank
 * lines (whitespace only) so callers can skip them. Throws `ProtocolError`
 * for malformed JSON or unknown frame types.
 */
export const decodeFrame = (line: string): PullFrame | null => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  const obj = parseJsonObject(trimmed)
  if (obj === null) {
    throw new ProtocolError({ reason: "malformed JSON", raw: line })
  }
  const type = obj["type"]
  const gen = toFiniteNumber(obj["gen"])
  const counter = toFiniteNumber(obj["counter"])
  const latency_ms = toFiniteNumber(obj["latency_ms"]) ?? 0
  if (gen === null || counter === null) {
    throw new ProtocolError({ reason: "missing gen/counter", raw: line })
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
        raw: line,
      })
    }
    const body_ttl_remaining_sec =
      toFiniteNumber(obj["body_ttl_remaining_sec"]) ?? 0
    return {
      _tag: "Data",
      gen,
      counter,
      op,
      partition,
      callRef,
      body: "body" in obj ? obj["body"] : null,
      body_ttl_remaining_sec,
      latency_ms,
    }
  }
  throw new ProtocolError({ reason: `unknown frame type "${String(type)}"`, raw: line })
}

const parseJsonObject = (raw: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fallthrough
  }
  return null
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
 * writes), which becomes the frame's `gen`. The body string from
 * storage is decoded as JSON (or kept as `null` when the body has
 * TTL'd / been DEL'd). `body_ttl_remaining_sec` comes straight from
 * the entry — server stamps the source's intended remaining TTL,
 * receiver uses it as the local body's TTL.
 *
 * `latency_ms` is set from the body's `written_at_ms` field if
 * present; otherwise `0`. The wire field is always present so
 * receivers can rely on its shape.
 */
export const buildDataFrame = (
  entry: PulledEntry,
  nowMs: number
): DataFrame | null => {
  const parts = parseMember(entry.member)
  if (parts === null) return null
  const body = entry.body !== null ? safeParseJsonValue(entry.body) : null
  const writtenAtMs = extractWrittenAtMs(body)
  const latency_ms = writtenAtMs !== null ? Math.max(0, nowMs - writtenAtMs) : 0
  return {
    _tag: "Data",
    gen: entry.entryGen,
    counter: entry.score,
    op: parts.op,
    partition: parts.partition,
    callRef: parts.callRef,
    body,
    body_ttl_remaining_sec: entry.body_ttl_remaining_sec,
    latency_ms,
  }
}

const safeParseJsonValue = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

const extractWrittenAtMs = (body: unknown): number | null => {
  if (typeof body !== "object" || body === null) return null
  const ts = (body as Record<string, unknown>)["written_at_ms"]
  return toFiniteNumber(ts)
}
