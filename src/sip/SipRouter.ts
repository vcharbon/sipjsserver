/**
 * SipRouter — unified SIP message processing pipeline.
 *
 * Owns:
 * - Call resolution (callRef+leg from Contact URI params, Via cr/lg params, or callId+fromTag fallback)
 * - `withCall` wrapper: resolve -> checkout -> tracing span -> handler -> processResult -> release
 * - Via/Contact header stamping on outbound messages
 * - Effect execution in fixed order
 *
 * Consumes TransactionEvent stream + timer events, delegates to handlers.
 */

import { Clock, Effect, Layer, ServiceMap, Stream } from "effect"
import type { RemoteInfo, SipHeader, SipMessage, SipRequest, SipResponse } from "./types.js"
import { TransactionLayer, type TransactionEvent } from "./TransactionLayer.js"
import { serialize, sipSummary, messageSummary } from "./Serializer.js"
import {
  buildRejectResponse,
  getHeader,
  getHeaders,
  isEmergencyRequest,
  newBranch,
} from "./MessageFactory.js"
import { AppConfig, type AppConfigData } from "../config/AppConfig.js"
import { CallState } from "../call/CallState.js"
import { CallControlClient } from "../http/CallControlClient.js"
import { CallLimiter } from "../call/CallLimiter.js"
import { TimerService } from "../call/TimerService.js"
import { CdrWriter } from "../cdr/CdrWriter.js"
import { TracingService } from "../tracing/TracingService.js"
import {
  type Call,
  type CdrEvent,
  type Leg,
  type Dialog,
  type TimerEntry,
  type TimerType,
  deriveCallRef,
  makeEmptyDialog
} from "../call/CallModel.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Unified event type consumed by withCall. */
export type CallEvent =
  | { readonly type: "sip"; readonly message: SipMessage; readonly rinfo: RemoteInfo }
  | { readonly type: "timer"; readonly timerType: TimerType; readonly callRef: string; readonly legId: string | undefined }
  | { readonly type: "cancelled"; readonly callId: string; readonly fromTag: string }
  | { readonly type: "timeout"; readonly branch: string; readonly callRef: string | undefined; readonly legId: string | undefined }

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
  readonly callControl: CallControlClient["Service"]
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
// Via/Contact encoding helpers
// ---------------------------------------------------------------------------

/** URL-encode a value for safe embedding in SIP Via/Contact params. */
function encodeParam(value: string): string {
  return encodeURIComponent(value)
}

/** Decode a URL-encoded param value. */
function decodeParam(value: string): string {
  return decodeURIComponent(value)
}

/** Build a Contact URI with callRef and leg encoded as URI parameters. */
function buildContactUri(localIp: string, localPort: number, callRef: string, leg: string, isEmergency: boolean): string {
  const base = `sip:b2bua@${localIp}:${localPort};callRef=${encodeParam(callRef)};leg=${encodeParam(leg)}`
  return isEmergency ? `${base};emerg=1` : base
}

/** Build a Via header with cr/lg custom parameters. */
function buildVia(localIp: string, localPort: number, callRef: string, leg: string, isEmergency: boolean): string {
  const branch = newBranch()
  const base = `SIP/2.0/UDP ${localIp}:${localPort};branch=${branch};cr=${encodeParam(callRef)};lg=${encodeParam(leg)}`
  return isEmergency ? `${base};em=1` : base
}

/** Build a Record-Route with callRef/leg encoded. */
function buildRecordRoute(localIp: string, localPort: number, callRef: string, leg: string, isEmergency: boolean): string {
  const base = `sip:b2bua@${localIp}:${localPort};callRef=${encodeParam(callRef)};leg=${encodeParam(leg)};lr`
  return isEmergency ? `<${base};emerg=1>` : `<${base}>`
}

/**
 * Stamp Via, Contact, and Record-Route on an outbound message with
 * callRef/leg params. When `isEmergency` is true, also stamps the
 * `;emerg=1` (URI) and `;em=1` (Via) markers used by the dispatcher
 * byte-classifier to route subsequent in-dialog packets into the
 * emergency priority queue.
 */
function stampHeaders(
  msg: SipRequest | SipResponse,
  localIp: string,
  localPort: number,
  callRef: string,
  leg: string,
  isEmergency: boolean
): SipRequest | SipResponse {
  const headers: SipHeader[] = msg.headers.map((h) => {
    const lower = h.name.toLowerCase()
    if (lower === "via" && h.value === "__PLACEHOLDER__") {
      return { name: h.name, value: buildVia(localIp, localPort, callRef, leg, isEmergency) }
    }
    if (lower === "contact" && h.value === "__PLACEHOLDER__") {
      return { name: h.name, value: `<${buildContactUri(localIp, localPort, callRef, leg, isEmergency)}>` }
    }
    if (lower === "record-route" && h.value === "__PLACEHOLDER__") {
      return { name: h.name, value: buildRecordRoute(localIp, localPort, callRef, leg, isEmergency) }
    }
    return h
  })

  return { ...msg, headers } as SipRequest | SipResponse
}

// ---------------------------------------------------------------------------
// Resolution logic
// ---------------------------------------------------------------------------

interface ResolvedKey {
  readonly callRef: string
  readonly leg: string
}

/** Resolve callRef+leg from an inbound SIP request (Contact URI params in Request-URI). */
function resolveFromRequest(req: SipRequest): ResolvedKey | undefined {
  const uriParams = req.parsed?.requestUri?.params
  if (uriParams?.callref && uriParams.leg) {
    return { callRef: decodeParam(uriParams.callref), leg: decodeParam(uriParams.leg) }
  }
  return undefined
}

/** Resolve callRef+leg from an inbound SIP response (cr/lg in top Via). */
function resolveFromResponse(resp: SipResponse): ResolvedKey | undefined {
  const viaParams = resp.parsed?.via?.params
  const cr = typeof viaParams?.cr === "string" ? viaParams.cr : undefined
  const lg = typeof viaParams?.lg === "string" ? viaParams.lg : undefined
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
  }
>()("@sipjsserver/SipRouter") {
  static readonly layer = Layer.effect(
    SipRouter,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const txnLayer = yield* TransactionLayer
      const callState = yield* CallState
      const callControl = yield* CallControlClient
      const limiter = yield* CallLimiter
      const timers = yield* TimerService
      const cdr = yield* CdrWriter
      const tracing = yield* TracingService

      // ── Timer handler that feeds back into withCall ──────────────────

      const timerHandler = (
        handlers: HandlerRegistry,
        callRef: string,
        timerType: TimerType,
        legId: string | undefined
      ): Effect.Effect<void> => {
        const event: CallEvent = { type: "timer" as const, timerType, callRef, legId }
        return withCall(handlers, event)
      }

      // ── processResult: execute handler output in fixed order ────────

      const processResult = Effect.fn("SipRouter.processResult")(
        function* (callRef: string, result: HandlerResult, handlers: HandlerRegistry, nowMs: number) {
          // 1. Update call state in memory
          yield* callState.update(callRef, () => result.call)

          // 2. Stamp headers, serialize, send outbound via TransactionLayer
          for (const env of result.outbound) {
            const isRequest = env.message.type === "request"
            // Determine leg for header stamping
            // For responses to a-leg, use leg=a; for requests to b-leg, use the b-leg id
            const outLeg = determineOutboundLeg(result.call, env)
            const stamped = stampHeaders(env.message, config.sipLocalIp, config.sipLocalPort, callRef, outLeg, result.call.emergency === true)

            yield* Effect.logDebug(`SIP OUT -> ${env.destination.host}:${env.destination.port} [${env.label}] ${messageSummary(stamped)}`)
            yield* Effect.logDebug(serialize(stamped).toString('utf-8'))

            // Emit send span for tracing
            if (result.call.sampled === true) {
              const sendName = stamped.type === "request"
                ? `sip.send.${(stamped as SipRequest).method}`
                : `sip.send.${(stamped as SipResponse).status}`
              const sendAttrs: Record<string, unknown> = {
                "sip.call_ref": callRef,
                "net.peer.addr": `${env.destination.host}:${env.destination.port}`,
                "sip.raw_message": tracing.scrubMessage(serialize(stamped).toString("utf-8")),
              }
              if (stamped.type === "request") {
                sendAttrs["sip.method"] = (stamped as SipRequest).method
              } else {
                sendAttrs["sip.status_code"] = (stamped as SipResponse).status
              }
              yield* tracing.emitSendSpan({ call: result.call, name: sendName, attributes: sendAttrs })
            }

            // ACK for 2xx is a one-shot — no transaction management (RFC 3261 §17.1.1.2)
            if (stamped.type === "request" && stamped.method === "ACK") {
              yield* txnLayer.sendRaw(serialize(stamped), env.destination.port, env.destination.host)
            } else {
              const txnType = isRequest
                ? (stamped.type === "request" && stamped.method === "INVITE" ? "invite" as const : "non-invite" as const)
                : "response" as const
              yield* txnLayer.send(stamped, env.destination, txnType)
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
            }
          }
        }
      )

      // ── Determine outbound leg for header stamping ──────────────────

      function determineOutboundLeg(call: Call, env: OutboundEnvelope): string {
        // If sending to a-leg source, stamp as a-leg
        if (env.destination.host === call.aLeg.source.address &&
            env.destination.port === call.aLeg.source.port) {
          return "a"
        }
        // Otherwise find matching b-leg
        for (const bLeg of call.bLegs) {
          if (env.label.includes(bLeg.legId)) return bLeg.legId
        }
        // Default to first b-leg
        return call.bLegs[0]?.legId ?? "b-1"
      }

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
              const toTag = event.message.parsed?.to?.tag
              if (!toTag) {
                // Initial INVITE — create skeleton call
                yield* handleInitialInvite(handlers, event.message, event.rinfo)
                return
              }
            }
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
          } else if (event.type === "sip") {
            let resolveMethod: string = "none"
            if (event.message.type === "request") {
              const resolved = resolveFromRequest(event.message)
              if (resolved) {
                callRef = resolved.callRef
                legHint = resolved.leg
                resolveMethod = "uri-params"
              } else {
                const callId = event.message.parsed?.callId ?? ""
                const fromTag = event.message.parsed?.from?.tag ?? ""
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
                const callId = event.message.parsed?.callId ?? ""
                const fromTag = event.message.parsed?.from?.tag ?? ""
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
              const summary = msg.type === "request"
                ? `${msg.method} ${msg.uri}`
                : `${msg.status} ${msg.reason}`
              const callId = msg.parsed?.callId ?? "?"
              const fromTag = msg.parsed?.from?.tag ?? "?"
              const toTag = msg.parsed?.to?.tag ?? "?"
              // Show resolution-relevant params
              let resolveDetail: string
              if (msg.type === "request") {
                const uriParams = msg.parsed?.requestUri?.params
                resolveDetail = uriParams?.callref
                  ? `uri-params: callRef=${uriParams.callref} leg=${uriParams.leg ?? "?"}`
                  : `no callRef in URI, fallback: callId=${callId} fromTag=${fromTag}`
              } else {
                const cr = typeof msg.parsed?.via?.params?.cr === "string" ? msg.parsed.via.params.cr : undefined
                const lg = typeof msg.parsed?.via?.params?.lg === "string" ? msg.parsed.via.params.lg : undefined
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
              // RFC 3261 §12.2.2 — reject unmatched in-dialog requests with 481
              // (ACK never gets a response; responses are silently dropped)
              if (msg.type === "request" && msg.method !== "ACK") {
                const reject = buildRejectResponse(msg as SipRequest, 481, "Call/Transaction Does Not Exist")
                // Replace Contact placeholder with concrete value (no call context for stamping)
                const rejectHeaders = reject.headers.map(hdr =>
                  hdr.value === "__PLACEHOLDER__"
                    ? { name: hdr.name, value: `<sip:b2bua@${config.sipLocalIp}:${config.sipLocalPort}>` }
                    : hdr
                )
                const rejectMsg: SipResponse = { ...reject, headers: rejectHeaders }
                yield* txnLayer.send(rejectMsg, { host: event.rinfo.address, port: event.rinfo.port }, "response")
              }
            } else {
              yield* Effect.logWarning(`Cannot resolve call for event type=${event.type} — dropping`)
            }
            return
          }

          // Step 2: Checkout call
          const call = yield* callState.checkout(callRef)
          if (call === undefined) {
            const summary = event.type === "sip"
              ? (event.message.type === "request"
                  ? `${event.message.method} ${event.message.uri}`
                  : `${(event.message as SipResponse).status} ${(event.message as SipResponse).reason}`)
              : event.type
            const legInfo = legHint ? ` leg=${legHint}` : ""
            yield* Effect.logWarning(`Call ${callRef} not found on checkout for ${summary}${legInfo} — rejecting`)
            // RFC 3261 §12.2.2 — reject requests for vanished calls with 481
            if (event.type === "sip" && event.message.type === "request" && event.message.method !== "ACK") {
              const reject = buildRejectResponse(event.message as SipRequest, 481, "Call/Transaction Does Not Exist")
              const rejectHeaders = reject.headers.map(hdr =>
                hdr.value === "__PLACEHOLDER__"
                  ? { name: hdr.name, value: `<sip:b2bua@${config.sipLocalIp}:${config.sipLocalPort}>` }
                  : hdr
              )
              const rejectMsg: SipResponse = { ...reject, headers: rejectHeaders }
              yield* txnLayer.send(rejectMsg, { host: event.rinfo.address, port: event.rinfo.port }, "response")
            }
            return
          }

          try {
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
              : `sip.${event.type}`

            const attrs: Record<string, unknown> = {
              "sip.call_ref": callRef,
              "sip.call_id.a_leg": call.aLeg.callId,
            }
            if (call.bLegs.length > 0) {
              attrs["sip.call_id.b_leg"] = call.bLegs[0]!.callId
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
          } finally {
            yield* callState.release(callRef)
          }
        }).pipe(
          Effect.catchTag("RedisError", (e) =>
            Effect.logError(`Redis error in withCall: ${e.reason}`)
          )
        )

      // ── Initial INVITE handling ─────────────────────────────────────

      const handleInitialInvite = Effect.fn("SipRouter.handleInitialInvite")(
        function* (handlers: HandlerRegistry, req: SipRequest, rinfo: RemoteInfo) {
          const callId = req.parsed?.callId
          const fromHeader = getHeader(req.headers, "from")
          const fromTag = req.parsed?.from?.tag

          if (callId === undefined || fromTag === undefined) {
            yield* Effect.logWarning("INVITE missing required headers — dropping")
            return
          }

          const callRef = deriveCallRef(callId, fromTag)
          const traceRateHeader = getHeader(req.headers, "X-Full-Trace-Sample-Rate")
          const overrideRate = traceRateHeader !== undefined ? parseFloat(traceRateHeader) : undefined
          const sampled = tracing.decideSampling(
            overrideRate !== undefined && !isNaN(overrideRate) ? overrideRate : undefined
          )

          // Store original header values for relaying responses back to a-leg
          const aLegVias = getHeaders(req.headers, "via")
          const aLegFrom = fromHeader!
          const aLegTo = getHeader(req.headers, "to") ?? req.uri
          const aLegCSeqRaw = getHeader(req.headers, "cseq") ?? "1 INVITE"
          const aLegCSeqNum = parseInt(aLegCSeqRaw, 10) || 1

          // Create skeleton call with a-leg
          const aLeg: Leg = {
            legId: "a",
            callId,
            fromTag,
            source: rinfo,
            state: "trying",
            disposition: "bridged",
            dialogs: [],
            noAnswerTimeoutSec: undefined,
            initialCSeq: aLegCSeqNum
          }

          const isEmergency = isEmergencyRequest(req)
          const nowMs = yield* Clock.currentTimeMillis

          const call: Call = {
            callRef,
            aLeg,
            bLegs: [],
            activePeer: null,
            callbackContext: undefined,
            limiterEntries: [],
            timers: [],
            cdrEvents: [{ type: "invite_received", timestamp: nowMs, legId: "a" }],
            state: "active",
            createdAt: nowMs,
            aLegVias,
            aLegFrom,
            aLegTo,
            tagMap: [],
            sampled,
            workerIndex: config.workerIndex >= 0 ? config.workerIndex : undefined,
            emergency: isEmergency || undefined
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
            "sip.from_uri": req.parsed?.from?.uri ?? "",
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

      const start = Effect.fn("SipRouter.start")(function* (handlers: HandlerRegistry) {
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
              event = { type: "timeout", branch: txnEvent.branch, callRef: txnEvent.callRef, legId: txnEvent.legId }
              break
          }

          return withCall(handlers, event).pipe(
            Effect.catchCause((cause) =>
              Effect.logError(`Unhandled error processing event [${describeEvent(event)}]`, cause)
            )
          )
        }) as unknown as Effect.Effect<never>
      })

      return { start }
    })
  )
}
