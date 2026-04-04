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
  | "contactPresence"
  | "toTagPresence"
  | "branchPrefix"

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
  readonly contactPresence?: ValidationFn
  readonly toTagPresence?: ValidationFn
  readonly branchPrefix?: ValidationFn
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
 * CSeq validation.
 *
 * Received requests:
 *   - CANCEL/ACK: CSeq number must match the pending INVITE's CSeq
 *   - Other: CSeq must be remoteCSeq+1 (or any value if remoteCSeq uninitialized)
 *   - CSeq method field must match the request method
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
      // New request: must be remoteCSeq + 1 (or any if uninitialized)
      if (dialogState.remoteCSeq !== undefined && cseq.num !== dialogState.remoteCSeq + 1) {
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
  contactPresence: validateContactPresence,
  toTagPresence: validateToTagPresence,
  branchPrefix: validateBranchPrefix,
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
