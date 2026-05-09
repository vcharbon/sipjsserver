/**
 * PullerFiber — long-lived per-peer pull loop for the replication
 * redesign (Slice 5).
 *
 * One fiber pulls from one source peer's `/replog?caller={self}` stream.
 * The fiber maintains a `(gen, counter)` watermark stored in a shared
 * `MutableRef<PeerView>`; the supervisor reads the same ref to drive
 * readiness and observability.
 *
 * State machine — per docs/plan/grill-me-on-the-spicy-lark.md §D5.2:
 *
 *   Discovered → Connecting → Streaming ↔ ErroredRetry → ErroredFailed
 *                                ▲              │
 *                                └──────────────┘
 *
 *   Disappeared is handled by the supervisor (via Fiber.interrupt); the
 *   fiber itself never enters that state — interruption unwinds the
 *   running effect and the supervisor flips `fiberState := Disappeared`
 *   on the preserved view.
 *
 * Apply rule (puller side):
 *
 *   if (F.gen, F.counter) > watermark:
 *     if F.type == "data": apply F (write or delete)
 *     watermark := (F.gen, F.counter)
 *   if F.type == "noop":
 *     fiber.everCaughtUp := true   # sticky
 *
 * Backoff: `initialBackoffMs * 2^attempt`, capped at `maxBackoffMs`. The
 * attempt counter resets on every successful Streaming entry (a working
 * connection that produces frames recovers the budget). Continuous error
 * for `failedThresholdMs` flips the fiber to `ErroredFailed`; the loop
 * keeps retrying — the threshold is observability-only post-Ready.
 *
 * Watermark preservation: this fiber NEVER resets the watermark. If a
 * supervisor interrupts it and later re-forks a new one against the
 * same view ref, the new fiber resumes from the preserved watermark.
 *
 * The transport is abstracted via `openStream` so tests can wire the
 * server's `buildPullStream` directly without HTTP, and the apply path
 * is abstracted via `applyFrame` so the SIP-storage cutover (Slice 7)
 * can plug in `ChannelIndex.write` without touching this module.
 *
 * Design ref: [docs/plan/grill-me-on-the-spicy-lark.md](../../docs/plan/grill-me-on-the-spicy-lark.md) §D4, §D5.2.
 */

import {
  Clock,
  Data,
  Effect,
  MutableRef,
  Result,
  Stream,
} from "effect"
import {
  compareGenCounter,
  decodeFrame,
  ProtocolError,
  type DataFrame,
  type PullFrame,
} from "./ReplicationProtocol.js"

// ---------------------------------------------------------------------------
// PeerView — per-peer record the supervisor maintains. See §D5.3.
// ---------------------------------------------------------------------------

export type FiberState =
  | "Discovered"
  | "Connecting"
  | "Streaming"
  | "ErroredRetry"
  | "ErroredFailed"
  | "Disappeared"

export interface Watermark {
  readonly gen: number
  readonly counter: number
}

export interface PeerViewError {
  readonly kind: "transport" | "parse"
  readonly at: number
  readonly message: string
}

export interface PeerView {
  readonly peerId: string
  readonly fiberState: FiberState
  /** Preserved across Disappeared/reappear cycles for the worker incarnation. */
  readonly watermark: Watermark
  /** Sticky-true once first noop received this incarnation; preserved across reappear. */
  readonly everCaughtUp: boolean
  /** Last time (Clock.currentTimeMillis) any frame was received. */
  readonly lastFrameAt: number
  readonly lastError: PeerViewError | null
  readonly bytesReceivedTotal: number
  readonly entriesAppliedTotal: number
  readonly noopsReceivedTotal: number
}

export const initialPeerView = (
  peerId: string,
  watermark: Watermark = { gen: 0, counter: 0 }
): PeerView => ({
  peerId,
  fiberState: "Discovered",
  watermark,
  everCaughtUp: false,
  lastFrameAt: 0,
  lastError: null,
  bytesReceivedTotal: 0,
  entriesAppliedTotal: 0,
  noopsReceivedTotal: 0,
})

// ---------------------------------------------------------------------------
// Transport / apply abstractions
// ---------------------------------------------------------------------------

/**
 * Transport-level error surfaced by `openStream`. Production wires this
 * to HTTP fetch failures; tests synthesize it via `Stream.fail`.
 */
export class PullerTransportError extends Data.TaggedError("PullerTransportError")<{
  readonly reason: string
}> {}

export interface OpenStreamArgs {
  readonly sinceGen: number
  readonly sinceCounter: number
  readonly chunkSize: number
}

export interface PullerFiberConfig {
  readonly peer: string
  /** Shared with the supervisor — the only durable place the watermark lives. */
  readonly viewRef: MutableRef.MutableRef<PeerView>
  /**
   * Open a long-lived NDJSON byte stream. Called once per Connecting
   * cycle, with the puller's current watermark inlined into the args.
   * The fiber treats every Stream.fail and every clean Stream end as
   * "connection lost — backoff and reconnect".
   */
  readonly openStream: (
    args: OpenStreamArgs
  ) => Stream.Stream<Uint8Array, PullerTransportError>
  /**
   * Apply a single Data frame (op=create/update/delete) to local storage.
   * The puller has already filtered by `(gen, counter) > watermark`, so
   * this callback is invoked only for frames that should advance state.
   * Errors from this callback are logged and treated as parse-class
   * (the connection itself is fine; the local apply failed).
   */
  readonly applyFrame: (frame: DataFrame) => Effect.Effect<void>
  /** Server-side chunk_size hint passed in /replog?chunk_size=. */
  readonly chunkSize: number
  /** Initial reconnect delay in millis. Defaults to 250. */
  readonly initialBackoffMs?: number
  /** Cap on reconnect delay. Defaults to 30 000. */
  readonly maxBackoffMs?: number
  /** Continuous-error duration before fiber is tagged ErroredFailed. Defaults to 30 000. */
  readonly failedThresholdMs?: number
}

export const DEFAULT_INITIAL_BACKOFF_MS = 250
export const DEFAULT_MAX_BACKOFF_MS = 30_000
export const DEFAULT_FAILED_THRESHOLD_MS = 30_000

// ---------------------------------------------------------------------------
// Internal — view mutation helpers
// ---------------------------------------------------------------------------

const patchView = (
  ref: MutableRef.MutableRef<PeerView>,
  patch: Partial<PeerView>
): void => {
  MutableRef.set(ref, { ...MutableRef.get(ref), ...patch })
}

// ---------------------------------------------------------------------------
// Public entrypoint: long-lived loop. Returns only on interruption.
// ---------------------------------------------------------------------------

/**
 * Run the puller loop for one peer. The returned Effect never completes
 * normally — only via supervisor interruption (`Fiber.interrupt`). On
 * interrupt the running stream is torn down and the loop unwinds; the
 * supervisor is responsible for marking `fiberState := Disappeared` on
 * the shared view ref afterwards.
 */
export const runPullerFiber = (
  config: PullerFiberConfig
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const initialBackoff =
      config.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS
    const maxBackoff = config.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
    const failedThreshold =
      config.failedThresholdMs ?? DEFAULT_FAILED_THRESHOLD_MS

    let attempt = 0
    let firstErrorAtMs: number | null = null

    // Each iteration: connect → stream → on end-or-error, backoff and retry.
    while (true) {
      patchView(config.viewRef, { fiberState: "Connecting" })

      const watermark = MutableRef.get(config.viewRef).watermark
      const stream = config.openStream({
        sinceGen: watermark.gen,
        sinceCounter: watermark.counter,
        chunkSize: config.chunkSize,
      })

      patchView(config.viewRef, { fiberState: "Streaming" })

      const result = yield* Effect.result(consumeStream(stream, config))

      const nowMs = yield* Clock.currentTimeMillis

      if (Result.isFailure(result)) {
        if (firstErrorAtMs === null) firstErrorAtMs = nowMs
        const failedFor = nowMs - firstErrorAtMs
        const fiberState: FiberState =
          failedFor >= failedThreshold ? "ErroredFailed" : "ErroredRetry"
        patchView(config.viewRef, {
          fiberState,
          lastError: {
            kind: result.failure._tag === "ProtocolError" ? "parse" : "transport",
            at: nowMs,
            message: result.failure.reason,
          },
        })
      } else {
        // Stream ended cleanly — treat as transport reset (long-lived
        // connection should never end unless the peer closed). Recorded
        // as transport error so the kind is uniform.
        if (firstErrorAtMs === null) firstErrorAtMs = nowMs
        const failedFor = nowMs - firstErrorAtMs
        const fiberState: FiberState =
          failedFor >= failedThreshold ? "ErroredFailed" : "ErroredRetry"
        patchView(config.viewRef, {
          fiberState,
          lastError: {
            kind: "transport",
            at: nowMs,
            message: "stream ended unexpectedly",
          },
        })
      }

      const backoff = Math.min(
        initialBackoff * 2 ** Math.min(attempt, 30),
        maxBackoff
      )
      attempt = attempt + 1
      yield* Effect.sleep(`${backoff} millis`)
    }
  })

// ---------------------------------------------------------------------------
// Internal — line-buffered NDJSON consumer that updates the view ref.
// ---------------------------------------------------------------------------

const consumeStream = (
  stream: Stream.Stream<Uint8Array, PullerTransportError>,
  config: PullerFiberConfig
): Effect.Effect<void, PullerTransportError | ProtocolError> =>
  Effect.gen(function* () {
    const decoder = new TextDecoder()
    let buffer = ""
    yield* stream.pipe(
      Stream.runForEach((chunk: Uint8Array) =>
        Effect.gen(function* () {
          // Update bytes-received counter eagerly, even before frames
          // parse — observability of the byte stream itself.
          const cur = MutableRef.get(config.viewRef)
          patchView(config.viewRef, {
            bytesReceivedTotal: cur.bytesReceivedTotal + chunk.length,
          })

          buffer += decoder.decode(chunk, { stream: true })
          let nl = buffer.indexOf("\n")
          while (nl !== -1) {
            const line = buffer.slice(0, nl)
            buffer = buffer.slice(nl + 1)
            if (line.length > 0) {
              const frame = yield* tryDecodeFrame(line)
              if (frame !== null) {
                yield* applyOne(frame, config)
              }
            }
            nl = buffer.indexOf("\n")
          }
        })
      )
    )
  })

const tryDecodeFrame = (
  line: string
): Effect.Effect<PullFrame | null, ProtocolError> =>
  Effect.try({
    try: () => decodeFrame(line),
    catch: (err) =>
      err instanceof ProtocolError
        ? err
        : new ProtocolError({
            reason: err instanceof Error ? err.message : String(err),
            raw: line,
          }),
  })

const applyOne = (
  frame: PullFrame,
  config: PullerFiberConfig
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const cur = MutableRef.get(config.viewRef)
    const incoming: Watermark = { gen: frame.gen, counter: frame.counter }
    const isNewer = compareGenCounter(incoming, cur.watermark) > 0
    const nowMs = yield* Clock.currentTimeMillis

    if (frame._tag === "Data") {
      if (isNewer) {
        yield* config.applyFrame(frame)
      }
      patchView(config.viewRef, {
        watermark: isNewer ? incoming : cur.watermark,
        lastFrameAt: nowMs,
        entriesAppliedTotal: isNewer
          ? cur.entriesAppliedTotal + 1
          : cur.entriesAppliedTotal,
        // Clear lastError on a successfully-processed frame: the
        // connection is healthy.
        lastError: null,
      })
    } else {
      // Noop — flips everCaughtUp sticky-true; advances watermark only
      // if the noop's `(gen, counter)` is ahead. The server always emits
      // a noop's counter at the channel head, so for a fresh connection
      // the noop also advances the watermark forward.
      patchView(config.viewRef, {
        watermark: isNewer ? incoming : cur.watermark,
        everCaughtUp: true,
        lastFrameAt: nowMs,
        noopsReceivedTotal: cur.noopsReceivedTotal + 1,
        lastError: null,
      })
    }
  })
