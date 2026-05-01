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

      // The call-body lookup uses the *primary* role — when the local
      // worker emits an entry to a backup peer, the call is owned
      // locally as "pri:{owner}:call:{ref}". We derive owner = our
      // EpochCounter's owner. (Reverse-propagate case — the local
      // worker is serving a request as backup and updates
      // "bak:{w_pri}:call:{ref}" so the original primary recovers it
      // on reboot — uses the same emit path with role/owner derived at
      // write time and a `direction: "reverse"` tag on the entry.
      // See docs/replication/call-cache-backup.md §0 for the invariant
      // this preserves; the backup never moves the call into its own
      // pri:. Slice 2.4 of the k8s-reliability rework adds the
      // direction field to the wire format; Slice 3 assumes
      // primary-side emission only.)
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
          callRef: string
        ): Effect.Effect<unknown | null, ReplLogStreamError> =>
          Effect.gen(function* () {
            const raw = yield* storage
              .getCall("pri", ownerOrdinal, callRef)
              .pipe(Effect.mapError(wrapStorageErr))
            if (raw === null) return null
            return yield* safeParse(raw)
          })

        const helloAndBacklog: Stream.Stream<ReplLogFrame, ReplLogStreamError> =
          Stream.unwrap(
            Effect.gen(function* () {
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
              const entryFrames = Stream.fromIterable(backlog).pipe(
                Stream.mapEffect((e) =>
                  fetchState(e.callRef).pipe(
                    Effect.map(
                      (state): ReplLogFrame => ({
                        type: "entry",
                        seq: e.seq,
                        callRef: e.callRef,
                        state,
                      })
                    )
                  )
                )
              )
              const caughtUp: ReplLogFrame = {
                type: "caught_up",
                at_seq: head,
              }
              return Stream.concat(
                Stream.make(helloFrame),
                Stream.concat(entryFrames, Stream.make(caughtUp))
              )
            })
          )

        // Long-poll phase: filtered notifications + heartbeat schedule,
        // both terminated when max-open elapses.
        const notifications: Stream.Stream<ReplLogFrame, ReplLogStreamError> =
          notifier.subscribe.pipe(
            Stream.filter((n) => n.peer === caller),
            Stream.mapEffect((n) =>
              fetchState(n.callRef).pipe(
                Effect.map(
                  (state): ReplLogFrame => ({
                    type: "entry",
                    seq: n.seq,
                    callRef: n.callRef,
                    state,
                  })
                )
              )
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
