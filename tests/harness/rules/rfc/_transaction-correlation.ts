/**
 * Pure helpers for RFC cross-message rules whose enforcement walks a
 * per-agent event stream and correlates messages by SIP client-transaction
 * identity. The transaction key in RFC 3261 §17 is the **top-Via branch**
 * (`z9hG4bK…`) combined with the request method; for the rules in this
 * family, branch alone is sufficient because each agent's ordered event
 * stream is already partitioned per Call-ID by the projector — collisions
 * would imply a branch-uniqueness violation already surfaced by
 * `rfc.branchPrefix` / `rfc.via`.
 *
 * The helper offers a single one-pass index over an `OrderedAgentEvent[]`
 * stream that buckets sent/received × request/response by top-Via branch.
 * Rule writers then ask narrow questions: "what was the sent INVITE on
 * branch X?", "did any final response arrive on branch X?", "what is the
 * ordered list of responses received for branch X?".
 *
 * Eight planned RFC 3261 rules consume this helper today:
 *   - rfc.ackRequireSubsetOfInvite  (first consumer; this PR)
 *   - rfc.cancelRouteEchoesInvite
 *   - rfc.cancelAfter1xx
 *   - rfc.serialRegister
 *   - rfc.noReInviteWhileInviteInProgress
 *   - rfc.proxy100WithinT100ms
 *   - rfc.strictRouteRewriteHandled
 *   - rfc.ackPreservesInviteRoute
 *
 * Pure functions; no Effect, no I/O. Bucketed data is mutable during the
 * one-pass build and exposed read-only afterwards.
 */

import type {
  SipMessage,
  SipRequest,
  SipResponse,
} from "../../../../src/sip/types.js"
import type { OrderedAgentEvent } from "./_dialog-model.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentDirection = "sent" | "received"

/** All four directional buckets for a single top-Via branch. */
export interface BranchEntry {
  /** Sent requests on this branch, in insertion order. */
  readonly sentRequests: ReadonlyArray<SipRequest>
  /** Received requests on this branch, in insertion order. */
  readonly receivedRequests: ReadonlyArray<SipRequest>
  /** Sent responses on this branch, in insertion order. */
  readonly sentResponses: ReadonlyArray<SipResponse>
  /** Received responses on this branch, in insertion order. */
  readonly receivedResponses: ReadonlyArray<SipResponse>
}

/**
 * Per-branch index built from one agent's ordered event stream.
 * Lookups are by raw branch string (including the `z9hG4bK` prefix).
 */
export interface BranchIndex {
  readonly byBranch: ReadonlyMap<string, BranchEntry>
}

// ---------------------------------------------------------------------------
// Internal mutable shape for one-pass build
// ---------------------------------------------------------------------------

interface MutableBranchEntry {
  sentRequests: SipRequest[]
  receivedRequests: SipRequest[]
  sentResponses: SipResponse[]
  receivedResponses: SipResponse[]
}

const newMutableEntry = (): MutableBranchEntry => ({
  sentRequests: [],
  receivedRequests: [],
  sentResponses: [],
  receivedResponses: [],
})

const topBranch = (msg: SipMessage): string =>
  msg.getHeader("via")[0]?.branch ?? ""

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * One-pass build of the per-branch index. Events lacking a top-Via branch
 * are skipped silently — `rfc.via` / `rfc.branchPrefix` cover the
 * "missing branch" obligation; this helper does not double-report.
 */
export const buildBranchIndex = (
  events: ReadonlyArray<OrderedAgentEvent>,
): BranchIndex => {
  const byBranch = new Map<string, MutableBranchEntry>()
  for (const ev of events) {
    const branch = topBranch(ev.msg)
    if (!branch) continue
    let entry = byBranch.get(branch)
    if (!entry) {
      entry = newMutableEntry()
      byBranch.set(branch, entry)
    }
    if (ev.msg.type === "request") {
      if (ev.kind === "sent") entry.sentRequests.push(ev.msg)
      else entry.receivedRequests.push(ev.msg)
    } else {
      if (ev.kind === "sent") entry.sentResponses.push(ev.msg)
      else entry.receivedResponses.push(ev.msg)
    }
  }
  return { byBranch }
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

const requestsFor = (
  idx: BranchIndex,
  branch: string,
  agent: AgentDirection,
): ReadonlyArray<SipRequest> => {
  const entry = idx.byBranch.get(branch)
  if (!entry) return []
  return agent === "sent" ? entry.sentRequests : entry.receivedRequests
}

/**
 * Ordered iterable of all responses on `branch` in the given direction.
 * Empty array when the branch is unknown.
 */
export const responsesFor = (
  idx: BranchIndex,
  branch: string,
  agent: AgentDirection,
): ReadonlyArray<SipResponse> => {
  const entry = idx.byBranch.get(branch)
  if (!entry) return []
  return agent === "sent" ? entry.sentResponses : entry.receivedResponses
}

/**
 * The first request matching `method` on `branch` in the given direction,
 * or `undefined`. `method` matched case-insensitively.
 *
 * Branch alone identifies a client transaction per RFC 3261 §17, but a
 * branch may carry both an INVITE and its later ACK in retransmit-free
 * scenarios; restricting by method picks the intended one.
 */
export const findRequestByBranch = (
  idx: BranchIndex,
  branch: string,
  method: string,
  agent: AgentDirection,
): SipRequest | undefined => {
  const m = method.toUpperCase()
  for (const req of requestsFor(idx, branch, agent)) {
    if (req.method.toUpperCase() === m) return req
  }
  return undefined
}

/**
 * Convenience for the common INVITE lookup. Defaults to the *sent* side
 * because most rules pair "ACK we sent" with "INVITE we sent".
 */
export const findInviteByBranch = (
  idx: BranchIndex,
  branch: string,
  agent: AgentDirection = "sent",
): SipRequest | undefined => findRequestByBranch(idx, branch, "INVITE", agent)

/** True iff any final (status >= 200) response appears on `branch`. */
export const hasFinalResponseFor = (
  idx: BranchIndex,
  branch: string,
  agent: AgentDirection,
): boolean => {
  for (const r of responsesFor(idx, branch, agent)) {
    if (r.status >= 200) return true
  }
  return false
}

/**
 * The first response status seen on `branch` (1xx included), or
 * `undefined` when no response was observed.
 */
export const firstResponseStatusFor = (
  idx: BranchIndex,
  branch: string,
  agent: AgentDirection,
): number | undefined => {
  const list = responsesFor(idx, branch, agent)
  return list.length === 0 ? undefined : list[0]!.status
}

// ---------------------------------------------------------------------------
// Header utilities — option-tag parsing shared with the cross-message
// rules. Re-exported so consumers don't need a second import for the
// common case of comparing Require / Proxy-Require / Supported lists.
// ---------------------------------------------------------------------------

/**
 * Split a comma-separated option-tag header value (Require / Supported /
 * Proxy-Require / Unsupported) into normalised lower-case tags. Empty
 * pieces are dropped.
 */
export const splitOptionTags = (
  values: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const out: string[] = []
  for (const v of values) {
    for (const piece of v.split(",")) {
      const tag = piece.trim().toLowerCase()
      if (tag.length > 0) out.push(tag)
    }
  }
  return out
}
