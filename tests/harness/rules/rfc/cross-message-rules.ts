/**
 * Cross-message RFC rules ported to the new SignalingNetwork.scopedAudit
 * path. Each rule consumes per-dialog slices produced by
 * `tests/harness/projections.ts:projectPerDialog` and walks the agent's
 * own sent / received stream to flag violations that span more than one
 * message.
 *
 * Each rule walks per-(bindKey, Call-ID, tags) slices and surfaces a
 * violation as a `SignalingAuditViolation` when the layer-close finalizer
 * runs.
 */

import { Effect } from "effect"
import type { LaneKey, RecordedStamps } from "../../../../src/test-harness/framework/report-recorder/types.js"
import type {
  CrossMessageAuditRule,
  SignalingNetworkEvent,
} from "../../../../src/sip/SignalingNetwork.contracts.js"
import { projectPerDialog, type PerDialogSlice } from "../../projections.js"
import {
  advanceDialogModel,
  emptyDialogModel,
  extractRouteUri,
  getAllHeaderValues,
  getHeaderValue,
  isInDialogRequest,
  parseSdpOrigin,
  type ParsedSdpOrigin,
  readRport,
  routeIsLoose,
  type OrderedAgentEvent,
} from "./_dialog-model.js"

// ---------------------------------------------------------------------------
// Rule interface
// ---------------------------------------------------------------------------

export interface CrossMessageRule {
  readonly name: string
  readonly check: (
    slices: ReadonlyArray<PerDialogSlice>,
  ) => Effect.Effect<ReadonlyArray<{ readonly bindKey: LaneKey; readonly detail: string }>>
}

// ---------------------------------------------------------------------------
// Helper: re-serialise a per-agent slot's sent + received into a single
// ordered stream. We use slot insertion order — projector already sorted
// the global stream by (atMs, seq), so each slot's `sent` and `received`
// arrays preserve the per-bindKey ordering; merging them by their
// original `idx` (assigned in the projector against the global ordered
// list) yields the timeline the legacy `advanceDialogModel` expects.
// ---------------------------------------------------------------------------

const orderedFromSlot = (slot: PerDialogSlice["perAgent"][number]): OrderedAgentEvent[] => {
  const all: OrderedAgentEvent[] = []
  for (const r of slot.received) all.push({ kind: "received", idx: r.idx, msg: r.msg })
  for (const s of slot.sent) all.push({ kind: "sent", idx: s.idx, msg: s.msg })
  all.sort((a, b) => a.idx - b.idx)
  return all
}

// ---------------------------------------------------------------------------
// rfc.midDialogFromUri
// ---------------------------------------------------------------------------

export const midDialogFromUriRule: CrossMessageRule = {
  name: "rfc.midDialogFromUri",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)
          const m = emptyDialogModel()
          for (const ev of events) {
            if (ev.kind === "sent" && ev.msg.type === "request") {
              const msg = ev.msg
              if (msg.method === "CANCEL") {
                advanceDialogModel(m, ev)
                continue
              }
              if (
                msg.method === "INVITE" &&
                !m.initialInviteSentBranch &&
                !m.initialInviteReceivedBranch
              ) {
                advanceDialogModel(m, ev)
                continue
              }
              if (!isInDialogRequest(msg, m)) {
                advanceDialogModel(m, ev)
                continue
              }
              if (
                m.dialogLocalUri &&
                msg.getHeader("from").uri !== m.dialogLocalUri
              ) {
                out.push({
                  bindKey: slot.bindKey,
                  detail:
                    `in-dialog ${msg.method} From URI ` +
                    `"${msg.getHeader("from").uri}" differs from dialog local URI ` +
                    `"${m.dialogLocalUri}" — RFC 3261 §12.2.1.1`,
                })
              }
              if (
                m.dialogRemoteUri &&
                msg.getHeader("to").uri !== m.dialogRemoteUri
              ) {
                out.push({
                  bindKey: slot.bindKey,
                  detail:
                    `in-dialog ${msg.method} To URI ` +
                    `"${msg.getHeader("to").uri}" differs from dialog remote URI ` +
                    `"${m.dialogRemoteUri}" — RFC 3261 §12.2.1.1`,
                })
              }
            }
            advanceDialogModel(m, ev)
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.midDialogRoute
// ---------------------------------------------------------------------------

export const midDialogRouteRule: CrossMessageRule = {
  name: "rfc.midDialogRoute",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)
          const m = emptyDialogModel()
          for (const ev of events) {
            if (ev.kind === "sent" && ev.msg.type === "request") {
              const msg = ev.msg
              if (msg.method === "CANCEL" || msg.method === "ACK") {
                advanceDialogModel(m, ev)
                continue
              }
              if (
                msg.method === "INVITE" &&
                !m.initialInviteSentBranch &&
                !m.initialInviteReceivedBranch
              ) {
                advanceDialogModel(m, ev)
                continue
              }
              if (!isInDialogRequest(msg, m)) {
                advanceDialogModel(m, ev)
                continue
              }
              if (m.routeSet.length === 0) {
                advanceDialogModel(m, ev)
                continue
              }

              const sentRoutes = getAllHeaderValues(msg.headers, "route")
              const firstRoute = m.routeSet[0]!

              if (routeIsLoose(firstRoute)) {
                if (sentRoutes.length === 0) {
                  out.push({
                    bindKey: slot.bindKey,
                    detail:
                      `in-dialog ${msg.method} omits Route header although ` +
                      `the dialog route set is non-empty (loose, first entry ` +
                      `"${firstRoute}") — RFC 3261 §12.2.1.1`,
                  })
                } else if (sentRoutes.length !== m.routeSet.length) {
                  out.push({
                    bindKey: slot.bindKey,
                    detail:
                      `in-dialog ${msg.method} Route header count ` +
                      `${sentRoutes.length} differs from dialog route set ` +
                      `length ${m.routeSet.length} — RFC 3261 §12.2.1.1`,
                  })
                } else {
                  for (let i = 0; i < sentRoutes.length; i++) {
                    const expected = extractRouteUri(m.routeSet[i]!)
                    const actual = extractRouteUri(sentRoutes[i]!)
                    if (expected !== actual) {
                      out.push({
                        bindKey: slot.bindKey,
                        detail:
                          `in-dialog ${msg.method} Route[${i}] URI "${actual}" ` +
                          `differs from dialog route set entry "${expected}" — ` +
                          `RFC 3261 §12.2.1.1`,
                      })
                      break
                    }
                  }
                }
              } else {
                const expectedUri = extractRouteUri(firstRoute)
                if (msg.uri !== expectedUri) {
                  out.push({
                    bindKey: slot.bindKey,
                    detail:
                      `in-dialog ${msg.method} Request-URI "${msg.uri}" should ` +
                      `be first strict route URI "${expectedUri}" — RFC 3261 §16.12`,
                  })
                }
                const expectedTail = m.routeSet.slice(1).map((r) => extractRouteUri(r))
                const actualTail = sentRoutes.map((r) => extractRouteUri(r))
                const matchesExact =
                  expectedTail.length === actualTail.length &&
                  expectedTail.every((u, i) => u === actualTail[i])
                const matchesWithTarget =
                  actualTail.length === expectedTail.length + 1 &&
                  expectedTail.every((u, i) => u === actualTail[i])
                if (!matchesExact && !matchesWithTarget) {
                  out.push({
                    bindKey: slot.bindKey,
                    detail:
                      `in-dialog ${msg.method} strict-route Route tail does not ` +
                      `match dialog route set (expected ${JSON.stringify(expectedTail)}, ` +
                      `got ${JSON.stringify(actualTail)}) — RFC 3261 §16.12`,
                  })
                }
              }
            }
            advanceDialogModel(m, ev)
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.sdpOriginContinuity
// ---------------------------------------------------------------------------

export const sdpOriginContinuityRule: CrossMessageRule = {
  name: "rfc.sdpOriginContinuity",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      // Per-(bindKey, callId) history of this agent's sent SDP origin.
      // The projector already partitions by Call-ID, but forked early
      // dialogs share Call-ID + From-tag — they observe the same UAC
      // emissions, so we key on bindKey + callId rather than per-slice.
      const history = new Map<
        string,
        ParsedSdpOrigin & { rawDigest: string }
      >()
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)
          for (const ev of events) {
            if (ev.kind !== "sent") continue
            if (ev.msg.body.byteLength === 0) continue
            const origin = parseSdpOrigin(ev.msg.body)
            if (origin === null) continue
            const callId = ev.msg.getHeader("call-id")
            if (!callId) continue
            const key = `${slot.bindKey}\x00${callId}`
            const prior = history.get(key)
            if (!prior) {
              history.set(key, {
                ...origin,
                rawDigest: origin.bodyDigestExcludingOrigin,
              })
              continue
            }
            const tupleStable =
              prior.username === origin.username &&
              prior.sessionId === origin.sessionId &&
              prior.nettype === origin.nettype &&
              prior.addrtype === origin.addrtype &&
              prior.unicastAddress === origin.unicastAddress
            if (!tupleStable) {
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `SDP origin tuple changed within session — prior ` +
                  `"${prior.rawOriginLine}", new "${origin.rawOriginLine}" — ` +
                  `RFC 4566 §5.2 / RFC 3264 §8`,
              })
              history.set(key, {
                ...origin,
                rawDigest: origin.bodyDigestExcludingOrigin,
              })
              continue
            }
            const bodyChanged =
              prior.rawDigest !== origin.bodyDigestExcludingOrigin
            const versionDelta = origin.sessionVersion - prior.sessionVersion
            if (bodyChanged && versionDelta !== 1) {
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `SDP body changed but sess-version went from ` +
                  `${prior.sessionVersion} to ${origin.sessionVersion} ` +
                  `(expected exactly +1) — RFC 3264 §8`,
              })
            } else if (!bodyChanged && versionDelta !== 0) {
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `SDP body unchanged but sess-version went from ` +
                  `${prior.sessionVersion} to ${origin.sessionVersion} ` +
                  `(expected unchanged for byte-identical SDP) — RFC 4566 §5.2`,
              })
            } else if (versionDelta < 0) {
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `SDP sess-version went backwards ` +
                  `(${prior.sessionVersion} → ${origin.sessionVersion}) — ` +
                  `RFC 4566 §5.2`,
              })
            }
            history.set(key, {
              ...origin,
              rawDigest: origin.bodyDigestExcludingOrigin,
            })
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.recordRoutePlacement
// ---------------------------------------------------------------------------

export const recordRoutePlacementRule: CrossMessageRule = {
  name: "rfc.recordRoutePlacement",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)
          const sentByBranch = new Map<
            string,
            { method: string; isInDialog: boolean }
          >()
          for (const ev of events) {
            if (ev.kind === "sent" && ev.msg.type === "request") {
              const branch = ev.msg.getHeader("via")[0]?.branch
              if (branch) {
                const hasToTag = ev.msg.getHeader("to").tag !== undefined
                sentByBranch.set(branch, {
                  method: ev.msg.method,
                  isInDialog: hasToTag,
                })
              }
              continue
            }
            if (ev.kind !== "received" || ev.msg.type !== "response") continue

            const rr = getAllHeaderValues(ev.msg.headers, "record-route")
            if (rr.length === 0) continue

            if (ev.msg.status === 100) {
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `100 Trying carries Record-Route header(s) — 100 is not ` +
                  `dialog-creating, Record-Route is vestigial here per ` +
                  `RFC 3261 §12.1.1. Found: ${rr[0]}`,
              })
              continue
            }
            const branch = ev.msg.getHeader("via")[0]?.branch
            const sent = branch ? sentByBranch.get(branch) : undefined
            if (sent && sent.isInDialog) {
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `${ev.msg.status} response to in-dialog ${sent.method} ` +
                  `carries Record-Route — route set is fixed at dialog ` +
                  `establishment per RFC 3261 §12.2.2. Found: ${rr[0]}`,
              })
            }
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.rportEcho
// ---------------------------------------------------------------------------

export const rportEchoRule: CrossMessageRule = {
  name: "rfc.rportEcho",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)
          const sentRportByBranch = new Map<string, { method: string }>()
          for (const ev of events) {
            if (ev.kind === "sent" && ev.msg.type === "request") {
              const topVia = ev.msg.getHeader("via")[0]
              if (!topVia) continue
              const info = readRport(topVia.params)
              if (info.present && info.value === undefined) {
                const branch = topVia.branch
                if (branch)
                  sentRportByBranch.set(branch, { method: ev.msg.method })
              }
              continue
            }
            if (ev.kind !== "received" || ev.msg.type !== "response") continue
            const branch = ev.msg.getHeader("via")[0]?.branch
            if (!branch) continue
            const sent = sentRportByBranch.get(branch)
            if (!sent) continue
            const respRport = readRport(ev.msg.getHeader("via")[0]!.params)
            if (!respRport.present) {
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `response ${ev.msg.status} to ${sent.method} (branch ` +
                  `${branch}) dropped the rport parameter the request ` +
                  `advertised — RFC 3581 §4 requires the server to echo ` +
                  `rport=<source-port>`,
              })
              continue
            }
            if (respRport.value === undefined) {
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `response ${ev.msg.status} to ${sent.method} (branch ` +
                  `${branch}) keeps an empty rport parameter — RFC 3581 §4 ` +
                  `requires the server to set it to the source port`,
              })
            }
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.allowSupportedOnInvite
// ---------------------------------------------------------------------------

const checkAllowSupported = (
  out: Array<{ bindKey: LaneKey; detail: string }>,
  bindKey: LaneKey,
  label: string,
  headers: ReadonlyArray<{ name: string; value: string }>,
): void => {
  const allow = getHeaderValue(headers, "allow")
  if (!allow) {
    out.push({
      bindKey,
      detail:
        `${label} missing Allow: header — RFC 3261 §13.2.1 ` +
        `(SHOULD list accepted methods)`,
    })
  }
  const supported = getHeaderValue(headers, "supported")
  if (supported === undefined) {
    out.push({
      bindKey,
      detail:
        `${label} missing Supported: header — RFC 3261 §20.37 ` +
        `(SHOULD list extensions for Require negotiation)`,
    })
  }
}

export const allowSupportedOnInviteRule: CrossMessageRule = {
  name: "rfc.allowSupportedOnInvite",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)
          const initialInviteBranchByCallId = new Map<string, string>()
          for (const ev of events) {
            if (ev.kind !== "received") continue
            const msg = ev.msg
            if (msg.type === "request" && msg.method === "INVITE") {
              const callId = msg.getHeader("call-id")
              const branch = msg.getHeader("via")[0]?.branch ?? ""
              const isInitial = !initialInviteBranchByCallId.has(callId)
              if (isInitial) {
                initialInviteBranchByCallId.set(callId, branch)
                continue
              }
              checkAllowSupported(out, slot.bindKey, "re-INVITE", msg.headers)
              continue
            }
            if (
              msg.type === "response" &&
              msg.status >= 200 &&
              msg.status < 300 &&
              msg.getHeader("cseq").method === "INVITE"
            ) {
              checkAllowSupported(
                out,
                slot.bindKey,
                `${msg.status} OK INVITE`,
                msg.headers,
              )
            }
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.proxy100TryingNotForwarded
// ---------------------------------------------------------------------------

export const proxy100TryingNotForwardedRule: CrossMessageRule = {
  name: "rfc.proxy100TryingNotForwarded",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)
          const sentInviteKey = new Map<string, { branch: string }>()
          const tryingCountByKey = new Map<string, number>()
          for (const ev of events) {
            if (
              ev.kind === "sent" &&
              ev.msg.type === "request" &&
              ev.msg.method === "INVITE"
            ) {
              const callId = ev.msg.getHeader("call-id")
              const cseq = ev.msg.getHeader("cseq").seq
              const key = `${callId}|${cseq}`
              if (!sentInviteKey.has(key)) {
                sentInviteKey.set(key, {
                  branch: ev.msg.getHeader("via")[0]?.branch ?? "",
                })
              }
              continue
            }
            if (
              ev.kind === "received" &&
              ev.msg.type === "response" &&
              ev.msg.status === 100 &&
              ev.msg.getHeader("cseq").method === "INVITE"
            ) {
              const callId = ev.msg.getHeader("call-id")
              const cseq = ev.msg.getHeader("cseq").seq
              const key = `${callId}|${cseq}`
              if (!sentInviteKey.has(key)) continue
              const next = (tryingCountByKey.get(key) ?? 0) + 1
              tryingCountByKey.set(key, next)
              if (next === 2) {
                out.push({
                  bindKey: slot.bindKey,
                  detail:
                    `received a second 100 Trying for INVITE CSeq=${cseq} ` +
                    `Call-ID=${callId} — the stateful proxy on the path ` +
                    `forwarded a downstream 100 it should have absorbed per ` +
                    `RFC 3261 §16.7 step 5`,
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
// Pack — slice-typed rules + CrossMessageAuditRule adapters for the
// SignalingNetwork.contracts wiring (which sees the raw event channel
// and projects internally).
// ---------------------------------------------------------------------------

const sliceTypedRules: ReadonlyArray<CrossMessageRule> = [
  midDialogFromUriRule,
  midDialogRouteRule,
  sdpOriginContinuityRule,
  recordRoutePlacementRule,
  rportEchoRule,
  allowSupportedOnInviteRule,
  proxy100TryingNotForwardedRule,
]

/**
 * Rules forced to `advisory` regardless of `RunContext`. Each entry is
 * a rule that catches a legitimate violation but fires widely in
 * existing fake-stack fixtures — making it `deferred-fail` would
 * cascade across tests that were not authored to enforce it.
 *
 *   - rfc.allowSupportedOnInvite: many fixtures emit re-INVITE without
 *     Allow/Supported. SHOULD-level header, not MUST.
 *   - rfc.rportEcho: OPTIONS-keepalive responses from the B2BUA don't
 *     echo `rport=` when the request arrived over loopback (the source
 *     port lookup the response builder does only triggers when NAT is
 *     in play). Harmless in fake-stack; flagged for visibility.
 *   - rfc.sdpOriginContinuity: agents that don't anchor an `o=` tuple
 *     across re-offers (B2BUA-mediated transfer fixtures emit fresh
 *     SDP from each side without preserving the originator's session
 *     id). Tracked for visibility.
 */
const ADVISORY_RULE_NAMES: ReadonlySet<string> = new Set<string>([
  "rfc.sdpOriginContinuity",
])

const adapt = (rule: CrossMessageRule): CrossMessageAuditRule => ({
  name: rule.name,
  severityOverride: ADVISORY_RULE_NAMES.has(rule.name) ? "advisory" : undefined,
  check: (events: ReadonlyArray<SignalingNetworkEvent & RecordedStamps>) =>
    Effect.gen(function* () {
      const slices = projectPerDialog(events)
      return yield* rule.check(slices)
    }),
})

export const crossMessagePeerRules: ReadonlyArray<CrossMessageAuditRule> =
  sliceTypedRules.map(adapt)

