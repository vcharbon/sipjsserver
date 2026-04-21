/**
 * TransactionLayer — RFC 3261 SIP transaction state machine.
 *
 * Sits between UdpTransport (raw packets) and SipRouter (application logic).
 *
 * Responsibilities:
 * - Duplicate detection (Via branch matching)
 * - Retransmission timers (Timer A/B for INVITE, Timer E/F for non-INVITE)
 * - CANCEL handling: send 200 OK + 487, emit transaction-cancelled event
 * - ACK for non-2xx: absorb (part of INVITE server transaction)
 * - Retransmit cached final responses for retransmitted requests
 *
 * In-memory only — transaction state is ephemeral (32s max lifetime).
 */

import { Cause, Clock, Duration, Effect, Fiber, Layer, MutableHashMap, Option, Queue, ServiceMap, Stream } from "effect"
import type { RemoteInfo, SipMessage, SipRequest, SipResponse } from "./types.js"
import { SipParser } from "./Parser.js"
import { UdpTransport } from "./UdpTransport.js"
import { serialize, sipSummary } from "./Serializer.js"
import {
  buildStatelessReject503Buffer,
  isEmergencyRequest,
  newBranch,
  newTag,
} from "./MessageHelpers.js"
import { _generateAckForNon2xx, generateResponse } from "./generators.js"
import { OverloadController } from "../b2bua/OverloadController.js"
import { parseVia, parseNameAddr } from "./parsers/custom/structured-headers.js"

// ---------------------------------------------------------------------------
// Transaction event types (emitted upstream to SipRouter)
// ---------------------------------------------------------------------------

export type TransactionEvent =
  | { readonly type: "message"; readonly message: SipMessage; readonly rinfo: RemoteInfo }
  | { readonly type: "cancelled"; readonly callId: string; readonly fromTag: string }
  | {
      readonly type: "timeout"
      readonly branch: string
      readonly callRef: string | undefined
      readonly legId: string | undefined
      /** SIP method of the transaction that timed out (INVITE / BYE / OPTIONS / …). */
      readonly method: string | undefined
    }

// ---------------------------------------------------------------------------
// Client transaction handles (returned by sendRequest; consumed by generators)
// ---------------------------------------------------------------------------

/**
 * Handle to an outgoing INVITE client transaction.
 *
 * Persists the Via branch and the original INVITE so later messages sourced
 * from the same transaction (CANCEL, ACK for 2xx) can reuse the identifiers
 * RFC 3261 mandates — CANCEL's branch (§9.1) and ACK-for-2xx's CSeq number
 * (§13.2.2.4) both come from here.
 */
export interface InviteClientTransactionHandle {
  readonly kind: "invite"
  readonly branch: string
  readonly originalInvite: SipRequest
  readonly destination: { readonly host: string; readonly port: number }
}

/** Handle to an outgoing non-INVITE client transaction (BYE, OPTIONS, …). */
export interface NonInviteClientTransactionHandle {
  readonly kind: "non-invite"
  readonly branch: string
  readonly originalRequest: SipRequest
  readonly destination: { readonly host: string; readonly port: number }
}

export type ClientTransactionHandle =
  | InviteClientTransactionHandle
  | NonInviteClientTransactionHandle

// ---------------------------------------------------------------------------
// Internal transaction state
// ---------------------------------------------------------------------------

type TxnRole = "client" | "server"
type TxnKind = "invite" | "non-invite"

interface Transaction {
  readonly branch: string
  readonly role: TxnRole
  readonly kind: TxnKind
  readonly callId: string
  readonly fromTag: string
  readonly originalRequest: SipRequest | undefined
  lastResponse: Buffer | undefined
  lastResponseStatus: number | undefined
  readonly callRef: string | undefined
  readonly legId: string | undefined
  state: "trying" | "proceeding" | "completed" | "terminated"
  retransmitFiber: Fiber.Fiber<void> | undefined
  timeoutFiber: Fiber.Fiber<void> | undefined
  readonly destination: { host: string; port: number } | undefined
  readonly originalBuffer: Buffer | undefined
  createdAt: number
  /**
   * To-tag the UAS used for the first response on this server INVITE
   * transaction. Captured on the first outbound >100 response and reused
   * by the TransactionLayer when it must synthesize a later response in
   * the same transaction (e.g. auto-487 on CANCEL) — RFC 3261 §17.2.1.
   */
  uasToTag: string | undefined
}

// ---------------------------------------------------------------------------
// Header extraction helpers
// ---------------------------------------------------------------------------
// Messages from the wire have `parsed` fields (set by the custom parser).
// Outbound messages built by the stack generators do NOT — they need header string
// parsing as a fallback.

function getHeaderValue(msg: SipMessage, name: string): string | undefined {
  const lower = name.toLowerCase()
  return msg.headers.find((h) => h.name.toLowerCase() === lower)?.value
}

/** Extract Via branch from a message, using parsed fields or header fallback. */
function extractBranch(msg: SipMessage): string | undefined {
  if (msg.parsed?.via?.branch) return msg.parsed.via.branch
  const via = getHeaderValue(msg, "via")
  if (!via) return undefined
  return parseVia(via).branch
}

/** Extract Via custom params (cr/lg) from a message. */
function extractViaCustomParams(msg: SipMessage): { cr: string | undefined; lg: string | undefined } {
  const params = msg.parsed?.via?.params
  if (params) {
    return {
      cr: typeof params.cr === "string" ? params.cr : undefined,
      lg: typeof params.lg === "string" ? params.lg : undefined,
    }
  }
  const via = getHeaderValue(msg, "via")
  if (!via) return { cr: undefined, lg: undefined }
  const parsed = parseVia(via)
  return {
    cr: typeof parsed.params.cr === "string" ? parsed.params.cr : undefined,
    lg: typeof parsed.params.lg === "string" ? parsed.params.lg : undefined,
  }
}

/** Extract Call-ID from a message. */
function extractCallId(msg: SipMessage): string {
  return msg.parsed?.callId ?? getHeaderValue(msg, "call-id") ?? ""
}

/** Extract From tag from a message. */
function extractFromTag(msg: SipMessage): string {
  if (msg.parsed?.from?.tag) return msg.parsed.from.tag
  const from = getHeaderValue(msg, "from")
  if (!from) return ""
  return parseNameAddr(from).tag ?? ""
}

/** Extract To tag from a message. */
function extractToTag(msg: SipMessage): string | undefined {
  if (msg.parsed?.to?.tag) return msg.parsed.to.tag
  const to = getHeaderValue(msg, "to")
  if (!to) return undefined
  return parseNameAddr(to).tag
}

// ---------------------------------------------------------------------------
// SIP timer constants (RFC 3261 §17)
// ---------------------------------------------------------------------------

const T1 = 500     // RTT estimate (ms)
const T2 = 4000    // Max retransmit interval for non-INVITE (ms)
const TIMER_B = 64 * T1  // INVITE client transaction timeout (32s)
const TIMER_F = 64 * T1  // Non-INVITE client transaction timeout (32s)
const TIMER_H = 64 * T1  // INVITE server txn cleanup (RFC 3261 §17.2.1)
const TIMER_J = 64 * T1  // Non-INVITE server txn cleanup (RFC 3261 §17.2.2)
const TXN_SWEEP_INTERVAL = 10_000 // Cleanup sweep interval (ms)
const TXN_MAX_AGE = 35_000        // Safety-net max age (just above Timer H/J = 32s)

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface TransactionLayerMetrics {
  /** Current number of active transactions (gauge). */
  readonly activeTransactions: () => number
  /** Total messages processed since start (counter). */
  messagesProcessed: number
}

export class TransactionLayer extends ServiceMap.Service<
  TransactionLayer,
  {
    /** Stream of deduplicated/processed events for SipRouter. */
    readonly events: Stream.Stream<TransactionEvent>
    /**
     * Send an outbound SIP request. Allocates a client transaction and
     * returns a typed handle carrying the Via branch, the original request,
     * and the destination — later messages sourced from the same transaction
     * (CANCEL, ACK for 2xx) consume this handle instead of duplicating state
     * on the dialog.
     */
    readonly sendRequest: (
      msg: SipRequest,
      destination: { host: string; port: number },
      txnType: "invite" | "non-invite"
    ) => Effect.Effect<ClientTransactionHandle>
    /** Send an outbound SIP response through the server transaction. */
    readonly sendResponse: (
      msg: SipResponse,
      destination: { host: string; port: number }
    ) => Effect.Effect<void>
    /**
     * Legacy combined send. Prefer `sendRequest` / `sendResponse` in new
     * code — this wrapper exists only so call sites can migrate
     * incrementally and is slated for removal once migration completes.
     */
    readonly send: (
      msg: SipMessage,
      destination: { host: string; port: number },
      txnType: "invite" | "non-invite" | "response"
    ) => Effect.Effect<void>
    /** Send raw buffer directly (bypass transaction management). */
    readonly sendRaw: (buf: Buffer, port: number, address: string) => Effect.Effect<void>
    /** Lightweight metrics for observability. */
    readonly metrics: TransactionLayerMetrics
  }
>()("@sipjsserver/TransactionLayer") {
  static readonly layer = Layer.effect(
    TransactionLayer,
    Effect.gen(function* () {
      const parser = yield* SipParser
      const transport = yield* UdpTransport
      const overload = yield* OverloadController

      const txnMap = MutableHashMap.empty<string, Transaction>()
      const eventQueue = yield* Queue.unbounded<TransactionEvent, Cause.Done>()

      const txnMetrics: TransactionLayerMetrics = {
        activeTransactions: () => MutableHashMap.size(txnMap),
        messagesProcessed: 0,
      }

      // ── Helpers ──────────────────────────────────────────────────────

      const findTxn = (branch: string): Effect.Effect<Transaction | undefined> =>
        Effect.sync(() => Option.getOrUndefined(MutableHashMap.get(txnMap, branch)))

      const setTxn = (branch: string, txn: Transaction): Effect.Effect<void> =>
        Effect.sync(() => { MutableHashMap.set(txnMap, branch, txn) })

      const deleteTxn = (branch: string): Effect.Effect<void> =>
        Effect.sync(() => { MutableHashMap.remove(txnMap, branch) })

      const sendBuffer = (buf: Buffer, dest: { host: string; port: number }): Effect.Effect<void> =>
        transport.send(buf, dest.port, dest.host).pipe(
          Effect.catchCause((cause) => Effect.logError(`TransactionLayer send error`, cause))
        )

      const emit = (event: TransactionEvent): Effect.Effect<void> =>
        Effect.sync(() => Queue.offerUnsafe(eventQueue, event))

      // ── Cleanup sweep ────────────────────────────────────────────────

      yield* Effect.forkDetach(
        Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.millis(TXN_SWEEP_INTERVAL))
            const now = yield* Clock.currentTimeMillis
            yield* Effect.sync(() => {
              for (const [branch, txn] of txnMap) {
                if (now - txn.createdAt > TXN_MAX_AGE) {
                  MutableHashMap.remove(txnMap, branch)
                }
              }
            })
          })
        )
      )

      // ── Client retransmission ────────────────────────────────────────

      const startClientRetransmit = Effect.fnUntraced(
        function* (branch: string, buf: Buffer, dest: { host: string; port: number }, kind: TxnKind) {
          const maxTimeout = kind === "invite" ? TIMER_B : TIMER_F

          // Retransmission fiber
          const retransmitEffect = Effect.gen(function* () {
            let interval = T1
            let elapsed = T1
            while (elapsed < maxTimeout) {
              yield* Effect.sleep(Duration.millis(interval))
              const txn = yield* findTxn(branch)
              if (txn === undefined || txn.state === "completed" || txn.state === "terminated") return
              yield* sendBuffer(buf, dest)
              yield* Effect.logDebug(`Retransmit ${kind} branch=${branch} interval=${interval}ms`)
              if (kind === "invite") {
                interval = interval * 2
              } else {
                interval = Math.min(interval * 2, T2)
              }
              elapsed += interval
            }
          })

          // Timeout fiber (Timer B/F)
          const timeoutEffect = Effect.gen(function* () {
            yield* Effect.sleep(Duration.millis(maxTimeout))
            const txn = yield* findTxn(branch)
            if (txn === undefined || txn.state === "completed" || txn.state === "terminated") return
            yield* Effect.logWarning(`Transaction timeout: ${kind} branch=${branch}`)
            yield* deleteTxn(branch)
            const method = txn.originalRequest?.method ?? (txn.kind === "invite" ? "INVITE" : undefined)
            yield* emit({ type: "timeout", branch, callRef: txn.callRef, legId: txn.legId, method })
          })

          const rFiber = yield* Effect.forkDetach(retransmitEffect)
          const tFiber = yield* Effect.forkDetach(timeoutEffect)

          yield* Effect.sync(() => {
            const opt = MutableHashMap.get(txnMap, branch)
            if (Option.isSome(opt)) {
              MutableHashMap.set(txnMap, branch, { ...opt.value, retransmitFiber: rFiber, timeoutFiber: tFiber })
            }
          })
        }
      )

      const stopTxnTimers = Effect.fnUntraced(
        function* (txn: Transaction) {
          if (txn.retransmitFiber) yield* Fiber.interrupt(txn.retransmitFiber)
          if (txn.timeoutFiber) yield* Fiber.interrupt(txn.timeoutFiber)
        }
      )

      // ── Inbound request processing ──────────────────────────────────

      const handleInboundRequest = Effect.fnUntraced(
        function* (req: SipRequest, rinfo: RemoteInfo) {
          const branch = req.parsed?.via?.branch ?? ""

          if (!branch) {
            // No branch — pass through (pre-RFC 3261 UA)
            yield* emit({ type: "message", message: req, rinfo })
            return
          }

          const existing = yield* findTxn(branch)

          if (req.method === "ACK") {
            if (existing !== undefined && existing.role === "server" && existing.kind === "invite") {
              if (existing.state === "completed" && existing.lastResponseStatus !== undefined && existing.lastResponseStatus >= 300) {
                // ACK for non-2xx (3xx-6xx) — absorb, terminate transaction
                yield* Effect.logDebug(`ACK for ${existing.lastResponseStatus} absorbed: branch=${branch}`)
                yield* stopTxnTimers(existing)
                yield* deleteTxn(branch)
                return
              }
              // ACK for 2xx on server transaction — pass through to application, terminate transaction
              if (existing.state === "completed" && existing.lastResponseStatus !== undefined && existing.lastResponseStatus >= 200 && existing.lastResponseStatus < 300) {
                yield* Effect.logDebug(`ACK for 2xx passed through: branch=${branch}`)
                yield* stopTxnTimers(existing)
                yield* deleteTxn(branch)
                yield* emit({ type: "message", message: req, rinfo })
                return
              }
            }
            // ACK with no matching server txn.
            //
            // Overload-protection rule: ACKs that arrive in response to a
            // *stateless* 503 (sent by Tier 1 / dispatcher overflow) have no
            // To-tag, because our templated 503 deliberately omits one. Such
            // ACKs cannot match any dialog and must be absorbed here, not
            // propagated upward — otherwise SipRouter would attempt call
            // resolution on them and waste work.
            //
            // Legitimate end-to-end 2xx ACKs always carry a To-tag (set by
            // the 200 OK responder), so they continue to pass through.
            const ackToTag = req.parsed?.to?.tag
            if (!ackToTag) {
              yield* Effect.logDebug(`Orphan ACK with no To-tag absorbed branch=${branch}`)
              return
            }
            yield* emit({ type: "message", message: req, rinfo })
            return
          }

          if (req.method === "CANCEL") {
            // Find the INVITE server transaction by matching callId + fromTag
            // (CANCEL shares the same branch as the original INVITE per RFC 3261)
            const callId = req.parsed?.callId ?? ""
            const fromTag = req.parsed?.from?.tag ?? ""

            // Find the matching INVITE transaction first — we need its UAS
            // To-tag so the 200 OK (CANCEL) and 487 (INVITE) echo the same
            // tag as any prior 18x (RFC 3261 §17.2.1 / §12.1.1). If no 1xx>100
            // was sent yet, fabricate a tag now and pin it on the txn.
            let matchedBranch: string | undefined
            let matchedTxn: Transaction | undefined
            for (const [txnBranch, txn] of txnMap) {
              if (txn.role === "server" && txn.kind === "invite" &&
                  txn.callId === callId && txn.fromTag === fromTag &&
                  (txn.state === "trying" || txn.state === "proceeding")) {
                matchedBranch = txnBranch
                matchedTxn = txn
                break
              }
            }
            let uasToTag = matchedTxn?.uasToTag
            if (matchedBranch !== undefined && matchedTxn !== undefined && uasToTag === undefined) {
              uasToTag = newTag()
              const pinnedTag = uasToTag
              yield* Effect.sync(() => {
                const opt = MutableHashMap.get(txnMap, matchedBranch!)
                if (Option.isSome(opt)) {
                  MutableHashMap.set(txnMap, matchedBranch!, { ...opt.value, uasToTag: pinnedTag })
                }
              })
              matchedTxn = { ...matchedTxn, uasToTag }
            }

            // Send 200 OK to CANCEL — generator omits Contact unless caller asks,
            // so no placeholder to strip for this path (bypasses SipRouter).
            const cancelOk = generateResponse(req, 200, "OK", uasToTag !== undefined ? { toTag: uasToTag } : {})
            yield* sendBuffer(serialize(cancelOk), { host: rinfo.address, port: rinfo.port })

            if (matchedBranch !== undefined && matchedTxn !== undefined && matchedTxn.originalRequest) {
              const terminated = generateResponse(matchedTxn.originalRequest, 487, "Request Terminated",
                uasToTag !== undefined ? { toTag: uasToTag } : {})
              const terminatedBuf = serialize(terminated)
              yield* sendBuffer(terminatedBuf, { host: rinfo.address, port: rinfo.port })
              yield* Effect.sync(() => {
                MutableHashMap.set(txnMap, matchedBranch!, {
                  ...matchedTxn!,
                  state: "completed",
                  lastResponse: terminatedBuf,
                  lastResponseStatus: 487,
                  originalRequest: undefined,
                  originalBuffer: undefined,
                })
              })
              // Timer H cleanup — if ACK for 487 never arrives, clean up after 32s
              yield* Effect.forkDetach(
                Effect.gen(function* () {
                  yield* Effect.sleep(Duration.millis(TIMER_H))
                  yield* deleteTxn(matchedBranch!)
                })
              )
            }

            // Emit cancelled event for SipRouter
            yield* emit({ type: "cancelled", callId, fromTag })
            return
          }

          // Duplicate detection for other requests
          if (existing !== undefined) {
            if (existing.lastResponse !== undefined) {
              // Retransmit cached response
              yield* Effect.logDebug(`Retransmit cached response for duplicate ${req.method} branch=${branch}`)
              yield* sendBuffer(existing.lastResponse, { host: rinfo.address, port: rinfo.port })
            } else {
              yield* Effect.logDebug(`Absorbing duplicate ${req.method} branch=${branch} (no response yet)`)
            }
            return
          }

          // ── Tier 3 admission gate (overload protection) ───────────────
          // Only initial INVITEs (no To-tag) are gated. Re-INVITEs always
          // carry a To-tag and are part of an existing call, so they bypass
          // the gate. Non-INVITE requests are also bypassed (they ride on
          // existing calls or are CANCEL/etc, handled above).
          if (req.method === "INVITE" && !req.parsed?.to?.tag) {
            const isEmergency = isEmergencyRequest(req)
            const decision = overload.shouldAdmit({ isEmergency })
            if (!decision.admit) {
              const respBuf = buildStatelessReject503Buffer(req.raw, decision.retryAfterSec)
              if (respBuf !== null) {
                yield* sendBuffer(respBuf, { host: rinfo.address, port: rinfo.port })
              }
              yield* Effect.logDebug(
                `Tier3 reject INVITE branch=${branch} reason=${decision.reason ?? "?"}`
              )
              return
            }
          }

          // New server transaction
          const callId = req.parsed?.callId ?? ""
          const fromTag = req.parsed?.from?.tag ?? ""
          const kind: TxnKind = req.method === "INVITE" ? "invite" : "non-invite"

          const txn: Transaction = {
            branch,
            role: "server",
            kind,
            callId,
            fromTag,
            originalRequest: req,
            lastResponse: undefined,
            lastResponseStatus: undefined,
            callRef: undefined,
            legId: undefined,
            state: "trying",
            retransmitFiber: undefined,
            timeoutFiber: undefined,
            destination: undefined,
            originalBuffer: undefined,
            createdAt: yield* Clock.currentTimeMillis,
            uasToTag: undefined,
          }
          yield* setTxn(branch, txn)

          // For INVITE, immediately send 100 Trying
          if (req.method === "INVITE") {
            const trying = generateResponse(req, 100, "Trying")
            const tryingBuf = serialize(trying)
            yield* sendBuffer(tryingBuf, { host: rinfo.address, port: rinfo.port })
            yield* Effect.sync(() => {
              const opt = MutableHashMap.get(txnMap, branch)
              if (Option.isSome(opt)) MutableHashMap.set(txnMap, branch, { ...opt.value, state: "proceeding" })
            })
          }

          yield* emit({ type: "message", message: req, rinfo })
        }
      )

      // ── Inbound response processing ─────────────────────────────────

      const handleInboundResponse = Effect.fnUntraced(
        function* (resp: SipResponse, rinfo: RemoteInfo) {
          const branch = resp.parsed?.via?.branch ?? ""
          const respCSeqMethod = resp.parsed?.cseq?.method?.toUpperCase()

          if (branch) {
            const existing = yield* findTxn(branch)
            // RFC 3261 §9.1: CANCEL reuses the INVITE's Via branch. Responses to
            // CANCEL (identified by their CSeq method) MUST NOT be matched to the
            // INVITE client transaction — doing so would tear down the INVITE txn
            // on the CANCEL's 200 OK and miss the subsequent 487 (no auto-ACK).
            // B2BUA-originated CANCELs are fire-and-forget (see SipRouter), so
            // no CANCEL client txn is tracked; we simply bypass client-txn
            // handling when the CSeq method is CANCEL and emit the message.
            if (respCSeqMethod === "CANCEL") {
              yield* emit({ type: "message", message: resp, rinfo })
              return
            }
            if (existing !== undefined && existing.role === "client") {
              if (resp.status >= 100 && resp.status < 200) {
                // Provisional — move to proceeding, stop retransmit (but keep timeout)
                yield* Effect.sync(() => {
                  const opt = MutableHashMap.get(txnMap, branch)
                  if (Option.isSome(opt)) MutableHashMap.set(txnMap, branch, { ...opt.value, state: "proceeding" })
                })
                if (existing.retransmitFiber) {
                  yield* Fiber.interrupt(existing.retransmitFiber)
                }
              } else {
                // Final response — stop timers, delete client transaction immediately.
                // Response retransmissions from b-leg UAS are handled by retransmit200Rule
                // in the rule chain, so keeping the client txn for Timer D is unnecessary.
                yield* stopTxnTimers(existing)

                // RFC 3261 §17.1.1.3: INVITE client transaction MUST generate ACK for 300-699.
                // The ACK is a hop-by-hop transaction-layer concern — not emitted to the application.
                if (existing.kind === "invite" && resp.status >= 300 && existing.originalRequest && existing.destination) {
                  const ack = _generateAckForNon2xx(existing.originalRequest, resp)
                  yield* sendBuffer(serialize(ack), existing.destination)
                  yield* Effect.logDebug(`Auto-ACK for ${resp.status} sent to ${existing.destination.host}:${existing.destination.port}`)
                }

                yield* deleteTxn(branch)
              }
            } else if (existing !== undefined && existing.role === "server") {
              // Response to a server transaction? Shouldn't happen in normal flow.
              yield* Effect.logDebug(`Response on server transaction branch=${branch} — passing through`)
            }
          }

          yield* emit({ type: "message", message: resp, rinfo })
        }
      )

      // ── Inbound packet processing ───────────────────────────────────

      // Disable auto-tracing for the packet processing loop.
      // Handlers inside are Effect.fnUntraced — the meaningful work is traced once
      // per external event via SipRouter (withProcessingSpan / withRootSpan).
      // Parse errors still get an always-sampled error span (re-enables tracing).
      yield* Effect.forkDetach(
        Stream.runForEach(transport.messages, (packet) =>
          Effect.gen(function* () {
            yield* Effect.logDebug(`SIP IN <- ${packet.rinfo.address}:${packet.rinfo.port} ${sipSummary(packet.raw)}`)
            yield* Effect.logDebug(packet.raw.toString('utf-8'))
            const maybeSip = yield* parser.parse(packet.raw).pipe(
              Effect.catchTag("SipParseError", (e) => {
                const preview = packet.raw.toString("utf-8", 0, Math.min(packet.raw.length, 500))
                return Effect.logWarning(
                  `SIP parse error from ${packet.rinfo.address}:${packet.rinfo.port}: ${e.reason}\n--- raw (${packet.raw.length} bytes) ---\n${preview}`
                ).pipe(
                  Effect.withSpan("sip.parse_error", {
                    root: true,
                    kind: "server",
                    attributes: {
                      "sip.error": e.reason,
                      "net.peer.addr": `${packet.rinfo.address}:${packet.rinfo.port}`,
                      "sip.raw_message": preview,
                    }
                  }),
                  // Re-enable tracing for the error span (outer scope disables it)
                  Effect.withTracerEnabled(true),
                  Effect.as(undefined as SipMessage | undefined)
                )
              })
            )

            if (maybeSip === undefined) return
            txnMetrics.messagesProcessed++

            if (maybeSip.type === "request") {
              yield* handleInboundRequest(maybeSip, packet.rinfo)
            } else {
              yield* handleInboundResponse(maybeSip, packet.rinfo)
            }
          }).pipe(
            Effect.withTracerEnabled(false),
            Effect.catchCause((cause) =>
              Effect.logError(`TransactionLayer unhandled error`, cause)
            )
          )
        )
      )

      // ── Outbound send API ───────────────────────────────────────────
      //
      // Split into sendRequest (returns a typed ClientTransactionHandle) and
      // sendResponse (void). The legacy `send(msg, dest, txnType)` method is
      // a thin wrapper kept for backward-compatibility until all call sites
      // are migrated in later slices.

      const sendResponse = Effect.fnUntraced(
        function* (msg: SipResponse, destination: { host: string; port: number }) {
          const buf = serialize(msg)
          const branch = extractBranch(msg)
          if (branch) {
            const isFinal = msg.status >= 200
            const outboundToTag = msg.status > 100 ? extractToTag(msg) : undefined
            let completedKind: TxnKind | undefined
            yield* Effect.sync(() => {
              const opt = MutableHashMap.get(txnMap, branch)
              if (Option.isSome(opt) && opt.value.role === "server") {
                if (isFinal) completedKind = opt.value.kind
                // RFC 3261 §17.2.1 / §12.1.1: pin the UAS To-tag on the
                // first >100 response so later auto-synthesized responses
                // (487 on CANCEL, etc.) reuse the same tag and the UAC
                // sees one coherent dialog identity.
                const uasToTag = opt.value.uasToTag ?? outboundToTag
                MutableHashMap.set(txnMap, branch, {
                  ...opt.value,
                  lastResponse: buf,
                  lastResponseStatus: msg.status,
                  state: isFinal ? "completed" : "proceeding",
                  uasToTag,
                  // Free memory on completion — only lastResponse needed for retransmit absorption
                  originalRequest: isFinal ? undefined : opt.value.originalRequest,
                  originalBuffer: isFinal ? undefined : opt.value.originalBuffer,
                })
              }
            })
            // Schedule Timer H/J cleanup for completed server transactions.
            // ACK arrival (for INVITE) or the sweep (safety net) may clean up earlier.
            if (completedKind !== undefined) {
              const delay = completedKind === "invite" ? TIMER_H : TIMER_J
              yield* Effect.forkDetach(
                Effect.gen(function* () {
                  yield* Effect.sleep(Duration.millis(delay))
                  yield* deleteTxn(branch)
                })
              )
            }
          }
          yield* sendBuffer(buf, destination)
        }
      )

      const sendRequest = Effect.fnUntraced(
        function* (
          msg: SipRequest,
          destination: { host: string; port: number },
          txnType: "invite" | "non-invite",
        ) {
          const buf = serialize(msg)
          const branch = extractBranch(msg) ?? newBranch()
          const callId = extractCallId(msg)
          const fromTag = extractFromTag(msg)
          const viaCustom = extractViaCustomParams(msg)

          const txn: Transaction = {
            branch,
            role: "client",
            kind: txnType,
            callId,
            fromTag,
            // Store original INVITE for ACK generation on non-2xx (RFC 3261 §17.1.1.3)
            originalRequest: txnType === "invite" ? msg : undefined,
            lastResponse: undefined,
            lastResponseStatus: undefined,
            state: "trying",
            retransmitFiber: undefined,
            timeoutFiber: undefined,
            destination,
            originalBuffer: buf,
            callRef: viaCustom.cr,
            legId: viaCustom.lg,
            createdAt: yield* Clock.currentTimeMillis,
            uasToTag: undefined,
          }
          yield* setTxn(branch, txn)

          // Send initial message
          yield* sendBuffer(buf, destination)

          // Start retransmission
          yield* startClientRetransmit(branch, buf, destination, txnType)

          const handle: ClientTransactionHandle = txnType === "invite"
            ? { kind: "invite", branch, originalInvite: msg, destination }
            : { kind: "non-invite", branch, originalRequest: msg, destination }
          return handle
        }
      )

      /**
       * Legacy combined send. Dispatches to sendRequest or sendResponse based
       * on txnType and discards the client-transaction handle. Prefer the
       * split methods in new code — this wrapper exists only so call sites
       * can migrate incrementally.
       */
      const send = Effect.fnUntraced(
        function* (msg: SipMessage, destination: { host: string; port: number }, txnType: "invite" | "non-invite" | "response") {
          if (txnType === "response") {
            if (msg.type !== "response") return
            yield* sendResponse(msg, destination)
            return
          }
          if (msg.type !== "request") return
          yield* sendRequest(msg, destination, txnType)
        }
      )

      const sendRaw = Effect.fnUntraced(
        function* (buf: Buffer, port: number, address: string) {
          yield* transport.send(buf, port, address).pipe(
            Effect.catchCause((cause) => Effect.logError(`TransactionLayer sendRaw error`, cause))
          )
        }
      )

      const events = Stream.fromQueue(eventQueue)

      return { events, sendRequest, sendResponse, send, sendRaw, metrics: txnMetrics }
    })
  )
}
