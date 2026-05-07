/**
 * ReplLog — long-poll HTTP endpoint that streams `propagate:{caller}`
 * entries to a peer. Slice 3 deliverable.
 *
 *   GET /replog?caller={N}&epoch={callerEpoch}&since={lastSeq}
 *
 * Wire format: NDJSON (one JSON object per line). See spec §7.2:
 *
 *   {"type":"hello","epoch":42,"head_at_open":12345}
 *   {"type":"entry","seq":12346,"callRef":"abc","state":<json>|null}
 *   ...
 *   {"type":"caught_up","at_seq":12345}
 *   {"type":"heartbeat","seq":12347}        <── every 10 s when idle
 *   {"type":"entry","seq":12348,"callRef":"ghi","state":<json>}
 *
 * Stream lifetime: opens with the `hello` frame, drains backlog above
 * `since`, emits `caught_up` once the backlog reaches `head_at_open`,
 * then long-polls (heartbeat + freshly-published entries) until either
 * the configurable max-open duration elapses or the connection closes.
 *
 * Notification mechanism: subscribes to `WriteNotifier` (in-process
 * sliding PubSub) — every successful peer-bearing write on this worker
 * publishes there. We filter to `peer === caller`. Re-fetches the call
 * body via `PartitionedRelayStorage.getCall` when emitting an entry so
 * the streamed `state` always reflects the current sidecar state at
 * emit time (compaction of multiple writes to the same callRef
 * collapses to a single emission with the latest state — same property
 * the in-Lua ZADD gives the propagate set itself).
 */

import {
  Clock,
  Duration,
  Effect,
  Layer,
  Schedule,
  ServiceMap,
  Stream,
} from "effect"
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import {
  PartitionedRelayStorage,
  type StorageError,
} from "../cache/PartitionedRelayStorage.js"
import type { PropagateDirection } from "./AtomicWriter.js"
import { EpochCounter } from "./EpochCounter.js"
import {
  PropagateStream,
  type PropagateStreamError,
} from "./PropagateStream.js"
import { WriteNotifier } from "./WriteNotifier.js"

// ---------------------------------------------------------------------------
// Frame types (spec §7.2)
// ---------------------------------------------------------------------------

export type ReplLogFrame =
  | { readonly type: "hello"; readonly epoch: number; readonly head_at_open: number }
  | {
      readonly type: "entry"
      readonly seq: number
      readonly callRef: string
      readonly state: unknown | null
      /**
       * Slice 2.4 propagate-direction tag. `forward` = emitter was the
       * call's primary writing to a backup peer (caller); `reverse` =
       * emitter was acting as backup-on-behalf-of caller (the original
       * primary), so the consumer should apply to `pri:{self}:` rather
       * than `bak:{emitter}:`. Default forward for backward compat with
       * any drained-but-not-yet-rewritten producer state.
       */
      readonly direction: PropagateDirection
      /**
       * Wall-clock millis at the moment the server emitted this frame
       * (Slice A — replication observability). Optional on the wire so a
       * peer running an older build silently ignores the field; the
       * receiver records `now() - tx_ms` into a histogram only when set.
       */
      readonly tx_ms?: number
    }
  | { readonly type: "caught_up"; readonly at_seq: number }
  | { readonly type: "heartbeat"; readonly seq: number }

const encodeFrame = (f: ReplLogFrame): string => `${JSON.stringify(f)}\n`

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ReplLogConfig {
  /** How often to emit heartbeat frames when idle. Default 10s (spec §7.2). */
  readonly heartbeatInterval?: Duration.Input
  /** Hard cap on a single connection's lifetime. Default 25s (spec §7.2). */
  readonly maxOpenDuration?: Duration.Input
  /**
   * If set, the stream emits `hello` + backlog + `caught_up` and then
   * ends — no long-poll, no heartbeats, no max-open timer. This is the
   * mode the Slice 5 `ReadyGate` uses to drain a peer's `propagate:N`
   * up to `head_at_open` during the boot handshake. Tests also use it
   * to make the framing assertions deterministic without juggling the
   * TestClock.
   */
  readonly drainOnly?: boolean
}

export const REPLLOG_DEFAULT_HEARTBEAT_MS = 10_000
export const REPLLOG_DEFAULT_MAX_OPEN_MS = 25_000

export interface ReplLogApi {
  /**
   * Build the NDJSON byte stream for a `/replog` call. Composes:
   *   - a leading `hello` frame,
   *   - the backlog drain above `sinceSeq`,
   *   - a `caught_up` frame at `head_at_open`,
   *   - then a long-poll of fresh notifications interleaved with
   *     heartbeats until max-open elapses.
   */
  readonly stream: (
    caller: string,
    sinceSeq: number,
    config?: ReplLogConfig
  ) => Stream.Stream<Uint8Array, ReplLogStreamError>
}

export class ReplLogStreamError extends Error {
  readonly _tag = "ReplLogStreamError"
  constructor(public reason: string) {
    super(reason)
  }
}

const wrapPropErr = (e: PropagateStreamError): ReplLogStreamError =>
  new ReplLogStreamError(e.reason)

const wrapStorageErr = (e: StorageError): ReplLogStreamError =>
  new ReplLogStreamError(e.reason)

export class ReplLog extends ServiceMap.Service<ReplLog, ReplLogApi>()(
  "@sipjsserver/replication/ReplLog"
) {
  /**
   * Standard layer requiring the read-side dependencies plus the
   * notification hub. Designed to be composed with whatever owner
   * ordinal the worker uses; the stream API takes the caller-specific
   * peer at call time.
   */
  static readonly layer: Layer.Layer<
    ReplLog,
    never,
    PropagateStream | PartitionedRelayStorage | WriteNotifier | EpochCounter
  > = Layer.effect(
    ReplLog,
    Effect.gen(function* () {
      const propagate = yield* PropagateStream
      const storage = yield* PartitionedRelayStorage
      const notifier = yield* WriteNotifier
      const counter = yield* EpochCounter

      // Slice 2.4 direction-aware body lookup. Forward entries: the
      // emitter is the call's primary, body lives at
      // `pri:{ownerOrdinal}:call:{ref}` locally. Reverse entries: the
      // emitter is acting as backup-on-behalf-of `caller` (the
      // original primary, currently down or recovering), so the body
      // lives at `bak:{caller}:call:{ref}` locally. The consumer
      // (caller's ReplPuller) routes the apply to `pri:{caller}:` —
      // i.e. its own pri partition — when it sees `direction:
      // "reverse"` on the wire. The backup never moves the call into
      // its own `pri:` (single-owner invariant, spec §0).
      const ownerOrdinal = counter.owner

      const stream = (
        caller: string,
        sinceSeq: number,
        config?: ReplLogConfig
      ): Stream.Stream<Uint8Array, ReplLogStreamError> => {
        const heartbeatMs = Duration.toMillis(
          Duration.fromInputUnsafe(config?.heartbeatInterval ?? "10 seconds")
        )
        const maxOpenMs = Duration.toMillis(
          Duration.fromInputUnsafe(config?.maxOpenDuration ?? "25 seconds")
        )

        // Lenient JSON parse: malformed bodies (tombstone-shape, etc.)
        // surface as `null` so the consumer treats them as "deleted,
        // clean your bak: copy". Slice 5 will widen this to recognise
        // the explicit tombstone JSON shape.
        const safeParse = (raw: string): Effect.Effect<unknown | null> =>
          Effect.try({
            try: () => JSON.parse(raw) as unknown,
            catch: () => "parse-failed",
          }).pipe(Effect.orElseSucceed(() => null))

        const fetchState = (
          callRef: string,
          direction: PropagateDirection
        ): Effect.Effect<unknown | null, ReplLogStreamError> =>
          Effect.gen(function* () {
            // Forward emission ⇒ local worker is primary, body lives in
            // pri:{ownerOrdinal}. Reverse emission ⇒ local worker is
            // acting as backup for `caller` (the original primary) and
            // the up-to-date body lives in bak:{caller}.
            const role = direction === "forward" ? "pri" : "bak"
            const owner = direction === "forward" ? ownerOrdinal : caller
            const raw = yield* storage
              .getCall(role, owner, callRef)
              .pipe(Effect.mapError(wrapStorageErr))
            if (raw === null) return null
            return yield* safeParse(raw)
          })

        const helloAndBacklog: Stream.Stream<ReplLogFrame, ReplLogStreamError> =
          Stream.unwrap(
            Effect.gen(function* () {
              yield* Effect.logDebug("repl: server-open", {
                caller,
                since_seq: sinceSeq,
              })
              const epoch = yield* counter.current.pipe(
                Effect.mapError((e) => new ReplLogStreamError(e.reason))
              )
              const head = yield* propagate
                .head(caller)
                .pipe(Effect.mapError(wrapPropErr))
              const backlog = yield* propagate
                .read(caller, sinceSeq)
                .pipe(Effect.mapError(wrapPropErr))

              const helloFrame: ReplLogFrame = {
                type: "hello",
                epoch,
                head_at_open: head,
              }
              yield* Effect.logInfo("repl: server-hello", {
                caller,
                epoch,
                head_at_open: head,
                since_seq: sinceSeq,
              })
              const entryFrames = Stream.fromIterable(backlog).pipe(
                Stream.mapEffect((e) =>
                  Effect.gen(function* () {
                    const state = yield* fetchState(e.callRef, e.direction)
                    const txMs = yield* Clock.currentTimeMillis
                    return {
                      type: "entry",
                      seq: e.seq,
                      callRef: e.callRef,
                      state,
                      direction: e.direction,
                      tx_ms: txMs,
                    } satisfies ReplLogFrame
                  })
                )
              )
              const caughtUp: ReplLogFrame = {
                type: "caught_up",
                at_seq: head,
              }
              const caughtUpTap = Stream.fromEffect(
                Effect.logInfo("repl: server-caught-up", {
                  caller,
                  at_seq: head,
                }).pipe(Effect.as(caughtUp))
              )
              return Stream.concat(
                Stream.make(helloFrame),
                Stream.concat(entryFrames, caughtUpTap)
              )
            })
          )

        // Long-poll phase: filtered notifications + heartbeat schedule,
        // both terminated when max-open elapses.
        const notifications: Stream.Stream<ReplLogFrame, ReplLogStreamError> =
          notifier.subscribe.pipe(
            Stream.filter((n) => n.peer === caller),
            Stream.mapEffect((n) =>
              Effect.gen(function* () {
                const state = yield* fetchState(n.callRef, n.direction)
                const txMs = yield* Clock.currentTimeMillis
                return {
                  type: "entry",
                  seq: n.seq,
                  callRef: n.callRef,
                  state,
                  direction: n.direction,
                  tx_ms: txMs,
                } satisfies ReplLogFrame
              })
            )
          )

        const heartbeats: Stream.Stream<ReplLogFrame, ReplLogStreamError> =
          Stream.fromSchedule(
            Schedule.spaced(Duration.millis(heartbeatMs))
          ).pipe(
            // Carry the most-recently-witnessed seq for diagnostics.
            // For Slice 3 we surface 0 as a placeholder; consumers
            // ignore the seq on heartbeats anyway.
            Stream.map((): ReplLogFrame => ({ type: "heartbeat", seq: 0 }))
          )

        const longPoll: Stream.Stream<ReplLogFrame, ReplLogStreamError> =
          Stream.merge(notifications, heartbeats)

        const closedLog =
          config?.drainOnly === true
            ? Effect.logDebug("repl: server-close", {
                caller,
                reason: "drain_complete",
              })
            : Effect.logInfo("repl: server-close", {
                caller,
                reason: "max_open_or_disconnect",
              })

        const framed: Stream.Stream<ReplLogFrame, ReplLogStreamError> =
          config?.drainOnly === true
            ? helloAndBacklog
            : Stream.concat(helloAndBacklog, longPoll).pipe(
                // Hard close after maxOpen — clients are expected to
                // reconnect with `since=lastSeq`. `haltWhen` ends the
                // stream gracefully so any in-flight emission is
                // delivered before the stream terminates.
                Stream.haltWhen(Effect.sleep(Duration.millis(maxOpenMs)))
              )

        return framed.pipe(
          Stream.ensuring(closedLog),
          Stream.map(encodeFrame),
          Stream.encodeText
        )
      }

      return { stream }
    })
  )
}

// ---------------------------------------------------------------------------
// HTTP route registration
// ---------------------------------------------------------------------------

/**
 * Register `GET /replog` on the supplied router. Query params:
 *   caller={ordinal}    — required; the calling worker's ordinal.
 *   epoch={number}      — optional; passed back in the hello frame for
 *                         epoch-mismatch detection on the consumer side.
 *   since={number}      — optional; default 0. Server emits all entries
 *                         in `propagate:{caller}` with seq > since.
 *   drainOnly={1|true}  — optional; when set, server emits hello + backlog
 *                         + caught_up and ends the stream (no long-poll,
 *                         no heartbeats). Used by the ReadyGate boot
 *                         handshake (spec §8) — the gate just needs to
 *                         drain up to head_at_open and move on.
 */
export const addReplLogRoutes = (
  router: HttpRouter.HttpRouter,
  config?: ReplLogConfig
): Effect.Effect<void, never, ReplLog> =>
  Effect.gen(function* () {
    const replLog = yield* ReplLog
    yield* router.add(
      "GET",
      "/replog",
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(req.url, "http://localhost")
        const caller = url.searchParams.get("caller")
        if (caller === null || caller.length === 0) {
          return HttpServerResponse.jsonUnsafe(
            { error: "missing required query param: caller" },
            { status: 400 }
          )
        }
        const sinceParam = url.searchParams.get("since")
        const sinceSeq =
          sinceParam !== null ? Number(sinceParam) : 0
        if (!Number.isFinite(sinceSeq) || sinceSeq < 0) {
          return HttpServerResponse.jsonUnsafe(
            { error: "invalid since param" },
            { status: 400 }
          )
        }
        const drainOnlyParam = url.searchParams.get("drainOnly")
        const drainOnly =
          drainOnlyParam !== null &&
          (drainOnlyParam === "1" ||
            drainOnlyParam.toLowerCase() === "true")
        // Per-request drainOnly flag overlays onto layer-level config.
        const perRequestConfig: ReplLogConfig = {
          ...(config ?? {}),
          ...(drainOnly ? { drainOnly: true } : {}),
        }
        const body = replLog.stream(caller, sinceSeq, perRequestConfig)
        return HttpServerResponse.stream(body, {
          contentType: "application/x-ndjson",
          headers: { "cache-control": "no-store" },
        })
      })
    )
  })
