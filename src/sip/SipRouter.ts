/**
 * SipRouter — unified SIP message processing pipeline.
 *
 * Owns:
 * - Call resolution (callRef+leg from Contact URI params, Via cr/lg params, or callId+fromTag fallback)
 * - `withCall` wrapper: resolve -> checkout -> tracing span -> handler -> processResult -> release
 * - Persist-before-send of handler results + side effect execution in fixed order
 *
 * Consumes TransactionEvent stream + timer events, delegates to handlers.
 * Outbound messages arrive already fully formed — the stack generators build
 * them at call-site time with real Via/Contact specs.
 */

import { Clock, Duration, Effect, Layer, ServiceMap, Stream, Tracer } from "effect"
import type { RemoteInfo, SipRequest, SipResponse, B2BUAMessage } from "./types.js"
import { TransactionLayer } from "./TransactionLayer.js"
import { UdpTransport } from "./UdpTransport.js"
import { serialize, messageSummary } from "./Serializer.js"
import {
  extractNameAddrUri,
  getHeader,
  isEmergencyRequest,
  newTag,
} from "./MessageHelpers.js"
import { generateResponse } from "./generators.js"
import { AppConfig, type AppConfigData } from "../config/AppConfig.js"
import { CallState } from "../call/CallState.js"
import { CallDecisionEngine } from "../decision/CallDecisionEngine.js"
import type { CallReferRequest as CallReferRequestType } from "../decision/schemas/requests.js"
import { CallLimiter } from "../call/CallLimiter.js"
import { TimerService } from "../call/TimerService.js"
import { CdrWriter } from "../cdr/CdrWriter.js"
import { TracingService } from "../tracing/TracingService.js"
import { MetricsRegistry } from "../observability/MetricsRegistry.js"
import { DrainingState } from "../b2bua/DrainingState.js"
import { WorkerReadiness } from "../cache/WorkerReadiness.js"
import { RedisError } from "../redis/RedisClient.js"
import {
  type Call,
  type CallTopology,
  type Leg,
  type Dialog,
  type TimerEntry,
  type TimerType,
  deriveCallRef,
} from "../call/CallModel.js"
import { parseStickinessCookie } from "../cache/StickinessCookie.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Unified event type consumed by withCall. */
export type CallEvent =
  | { readonly type: "sip"; readonly message: B2BUAMessage; readonly rinfo: RemoteInfo }
  | { readonly type: "timer"; readonly timerType: TimerType; readonly callRef: string; readonly legId: string | undefined }
  | { readonly type: "cancelled"; readonly callId: string; readonly fromTag: string }
  | {
      readonly type: "timeout"
      readonly branch: string
      readonly callRef: string | undefined
      readonly legId: string | undefined
      /** SIP method of the transaction that timed out. Used by rules to discriminate
       *  INVITE timeouts (failover path) from non-INVITE timeouts (BYE/OPTIONS/PRACK). */
      readonly method: string | undefined
    }
  | {
      /**
       * Synthetic in-process event carrying the result of an async side-effect
       * (e.g. /call/refer HTTP response). Re-enters the rule chain on an
       * explicit callRef so that response-handling rules can match the outcome
       * without a dedicated top-level dispatcher.
       */
      readonly type: "internal-event"
      readonly callRef: string
      /** Event family — rules match on this via InternalEventMatch.topic. */
      readonly topic: string
      /** Coarse result classification — e.g. "allow" / "reject" / "error". */
      readonly outcome: string
      /** Full payload for the consuming rule to interpret. */
      readonly payload: unknown
    }

/** Human-readable summary of a CallEvent for logging. */
export function describeEvent(event: CallEvent): string {
  switch (event.type) {
    case "sip": {
      const msg = event.message
      return msg.type === "request"
        ? `sip:${msg.method}`
        : `sip:${msg.status}`
    }
    case "timer":
      return `timer:${event.timerType}${event.legId ? ` leg=${event.legId}` : ""}`
    case "cancelled":
      return `cancelled`
    case "timeout":
      return `timeout${event.legId ? ` leg=${event.legId}` : ""}`
    case "internal-event":
      return `internal:${event.topic}/${event.outcome}`
  }
}

/**
 * Verbose discriminator for event-handler timeout logs. Includes every
 * piece of routing info we have on the event so the first hit (which
 * the operator will see exactly once before metrics fire) identifies
 * the offending class without needing a heap snapshot.
 */
export function describeEventDetail(event: CallEvent): string {
  switch (event.type) {
    case "sip": {
      const msg = event.message
      const callId = msg.getHeader("call-id")
      if (msg.type === "request") {
        return `event=sip method=${msg.method} call-id=${callId} from=${event.rinfo.address}:${event.rinfo.port}`
      }
      return `event=sip status=${msg.status} call-id=${callId} from=${event.rinfo.address}:${event.rinfo.port}`
    }
    case "timer":
      return `event=timer type=${event.timerType} callRef=${event.callRef}${event.legId ? ` leg=${event.legId}` : ""}`
    case "cancelled":
      return `event=cancelled call-id=${event.callId} fromTag=${event.fromTag}`
    case "timeout":
      return `event=timeout callRef=${event.callRef} method=${event.method}${event.legId ? ` leg=${event.legId}` : ""} branch=${event.branch}`
    case "internal-event":
      return `event=internal topic=${event.topic} outcome=${event.outcome} callRef=${event.callRef}`
  }
}

/** Context passed to handlers after resolution. */
export interface ResolvedContext {
  readonly call: Call
  readonly callRef: string
  readonly leg: Leg
  readonly dialog: Dialog | undefined
  readonly direction: "from-a" | "from-b"
  readonly event: CallEvent
  readonly config: AppConfigData
  readonly callControl: CallDecisionEngine["Service"]
  readonly limiter: CallLimiter["Service"]
  /** Wall-clock-equivalent timestamp captured at message receive time. Sourced from
   *  Effect's Clock so it advances under TestClock in tests. Use this for any
   *  timestamping or timer fireAt computation in handlers — never `Date.now()`. */
  readonly nowMs: number
}

/** Outbound message envelope returned by handlers. */
export interface OutboundEnvelope {
  readonly message: SipRequest | SipResponse
  readonly destination: { readonly host: string; readonly port: number }
  readonly label: string
  /** Target leg for Via/Contact stamping. When set, bypasses label-based heuristic. */
  readonly legId?: string
}

/** Side effects returned by handlers. */
export type SideEffect =
  | { readonly type: "schedule-timer"; readonly timer: TimerEntry }
  | { readonly type: "cancel-timer"; readonly id: string }
  | { readonly type: "cancel-all-timers" }
  | { readonly type: "decrement-limiter"; readonly limiterId: string; readonly window: number }
  | { readonly type: "write-cdr" }
  | { readonly type: "remove-call" }
  | { readonly type: "flush-redis" }
  /**
   * Fork /call/refer, then re-enter withCall with an internal-event carrying
   * the HTTP outcome. State is persisted before effects run, so the resulting
   * internal-event sees the up-to-date transfer state.
   */
  | { readonly type: "refer-async-http"; readonly callRef: string; readonly request: CallReferRequestType }

/** Result returned by handlers — pure data, no side effects. */
export interface HandlerResult {
  readonly call: Call
  readonly outbound: ReadonlyArray<OutboundEnvelope>
  readonly effects: ReadonlyArray<SideEffect>
  /** Optional span events emitted on the current processing span (e.g. route_decision). */
  readonly spanEvents?: ReadonlyArray<{ readonly name: string; readonly attributes?: Record<string, unknown> }>
}

/** Handler function signature. */
export type Handler = (ctx: ResolvedContext) => Effect.Effect<HandlerResult, never, never>

/** Handler registry — maps event types to handler functions. */
export interface HandlerRegistry {
  readonly initialInvite: Handler
  readonly inDialog: Handler
}

// ---------------------------------------------------------------------------
// Resolution logic
// ---------------------------------------------------------------------------

/** Decode a URL-encoded Via/Contact param value. */
function decodeParam(value: string): string {
  return decodeURIComponent(value)
}

interface ResolvedKey {
  readonly callRef: string
  readonly leg: string
}

/** Resolve callRef+leg from an inbound SIP request (Contact URI params in Request-URI). */
function resolveFromRequest(req: SipRequest): ResolvedKey | undefined {
  const uriParams = req.requestUri.params
  if (uriParams.callref && uriParams.leg) {
    return { callRef: decodeParam(uriParams.callref), leg: decodeParam(uriParams.leg) }
  }
  return undefined
}

/** Resolve callRef+leg from an inbound SIP response (cr/lg in top Via). */
function resolveFromResponse(resp: SipResponse): ResolvedKey | undefined {
  const viaParams = resp.getHeader("via")[0].params
  const cr = typeof viaParams.cr === "string" ? viaParams.cr : undefined
  const lg = typeof viaParams.lg === "string" ? viaParams.lg : undefined
  if (cr && lg) {
    return { callRef: decodeParam(cr), leg: decodeParam(lg) }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Determine which leg a message belongs to
// ---------------------------------------------------------------------------

function findLegAndDialog(call: Call, resolvedLeg: string): { leg: Leg; dialog: Dialog | undefined; direction: "from-a" | "from-b" } {
  if (resolvedLeg === "a") {
    return { leg: call.aLeg, dialog: call.aLeg.dialogs[0], direction: "from-a" }
  }
  const bLeg = call.bLegs.find((l) => l.legId === resolvedLeg)
  if (bLeg) {
    return { leg: bLeg, dialog: bLeg.dialogs[0], direction: "from-b" }
  }
  // Fallback: check by legId prefix
  return { leg: call.aLeg, dialog: call.aLeg.dialogs[0], direction: "from-a" }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SipRouter extends ServiceMap.Service<
  SipRouter,
  {
    readonly start: (handlers: HandlerRegistry) => Effect.Effect<never>
    /**
     * Rehydrate calls owned by this worker from the local `pri:{self}:`
     * partition into the in-memory `callsMap` and respawn timer fibers
     * for every persisted `TimerEntry`.
     *
     * Called once at boot, after ReadyGate has drained peers'
     * reverse-propagate streams. Restored timers reuse the same
     * `timerHandler` closure SipRouter uses at runtime, so a fired
     * timer (OPTIONS keepalive, no-answer, limiter-refresh, etc.)
     * re-enters `withCall` exactly as if it had been scheduled in this
     * boot. Timers whose `fireAt` is already in the past fire
     * immediately on respawn (warning logged inside
     * `TimerService.restoreFromEntries`).
     */
    readonly rehydrateOwnedCalls: (
      handlers: HandlerRegistry
    ) => Effect.Effect<void, RedisError>
  }
>()("@sipjsserver/SipRouter") {
  static readonly layer = Layer.effect(
    SipRouter,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const txnLayer = yield* TransactionLayer
      const transport = yield* UdpTransport
      const callState = yield* CallState
      const callControl = yield* CallDecisionEngine
      const limiter = yield* CallLimiter
      const timers = yield* TimerService
      const cdr = yield* CdrWriter
      const tracing = yield* TracingService
      const draining = yield* DrainingState
      const readiness = yield* WorkerReadiness
      const registry = yield* MetricsRegistry

      // Slice 1.4 + event-handler safety: counters surfaced via
      // MetricsRegistry. `eventHandlerTimeoutTotal` flips on first hit
      // and identifies (via the accompanying log line) the event class
      // that hung; `forcePurgeTotal` counts safety-timer rescue
      // operations driven from `timerHandler` below. Both should stay
      // at zero in a healthy run.
      let eventHandlerTimeoutTotal = 0
      let forcePurgeTotal = 0
      // Counts Timer B/F firings whose owning call has already vanished.
      // After TransactionLayer.cancelTxnsForCall is wired into every
      // call-eviction path, this should be unreachable; a non-zero
      // count points to an eviction path that bypassed the cancel —
      // alert-worthy.
      let zombieTimeoutTotal = 0
      // `b2bua_stale_response_dropped_total{method, status}` — keyed
      // by the bucket label `${method}|${status}`. Incremented when
      // an inbound response resolves to a missing call (either via
      // top-Via cr/lg pointing at a vanished callRef, or via
      // resolveFromSipKey miss). The SipRouter already drops these
      // silently; the counter surfaces visibility.
      const staleResponseDroppedTotal: Record<string, number> = {}
      const bumpStaleResponse = (method: string, status: number): void => {
        const key = `${method}|${status}`
        staleResponseDroppedTotal[key] = (staleResponseDroppedTotal[key] ?? 0) + 1
      }
      registry.sipRouter = {
        eventHandlerTimeoutTotal: () => eventHandlerTimeoutTotal,
        forcePurgeTotal: () => forcePurgeTotal,
        staleResponseDroppedTotal: () => ({ ...staleResponseDroppedTotal }),
        zombieTimeoutTotal: () => zombieTimeoutTotal,
      }
      // Bind background forks to the layer's scope so they die when
      // the worker scope closes. Required for the simulated cluster's
      // `kill`/respawn cycle in failover tests — `forkDetach` would
      // leave the fork running against a torn-down worker.
      const layerScope = yield* Effect.scope

      // ── Timer handler that feeds back into withCall ──────────────────

      const timerHandler = (
        handlers: HandlerRegistry,
        callRef: string,
        timerType: TimerType,
        legId: string | undefined
      ): Effect.Effect<void> => {
        const event: CallEvent = { type: "timer" as const, timerType, callRef, legId }
        return Effect.gen(function* () {
          const call = yield* callState.peek(callRef)
          const baseBody = withCall(handlers, event)
          const tracedBody =
            call?.sampled === true && call.traceId !== undefined && call.rootSpanId !== undefined
              ? baseBody.pipe(
                  Effect.withSpan("timer.fire", {
                    parent: Tracer.externalSpan({
                      traceId: call.traceId,
                      spanId: call.rootSpanId,
                      sampled: true,
                    }),
                    attributes: {
                      "sip.call_ref": callRef,
                      "sip.timer_type": timerType,
                      ...(legId !== undefined ? { "sip.leg_id": legId } : {}),
                    },
                  }),
                )
              : baseBody

          // Slice 1.4 — safety-net force-purge. The
          // `terminating_timeout` timer is the call's last-resort
          // cleanup path. If its handler errors (e.g. a downstream
          // schema/encode failure surfaced as a defect via orDie) or
          // hangs past the per-event budget, the rule chain's
          // `terminate-leg` actions never run and the call drifts in
          // `terminating` until the 60-s orphan sweep notices.
          // Force-purge here drives the same recovery the orphan
          // sweep would have done, on demand.
          //
          // For other timer types we just log and move on — keepalive
          // hangs do not justify discarding the call's state, and the
          // orphan sweep / next safety timer will catch anything truly
          // stuck.
          const guarded = tracedBody.pipe(
            Effect.timeout(Duration.millis(config.eventHandlerTimeoutMs)),
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logError(
                  `Timer handler ${timerType} for call ${callRef}` +
                    `${legId ? ` leg=${legId}` : ""} failed or timed out`,
                  cause,
                )
                if (timerType === "terminating_timeout") {
                  forcePurgeTotal++
                  yield* callState.forcePurge(callRef, "safety_timer_failure")
                }
              }),
            ),
          )
          yield* guarded
        })
      }

      // ── processResult: execute handler output in fixed order ────────

      const processResult = Effect.fnUntraced(
        function* (callRef: string, result: HandlerResult, handlers: HandlerRegistry, nowMs: number) {
          // Persist updated call state BEFORE sending any messages — upholds
          // the "state updates before sending" invariant. Via/Contact stamping
          // and INVITE/ACK branch capture now happen at generator call-sites
          // in handlers, so no pre-send mutation is needed here.
          yield* callState.update(callRef, () => result.call)

          // Send outbound messages (pure output, no state mutation).
          for (const env of result.outbound) {
            const msg = env.message
            const isRequest = msg.type === "request"

            yield* Effect.logDebug(`SIP OUT -> ${env.destination.host}:${env.destination.port} [${env.label}] ${messageSummary(msg)}`)
            yield* Effect.logDebug(serialize(msg).toString('utf-8'))

            // Emit send span for tracing
            if (result.call.sampled === true) {
              const sendName = msg.type === "request"
                ? `sip.send.${msg.method}`
                : `sip.send.${msg.status}`
              const sendAttrs: Record<string, unknown> = {
                "sip.call_ref": callRef,
                "net.peer.addr": `${env.destination.host}:${env.destination.port}`,
                "sip.raw_message": tracing.scrubMessage(serialize(msg).toString("utf-8")),
              }
              if (msg.type === "request") {
                sendAttrs["sip.method"] = msg.method
              } else {
                sendAttrs["sip.status_code"] = msg.status
              }
              yield* tracing.emitSendSpan({ call: result.call, name: sendName, attributes: sendAttrs })
            }

            // ACK for 2xx is a one-shot — no transaction management (RFC 3261 §17.1.1.2).
            // CANCEL is fire-and-forget: it reuses the INVITE's Via branch (RFC 3261 §9.1),
            // and creating a CANCEL client transaction would overwrite the INVITE client
            // transaction in the branch-keyed txn map. Retransmission is unnecessary —
            // the peer's INVITE server transaction (or our no-answer timer) will time out
            // if the CANCEL is lost. The 200 OK / 487 responses are routed by CSeq method
            // in TransactionLayer.handleInboundResponse.
            if (isRequest && (msg.method === "ACK" || msg.method === "CANCEL")) {
              yield* txnLayer.sendRaw(serialize(msg), env.destination.port, env.destination.host)
            } else {
              const txnType = isRequest
                ? (msg.method === "INVITE" ? "invite" as const : "non-invite" as const)
                : "response" as const
              yield* txnLayer.send(msg, env.destination, txnType)
            }
          }

          // 3-7. Execute side effects in fixed order
          for (const effect of result.effects) {
            switch (effect.type) {
              case "schedule-timer": {
                const handler = (cr: string, tt: TimerType, lid: string | undefined) =>
                  timerHandler(handlers, cr, tt, lid)
                yield* timers.schedule(callRef, effect.timer, handler)
                break
              }
              case "cancel-timer":
                yield* timers.cancel(effect.id)
                break
              case "cancel-all-timers":
                yield* timers.cancelAll(callRef)
                break
              case "decrement-limiter":
                yield* limiter.decrement(effect.limiterId, effect.window).pipe(
                  Effect.catchTag("RedisError", (e) =>
                    Effect.logError(`Failed to decrement limiter ${effect.limiterId}: ${e.reason}`)
                  )
                )
                break
              case "write-cdr":
                yield* cdr.write(result.call).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logError(`Failed to write CDR for ${callRef}`, cause)
                  )
                )
                break
              case "flush-redis":
                yield* callState.flushToRedis(callRef).pipe(
                  Effect.catchTag("RedisError", (e) =>
                    Effect.logError(`Failed to flush ${callRef} to Redis: ${e.reason}`)
                  )
                )
                break
              case "remove-call":
                // Emit tombstone for non-sampled calls at teardown
                if (result.call.sampled !== true && result.call.traceId !== undefined) {
                  yield* tracing.emitTombstone({
                    call: result.call,
                    durationMs: nowMs - result.call.createdAt,
                    finalStatus: result.call.state,
                  })
                }
                yield* callState.remove(callRef).pipe(
                  Effect.catchTag("RedisError", (e) =>
                    Effect.logError(`Failed to remove ${callRef}: ${e.reason}`)
                  )
                )
                break
              case "refer-async-http": {
                // Fork /call/refer, then re-enter withCall with an internal-event
                // carrying the HTTP outcome. State was already persisted above,
                // so the consuming rule sees the up-to-date transfer state when
                // the result arrives.
                const referReq = effect.request
                const asyncCallRef = effect.callRef
                yield* Effect.forkIn(
                  Effect.gen(function* () {
                    const resp = yield* callControl.callRefer(referReq).pipe(
                      Effect.map((r) => ({ ok: true as const, resp: r })),
                      Effect.catchTag("CallDecisionError", (e) =>
                        Effect.succeed({ ok: false as const, reason: e.detail })
                      )
                    )
                    const outcome = resp.ok ? resp.resp.action : "error"
                    const payload = resp.ok ? resp.resp : { error: resp.reason }
                    const internalEvent: CallEvent = {
                      type: "internal-event",
                      callRef: asyncCallRef,
                      topic: "refer-http-result",
                      outcome,
                      payload,
                    }
                    yield* withCall(handlers, internalEvent)
                  }),
                  layerScope,
                )
                break
              }
            }
          }
        }
      )

      // ── withCall: the unified processing wrapper ────────────────────

      const withCall = (handlers: HandlerRegistry, event: CallEvent): Effect.Effect<void> =>
        Effect.gen(function* () {
          // Step 1: Resolve callRef and determine if this is initial INVITE vs in-dialog

          if (event.type === "sip" && event.message.type === "request" && event.message.method === "INVITE") {
            // Check if this is an initial INVITE (no callRef in URI params)
            const resolved = resolveFromRequest(event.message)
            if (resolved === undefined) {
              // RFC 3261 §12.2.2: an INVITE with a To-tag is a re-INVITE
              // (in-dialog). Without URI params we cannot resolve the call,
              // so fall through to the normal in-dialog resolution which
              // will try callId+fromTag fallback and 481 on miss.
              const toTag = event.message.getHeader("to").tag
              if (!toTag) {
                // Initial INVITE — create skeleton call
                yield* handleInitialInvite(handlers, event.message, event.rinfo)
                return
              }
            }
          }

          // ── Dialog-less OPTIONS keepalive (RFC 3261 §11) ──────────────
          // The proxy front sends out-of-dialog OPTIONS to probe the worker.
          // These are infrastructure pings, not call-bound — short-circuit
          // BEFORE call resolution so they never touch CallStateCache.
          //
          // Reply must agree with the K8s `/ready` HTTP probe so the
          // proxy's two readiness signals (Endpoints membership +
          // SIP HealthProbe) cannot disagree:
          //   - serving   AND  ready   → 200 OK (RFC 3261 §11; minimal
          //                              response, no Allow body — operators
          //                              use Prometheus / SIP probes for
          //                              feature discovery in this codebase).
          //   - serving   AND  !ready  → 503 + `Retry-After: 0` (boot-time
          //                              ReadyGate still draining peers'
          //                              `propagate:N` queues — pod is also
          //                              out of K8s Endpoints, so few SIP
          //                              probes reach here, but if any do
          //                              we must mirror the HTTP gate).
          //   - draining               → 503 + `Retry-After: 0`
          //                              (RFC 3261 §21.5.4 + §20.33).
          //                              `Retry-After: 0` is the canonical
          //                              "drained" signal proxies use to
          //                              demote the worker to
          //                              `health=draining`.
          //
          // In-dialog OPTIONS (To-tag present) falls through to the rule
          // chain so existing transparent-relay rules handle it.
          if (
            event.type === "sip" &&
            event.message.type === "request" &&
            event.message.method === "OPTIONS" &&
            !event.message.getHeader("to").tag
          ) {
            const mode = yield* draining.mode
            const ready = yield* readiness.currentReady
            const req = event.message
            const respDest = { host: event.rinfo.address, port: event.rinfo.port }
            if (mode === "serving" && ready) {
              const ok = generateResponse(req, 200, "OK", { toTag: newTag() })
              yield* Effect.logDebug(
                `OPTIONS keepalive from ${respDest.host}:${respDest.port} → 200 (serving, ready)`
              )
              yield* txnLayer.send(ok, respDest, "response")
            } else {
              // Encode the worker-side cause in a `Reason:` header
              // (RFC 3326) so the proxy's HealthProbe can distinguish a
              // SIGTERM-driven `draining` reply from a boot-time
              // `not-ready` reply. Both are 503 + Retry-After: 0 so an
              // RFC-compliant probe still demotes the worker; the
              // `Reason` text adds the proxy-internal qualifier we need
              // for the decode_forward → decode_forward_backup
              // promotion in Slice E1 of the respawn fix.
              const reason =
                mode === "draining" ? "draining" : "not-ready (boot drain)"
              const reasonHeader = `SIP;cause=503;text="${reason}"`
              const unavailable = generateResponse(req, 503, "Service Unavailable", {
                toTag: newTag(),
                extraHeaders: [
                  { name: "Retry-After", value: "0" },
                  { name: "Reason", value: reasonHeader },
                ],
              })
              yield* Effect.logDebug(
                `OPTIONS keepalive from ${respDest.host}:${respDest.port} → 503 (${reason})`
              )
              yield* txnLayer.send(unavailable, respDest, "response")
            }
            return
          }

          // In-dialog or timer event — resolve callRef
          let callRef: string | undefined
          let legHint: string | undefined

          if (event.type === "timer") {
            callRef = event.callRef
            legHint = event.legId
          } else if (event.type === "cancelled") {
            callRef = yield* callState.resolveFromSipKey(event.callId, event.fromTag)
          } else if (event.type === "timeout") {
            callRef = event.callRef
            legHint = event.legId
          } else if (event.type === "internal-event") {
            callRef = event.callRef
          } else if (event.type === "sip") {
            let resolveMethod: string = "none"
            if (event.message.type === "request") {
              const resolved = resolveFromRequest(event.message)
              if (resolved) {
                callRef = resolved.callRef
                legHint = resolved.leg
                resolveMethod = "uri-params"
              } else {
                const callId = event.message.getHeader("call-id")
                const fromTag = event.message.getHeader("from").tag ?? ""
                callRef = yield* callState.resolveFromSipKey(callId, fromTag)
                resolveMethod = `callId+fromTag fallback (${callId}/${fromTag})`
              }
            } else {
              const resolved = resolveFromResponse(event.message)
              if (resolved) {
                callRef = resolved.callRef
                legHint = resolved.leg
                resolveMethod = "via-params"
              } else {
                const callId = event.message.getHeader("call-id")
                const fromTag = event.message.getHeader("from").tag ?? ""
                callRef = yield* callState.resolveFromSipKey(callId, fromTag)
                resolveMethod = `callId+fromTag fallback (${callId}/${fromTag})`
              }
            }
            const msgSummary = event.message.type === "request"
              ? `${event.message.method} ${event.message.uri}`
              : `${(event.message as SipResponse).status}`
            yield* Effect.logDebug(`Resolved ${msgSummary} via ${resolveMethod} → callRef=${callRef ?? "?"} leg=${legHint ?? "?"}`)
          }

          if (callRef === undefined) {
            // Unroutable — error span
            if (event.type === "sip") {
              const msg = event.message
              // Narrow once so getHeader resolves on a single concrete type
              // (overload resolution on union types picks the raw-string
              // fallback — see SipRequest.getHeader doc).
              let summary: string
              let callId: string
              let fromTag: string
              let toTag: string
              let resolveDetail: string
              if (msg.type === "request") {
                summary = `${msg.method} ${msg.uri}`
                callId = msg.getHeader("call-id")
                fromTag = msg.getHeader("from").tag ?? "?"
                toTag = msg.getHeader("to").tag ?? "?"
                const uriParams = msg.requestUri.params
                resolveDetail = uriParams.callref
                  ? `uri-params: callRef=${uriParams.callref} leg=${uriParams.leg ?? "?"}`
                  : `no callRef in URI, fallback: callId=${callId} fromTag=${fromTag}`
              } else {
                summary = `${msg.status} ${msg.reason}`
                callId = msg.getHeader("call-id")
                fromTag = msg.getHeader("from").tag ?? "?"
                toTag = msg.getHeader("to").tag ?? "?"
                const viaParams = msg.getHeader("via")[0].params
                const cr = typeof viaParams.cr === "string" ? viaParams.cr : undefined
                const lg = typeof viaParams.lg === "string" ? viaParams.lg : undefined
                resolveDetail = cr
                  ? `via-params: cr=${cr} lg=${lg ?? "?"}`
                  : `no cr in Via, fallback: callId=${callId} fromTag=${fromTag}`
              }
              const attrs: Record<string, unknown> = {
                "sip.remote_addr": `${event.rinfo.address}:${event.rinfo.port}`,
                "sip.summary": summary,
                "sip.call_id": callId
              }
              yield* tracing.withErrorSpan("sip.unroutable", attrs,
                Effect.logWarning(`Unroutable ${summary} from ${event.rinfo.address}:${event.rinfo.port} Call-ID=${callId} fromTag=${fromTag} toTag=${toTag} [${resolveDetail}] — rejecting`)
              )
              // Stale-response anomaly counter — bumped per RFC 3261
              // §17.1.1.2 silent-drop path so operators can see the
              // teardown-race rate (typically OPTIONS keepalive 200 OKs
              // arriving after the call was deleted).
              if (msg.type === "response") {
                bumpStaleResponse(msg.getHeader("cseq").method, msg.status)
              }
              // RFC 3261 §12.2.2 — reject unmatched in-dialog requests with 481
              // (ACK never gets a response; responses are silently dropped)
              if (msg.type === "request" && msg.method !== "ACK") {
                // No call context available for leg/callref Contact params — emit
                // a plain b2bua Contact directly. Tag fabricated for any incoming
                // To missing one (generator only inserts when absent).
                const rejectMsg = generateResponse(msg as SipRequest, 481, "Call/Transaction Does Not Exist", {
                  toTag: newTag(),
                  contact: { user: "b2bua", host: transport.localAddress.ip, port: transport.localAddress.port },
                })
                yield* txnLayer.send(rejectMsg, { host: event.rinfo.address, port: event.rinfo.port }, "response")
              }
            } else {
              yield* Effect.logWarning(`Cannot resolve call for event type=${event.type} — dropping`)
            }
            return
          }

          // Step 2: Run handler under the per-callRef serialisation
          // permit. `withCall` loads the call, holds the permit for the
          // body, and releases it via `Semaphore.withPermits`'s
          // uninterruptible finalizer — so a defect / interrupt mid-
          // body cannot leak the permit (the historical hazard of the
          // old `checkout` + JS try/finally `release` shape).
          yield* callState.withCall(callRef, (call) =>
            Effect.gen(function* () {
              if (call === undefined) {
                const summary = event.type === "sip"
                  ? (event.message.type === "request"
                      ? `${event.message.method} ${event.message.uri}`
                      : `${(event.message as SipResponse).status} ${(event.message as SipResponse).reason}`)
                  : event.type
                const legInfo = legHint ? ` leg=${legHint}` : ""
                if (event.type === "timeout") {
                  // After TransactionLayer.cancelTxnsForCall is wired into
                  // every call-eviction path this is unreachable — Timer B/F
                  // for an evicted call's transaction should never fire.
                  zombieTimeoutTotal++
                  yield* Effect.logError(`Call ${callRef} not found on checkout for ${summary}${legInfo} — zombie timer fired (eviction-path bug)`)
                } else {
                  yield* Effect.logWarning(`Call ${callRef} not found on checkout for ${summary}${legInfo} — rejecting`)
                }
                // Late response on a deleted call (the teardown-race
                // surface that motivated the tombstone redesign):
                // RFC 3261 §17.1.1.2 silent drop, observable via the
                // stale-response counter.
                if (event.type === "sip" && event.message.type === "response") {
                  bumpStaleResponse(
                    event.message.getHeader("cseq").method,
                    event.message.status,
                  )
                }
                // RFC 3261 §12.2.2 — reject requests for vanished calls with 481
                if (event.type === "sip" && event.message.type === "request" && event.message.method !== "ACK") {
                  const rejectMsg = generateResponse(event.message as SipRequest, 481, "Call/Transaction Does Not Exist", {
                    toTag: newTag(),
                    contact: { user: "b2bua", host: transport.localAddress.ip, port: transport.localAddress.port },
                  })
                  yield* txnLayer.send(rejectMsg, { host: event.rinfo.address, port: event.rinfo.port }, "response")
                }
                return
              }

              // Step 3: Determine leg and dialog
              const { leg, dialog, direction } = legHint
                ? findLegAndDialog(call, legHint)
                : { leg: call.aLeg, dialog: call.aLeg.dialogs[0] as Dialog | undefined, direction: "from-a" as const }

              const nowMs = yield* Clock.currentTimeMillis
              const resolvedCtx: ResolvedContext = {
                call, callRef, leg, dialog, direction, event, config, callControl, limiter, nowMs
              }

              // Step 4: Run handler inside tracing span
              const spanName = event.type === "sip"
                ? (event.message.type === "request"
                    ? `sip.recv.${event.message.method}`
                    : `sip.recv.${(event.message as SipResponse).status}`)
                : event.type === "timer" ? `timer.${event.timerType}`
                : event.type === "internal-event" ? `internal.${event.topic}.${event.outcome}`
                : `sip.${event.type}`

              const attrs: Record<string, unknown> = {
                "sip.call_ref": callRef,
                "sip.call_id.a_leg": call.aLeg.callId,
              }
              if (call.bLegs.length > 0) {
                attrs["sip.call_id.b_leg"] = call.bLegs[0]!.callId
              }
              if (event.type === "internal-event") {
                attrs["internal.topic"] = event.topic
                attrs["internal.outcome"] = event.outcome
              }
              if (event.type === "sip") {
                attrs["net.peer.addr"] = `${event.rinfo.address}:${event.rinfo.port}`
                attrs["sip.direction"] = direction === "from-a" ? "inbound" : "outbound"
                if (event.message.type === "request") {
                  attrs["sip.method"] = event.message.method
                } else {
                  attrs["sip.status_code"] = (event.message as SipResponse).status
                }
                if (call.sampled === true) {
                  attrs["sip.raw_message"] = tracing.scrubMessage(serialize(event.message).toString("utf-8"))
                }
              }

              const handler = handlers.inDialog
              const inner = Effect.gen(function* () {
                const result = yield* handler(resolvedCtx)
                // Emit span events declared by the handler
                if (result.spanEvents && result.spanEvents.length > 0) {
                  yield* tracing.emitSpanEvents(result.spanEvents)
                }
                yield* processResult(callRef, result, handlers, nowMs)
              })

              yield* tracing.withProcessingSpan({ call, name: spanName, attributes: attrs, effect: inner })
            }),
          )
        }).pipe(
          Effect.catchTag("RedisError", (e) =>
            Effect.logError(`Redis error in withCall: ${e.reason}`)
          )
        )

      // ── Initial INVITE handling ─────────────────────────────────────

      const handleInitialInvite = Effect.fnUntraced(
        function* (handlers: HandlerRegistry, req: SipRequest, rinfo: RemoteInfo) {
          const callId = req.getHeader("call-id")
          const fromHeader = getHeader(req.headers, "from")
          const fromTag = req.getHeader("from").tag

          if (fromTag === undefined) {
            yield* Effect.logWarning("INVITE missing required headers — dropping")
            return
          }

          // Slice 4/5: encode the natural primary's ordinal into the
          // callRef so any worker holding the ref can derive
          // `(role, primary)` for storage path construction without
          // consulting the proxy or the cookie. Prefers the explicit
          // `workerOrdinalLabel` (production K8s pod hostname; matches
          // the `WorkerId` string the proxy puts in the cookie); falls
          // back to `String(workerIndex)` (clustered mode) and finally
          // to "self" (single-worker tests / dev).
          const selfOrdinal =
            config.workerOrdinalLabel !== undefined
              ? config.workerOrdinalLabel
              : config.workerIndex >= 0
                ? String(config.workerIndex)
                : "self"
          const callRef = deriveCallRef(selfOrdinal, callId, fromTag)
          const traceRateHeader = getHeader(req.headers, "X-Full-Trace-Sample-Rate")
          const overrideRate = traceRateHeader !== undefined ? parseFloat(traceRateHeader) : undefined
          const sampled = tracing.decideSampling(
            overrideRate !== undefined && !isNaN(overrideRate) ? overrideRate : undefined
          )

          const aLegFromForUri = fromHeader!
          const aLegToForUri = getHeader(req.headers, "to") ?? req.uri

          // Create skeleton call with a-leg
          // RFC 3261 §12.2.1.1: track local/remote URIs for in-dialog header construction
          // B2BUA is UAS on a-leg: localUri = To URI (our identity), remoteUri = From URI (Alice)
          const aLeg: Leg = {
            legId: "a",
            callId,
            fromTag,
            source: rinfo,
            state: "trying",
            disposition: "bridged",
            dialogs: [],
            noAnswerTimeoutSec: undefined,
            localUri: extractNameAddrUri(aLegToForUri),
            remoteUri: extractNameAddrUri(aLegFromForUri),
          }

          const isEmergency = isEmergencyRequest(req)
          const nowMs = yield* Clock.currentTimeMillis

          // Slice 5: parse the proxy's stickiness cookie out of the
          // inbound INVITE's top-most Record-Route. The proxy already
          // verified its HMAC; we just lift `(w_pri, w_bak)` so the
          // dual-write path knows the backup peer. When no cookie is
          // present (single-worker / dev / test without proxy), we
          // self-name as primary and leave bak empty.
          const cookie = parseStickinessCookie(req.headers)
          const topology: CallTopology = {
            pri: cookie?.pri ?? selfOrdinal,
            bak: cookie?.bak ?? "",
            gen: 0,
          }

          const call: Call = {
            callRef,
            aLeg,
            bLegs: [],
            activePeer: null,
            callbackContext: undefined,
            // Retain the full a-leg INVITE — source of truth for response
            // relaying (Via/From/To/CSeq echo per RFC 3261 §8.2.6.2) and for
            // failover b-leg reconstruction / transfer SDP lookups.
            aLegInvite: { uri: req.uri, headers: req.headers, body: req.body },
            limiterEntries: [],
            timers: [],
            cdrEvents: [{ type: "invite_received", timestamp: nowMs, legId: "a" }],
            state: "active",
            createdAt: nowMs,
            tagMap: [],
            sampled,
            workerIndex: config.workerIndex >= 0 ? config.workerIndex : undefined,
            emergency: isEmergency || undefined,
            _topology: topology,
          }

          yield* callState.create(call)

          const event: CallEvent = { type: "sip", message: req, rinfo }
          const resolvedCtx: ResolvedContext = {
            call, callRef, leg: aLeg, dialog: undefined, direction: "from-a", event, config, callControl, limiter, nowMs
          }

          const attrs: Record<string, unknown> = {
            "sip.call_ref": callRef,
            "sip.method": "INVITE",
            "sip.direction": "inbound",
            "sip.call_id.a_leg": callId,
            "sip.from_uri": req.getHeader("from").uri,
            "sip.request_uri": req.uri,
            "net.peer.addr": `${rinfo.address}:${rinfo.port}`,
          }
          if (sampled) {
            attrs["sip.raw_message"] = tracing.scrubMessage(serialize(req).toString("utf-8"))
          }

          const inner = Effect.gen(function* () {
            const result = yield* handlers.initialInvite(resolvedCtx)
            // Emit span events declared by the handler
            if (result.spanEvents && result.spanEvents.length > 0) {
              yield* tracing.emitSpanEvents(result.spanEvents)
            }
            yield* processResult(callRef, result, handlers, nowMs)
          })

          const { traceId, spanId } = yield* tracing.withRootSpan({
            name: "call.lifecycle",
            sampled,
            attributes: attrs,
            effect: inner,
          })
          yield* callState.update(callRef, (c) => ({ ...c, traceId, rootSpanId: spanId, sampled }))
        }
      )

      // ── Start: consume TransactionEvent stream ──────────────────────

      // ── Rehydrate owned calls + timer fibers on boot ─────────────────
      //
      // After ReadyGate has drained peers' reverse-propagate streams
      // into local `pri:{self}:`, walk every owned call back into the
      // in-memory `callsMap` (via `loadOwnedCalls`) and respawn timer
      // fibers for every persisted `TimerEntry`. This is the only path
      // that keeps OPTIONS keepalive / limiter-refresh / no-answer
      // timers ticking across a worker restart — without it, recovered
      // calls sit silent until the next inbound SIP message wakes them.
      const rehydrateOwnedCalls = Effect.fnUntraced(function* (
        handlers: HandlerRegistry
      ) {
        const calls = yield* callState.loadOwnedCalls(config.workerIndex)
        for (const call of calls) {
          const handler = (cr: string, tt: TimerType, lid: string | undefined) =>
            timerHandler(handlers, cr, tt, lid)
          // Slice 6: demoted from bare `console.log` so the diag line
          // rides the structured logger (timestamps, level, scope) and
          // is suppressed at production log levels.
          yield* Effect.logDebug(
            `rehydrate ${call.callRef} aLeg.localCSeq=${call.aLeg.dialogs[0]?.sip.localCSeq} bLeg=${call.bLegs[0]?.dialogs[0]?.sip.localCSeq} timers=${call.timers.map((t) => t.id + "@" + t.fireAt).join(",")}`,
          )
          yield* timers.restoreFromEntries(call.callRef, call.timers, handler)
        }
        yield* Effect.logInfo(
          `SipRouter: rehydrated ${calls.length} owned call(s) and respawned their timer fibers`
        )
      })

      const start = Effect.fnUntraced(function* (handlers: HandlerRegistry) {
        return yield* Stream.runForEach(txnLayer.events, (txnEvent) => {
          let event: CallEvent

          switch (txnEvent.type) {
            case "message":
              event = { type: "sip", message: txnEvent.message, rinfo: txnEvent.rinfo }
              break
            case "cancelled":
              event = { type: "cancelled", callId: txnEvent.callId, fromTag: txnEvent.fromTag }
              break
            case "timeout":
              event = { type: "timeout", branch: txnEvent.branch, callRef: txnEvent.callRef, legId: txnEvent.legId, method: txnEvent.method }
              break
          }
          return withCall(handlers, event).pipe(
            // Per-event safety timeout. The first hit identifies the
            // event class that hung — log all the discriminators we
            // have so triage doesn't need a heap snapshot. The wrap
            // intentionally sits *outside* the catchCause so the
            // existing error-logging path stays in charge of plain
            // failures; only Cause.TimeoutError is intercepted here.
            Effect.timeoutOrElse({
              duration: Duration.millis(config.eventHandlerTimeoutMs),
              orElse: () =>
                Effect.gen(function* () {
                  eventHandlerTimeoutTotal++
                  const detail = describeEventDetail(event)
                  yield* Effect.logError(
                    `Event handler timed out after ${config.eventHandlerTimeoutMs}ms — ${detail}`,
                  )
                }),
            }),
            Effect.catchCause((cause) =>
              Effect.logError(`Unhandled error processing event [${describeEvent(event)}]`, cause)
            )
          )
        }) as unknown as Effect.Effect<never>
      })

      return { start, rehydrateOwnedCalls }
    })
  )
}
