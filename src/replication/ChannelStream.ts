/**
 * Shared paginate-driven primitive for the replication channel streams.
 *
 * Two streams ride on this primitive:
 *   - The **replog stream** (long-lived `/replog` delta endpoint) loops
 *     between `Pulling` and `Idle` ticks forever, advancing a
 *     `(gen, counter)` watermark cursor.
 *   - The **bootstrap stream** (one-shot `/bootstrap` snapshot endpoint)
 *     walks `FetchingHead → Scanning → EmitTerminalNoop → None`,
 *     emitting one terminal `Noop` carrying the channel head watermark
 *     so the receiver can seed its puller without re-walking the
 *     partition.
 *
 * Why one primitive: both endpoints emit the same `PullFrame` wire
 * vocabulary, share the same byte-encoder tail, and are easier to keep
 * consistent (one place to add a frame field, one place to fix a leak)
 * when the only thing that differs is the tagged-state machine in the
 * paginate body. The encoder runs downstream of paginate so the loop
 * body deals only in typed frames.
 *
 * History: the previous `buildPullStream` recursive `Stream.concat`
 * accumulated one Effect-Scope finalizer per tick under a long-lived
 * HTTP request scope — observed as ~45 MB OOM after ~15 min on every
 * worker (memory `project_oom_investigation_2026_05_10`). The
 * paginate-based shape collapses the recursion into a single Suspend
 * node — no per-tick finalizer growth.
 */

import { Effect, Option, Stream } from "effect"
import {
  encodeFrame,
  type PullFrame,
} from "./ReplicationProtocol.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The `(gen, counter)` cursor pair used by both endpoints. */
export type Watermark = {
  readonly gen: number
  readonly counter: number
}

/**
 * Replog tick state. The state machine alternates between `Pulling`
 * (which may transition to `Idle` on a partial batch) and `Idle`
 * (which always transitions back to `Pulling`). Both states carry the
 * same cursor; the tag distinguishes "pull next" from "sleep first".
 */
export type ReplogTickState =
  | { readonly _tag: "Pulling"; readonly cursor: Watermark }
  | { readonly _tag: "Idle"; readonly cursor: Watermark }

/**
 * Bootstrap tick state. Three sequential phases:
 *   - `FetchingHead`: record the channel head watermark BEFORE scan so
 *     writes that race the scan window land at `(head.gen, head+N)` and
 *     the puller picks them up via the seeded watermark.
 *   - `Scanning`: walk the partition and emit one `Data` frame per
 *     entry.
 *   - `EmitTerminalNoop`: emit a single `Noop` frame at `head`, then
 *     terminate (`Option.none`).
 */
export type BootstrapTickState =
  | { readonly _tag: "FetchingHead" }
  | { readonly _tag: "Scanning"; readonly head: Watermark }
  | { readonly _tag: "EmitTerminalNoop"; readonly head: Watermark }

// ---------------------------------------------------------------------------
// Primitive
// ---------------------------------------------------------------------------

/**
 * The shared paginate-based stream builder. `step` returns
 * `[frames, Option.some(next)]` to continue or `[frames, Option.none]`
 * to terminate. The replog uses the former exclusively (infinite); the
 * bootstrap uses the latter on the terminal Noop tick.
 *
 * Surface intentionally thin: it's a typed alias over `Stream.paginate`
 * so call-sites read as a domain primitive ("build a channel stream")
 * rather than a raw stream constructor.
 */
export const buildChannelStream = <S, E, R>(
  initial: S,
  step: (
    s: S
  ) => Effect.Effect<
    readonly [ReadonlyArray<PullFrame>, Option.Option<S>],
    E,
    R
  >
): Stream.Stream<PullFrame, E, R> => Stream.paginate(initial, step)

// ---------------------------------------------------------------------------
// Encoder tail
// ---------------------------------------------------------------------------

/**
 * Encode a typed `PullFrame` stream into NDJSON bytes. `encodeFrame`
 * already terminates each line with `\n`, so `Stream.encodeText`'s
 * default UTF-8 encoding is the only byte-level work that remains.
 */
export const encodeFramesToBytes = <E, R>(
  frames: Stream.Stream<PullFrame, E, R>
): Stream.Stream<Uint8Array, E, R> =>
  frames.pipe(Stream.map(encodeFrame), Stream.encodeText)
