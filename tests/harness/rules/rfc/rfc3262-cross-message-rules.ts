/**
 * RFC 3262 cross-message rules. Rules covering reliable provisional
 * response (PRACK) MUSTs from the RFC 3262 inventory whose enforcement
 * spans more than one message land here, separate from the RFC 3261
 * pack. Each rule plugs into the same `CrossMessageRule` interface and
 * `adaptCrossMessageRule` plumbing.
 */

import { Effect, Result } from "effect"
import type { LaneKey } from "../../../../src/test-harness/framework/report-recorder/types.js"
import type { CrossMessageAuditRule } from "../../../../src/sip/SignalingNetwork.contracts.js"
import {
  adaptCrossMessageRule,
  type CrossMessageRule,
  orderedFromSlot,
} from "./cross-message-rules.js"
import { getAllHeaderValues } from "./_dialog-model.js"

// ---------------------------------------------------------------------------
// rfc.requireReliable1xxOnRequire
//
// RFC 3262 §3 / RFC3262-MUST-001 + RFC3262-MUST-002: a UAS receiving an
// INVITE whose Require header lists `100rel` MUST honour the obligation
// — every non-100 1xx response on that transaction MUST be sent reliably
// (carrying `Require: 100rel` AND `RSeq`). If the UAS does not support
// 100rel, it MUST instead reject the INVITE with a 420 (Bad Extension)
// response carrying `Unsupported: 100rel`. This single rule asserts the
// disjunction: either every 1xx is reliable OR a conforming 420 was
// sent.
//
// Per-agent walk: index received INVITEs that carry `Require: 100rel` by
// top-Via branch + Call-ID. For each such INVITE, inspect the agent's
// sent responses on the same branch — if any sent response is 420 with
// `Unsupported: 100rel`, the M-002 leg is satisfied; otherwise, every
// sent non-100 1xx (101-199) MUST carry both `Require: 100rel` and
// `RSeq`. INVITE retransmits reuse the same Via top-branch, so the
// per-branch dedup naturally handles them.
//
// Regression-only: no current fixture INVITEs with `Require:100rel`
// against a non-supporting UAS; rule trips if the reliable 1xx contract
// is violated. Covers both MUST-001 (must send reliable) and MUST-002
// (must 420 if unsupported).
// ---------------------------------------------------------------------------

const collectOptionTags = (values: ReadonlyArray<string>): string[] => {
  const out: string[] = []
  for (const v of values) {
    for (const piece of v.split(",")) {
      const tag = piece.trim().toLowerCase()
      if (tag.length > 0) out.push(tag)
    }
  }
  return out
}

const hasOptionTag = (
  headers: ReadonlyArray<{ name: string; value: string }>,
  header: string,
  tag: string,
): boolean =>
  collectOptionTags(getAllHeaderValues(headers, header)).includes(tag)

export const requireReliable1xxOnRequireRule: CrossMessageRule = {
  name: "rfc.requireReliable1xxOnRequire",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          // Per-Via-branch index of received INVITEs that carry
          // Require: 100rel, plus the agent's sent responses on the
          // same branch.
          const requiringInviteByBranch = new Map<
            string,
            { callId: string }
          >()
          // Tracks whether the agent emitted a conforming 420 / Unsupported:100rel
          // for the branch (M-002 satisfaction).
          const satisfied420ByBranch = new Set<string>()
          // Per-branch list of sent non-100 1xx responses that violate
          // the reliable-1xx shape (lack Require:100rel or RSeq).
          const violationsByBranch = new Map<
            string,
            Array<{ status: number }>
          >()

          for (const ev of events) {
            const msg = ev.msg
            if (
              ev.kind === "received" &&
              msg.type === "request" &&
              msg.method.toUpperCase() === "INVITE"
            ) {
              if (!hasOptionTag(msg.headers, "require", "100rel")) continue
              const branch = msg.getHeader("via")[0]?.branch ?? ""
              if (!branch) continue
              if (!requiringInviteByBranch.has(branch)) {
                requiringInviteByBranch.set(branch, {
                  callId: msg.getHeader("call-id"),
                })
              }
              continue
            }
            if (ev.kind !== "sent" || msg.type !== "response") continue
            if (msg.getHeader("cseq").method.toUpperCase() !== "INVITE") continue
            const branch = msg.getHeader("via")[0]?.branch ?? ""
            if (!branch) continue
            if (!requiringInviteByBranch.has(branch)) continue

            if (
              msg.status === 420 &&
              hasOptionTag(msg.headers, "unsupported", "100rel")
            ) {
              satisfied420ByBranch.add(branch)
              continue
            }
            if (msg.status <= 100 || msg.status >= 200) continue
            const reliable =
              hasOptionTag(msg.headers, "require", "100rel") &&
              getAllHeaderValues(msg.headers, "rseq").length > 0
            if (reliable) continue
            let list = violationsByBranch.get(branch)
            if (!list) {
              list = []
              violationsByBranch.set(branch, list)
            }
            list.push({ status: msg.status })
          }

          for (const [branch, info] of requiringInviteByBranch) {
            if (satisfied420ByBranch.has(branch)) continue
            const violations = violationsByBranch.get(branch)
            if (!violations || violations.length === 0) continue
            for (const v of violations) {
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `INVITE required 100rel (callId ${info.callId}, branch ` +
                  `${branch}) but sent 1xx response ${v.status} lacks ` +
                  `Require:100rel/RSeq and no 420 Unsupported:100rel was ` +
                  `sent — RFC 3262 §3 / RFC3262-MUST-001/-002`,
              })
            }
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.reliableNeedsClientOptIn
//
// RFC 3262 §3 / RFC3262-MUST-004: a UAS MUST NOT send a reliable 1xx
// response (Require:100rel + RSeq) unless the matching INVITE carried
// `Supported: 100rel` OR `Require: 100rel`. Without client opt-in (or
// requirement), the UAS has no licence to engage the PRACK machinery.
//
// Per-agent walk: index received INVITEs by top-Via branch and note
// their `Supported:`/`Require:` option tags. For each sent reliable 1xx
// (status 101-199 with `Require: 100rel`), look up the matched INVITE
// by branch — fire if that INVITE listed `100rel` in neither header.
//
// Regression-only: current fixtures only send reliable 1xx when the
// matched INVITE opts in; rule trips on UAS-emitted reliable 1xx
// without client consent.
// ---------------------------------------------------------------------------

export const reliableNeedsClientOptInRule: CrossMessageRule = {
  name: "rfc.reliableNeedsClientOptIn",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          // Per-Via-branch index of received INVITEs and whether they
          // opted into 100rel (via Supported or Require).
          const inviteOptInByBranch = new Map<string, boolean>()

          for (const ev of events) {
            const msg = ev.msg
            if (
              ev.kind === "received" &&
              msg.type === "request" &&
              msg.method.toUpperCase() === "INVITE"
            ) {
              const branch = msg.getHeader("via")[0]?.branch ?? ""
              if (!branch) continue
              if (inviteOptInByBranch.has(branch)) continue
              const optIn =
                hasOptionTag(msg.headers, "supported", "100rel") ||
                hasOptionTag(msg.headers, "require", "100rel")
              inviteOptInByBranch.set(branch, optIn)
              continue
            }
            if (ev.kind !== "sent" || msg.type !== "response") continue
            if (msg.getHeader("cseq").method.toUpperCase() !== "INVITE") continue
            if (msg.status <= 100 || msg.status >= 200) continue
            if (!hasOptionTag(msg.headers, "require", "100rel")) continue
            const branch = msg.getHeader("via")[0]?.branch ?? ""
            if (!branch) continue
            const optIn = inviteOptInByBranch.get(branch)
            if (optIn === undefined || optIn) continue
            out.push({
              bindKey: slot.bindKey,
              detail:
                `Sent reliable 1xx (status ${msg.status}, callId ` +
                `${msg.getHeader("call-id")}, branch ${branch}) — matching ` +
                `INVITE neither Supported:100rel nor Require:100rel ` +
                `(RFC 3262 §3 / RFC3262-MUST-004)`,
            })
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.noReliable1xxOnInDialog
//
// RFC 3262 §3 / RFC3262-MUST-005: a UAS (or proxy) MUST NOT send a
// reliable 1xx (Require:100rel) in response to a request that carries a
// To-tag — i.e. a mid-dialog re-INVITE or similar in-dialog request.
//
// Per-agent walk: index received requests by top-Via branch, recording
// whether the request carried a To-tag (in-dialog). For each sent 1xx
// response (101-199) with `Require: 100rel`, look up the matched
// request by branch; fire if the matched request carried a To-tag.
//
// Regression-only — Phase 1 scope decision originally requested a
// positive fixture (Bob sending reliable 18x on a re-INVITE);
// deferred until cross-message rule unit-test infrastructure exists.
// The deferred-fail path is exercised in full-stack tests that include
// re-INVITE flows; no current fixture violates this MUST.
// ---------------------------------------------------------------------------

export const noReliable1xxOnInDialogRule: CrossMessageRule = {
  name: "rfc.noReliable1xxOnInDialog",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          // Per-Via-branch index of received requests: tracks whether
          // the request carried a To-tag (in-dialog) and the method.
          const requestByBranch = new Map<
            string,
            { inDialog: boolean; method: string }
          >()

          for (const ev of events) {
            const msg = ev.msg
            if (ev.kind === "received" && msg.type === "request") {
              const branch = msg.getHeader("via")[0]?.branch ?? ""
              if (!branch) continue
              if (requestByBranch.has(branch)) continue
              requestByBranch.set(branch, {
                inDialog: msg.getHeader("to").tag !== undefined,
                method: msg.method.toUpperCase(),
              })
              continue
            }
            if (ev.kind !== "sent" || msg.type !== "response") continue
            if (msg.status <= 100 || msg.status >= 200) continue
            if (!hasOptionTag(msg.headers, "require", "100rel")) continue
            const branch = msg.getHeader("via")[0]?.branch ?? ""
            if (!branch) continue
            const req = requestByBranch.get(branch)
            if (!req || !req.inDialog) continue
            out.push({
              bindKey: slot.bindKey,
              detail:
                `Sent reliable 1xx on in-dialog request (status ` +
                `${msg.status}, callId ${msg.getHeader("call-id")}, ` +
                `branch ${branch}, method ${req.method}) — forbidden ` +
                `per RFC 3262 §3 / RFC3262-MUST-005`,
            })
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.unmatchedPrackProxied
//
// RFC 3262 §3 / RFC3262-MUST-006: a proxy receiving a PRACK that does
// not match any locally-known reliable 1xx MUST forward it (not
// absorb).
//
// Heuristic per-slot walk: index received PRACKs by RAck triple
// (response-num, CSeq-num, method) and the set of received reliable 1xx
// RSeq numbers within the slot's INVITE branch. For each received
// PRACK, if its RAck.response-num matches no observed received reliable
// 1xx RSeq in this slot AND no PRACK with the same RAck triple was
// emitted (sent) by the agent → flag as "absorbed".
//
// This view is necessarily loose: "forwarded" is observable here only
// as "the proxy also sent a PRACK with matching RAck on its other
// bind" — the slot is per-(bindKey, dialog) so a forwarded PRACK on a
// different outbound interface may not appear in the same slot at all.
// The rule trades precision for the regression-tripwire shape; a
// fixture that genuinely absorbs unmatched PRACKs will fire it across
// every audited slot.
//
// Regression-only — heuristic check (per-slot view of "forwarding" is
// loose); no current proxy fixture absorbs unmatched PRACKs.
// ---------------------------------------------------------------------------

const rackKey = (responseNum: number, cseqNum: number, method: string): string =>
  `${responseNum}\x00${cseqNum}\x00${method.toUpperCase()}`

export const unmatchedPrackProxiedRule: CrossMessageRule = {
  name: "rfc.unmatchedPrackProxied",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          // Set of RSeq values observed on received reliable 1xx in
          // this slot.
          const receivedReliable1xxRseqs = new Set<number>()
          // Set of RAck triples on PRACKs the agent emitted within this
          // slot (proxy's outbound side, observable when same bind acts
          // as both inbound and outbound for the dialog).
          const sentPrackRacks = new Set<string>()
          // Received PRACKs with their RAck triple — checked at end.
          const receivedPracks: Array<{
            rack: { rseq: number; seq: number; method: string }
            rackRaw: string
            callId: string
            branch: string
          }> = []

          for (const ev of events) {
            const msg = ev.msg
            if (ev.kind === "received" && msg.type === "response") {
              if (msg.status <= 100 || msg.status >= 200) continue
              const rseqValues = getAllHeaderValues(msg.headers, "rseq")
              for (const raw of rseqValues) {
                const n = parseInt(raw.trim(), 10)
                if (Number.isFinite(n)) receivedReliable1xxRseqs.add(n)
              }
              continue
            }
            if (msg.type !== "request" || msg.method.toUpperCase() !== "PRACK") continue
            const rackRes = msg.getHeader("rack")
            if (Result.isFailure(rackRes)) continue
            const rack = rackRes.success
            if (rack === undefined) continue
            const key = rackKey(rack.rseq, rack.seq, rack.method)
            if (ev.kind === "sent") {
              sentPrackRacks.add(key)
              continue
            }
            receivedPracks.push({
              rack: { rseq: rack.rseq, seq: rack.seq, method: rack.method },
              rackRaw: `${rack.rseq} ${rack.seq} ${rack.method.toUpperCase()}`,
              callId: msg.getHeader("call-id"),
              branch: msg.getHeader("via")[0]?.branch ?? "",
            })
          }

          for (const p of receivedPracks) {
            if (receivedReliable1xxRseqs.has(p.rack.rseq)) continue
            const key = rackKey(p.rack.rseq, p.rack.seq, p.rack.method)
            if (sentPrackRacks.has(key)) continue
            out.push({
              bindKey: slot.bindKey,
              detail:
                `Received PRACK with RAck=${p.rackRaw} on proxy bind ` +
                `(callId ${p.callId}, branch ${p.branch}) — no matching ` +
                `reliable 1xx in this slot AND no outgoing PRACK observed ` +
                `(proxy must forward unmatched PRACKs, not absorb) — ` +
                `RFC 3262 §3 / RFC3262-MUST-006`,
            })
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.prackResponseSemantics
//
// RFC 3262 §3 / RFC3262-MUST-009 + RFC3262-MUST-010: a UAS receiving a
// PRACK MUST respond 481 (Call/Transaction Does Not Exist) if no
// matching unacked RSeq exists; otherwise it MUST respond with a 2xx.
//
// Per-agent walk: track sent reliable 1xx responses by (callId, INVITE
// top-Via branch, RSeq) — these are the agent's "unacked RSeqs". For
// each received PRACK carrying `RAck: <response-num> <cseq-num>
// INVITE`, look up whether response-num matches any unacked RSeq for
// the same Call-ID. The agent's sent response to the PRACK (correlated
// by the PRACK's own top-Via branch) MUST be 2xx when a match exists
// and 481 otherwise. Skip when no response was sent (different
// obligation).
//
// Regression-only — current PRACK flows correctly trigger 2xx / 481;
// rule trips on mismatched response.
// ---------------------------------------------------------------------------

export const prackResponseSemanticsRule: CrossMessageRule = {
  name: "rfc.prackResponseSemantics",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          // Per-Call-ID set of RSeq values the agent has sent reliably
          // (Require:100rel + RSeq) on the INVITE transaction. Modeled
          // as "unacked" for the lifetime of the slot — MUST-009/-010
          // pivot on match presence, not on whether the PRACK already
          // arrived.
          const sentRseqsByCallId = new Map<string, Set<number>>()
          // Received PRACKs awaiting their sent response, keyed by
          // PRACK's own top-Via branch.
          const pendingPracks = new Map<
            string,
            { callId: string; responseNum: number; matched: boolean }
          >()

          for (const ev of events) {
            const msg = ev.msg

            if (
              ev.kind === "sent" &&
              msg.type === "response" &&
              msg.getHeader("cseq").method.toUpperCase() === "INVITE" &&
              msg.status > 100 &&
              msg.status < 200 &&
              hasOptionTag(msg.headers, "require", "100rel")
            ) {
              const callId = msg.getHeader("call-id")
              for (const raw of getAllHeaderValues(msg.headers, "rseq")) {
                const n = parseInt(raw.trim(), 10)
                if (!Number.isFinite(n)) continue
                let set = sentRseqsByCallId.get(callId)
                if (!set) {
                  set = new Set<number>()
                  sentRseqsByCallId.set(callId, set)
                }
                set.add(n)
              }
              continue
            }

            if (
              ev.kind === "received" &&
              msg.type === "request" &&
              msg.method.toUpperCase() === "PRACK"
            ) {
              const rackRes = msg.getHeader("rack")
              if (Result.isFailure(rackRes)) continue
              const rack = rackRes.success
              if (rack === undefined) continue
              const branch = msg.getHeader("via")[0]?.branch ?? ""
              if (!branch) continue
              const callId = msg.getHeader("call-id")
              const matched = sentRseqsByCallId.get(callId)?.has(rack.rseq) ?? false
              pendingPracks.set(branch, {
                callId,
                responseNum: rack.rseq,
                matched,
              })
              continue
            }

            if (
              ev.kind === "sent" &&
              msg.type === "response" &&
              msg.getHeader("cseq").method.toUpperCase() === "PRACK"
            ) {
              const branch = msg.getHeader("via")[0]?.branch ?? ""
              if (!branch) continue
              const pending = pendingPracks.get(branch)
              if (!pending) continue
              pendingPracks.delete(branch)
              const status = msg.status
              if (pending.matched) {
                if (status >= 200 && status < 300) continue
                out.push({
                  bindKey: slot.bindKey,
                  detail:
                    `Received PRACK with RAck.response-num ${pending.responseNum} ` +
                    `matches sent RSeq, but agent responded ${status} instead ` +
                    `of 2xx (callId ${pending.callId}) — RFC 3262 §3 / ` +
                    `RFC3262-MUST-009`,
                })
              } else {
                if (status === 481) continue
                out.push({
                  bindKey: slot.bindKey,
                  detail:
                    `Received PRACK with RAck.response-num ${pending.responseNum} ` +
                    `matches NO sent RSeq, but agent responded ${status} ` +
                    `instead of 481 (callId ${pending.callId}) — RFC 3262 §3 ` +
                    `/ RFC3262-MUST-010`,
                })
              }
            }
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.serialReliable1xx
//
// RFC 3262 §3 / RFC3262-MUST-012: a UAS MUST NOT send a second reliable
// 1xx in the same dialog before the first is PRACKed.
//
// Per-agent walk in event order: maintain per-Call-ID list of unacked
// sent reliable-1xx RSeqs. On a sent reliable 1xx (101-199 with
// `Require: 100rel`) carrying a fresh RSeq, fire if there is already at
// least one unacked RSeq queued for the same Call-ID. On a received
// PRACK whose `RAck.response-num` matches a queued RSeq, drop that RSeq
// from the unacked list. Retransmits (RSeq value already in the unacked
// list) are skipped — they are not "a second reliable 1xx".
//
// Regression-only — current PRACK flows wait between reliable 1xx; rule
// trips on race.
// ---------------------------------------------------------------------------

export const serialReliable1xxRule: CrossMessageRule = {
  name: "rfc.serialReliable1xx",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          // Per-Call-ID list of unacked sent reliable-1xx RSeqs.
          const unackedByCallId = new Map<string, number[]>()

          for (const ev of events) {
            const msg = ev.msg

            if (
              ev.kind === "sent" &&
              msg.type === "response" &&
              msg.getHeader("cseq").method.toUpperCase() === "INVITE" &&
              msg.status > 100 &&
              msg.status < 200 &&
              hasOptionTag(msg.headers, "require", "100rel")
            ) {
              const callId = msg.getHeader("call-id")
              for (const raw of getAllHeaderValues(msg.headers, "rseq")) {
                const n = parseInt(raw.trim(), 10)
                if (!Number.isFinite(n)) continue
                let list = unackedByCallId.get(callId)
                if (!list) {
                  list = []
                  unackedByCallId.set(callId, list)
                }
                // Retransmit of the same RSeq is not a new reliable 1xx.
                if (list.includes(n)) continue
                if (list.length > 0) {
                  const prior = list[0]!
                  out.push({
                    bindKey: slot.bindKey,
                    detail:
                      `Sent second reliable 1xx (status ${msg.status}, ` +
                      `RSeq=${n}, callId ${callId}) before prior RSeq ` +
                      `${prior} PRACKed — RFC 3262 §3 / RFC3262-MUST-012`,
                  })
                }
                list.push(n)
              }
              continue
            }

            if (
              ev.kind === "received" &&
              msg.type === "request" &&
              msg.method.toUpperCase() === "PRACK"
            ) {
              const rackRes = msg.getHeader("rack")
              if (Result.isFailure(rackRes)) continue
              const rack = rackRes.success
              if (rack === undefined) continue
              const callId = msg.getHeader("call-id")
              const list = unackedByCallId.get(callId)
              if (!list) continue
              const idx = list.indexOf(rack.rseq)
              if (idx >= 0) list.splice(idx, 1)
            }
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.rseqMonotonic
//
// RFC 3262 §3 / RFC3262-MUST-013: subsequent reliable 1xx in the same
// dialog MUST have RSeq = prior + 1; RSeq numbers never wrap.
//
// Per-agent walk in event order: track per-Call-ID the prior sent
// reliable-1xx RSeq. On a sent reliable 1xx (101-199 with
// `Require: 100rel`), parse RSeq. If a prior RSeq exists and the new
// RSeq != prior + 1, fire. Identical-RSeq retransmits are skipped.
//
// Regression-only — current RSeq emission is contiguous; rule trips on
// gaps or backwards moves.
// ---------------------------------------------------------------------------

export const rseqMonotonicRule: CrossMessageRule = {
  name: "rfc.rseqMonotonic",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          // Per-Call-ID prior sent reliable-1xx RSeq.
          const priorRseqByCallId = new Map<string, number>()

          for (const ev of events) {
            const msg = ev.msg
            if (
              ev.kind !== "sent" ||
              msg.type !== "response" ||
              msg.getHeader("cseq").method.toUpperCase() !== "INVITE" ||
              msg.status <= 100 ||
              msg.status >= 200 ||
              !hasOptionTag(msg.headers, "require", "100rel")
            ) {
              continue
            }
            const callId = msg.getHeader("call-id")
            for (const raw of getAllHeaderValues(msg.headers, "rseq")) {
              const n = parseInt(raw.trim(), 10)
              if (!Number.isFinite(n)) continue
              const prior = priorRseqByCallId.get(callId)
              if (prior === undefined) {
                priorRseqByCallId.set(callId, n)
                continue
              }
              if (n === prior) continue // retransmit
              if (n === prior + 1) {
                priorRseqByCallId.set(callId, n)
                continue
              }
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `Sent reliable 1xx RSeq=${n} not contiguous with prior ` +
                  `RSeq=${prior} (callId ${callId}) — RFC 3262 §3 / ` +
                  `RFC3262-MUST-013`,
              })
              priorRseqByCallId.set(callId, n)
            }
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.delay2xxOnUnackedReliable1xxWithSdp
//
// RFC 3262 §3 / RFC3262-MUST-014 (also covers RFC3262-MUST-028
// restatement): if a reliable 1xx carrying SDP is unacked (no PRACK
// received yet), the UAS MUST NOT send the 2xx final until PRACK
// arrives.
//
// Per-agent walk in event order, partitioned by (Call-ID, INVITE
// top-Via branch):
// - Track sent reliable-1xx RSeqs that carried an SDP body. A body
//   presence check (`body.byteLength > 0`) is the conservative proxy
//   for "carries SDP" — Phase-2 will sharpen via `_offer-answer.ts`.
// - On received PRACK matching one of those RSeqs (by Call-ID +
//   RAck.response-num), remove it from the unacked set.
// - On sent 2xx INVITE response on the same Call-ID + branch: if any
//   reliable-1xx-with-SDP RSeq is still unacked, fire.
//
// Regression-only — current PRACK flows wait for PRACK before 2xx;
// rule trips on premature 2xx. Also covers RFC3262-MUST-028
// restatement.
// ---------------------------------------------------------------------------

export const delay2xxOnUnackedReliable1xxWithSdpRule: CrossMessageRule = {
  name: "rfc.delay2xxOnUnackedReliable1xxWithSdp",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          // Per-(callId, INVITE branch) set of unacked reliable-1xx
          // RSeqs that carried an SDP body.
          const unackedByKey = new Map<string, Set<number>>()
          const partitionKey = (callId: string, branch: string): string =>
            `${callId}\x00${branch}`

          for (const ev of events) {
            const msg = ev.msg

            if (
              ev.kind === "sent" &&
              msg.type === "response" &&
              msg.getHeader("cseq").method.toUpperCase() === "INVITE" &&
              msg.status > 100 &&
              msg.status < 200 &&
              hasOptionTag(msg.headers, "require", "100rel") &&
              msg.body.byteLength > 0
            ) {
              const callId = msg.getHeader("call-id")
              const branch = msg.getHeader("via")[0]?.branch ?? ""
              if (!branch) continue
              const key = partitionKey(callId, branch)
              for (const raw of getAllHeaderValues(msg.headers, "rseq")) {
                const n = parseInt(raw.trim(), 10)
                if (!Number.isFinite(n)) continue
                let set = unackedByKey.get(key)
                if (!set) {
                  set = new Set<number>()
                  unackedByKey.set(key, set)
                }
                set.add(n)
              }
              continue
            }

            if (
              ev.kind === "received" &&
              msg.type === "request" &&
              msg.method.toUpperCase() === "PRACK"
            ) {
              const rackRes = msg.getHeader("rack")
              if (Result.isFailure(rackRes)) continue
              const rack = rackRes.success
              if (rack === undefined) continue
              const callId = msg.getHeader("call-id")
              // PRACK's own top-Via branch differs from the INVITE
              // branch; drop the matching RSeq from any partition with
              // this Call-ID.
              for (const [key, set] of unackedByKey) {
                if (!key.startsWith(`${callId}\x00`)) continue
                set.delete(rack.rseq)
              }
              continue
            }

            if (
              ev.kind === "sent" &&
              msg.type === "response" &&
              msg.getHeader("cseq").method.toUpperCase() === "INVITE" &&
              msg.status >= 200 &&
              msg.status < 300
            ) {
              const callId = msg.getHeader("call-id")
              const branch = msg.getHeader("via")[0]?.branch ?? ""
              if (!branch) continue
              const key = partitionKey(callId, branch)
              const set = unackedByKey.get(key)
              if (!set || set.size === 0) continue
              for (const rseq of set) {
                out.push({
                  bindKey: slot.bindKey,
                  detail:
                    `Sent 2xx INVITE response while reliable 1xx (RSeq=${rseq}) ` +
                    `with SDP still unacked (callId ${callId}, branch ${branch}) ` +
                    `— RFC 3262 §3 / RFC3262-MUST-014`,
                })
              }
            }
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.prackAcceptedAfterFinal
//
// RFC 3262 §3 / RFC3262-MUST-015: a PRACK arriving after the final INVITE
// response has been sent still draws a 2xx response — the UAS must be
// prepared to process PRACK requests for outstanding reliable 1xx
// responses even though the call is now established or terminated.
//
// Per-agent walk in event order: track per-Call-ID whether a final INVITE
// response (≥200) has been sent. For each received PRACK whose Call-ID
// already had a final INVITE response sent, look up the agent's sent
// response on the PRACK's own Via branch — fire if that response is not
// 2xx (including 481, which would be wrong here).
//
// Regression-only — current PRACK flows accept late PRACKs; rule trips on
// rejection.
// ---------------------------------------------------------------------------

export const prackAcceptedAfterFinalRule: CrossMessageRule = {
  name: "rfc.prackAcceptedAfterFinal",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          // Per-Call-ID: has a final (≥200) INVITE response been sent?
          const finalSentByCallId = new Set<string>()
          // PRACKs received after a final was sent, awaiting the agent's
          // response. Keyed by PRACK's own top-Via branch.
          const pendingLatePracks = new Map<
            string,
            { callId: string }
          >()

          for (const ev of events) {
            const msg = ev.msg

            if (
              ev.kind === "sent" &&
              msg.type === "response" &&
              msg.getHeader("cseq").method.toUpperCase() === "INVITE" &&
              msg.status >= 200
            ) {
              finalSentByCallId.add(msg.getHeader("call-id"))
              continue
            }

            if (
              ev.kind === "received" &&
              msg.type === "request" &&
              msg.method.toUpperCase() === "PRACK"
            ) {
              const callId = msg.getHeader("call-id")
              if (!finalSentByCallId.has(callId)) continue
              const branch = msg.getHeader("via")[0]?.branch ?? ""
              if (!branch) continue
              pendingLatePracks.set(branch, { callId })
              continue
            }

            if (
              ev.kind === "sent" &&
              msg.type === "response" &&
              msg.getHeader("cseq").method.toUpperCase() === "PRACK"
            ) {
              const branch = msg.getHeader("via")[0]?.branch ?? ""
              if (!branch) continue
              const pending = pendingLatePracks.get(branch)
              if (!pending) continue
              pendingLatePracks.delete(branch)
              if (msg.status >= 200 && msg.status < 300) continue
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `Received PRACK after final INVITE response was sent ` +
                  `(callId ${pending.callId}, PRACK branch ${branch}) but ` +
                  `PRACK got ${msg.status} instead of 2xx — RFC 3262 §3 / ` +
                  `RFC3262-MUST-015`,
              })
            }
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.noNewReliable1xxAfterFinal
//
// RFC 3262 §3 / RFC3262-MUST-016: a UAS MUST NOT send a new reliable
// 1xx (carrying an unseen RSeq) on the same INVITE transaction after a
// final response (≥200) has been sent. Retransmits of already-emitted
// reliable 1xx (same RSeq) are allowed; new ones are not.
//
// Per-agent walk in event order, partitioned by (Call-ID, INVITE
// top-Via branch):
// - Track when a final INVITE response (≥200) was sent on the
//   partition.
// - Track the set of RSeq values already emitted reliably on the
//   partition.
// - For each sent reliable 1xx (101-199 with `Require:100rel`) carrying
//   an RSeq, fire when a final has already been sent AND the RSeq is
//   not in the seen set (i.e. not a retransmit).
//
// Regression-only — current flows stop emitting 18x after final; rule
// trips on stray reliable 18x post-final.
// ---------------------------------------------------------------------------

export const noNewReliable1xxAfterFinalRule: CrossMessageRule = {
  name: "rfc.noNewReliable1xxAfterFinal",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          // Per-(callId, INVITE branch): whether a final ≥200 response
          // was sent, and the set of reliable-1xx RSeqs already emitted.
          const finalSentByKey = new Set<string>()
          const seenRseqsByKey = new Map<string, Set<number>>()
          const partitionKey = (callId: string, branch: string): string =>
            `${callId}\x00${branch}`

          for (const ev of events) {
            const msg = ev.msg
            if (
              ev.kind !== "sent" ||
              msg.type !== "response" ||
              msg.getHeader("cseq").method.toUpperCase() !== "INVITE"
            ) {
              continue
            }
            const callId = msg.getHeader("call-id")
            const branch = msg.getHeader("via")[0]?.branch ?? ""
            if (!branch) continue
            const key = partitionKey(callId, branch)

            if (msg.status >= 200) {
              finalSentByKey.add(key)
              continue
            }
            if (msg.status <= 100 || msg.status >= 200) continue
            if (!hasOptionTag(msg.headers, "require", "100rel")) continue
            for (const raw of getAllHeaderValues(msg.headers, "rseq")) {
              const n = parseInt(raw.trim(), 10)
              if (!Number.isFinite(n)) continue
              let seen = seenRseqsByKey.get(key)
              if (!seen) {
                seen = new Set<number>()
                seenRseqsByKey.set(key, seen)
              }
              if (seen.has(n)) continue // retransmit
              if (finalSentByKey.has(key)) {
                out.push({
                  bindKey: slot.bindKey,
                  detail:
                    `Sent new reliable 1xx (RSeq=${n}, callId ${callId}) ` +
                    `after final INVITE response — forbidden per RFC 3262 ` +
                    `§3 / RFC3262-MUST-016`,
                })
              }
              seen.add(n)
            }
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.uacIgnore100rel100Trying
//
// RFC 3262 §4 / RFC3262-MUST-019: if a 100 (Trying) response carries
// `Require: 100rel`, the UAC MUST ignore the 100rel and MUST NOT PRACK
// it — 100 Trying is never sent reliably.
//
// Per-agent walk: track received 100 Trying responses that incorrectly
// carry `Require: 100rel`, indexed by (Call-ID, RSeq). For each sent
// PRACK, check whether its `RAck.response-num` references the RSeq of a
// such a received malformed 100. Fire if a PRACK references one.
//
// Regression-only — received 100 Trying is normally absorbed by the
// TransactionLayer; no current fixture has a peer send a
// 100-Trying-with-Require:100rel, so this rule trips only if a UAC ever
// PRACKs such a malformed 100.
// ---------------------------------------------------------------------------

export const uacIgnore100rel100TryingRule: CrossMessageRule = {
  name: "rfc.uacIgnore100rel100Trying",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          // Per-Call-ID set of RSeq values from received 100 Trying
          // responses that incorrectly carried `Require: 100rel`.
          const bogusRseqsByCallId = new Map<string, Set<number>>()

          for (const ev of events) {
            const msg = ev.msg

            if (
              ev.kind === "received" &&
              msg.type === "response" &&
              msg.status === 100 &&
              hasOptionTag(msg.headers, "require", "100rel")
            ) {
              const callId = msg.getHeader("call-id")
              for (const raw of getAllHeaderValues(msg.headers, "rseq")) {
                const n = parseInt(raw.trim(), 10)
                if (!Number.isFinite(n)) continue
                let set = bogusRseqsByCallId.get(callId)
                if (!set) {
                  set = new Set<number>()
                  bogusRseqsByCallId.set(callId, set)
                }
                set.add(n)
              }
              continue
            }

            if (
              ev.kind === "sent" &&
              msg.type === "request" &&
              msg.method.toUpperCase() === "PRACK"
            ) {
              const rackRes = msg.getHeader("rack")
              if (Result.isFailure(rackRes)) continue
              const rack = rackRes.success
              if (rack === undefined) continue
              const callId = msg.getHeader("call-id")
              const set = bogusRseqsByCallId.get(callId)
              if (!set || !set.has(rack.rseq)) continue
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `Sent PRACK references RSeq ${rack.rseq} from a received ` +
                  `100 Trying carrying Require:100rel — UAC MUST ignore ` +
                  `100rel on 100 Trying (RFC 3262 §4 / RFC3262-MUST-019)`,
              })
            }
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.prackOnReliable1xx
//
// RFC 3262 §4 / RFC3262-MUST-021: every received reliable 1xx (status
// 101-199 carrying `Require: 100rel`) MUST draw a matching outbound
// PRACK from the UAC. Complement to existing `rfc.rackCorrelation`,
// which goes the other direction (every sent PRACK must match a
// received reliable 1xx).
//
// Per-agent walk: track received reliable 1xx responses by (Call-ID,
// RSeq). For each sent PRACK, mark the matching candidate as PRACKed
// via its `RAck.response-num`. At end of walk, any unmatched candidate
// is a violation.
//
// Regression-only — current UAC flows PRACK every reliable 1xx; rule
// trips on missed PRACK.
// ---------------------------------------------------------------------------

export const prackOnReliable1xxRule: CrossMessageRule = {
  name: "rfc.prackOnReliable1xx",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          // Per-Call-ID map of received reliable-1xx RSeq → candidate
          // record (status + PRACKed flag).
          const candidatesByCallId = new Map<
            string,
            Map<number, { status: number; prackedBy: boolean }>
          >()

          for (const ev of events) {
            const msg = ev.msg

            if (
              ev.kind === "received" &&
              msg.type === "response" &&
              msg.status > 100 &&
              msg.status < 200 &&
              hasOptionTag(msg.headers, "require", "100rel")
            ) {
              const callId = msg.getHeader("call-id")
              for (const raw of getAllHeaderValues(msg.headers, "rseq")) {
                const n = parseInt(raw.trim(), 10)
                if (!Number.isFinite(n)) continue
                let inner = candidatesByCallId.get(callId)
                if (!inner) {
                  inner = new Map<number, { status: number; prackedBy: boolean }>()
                  candidatesByCallId.set(callId, inner)
                }
                if (inner.has(n)) continue // retransmit of same reliable 1xx
                inner.set(n, { status: msg.status, prackedBy: false })
              }
              continue
            }

            if (
              ev.kind === "sent" &&
              msg.type === "request" &&
              msg.method.toUpperCase() === "PRACK"
            ) {
              const rackRes = msg.getHeader("rack")
              if (Result.isFailure(rackRes)) continue
              const rack = rackRes.success
              if (rack === undefined) continue
              const callId = msg.getHeader("call-id")
              const inner = candidatesByCallId.get(callId)
              if (!inner) continue
              const candidate = inner.get(rack.rseq)
              if (!candidate) continue
              candidate.prackedBy = true
            }
          }

          for (const [callId, inner] of candidatesByCallId) {
            for (const [rseq, candidate] of inner) {
              if (candidate.prackedBy) continue
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `Received reliable 1xx (status ${candidate.status}, ` +
                  `RSeq=${rseq}, callId ${callId}) — UAC did not send a ` +
                  `matching PRACK (RFC 3262 §4 / RFC3262-MUST-021)`,
              })
            }
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.uacRseqStrictness
//
// RFC 3262 §4 / RFC3262-MUST-024: the UAC MUST PRACK only the in-order
// RSeq from received reliable 1xx; out-of-order reliable 1xx MUST NOT
// yield a PRACK until the gap is filled.
//
// Per-agent walk in event order, partitioned by Call-ID:
// - Track the expected next-RSeq. Undefined until the first received
//   reliable 1xx arrives; that first RSeq sets the expected value
//   (subsequent in-order reliable 1xx bumps it by 1).
// - For each received reliable 1xx, if RSeq != expected, the message is
//   out of order and MUST NOT be PRACKed.
// - For each sent PRACK whose RAck.response-num references an
//   out-of-order RSeq tracked above, fire.
//
// Regression-only — current UAC flows respect in-order RSeq; rule trips
// on out-of-order PRACK.
// ---------------------------------------------------------------------------

export const uacRseqStrictnessRule: CrossMessageRule = {
  name: "rfc.uacRseqStrictness",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          // Per-Call-ID expected next-RSeq tracker and the set of
          // out-of-order RSeq values observed on received reliable 1xx.
          const expectedByCallId = new Map<string, number>()
          const outOfOrderByCallId = new Map<string, Set<number>>()

          for (const ev of events) {
            const msg = ev.msg

            if (
              ev.kind === "received" &&
              msg.type === "response" &&
              msg.status > 100 &&
              msg.status < 200 &&
              hasOptionTag(msg.headers, "require", "100rel")
            ) {
              const callId = msg.getHeader("call-id")
              for (const raw of getAllHeaderValues(msg.headers, "rseq")) {
                const n = parseInt(raw.trim(), 10)
                if (!Number.isFinite(n)) continue
                const expected = expectedByCallId.get(callId)
                if (expected === undefined) {
                  expectedByCallId.set(callId, n + 1)
                  continue
                }
                if (n === expected) {
                  expectedByCallId.set(callId, n + 1)
                  continue
                }
                if (n === expected - 1) continue // retransmit of prior in-order RSeq
                let set = outOfOrderByCallId.get(callId)
                if (!set) {
                  set = new Set<number>()
                  outOfOrderByCallId.set(callId, set)
                }
                set.add(n)
              }
              continue
            }

            if (
              ev.kind === "sent" &&
              msg.type === "request" &&
              msg.method.toUpperCase() === "PRACK"
            ) {
              const rackRes = msg.getHeader("rack")
              if (Result.isFailure(rackRes)) continue
              const rack = rackRes.success
              if (rack === undefined) continue
              const callId = msg.getHeader("call-id")
              const set = outOfOrderByCallId.get(callId)
              if (!set || !set.has(rack.rseq)) continue
              const expected = expectedByCallId.get(callId)
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `Sent PRACK for out-of-order RSeq=${rack.rseq} (expected ` +
                  `${expected ?? "?"}, callId ${callId}) — UAC must PRACK in ` +
                  `order (RFC 3262 §4 / RFC3262-MUST-024)`,
              })
            }
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.prackOfferAnswerModel
//
// RFC 3262 §5 / RFC3262-MUST-025 + RFC3262-MUST-026 + RFC3262-MUST-027:
// PRACK-flavored offer/answer pairing. When a reliable 1xx carries an
// SDP offer, the corresponding PRACK MUST carry the SDP answer
// (M-025/-026); the 2xx response to the PRACK MAY then carry a further
// SDP exchange (M-027). The dialog-confirmation half of M-026 is
// covered structurally — enforcing "offer-in-1xx ⇒ answer-in-PRACK"
// makes the negotiation observable from the trace.
//
// Per-agent walk, per Call-ID. Loose heuristic via body-presence —
// `_offer-answer.ts` (planned for the RFC 3264 batch) will sharpen this
// to true SDP-shape inspection.
//
// - On reliable 1xx (sent or received, status 101-199 with
//   `Require: 100rel`) carrying a body, record the RSeq as "offer
//   present".
// - On PRACK (sent or received) keyed by RAck.response-num against the
//   same Call-ID, fire if the matched reliable 1xx carried an offer but
//   the PRACK body is empty.
//
// Regression-only — covers M-025/-026/-027 PRACK offer/answer pairing.
// ---------------------------------------------------------------------------

export const prackOfferAnswerModelRule: CrossMessageRule = {
  name: "rfc.prackOfferAnswerModel",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          // Per-Call-ID set of reliable-1xx RSeqs (observed sent or
          // received) that carried an SDP offer (body present).
          const offerRseqsByCallId = new Map<string, Set<number>>()

          for (const ev of events) {
            const msg = ev.msg

            if (
              msg.type === "response" &&
              msg.getHeader("cseq").method.toUpperCase() === "INVITE" &&
              msg.status > 100 &&
              msg.status < 200 &&
              hasOptionTag(msg.headers, "require", "100rel") &&
              msg.body.byteLength > 0
            ) {
              const callId = msg.getHeader("call-id")
              for (const raw of getAllHeaderValues(msg.headers, "rseq")) {
                const n = parseInt(raw.trim(), 10)
                if (!Number.isFinite(n)) continue
                let set = offerRseqsByCallId.get(callId)
                if (!set) {
                  set = new Set<number>()
                  offerRseqsByCallId.set(callId, set)
                }
                set.add(n)
              }
              continue
            }

            if (msg.type !== "request" || msg.method.toUpperCase() !== "PRACK") {
              continue
            }
            const rackRes = msg.getHeader("rack")
            if (Result.isFailure(rackRes)) continue
            const rack = rackRes.success
            if (rack === undefined) continue
            const callId = msg.getHeader("call-id")
            const offerSet = offerRseqsByCallId.get(callId)
            if (!offerSet || !offerSet.has(rack.rseq)) continue
            if (msg.body.byteLength > 0) continue
            out.push({
              bindKey: slot.bindKey,
              detail:
                `PRACK for reliable-1xx-with-offer (RSeq=${rack.rseq}, ` +
                `callId ${callId}) carries no body — RFC 3262 §5 / ` +
                `RFC3262-MUST-025`,
            })
          }
        }
      }
      return out
    }),
}

const sliceTypedRules: ReadonlyArray<CrossMessageRule> = [
  requireReliable1xxOnRequireRule,
  reliableNeedsClientOptInRule,
  noReliable1xxOnInDialogRule,
  unmatchedPrackProxiedRule,
  prackResponseSemanticsRule,
  serialReliable1xxRule,
  rseqMonotonicRule,
  delay2xxOnUnackedReliable1xxWithSdpRule,
  prackAcceptedAfterFinalRule,
  noNewReliable1xxAfterFinalRule,
  uacIgnore100rel100TryingRule,
  prackOnReliable1xxRule,
  uacRseqStrictnessRule,
  prackOfferAnswerModelRule,
]

// Advisory overrides — rules that fire on legitimate B2BUA traffic
// (Call-ID rewrite across legs, internal PRACK-termination policy)
// where the heuristic can't cleanly distinguish "B2BUA pattern" from
// "real violation". Mirrors the override table in
// rfc3261-cross-message-rules.ts.
const RFC3262_ADVISORY_OVERRIDES: ReadonlyMap<string, string> = new Map<string, string>([
  [
    "rfc.unmatchedPrackProxied",
    "B2BUA worker terminates PRACK per leg (not a §3 proxy in the strict " +
      "sense). The peer's PRACK lands on the worker's bind in dialog A's " +
      "slice but the reliable 1xx that triggered it was emitted on " +
      "dialog B's leg (different Call-ID after the worker's leg rewrite), " +
      "so from a per-slice view the PRACK appears 'unmatched'. Advisory " +
      "until either subject narrows to a dedicated proxy bind or the rule " +
      "correlates across leg-mate slices.",
  ],
  [
    "rfc.reliableNeedsClientOptIn",
    "B2BUA worker may emit reliable 18x on one leg when policy requires " +
      "PRACK termination at the B2BUA. The upstream INVITE on the other " +
      "leg did opt in (Supported:100rel), but the downstream INVITE the " +
      "rule sees may not — the B2BUA negotiated 100rel termination " +
      "internally. Advisory until subject narrows to non-DUT peer binds " +
      "or the rule models the B2BUA's internal PRACK-termination policy.",
  ],
  [
    "rfc.prackOfferAnswerModel",
    "B2BUA terminates PRACK per leg; the reliable 1xx with offer body " +
      "lives on one leg's slice while the PRACK with answer body lives " +
      "on the other leg's slice (different Call-ID after the worker's " +
      "leg rewrite). The body-presence heuristic fires because both " +
      "halves of the offer/answer round are not visible from a single " +
      "per-slice view. Advisory until the planned `_offer-answer.ts` " +
      "helper models cross-leg PRACK O/A correlation OR subject narrows " +
      "to non-DUT peer binds.",
  ],
])

export const rfc3262CrossMessageRules: ReadonlyArray<CrossMessageAuditRule> =
  sliceTypedRules.map((rule) => {
    const advisory = RFC3262_ADVISORY_OVERRIDES.get(rule.name)
    const base = adaptCrossMessageRule(rule)
    if (advisory === undefined) return base
    return { ...base, severityOverride: "advisory", justification: advisory }
  })
