/**
 * SIP message validation for received messages in E2E tests.
 *
 * Each check is an independent function that inspects a received message
 * against the agent's dialog state and returns an array of error strings
 * (empty = pass). Checks can be skipped or overridden per-expect-step.
 */

import type { SipMessage, SipHeader } from "../../../src/sip/types.js"
import type { AgentDialogState } from "./message-builder.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ValidationCheckName =
  | "tags"
  | "cseq"
  | "via"
  | "callId"
  | "maxForwards"
  | "contentLength"
  | "contentType"
  | "contactPresence"
  | "toTagPresence"
  | "branchPrefix"
  | "dialogUri"
  | "recordRoute"
  | "cancelRequestUri"
  | "cancelViaBranch"
  | "responseCorrelation"
  | "rackCorrelation"
  | "tagConsistency"
  | "offerAnswer"

export type ValidationFn = (
  msg: SipMessage,
  dialogState: AgentDialogState,
  correlatedRequest: SipMessage | undefined
) => string[]

export interface ValidationOverrides {
  readonly cseq?: ValidationFn
  readonly via?: ValidationFn
  readonly callId?: ValidationFn
  readonly tags?: ValidationFn
  readonly maxForwards?: ValidationFn
  readonly contentLength?: ValidationFn
  readonly contentType?: ValidationFn
  readonly contactPresence?: ValidationFn
  readonly toTagPresence?: ValidationFn
  readonly branchPrefix?: ValidationFn
  readonly dialogUri?: ValidationFn
  readonly recordRoute?: ValidationFn
  readonly cancelRequestUri?: ValidationFn
  readonly cancelViaBranch?: ValidationFn
  readonly responseCorrelation?: ValidationFn
  readonly rackCorrelation?: ValidationFn
  readonly tagConsistency?: ValidationFn
}

export interface PendingRequest {
  readonly refId: number
  readonly msg: SipMessage
  readonly method: string
  readonly cseqNumber: number
  finalResponseSent: boolean
}

export interface SentRequestRecord {
  readonly msg: SipMessage
  readonly method: string
  readonly cseqNumber: number
  readonly viaBranch: string
}

// ---------------------------------------------------------------------------
// Header extraction helpers
// ---------------------------------------------------------------------------

function getHeaderValue(headers: ReadonlyArray<SipHeader>, name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value
}

function getAllHeaderValues(headers: ReadonlyArray<SipHeader>, name: string): string[] {
  return headers.filter((h) => h.name.toLowerCase() === name.toLowerCase()).map((h) => h.value)
}

function extractTag(headerValue: string): string | undefined {
  const m = /;tag=([^\s;,>]+)/i.exec(headerValue)
  return m?.[1]
}

function extractBranch(viaValue: string): string | undefined {
  const m = /;branch=([^\s;,>]+)/i.exec(viaValue)
  return m?.[1]
}

function parseCSeq(headers: ReadonlyArray<SipHeader>): { num: number; method: string } | undefined {
  const raw = getHeaderValue(headers, "cseq")
  if (!raw) return undefined
  const parts = raw.trim().split(/\s+/)
  if (parts.length < 2) return undefined
  return { num: parseInt(parts[0]!, 10), method: parts[1]! }
}

// ---------------------------------------------------------------------------
// Individual validation checks
// ---------------------------------------------------------------------------

/**
 * Tag validation (moved from interpreter.ts).
 * - Requests received by agent: To-tag must be one of agent's localTags (if dialog established)
 * - Responses received by agent: From-tag must be one of agent's localTags
 */
function validateTags(
  msg: SipMessage,
  dialogState: AgentDialogState,
  _correlatedRequest: SipMessage | undefined
): string[] {
  const errors: string[] = []
  const toHeader = getHeaderValue(msg.headers, "to") ?? ""
  const fromHeader = getHeaderValue(msg.headers, "from") ?? ""

  if (msg.type === "request") {
    if (dialogState.remoteTag) {
      const toTag = extractTag(toHeader)
      if (toTag && !dialogState.localTags.has(toTag)) {
        const expected = [...dialogState.localTags].join(" | ")
        errors.push(
          `To tag mismatch: expected one of [${expected}] (agent's local tags) but got "${toTag}"`
        )
      }
    }
  } else {
    const fromTag = extractTag(fromHeader)
    if (fromTag !== undefined && !dialogState.localTags.has(fromTag)) {
      const expected = [...dialogState.localTags].join(" | ")
      errors.push(
        `From tag mismatch: expected one of [${expected}] (agent's local tags) but got "${fromTag}"`
      )
    }
  }

  return errors
}

/**
 * Build a dialog identity key for the per-dialog CSeq counter.
 *
 * RFC 3261 §12.1 identifies a dialog by `(Call-ID, local-tag, remote-tag)`.
 * For the receiving agent the "local" tag on a received request is the
 * To-tag and the "remote" tag is the From-tag. Including both tags keeps
 * forked early dialogs distinct (each fork has its own To-tag).
 *
 * Returns undefined when either tag is missing — i.e. out-of-dialog
 * requests like the initial INVITE or CANCEL — so per-dialog validation
 * is skipped for those.
 */
function dialogKey(msg: SipMessage): string | undefined {
  const callId = getHeaderValue(msg.headers, "call-id")
  if (!callId) return undefined
  const fromTag = extractTag(getHeaderValue(msg.headers, "from") ?? "")
  const toTag = extractTag(getHeaderValue(msg.headers, "to") ?? "")
  if (!fromTag || !toTag) return undefined
  return `${callId}|${fromTag}|${toTag}`
}

/**
 * CSeq validation.
 *
 * Received requests:
 *   - CANCEL/ACK: CSeq number must match the pending INVITE's CSeq
 *   - In-dialog (has both tags): CSeq must be strictly monotonic per dialog
 *     (first request in dialog = INVITE baseline + 1; subsequent = prev + 1).
 *     Forked early dialogs each have their own sequence (RFC 3261 §12.2.1.1).
 *   - Out-of-dialog (no tag pair, e.g. initial INVITE): any value accepted.
 *   - CSeq method field must match the request method.
 *
 * Received responses:
 *   - CSeq number+method must match the correlated sent request
 */
function validateCSeq(
  msg: SipMessage,
  dialogState: AgentDialogState,
  correlatedRequest: SipMessage | undefined
): string[] {
  const errors: string[] = []
  const cseq = parseCSeq(msg.headers)

  if (!cseq) {
    errors.push("Missing or malformed CSeq header")
    return errors
  }

  if (msg.type === "request") {
    // CSeq method must match the request method
    if (cseq.method !== msg.method) {
      errors.push(
        `CSeq method mismatch: request method is "${msg.method}" but CSeq method is "${cseq.method}"`
      )
    }

    if (msg.method === "CANCEL" || msg.method === "ACK") {
      // CANCEL and ACK must reuse the INVITE's CSeq number.
      // Both may arrive after the INVITE already has a final response
      // (ACK for 2xx, or CANCEL crossing with a final response),
      // so search all INVITEs regardless of finalResponseSent.
      // Use findLast to match the most recent INVITE (handles re-INVITEs).
      const pendingInvite = dialogState.pendingRequests.findLast(
        (p) => p.method === "INVITE"
      )
      if (pendingInvite && cseq.num !== pendingInvite.cseqNumber) {
        errors.push(
          `CSeq number mismatch: ${msg.method} has CSeq ${cseq.num} but INVITE had ${pendingInvite.cseqNumber}`
        )
      }
    } else {
      const key = dialogKey(msg)
      if (key !== undefined) {
        const callId = getHeaderValue(msg.headers, "call-id") ?? ""
        const prior = dialogState.remoteCSeqByDialog.get(key)
        const baseline = dialogState.inviteCSeqByCallId.get(callId)
        const expected = prior !== undefined
          ? prior + 1
          : baseline !== undefined
            ? baseline + 1
            : undefined
        if (expected !== undefined && cseq.num !== expected) {
          const anchor = prior !== undefined
            ? `prior in-dialog CSeq ${prior}`
            : `INVITE baseline ${baseline}`
          errors.push(
            `Per-dialog CSeq out of sequence for ${msg.method} (dialog ${key}): ` +
            `expected ${expected} (${anchor} + 1) but got ${cseq.num} — ` +
            `RFC 3261 §12.2.1.1 (CSeq is scoped to the dialog; forked early dialogs ` +
            `each maintain an independent sequence).`
          )
        }
      } else if (dialogState.remoteCSeq !== undefined && cseq.num !== dialogState.remoteCSeq + 1) {
        // Out-of-dialog fallback (no tag pair): retain legacy single-counter check.
        errors.push(
          `CSeq out of sequence: expected ${dialogState.remoteCSeq + 1} but got ${cseq.num}`
        )
      }
    }
  } else {
    // Response: CSeq must match the sent request
    if (correlatedRequest) {
      const sentCSeq = parseCSeq(correlatedRequest.headers)
      if (sentCSeq) {
        if (cseq.num !== sentCSeq.num) {
          errors.push(
            `Response CSeq number ${cseq.num} does not match sent request CSeq ${sentCSeq.num}`
          )
        }
        if (cseq.method !== sentCSeq.method) {
          errors.push(
            `Response CSeq method "${cseq.method}" does not match sent request method "${sentCSeq.method}"`
          )
        }
      }
    }
  }

  return errors
}

/**
 * Via validation — responses only.
 *
 * - Topmost Via branch must match the branch the agent sent
 * - Via count must equal the count the agent sent
 */
function validateVia(
  msg: SipMessage,
  _dialogState: AgentDialogState,
  correlatedRequest: SipMessage | undefined
): string[] {
  // Only validate responses
  if (msg.type === "request") return []

  const errors: string[] = []
  const responseVias = getAllHeaderValues(msg.headers, "via")

  if (correlatedRequest) {
    const sentVias = getAllHeaderValues(correlatedRequest.headers, "via")

    // Topmost Via branch must match
    if (responseVias.length > 0 && sentVias.length > 0) {
      const responseBranch = extractBranch(responseVias[0]!)
      const sentBranch = extractBranch(sentVias[0]!)
      if (responseBranch && sentBranch && responseBranch !== sentBranch) {
        errors.push(
          `Via branch mismatch: response has "${responseBranch}" but we sent "${sentBranch}"`
        )
      }
    }

    // Via count must match
    if (responseVias.length !== sentVias.length) {
      errors.push(
        `Via count mismatch: response has ${responseVias.length} Via(s) but sent request had ${sentVias.length}`
      )
    }
  }

  return errors
}

/**
 * Call-ID validation.
 * Once established in dialog, Call-ID must remain consistent.
 */
function validateCallId(
  msg: SipMessage,
  dialogState: AgentDialogState,
  _correlatedRequest: SipMessage | undefined
): string[] {
  const callId = getHeaderValue(msg.headers, "call-id")
  if (!callId) return ["Missing Call-ID header"]

  // Only enforce consistency after Call-ID has been confirmed by a received message.
  // B-side agents have a locally generated Call-ID that gets replaced on first INVITE.
  if (dialogState.callIdConfirmed && callId !== dialogState.callId) {
    return [`Call-ID mismatch: expected "${dialogState.callId}" but got "${callId}"`]
  }

  return []
}

/**
 * Max-Forwards validation — requests only.
 * RFC 3261 §8.1.1.6: Max-Forwards must be present on all requests.
 */
function validateMaxForwards(
  msg: SipMessage,
  _dialogState: AgentDialogState,
  _correlatedRequest: SipMessage | undefined
): string[] {
  if (msg.type !== "request") return []

  const mf = getHeaderValue(msg.headers, "max-forwards")
  if (mf === undefined) {
    return ["Missing Max-Forwards header on request"]
  }

  const val = parseInt(mf, 10)
  if (!Number.isFinite(val) || val < 0 || val > 255) {
    return [`Invalid Max-Forwards value: "${mf}"`]
  }

  // Max-Forwards should be <= 70. Values above 70 indicate a bug;
  // values below are expected after B2BUA/proxy decrement.
  if (val > 70) {
    return [`Max-Forwards is ${val}, exceeds 70 — per RFC 3261 §8.1.1.6`]
  }

  return []
}

/**
 * Content-Length validation.
 * RFC 3261 §20.14: Content-Length must match actual body size.
 */
function validateContentLength(
  msg: SipMessage,
  _dialogState: AgentDialogState,
  _correlatedRequest: SipMessage | undefined
): string[] {
  const cl = getHeaderValue(msg.headers, "content-length")
  if (cl === undefined) return [] // Not required on UDP, but if present must be correct

  const declared = parseInt(cl, 10)
  if (!Number.isFinite(declared) || declared < 0) {
    return [`Invalid Content-Length value: "${cl}"`]
  }

  const actualSize = msg.body.byteLength
  if (declared !== actualSize) {
    return [`Content-Length mismatch: header says ${declared} but body is ${actualSize} bytes`]
  }

  return []
}

/**
 * Content-Type validation.
 * RFC 3261 §7.4.1: If a request/response contains a message body,
 * the Content-Type header field MUST be present.
 */
function validateContentType(
  msg: SipMessage,
  _dialogState: AgentDialogState,
  _correlatedRequest: SipMessage | undefined
): string[] {
  if (msg.body.byteLength === 0) return []

  const ct = getHeaderValue(msg.headers, "content-type")
  if (!ct) {
    return ["Missing Content-Type header on message with body (required by RFC 3261 §7.4.1)"]
  }

  return []
}

/**
 * Contact presence validation — requests that establish dialogs.
 * RFC 3261 §8.1.1.8: INVITE and SUBSCRIBE requests MUST contain a Contact header.
 */
function validateContactPresence(
  msg: SipMessage,
  _dialogState: AgentDialogState,
  _correlatedRequest: SipMessage | undefined
): string[] {
  if (msg.type !== "request") return []

  const dialogEstablishingMethods = new Set(["INVITE", "SUBSCRIBE"])
  if (!dialogEstablishingMethods.has(msg.method)) return []

  const contact = getHeaderValue(msg.headers, "contact")
  if (!contact) {
    return [`Missing Contact header on ${msg.method} request (required for dialog-establishing methods)`]
  }

  return []
}

/**
 * To-tag presence validation — responses >= 101.
 * RFC 3261 §8.2.6.2: UAS MUST add a tag to the To header of responses (except 100 Trying).
 */
function validateToTagPresence(
  msg: SipMessage,
  _dialogState: AgentDialogState,
  _correlatedRequest: SipMessage | undefined
): string[] {
  if (msg.type !== "response") return []
  if (msg.status <= 100) return []

  const toHeader = getHeaderValue(msg.headers, "to")
  if (!toHeader) return ["Missing To header on response"]

  const tag = extractTag(toHeader)
  if (!tag) {
    return [`Missing To-tag on ${msg.status} response (required for responses > 100 per RFC 3261 §8.2.6.2)`]
  }

  return []
}

/**
 * Via branch prefix validation.
 * RFC 3261 §8.1.1.7: Branch parameter MUST start with "z9hG4bK" (magic cookie).
 */
function validateBranchPrefix(
  msg: SipMessage,
  _dialogState: AgentDialogState,
  _correlatedRequest: SipMessage | undefined
): string[] {
  const errors: string[] = []
  const vias = getAllHeaderValues(msg.headers, "via")

  for (const via of vias) {
    const branch = extractBranch(via)
    if (branch && !branch.startsWith("z9hG4bK")) {
      errors.push(
        `Via branch "${branch}" missing RFC 3261 magic cookie prefix "z9hG4bK"`
      )
    }
  }

  return errors
}

/**
 * Dialog URI consistency validation.
 * RFC 3261 §12.2.1.1: Within a dialog, the From URI MUST be set to the
 * local URI and the To URI MUST be set to the remote URI from the dialog state.
 *
 * For received requests: the From URI should match the remote party's URI
 * that was established when the dialog was created (from the initial INVITE).
 */
function validateDialogUri(
  msg: SipMessage,
  dialogState: AgentDialogState,
  _correlatedRequest: SipMessage | undefined
): string[] {
  // Only validate once dialog is established (remoteTag set) and we know the remote URI
  if (!dialogState.remoteTag) return []
  if (!dialogState.dialogRemoteUri) return []
  if (msg.type !== "request") return []

  const errors: string[] = []
  const fromHeader = getHeaderValue(msg.headers, "from") ?? ""
  const fromUri = extractUriFromNameAddr(fromHeader)

  if (fromUri && fromUri !== dialogState.dialogRemoteUri) {
    errors.push(
      `From URI "${fromUri}" differs from dialog-established URI "${dialogState.dialogRemoteUri}" (RFC 3261 §12.2.1.1)`
    )
  }

  return errors
}

/** Extract the URI from a Name-Addr or addr-spec header value (e.g., `<sip:alice@test>;tag=x` → `sip:alice@test`). */
function extractUriFromNameAddr(headerValue: string): string | undefined {
  const m = /<([^>]+)>/.exec(headerValue)
  return m?.[1]
}

/**
 * Record-Route validation for B2BUA-originated messages.
 * RFC 3261 §16.6: Record-Route is a proxy mechanism.
 * A B2BUA (which acts as a UA) MUST NOT insert Record-Route.
 *
 * Detects Record-Route headers containing B2BUA markers (callRef=, leg=)
 * on received requests. Responses may legitimately echo Record-Route
 * from requests, so this check only applies to requests.
 */
function validateRecordRoute(
  msg: SipMessage,
  _dialogState: AgentDialogState,
  _correlatedRequest: SipMessage | undefined
): string[] {
  if (msg.type !== "request") return []

  const rrHeaders = getAllHeaderValues(msg.headers, "record-route")
  const b2buaRRs = rrHeaders.filter((v) => v.includes("callRef=") || v.includes("leg="))

  if (b2buaRRs.length > 0) {
    return [
      `B2BUA inserted Record-Route in request — B2BUAs are UAs and MUST NOT use Record-Route (RFC 3261 §16.6). Found: ${b2buaRRs[0]}`
    ]
  }

  return []
}

/**
 * CANCEL Request-URI validation.
 * RFC 3261 §9.1: The Request-URI of the CANCEL request MUST be identical
 * to the Request-URI of the request being cancelled (the INVITE).
 */
function validateCancelRequestUri(
  msg: SipMessage,
  dialogState: AgentDialogState,
  _correlatedRequest: SipMessage | undefined
): string[] {
  if (msg.type !== "request" || msg.method !== "CANCEL") return []
  if (!dialogState.receivedInviteUri) return []

  if (msg.uri !== dialogState.receivedInviteUri) {
    return [
      `CANCEL Request-URI "${msg.uri}" differs from INVITE Request-URI "${dialogState.receivedInviteUri}" — RFC 3261 §9.1`
    ]
  }

  return []
}

/**
 * CANCEL Via branch validation.
 * RFC 3261 §9.1: The CANCEL request MUST have a single Via header field
 * value matching the top Via header field of the request being cancelled.
 */
function validateCancelViaBranch(
  msg: SipMessage,
  dialogState: AgentDialogState,
  _correlatedRequest: SipMessage | undefined
): string[] {
  if (msg.type !== "request" || msg.method !== "CANCEL") return []
  if (!dialogState.receivedInviteBranch) return []

  const cancelVia = getAllHeaderValues(msg.headers, "via")
  if (cancelVia.length === 0) return []

  const cancelBranch = extractBranch(cancelVia[0]!)
  if (!cancelBranch) return []

  if (cancelBranch !== dialogState.receivedInviteBranch) {
    return [
      `CANCEL Via branch "${cancelBranch}" differs from INVITE Via branch "${dialogState.receivedInviteBranch}" — RFC 3261 §9.1`
    ]
  }

  return []
}

/**
 * RAck correlation validation (RFC 3262 §7.2).
 * The CSeq component of an incoming PRACK's RAck header must reference the
 * CSeq of the request (INVITE or re-INVITE) we sent that produced the
 * outstanding reliable 1xx. If we never sent a request with that CSeq+method,
 * the PRACK cannot be matched to any reliable-1xx transaction on our side.
 */
function validateRackCorrelation(
  msg: SipMessage,
  dialogState: AgentDialogState,
  _correlatedRequest: SipMessage | undefined
): string[] {
  if (msg.type !== "request" || msg.method !== "PRACK") return []
  const rack = getHeaderValue(msg.headers, "rack")
  if (!rack) return []

  const parts = rack.trim().split(/\s+/)
  if (parts.length < 3) return [`Malformed RAck header: "${rack}"`]

  const cseqNum = parseInt(parts[1]!, 10)
  const method = parts[2]!.toUpperCase()
  if (!Number.isFinite(cseqNum)) return [`Invalid RAck CSeq number: "${parts[1]}"`]

  // We (the agent) should have received a request of that method with that CSeq
  // (it's the request WE sent in our role as UAS receiving the INVITE). Check
  // against our pendingRequests — the INVITE we received lives there.
  const matched = dialogState.pendingRequests.find(
    (p) => p.method === method && p.cseqNumber === cseqNum
  )
  if (!matched) {
    const received = dialogState.pendingRequests
      .filter((p) => p.method === method)
      .map((p) => p.cseqNumber)
      .join(", ") || "none"
    return [
      `RAck CSeq ${cseqNum} ${method} does not match any received ${method} CSeq [${received}] — RFC 3262 §7.2`,
    ]
  }

  return []
}

/**
 * Response correlation validation.
 * RFC 3261 §8.1.3.3 / §17.1.3: A response's CSeq number and method MUST echo
 * the request that generated it. If we sent at least one request of this method
 * but no sent request matches this response's CSeq number, the peer is replying
 * to a phantom request — the 200/PRACK CSeq-not-echoed anomaly.
 *
 * Orthogonal to validateCSeq: that check silently passes when correlation fails;
 * this one errors explicitly so anomalies like C2 in the anomaly report are
 * reported automatically rather than slipping through.
 */
function validateResponseCorrelation(
  msg: SipMessage,
  dialogState: AgentDialogState,
  correlatedRequest: SipMessage | undefined
): string[] {
  if (msg.type !== "response") return []
  if (correlatedRequest !== undefined) return []

  const cseq = parseCSeq(msg.headers)
  if (!cseq) return []

  // Only flag when we have sent at least one request with the same method.
  // Otherwise the response may be for a request we never tracked (rare; and
  // if we never sent that method, the CSeq method mismatch is its own error).
  const sentSameMethod = dialogState.sentRequests.filter((r) => r.method === cseq.method)
  if (sentSameMethod.length === 0) return []

  const sentNums = sentSameMethod.map((r) => r.cseqNumber).join(", ")
  return [
    `Response CSeq ${cseq.num} ${cseq.method} does not echo any sent ${cseq.method} CSeq [${sentNums}] — RFC 3261 §8.1.3.3`,
  ]
}

/**
 * UAS tag consistency across final responses (RFC 3261 §17.2.1 / §12.1.1).
 *
 * Provisional 1xx>100 responses on a single server transaction may legitimately
 * introduce multiple To-tags when forking occurs (each fork establishes its own
 * early dialog — RFC 3261 §13.2.2.4). A final response (>=200), however, must
 * tie the transaction to exactly one dialog: its To-tag must match one of the
 * To-tags already established by a prior provisional, OR — if no provisional
 * was sent — introduce the dialog's tag.
 *
 * This flags the "cancel" anomaly: 180 with tag X then 487 with fresh tag Y on
 * the same branch (the UAS manufactured a new tag for 487 instead of echoing
 * the 180 tag), and the 200-OK-CANCEL that carries yet another fresh tag.
 */
function validateTagConsistency(
  msg: SipMessage,
  dialogState: AgentDialogState,
  _correlatedRequest: SipMessage | undefined
): string[] {
  if (msg.type !== "response") return []
  if (msg.status < 200) return []

  const myVias = getAllHeaderValues(msg.headers, "via")
  if (myVias.length === 0) return []
  const myBranch = extractBranch(myVias[0]!)
  if (!myBranch) return []

  const myTag = extractTag(getHeaderValue(msg.headers, "to") ?? "")
  if (!myTag) return []

  const priorProvisionalTags: string[] = []
  for (const prior of dialogState.messagesByRef.values()) {
    if (prior === msg) continue
    if (prior.type !== "response") continue
    if (prior.status <= 100 || prior.status >= 200) continue
    const priorVias = getAllHeaderValues(prior.headers, "via")
    if (priorVias.length === 0) continue
    if (extractBranch(priorVias[0]!) !== myBranch) continue
    const priorTag = extractTag(getHeaderValue(prior.headers, "to") ?? "")
    if (priorTag) priorProvisionalTags.push(priorTag)
  }

  if (priorProvisionalTags.length === 0) return []
  if (priorProvisionalTags.includes(myTag)) return []

  return [
    `UAS To-tag mismatch on ${msg.status} (branch ${myBranch}): prior provisional(s) established tag(s) [${[...new Set(priorProvisionalTags)].join(", ")}] but final carries "${myTag}" — RFC 3261 §17.2.1 / §12.1.1`,
  ]
}

// ---------------------------------------------------------------------------
// Default check registry
// ---------------------------------------------------------------------------

const defaultChecks: Record<ValidationCheckName, ValidationFn> = {
  tags: validateTags,
  cseq: validateCSeq,
  via: validateVia,
  callId: validateCallId,
  maxForwards: validateMaxForwards,
  contentLength: validateContentLength,
  contentType: validateContentType,
  contactPresence: validateContactPresence,
  toTagPresence: validateToTagPresence,
  branchPrefix: validateBranchPrefix,
  dialogUri: validateDialogUri,
  recordRoute: validateRecordRoute,
  cancelRequestUri: validateCancelRequestUri,
  cancelViaBranch: validateCancelViaBranch,
  responseCorrelation: validateResponseCorrelation,
  rackCorrelation: validateRackCorrelation,
  tagConsistency: validateTagConsistency,
  // offerAnswer is enforced by OfferAnswerTracker in the interpreter, not here;
  // the entry exists only so skipValidation: ["offerAnswer"] typechecks.
  offerAnswer: () => [],
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export function runValidationChecks(
  msg: SipMessage,
  dialogState: AgentDialogState,
  correlatedRequest: SipMessage | undefined,
  skipSet: ReadonlySet<ValidationCheckName>,
  overrides: ValidationOverrides | undefined,
  errors: string[]
): void {
  for (const [name, defaultFn] of Object.entries(defaultChecks) as Array<[ValidationCheckName, ValidationFn]>) {
    if (skipSet.has(name)) continue
    const fn = overrides?.[name] ?? defaultFn
    const checkErrors = fn(msg, dialogState, correlatedRequest)
    errors.push(...checkErrors)
  }
}

// ---------------------------------------------------------------------------
// Response correlation
// ---------------------------------------------------------------------------

/**
 * Find the sent request that matches a received response by CSeq number + method.
 * Returns the most recent match (reverse search).
 */
export function correlateResponse(
  msg: SipMessage,
  dialogState: AgentDialogState
): SipMessage | undefined {
  if (msg.type !== "response") return undefined

  const cseq = parseCSeq(msg.headers)
  if (!cseq) return undefined

  // Reverse search — most recent sent request with matching CSeq
  for (let i = dialogState.sentRequests.length - 1; i >= 0; i--) {
    const record = dialogState.sentRequests[i]!
    if (record.cseqNumber === cseq.num && record.method === cseq.method) {
      return record.msg
    }
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Auto-resolution of inResponseTo
// ---------------------------------------------------------------------------

/**
 * Auto-resolve the pending request to respond to.
 * Returns the refId of the single pending request, or throws on ambiguity/none.
 */
export function autoResolveInResponseTo(
  agentName: string,
  dialogState: AgentDialogState
): number {
  const pending = dialogState.pendingRequests.filter((p) => !p.finalResponseSent)
  if (pending.length === 0) {
    throw new Error(`No pending requests for "${agentName}" to respond to`)
  }
  if (pending.length === 1) {
    return pending[0]!.refId
  }
  const methods = pending.map((p) => p.method).join(", ")
  throw new Error(
    `Ambiguous: "${agentName}" has ${pending.length} pending requests [${methods}]. Use explicit inResponseTo.`
  )
}
