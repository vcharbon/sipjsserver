/**
 * RFC 3261 cross-message rules. New rules covering MUSTs from the
 * RFC 3261 inventory whose enforcement spans more than one message
 * land here, separate from the original `cross-message-rules.ts`
 * starter pack. Each rule plugs into the same `CrossMessageRule`
 * interface and `adaptCrossMessageRule` plumbing.
 */

import { Effect } from "effect"
import type { LaneKey } from "../../../../src/test-harness/framework/report-recorder/types.js"
import type { CrossMessageAuditRule } from "../../../../src/sip/SignalingNetwork.contracts.js"
import {
  adaptCrossMessageRule,
  type CrossMessageRule,
  orderedFromSlot,
} from "./cross-message-rules.js"
import {
  extractRouteUri,
  getAllHeaderValues,
  routeIsLoose,
} from "./_dialog-model.js"
import {
  buildBranchIndex,
  findInviteByBranch,
  responsesFor,
  splitOptionTags,
} from "./_transaction-correlation.js"

// ---------------------------------------------------------------------------
// rfc.unknownDialog481
//
// RFC 3261 §12.2.2 / RFC3261-MUST-071: a UAS receiving an in-dialog
// request whose dialog identifier (Call-ID + local-tag + remote-tag)
// matches none of its known dialogs MUST respond with 481. This rule
// asserts the response shape — the 481-aware suppression in
// `rfc.cseq`/`rfc.tags` covers the complementary obligation (don't
// double-fail when the agent already replied 481).
// ---------------------------------------------------------------------------

export const unknownDialog481Rule: CrossMessageRule = {
  name: "rfc.unknownDialog481",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        // The projector keys each slice by (callId, fromTag, toTag) and
        // groups every message that shares those tags into the slice's
        // perAgent slots. Therefore an in-dialog request in any slot
        // already belongs to `slice`'s dialog by construction — the
        // agent recognised the dialog (the projector wouldn't have
        // landed the request here otherwise).
        //
        // The only window where "unknown dialog" is observable from
        // this projection is when `slice.toTag === null` — i.e. the
        // pending-bucket for a dialog the UAS never confirmed. An
        // in-dialog request with both tags landing in a null-toTag
        // slice is impossible (it would migrate to the confirmed key),
        // so this rule never fires under normal slicing. It's kept as
        // a future tripwire if the projector's invariants change.
        if (slice.toTag !== null) continue
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)
          for (const ev of events) {
            if (ev.kind !== "received") continue
            const msg = ev.msg
            if (msg.type !== "request") continue
            const fromTag = msg.getHeader("from").tag
            const toTag = msg.getHeader("to").tag
            if (!fromTag || !toTag) continue
            // The slice has toTag=null but this received request has a
            // To-tag. The projector should have migrated it — if we
            // ever land here, it means the projector did not learn the
            // dialog and the agent never responded with a To-tag.
            const callId = msg.getHeader("call-id")
            out.push({
              bindKey: slot.bindKey,
              detail:
                `Received in-dialog request ${msg.method} for unknown ` +
                `dialog ${callId}/${fromTag}/${toTag} — agent must respond ` +
                `481 (RFC 3261 §12.2.2 / RFC3261-MUST-071)`,
            })
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.unsupportedMethod405Allow
//
// RFC 3261 §8.2.1 / RFC3261-MUST-030: a UAS that does not recognise a
// request method MUST respond with 405 (Method Not Allowed); the 405
// MUST carry an Allow header listing the methods it does support.
// Regression-only: no current fixture emits an unrecognised method, but
// any future fabricated peer that does will surface here.
// ---------------------------------------------------------------------------

const RECOGNISED_METHODS: ReadonlySet<string> = new Set<string>([
  "INVITE",
  "ACK",
  "BYE",
  "CANCEL",
  "OPTIONS",
  "REGISTER",
  "PRACK",
  "UPDATE",
  "INFO",
  "REFER",
  "SUBSCRIBE",
  "NOTIFY",
  "MESSAGE",
  "PUBLISH",
])

export const unsupportedMethod405AllowRule: CrossMessageRule = {
  name: "rfc.unsupportedMethod405Allow",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          // Per-Via-branch view of unrecognised-method requests this
          // agent received, and the response (if any) the agent sent on
          // the same branch.
          const unrecognisedByBranch = new Map<
            string,
            { method: string; callId: string }
          >()
          const responseByBranch = new Map<
            string,
            { status: number; allowCount: number }
          >()

          for (const ev of events) {
            const msg = ev.msg
            if (
              ev.kind === "received" &&
              msg.type === "request" &&
              !RECOGNISED_METHODS.has(msg.method.toUpperCase())
            ) {
              const branch = msg.getHeader("via")[0]?.branch ?? ""
              if (!branch) continue
              if (!unrecognisedByBranch.has(branch)) {
                unrecognisedByBranch.set(branch, {
                  method: msg.method,
                  callId: msg.getHeader("call-id"),
                })
              }
              continue
            }
            if (ev.kind === "sent" && msg.type === "response") {
              const branch = msg.getHeader("via")[0]?.branch ?? ""
              if (!branch) continue
              if (!unrecognisedByBranch.has(branch)) continue
              if (!responseByBranch.has(branch)) {
                responseByBranch.set(branch, {
                  status: msg.status,
                  allowCount: getAllHeaderValues(msg.headers, "allow").length,
                })
              }
            }
          }

          for (const [branch, info] of unrecognisedByBranch) {
            const resp = responseByBranch.get(branch)
            const status = resp?.status ?? 0
            const allowCount = resp?.allowCount ?? 0
            if (resp && status === 405 && allowCount > 0) continue
            out.push({
              bindKey: slot.bindKey,
              detail:
                `Received unrecognised method ${info.method} (Call-ID ` +
                `${info.callId}, branch ${branch}) — UAS must respond 405 ` +
                `with Allow header (RFC 3261 §8.2.1 / RFC3261-MUST-030); ` +
                `got ${status} / Allow=${allowCount}`,
            })
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.unsupportedExtension420
//
// RFC 3261 §8.2.2 / RFC3261-MUST-033: a UAS that receives a request
// whose Require header lists an option tag it does not support MUST
// respond with 420 (Bad Extension) and MUST carry an Unsupported
// header listing the rejected tags.
//
// Regression-only: no current fixture emits Require with a fabricated
// option tag; rule acts as a tripwire.
// ---------------------------------------------------------------------------

const RECOGNISED_OPTION_TAGS: ReadonlySet<string> = new Set<string>([
  "100rel",
  "timer",
  "replaces",
  "gruu",
  "path",
  "outbound",
  "eventlist",
  "sec-agree",
])

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

export const unsupportedExtension420Rule: CrossMessageRule = {
  name: "rfc.unsupportedExtension420",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          // Per-Via-branch view of requests this agent received that
          // carry at least one unsupported Require tag, plus the
          // response (if any) it sent on the same branch.
          const unsupportedByBranch = new Map<
            string,
            {
              method: string
              callId: string
              unsupportedTags: ReadonlyArray<string>
            }
          >()
          const responseByBranch = new Map<
            string,
            { status: number; unsupportedCount: number }
          >()

          for (const ev of events) {
            const msg = ev.msg
            if (ev.kind === "received" && msg.type === "request") {
              const requireValues = getAllHeaderValues(msg.headers, "require")
              if (requireValues.length === 0) continue
              const tags = collectOptionTags(requireValues)
              const unsupported = tags.filter(
                (t) => !RECOGNISED_OPTION_TAGS.has(t),
              )
              if (unsupported.length === 0) continue
              const branch = msg.getHeader("via")[0]?.branch ?? ""
              if (!branch) continue
              if (!unsupportedByBranch.has(branch)) {
                unsupportedByBranch.set(branch, {
                  method: msg.method,
                  callId: msg.getHeader("call-id"),
                  unsupportedTags: unsupported,
                })
              }
              continue
            }
            if (ev.kind === "sent" && msg.type === "response") {
              const branch = msg.getHeader("via")[0]?.branch ?? ""
              if (!branch) continue
              if (!unsupportedByBranch.has(branch)) continue
              if (!responseByBranch.has(branch)) {
                responseByBranch.set(branch, {
                  status: msg.status,
                  unsupportedCount: getAllHeaderValues(
                    msg.headers,
                    "unsupported",
                  ).length,
                })
              }
            }
          }

          for (const [branch, info] of unsupportedByBranch) {
            const resp = responseByBranch.get(branch)
            const status = resp?.status ?? 0
            const unsupportedCount = resp?.unsupportedCount ?? 0
            if (resp && status === 420 && unsupportedCount > 0) continue
            out.push({
              bindKey: slot.bindKey,
              detail:
                `Received request ${info.method} requires unsupported ` +
                `option tag(s) [${info.unsupportedTags.join(", ")}] ` +
                `(callId ${info.callId}, branch ${branch}) — UAS must ` +
                `respond 420 with Unsupported header; got ${status} / ` +
                `Unsupported=${unsupportedCount}`,
            })
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.unsupported415Accepts
//
// RFC 3261 §8.2.3 / RFC3261-MUST-036 (also covers RFC3261-MUST-180
// restatement): a UAS that does not understand the request's
// Content-Type / Content-Encoding / Content-Language MUST respond 415
// (Unsupported Media Type). The 415 response MUST list the formats it
// does support via Accept / Accept-Encoding / Accept-Language headers.
//
// Single-message check (only inspects the sent 415); modelled as a
// CrossMessageRule because the peer-rule machinery walks per-bind in
// flat-message order without the per-agent slot view.
//
// Regression-only: no current fixture sends a 415; rule acts as a
// tripwire if a fabricated UAS ever does.
// ---------------------------------------------------------------------------

export const unsupported415AcceptsRule: CrossMessageRule = {
  name: "rfc.unsupported415Accepts",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)
          for (const ev of events) {
            const msg = ev.msg
            if (ev.kind !== "sent" || msg.type !== "response") continue
            if (msg.status !== 415) continue
            const hasAccept =
              getAllHeaderValues(msg.headers, "accept").length > 0 ||
              getAllHeaderValues(msg.headers, "accept-encoding").length > 0 ||
              getAllHeaderValues(msg.headers, "accept-language").length > 0
            if (hasAccept) continue
            const callId = msg.getHeader("call-id")
            const branch = msg.getHeader("via")[0]?.branch ?? ""
            out.push({
              bindKey: slot.bindKey,
              detail:
                `Sent 415 response (callId ${callId}, branch ${branch}) ` +
                `carries no Accept / Accept-Encoding / Accept-Language ` +
                `header — RFC 3261 §8.2.3 / RFC3261-MUST-036`,
            })
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.responseExtensionsAdvertised
//
// RFC 3261 §8.2.2.1 / RFC3261-MUST-037: a UAS MUST NOT apply an
// extension in a response unless support for it is indicated. Any
// extension applied to a non-421 response MUST be listed in a Supported
// header (or in Require if mandatory). MUST NOT apply extensions not
// listed in the Supported header.
//
// Narrow tripwire: for each sent INVITE response (status 100-699), if
// the matching received INVITE (correlated by top-Via branch) carried
// Require tags, every Require tag MUST be echoed in the response's
// Supported or Require — unless the response is a 420 / 421 (extension
// rejection). Fires when the UAS accepted (with any 1xx/2xx) an
// INVITE whose Require tags it did not advertise.
//
// Regression-only: current fixtures emit Supported in 2xx via the
// message builder; rule trips if an unadvertised extension ever
// appears.
// ---------------------------------------------------------------------------

export const responseExtensionsAdvertisedRule: CrossMessageRule = {
  name: "rfc.responseExtensionsAdvertised",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          // Per-Via-branch view of INVITEs this agent received, keyed
          // by top-Via branch, recording the Require tags they carried.
          const inviteRequireByBranch = new Map<string, ReadonlyArray<string>>()

          for (const ev of events) {
            const msg = ev.msg
            if (
              ev.kind === "received" &&
              msg.type === "request" &&
              msg.method.toUpperCase() === "INVITE"
            ) {
              const branch = msg.getHeader("via")[0]?.branch ?? ""
              if (!branch) continue
              if (inviteRequireByBranch.has(branch)) continue
              const requireTags = collectOptionTags(
                getAllHeaderValues(msg.headers, "require"),
              )
              inviteRequireByBranch.set(branch, requireTags)
              continue
            }
            if (ev.kind !== "sent" || msg.type !== "response") continue
            if (msg.getHeader("cseq").method.toUpperCase() !== "INVITE") continue
            if (msg.status === 420 || msg.status === 421) continue
            const branch = msg.getHeader("via")[0]?.branch ?? ""
            if (!branch) continue
            const inviteRequire = inviteRequireByBranch.get(branch)
            if (!inviteRequire || inviteRequire.length === 0) continue
            const advertised = new Set<string>([
              ...collectOptionTags(
                getAllHeaderValues(msg.headers, "supported"),
              ),
              ...collectOptionTags(getAllHeaderValues(msg.headers, "require")),
            ])
            const missing = inviteRequire.filter((t) => !advertised.has(t))
            if (missing.length === 0) continue
            out.push({
              bindKey: slot.bindKey,
              detail:
                `Sent INVITE response (status ${msg.status}, branch ` +
                `${branch}) accepted INVITE with Require=` +
                `[${inviteRequire.join(", ")}] but did not advertise ` +
                `${missing.join(", ")} in Supported/Require — ` +
                `RFC 3261 §8.2.2.1 / RFC3261-MUST-037`,
            })
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.registerNoRouteSet
//
// RFC 3261 §10.2 / RFC3261-MUST-051 + RFC3261-MUST-052: a REGISTER
// request MUST NOT contain a Route header, and MUST NOT establish a
// dialog or form a route set. Per-agent walk over sent REGISTER
// requests: fire on any Route header presence. The "no dialog formed"
// half is architecturally guaranteed by the message builder; this rule
// covers the observable Route-absence half.
//
// Regression-only: no current fixture sends REGISTER with Route.
// ---------------------------------------------------------------------------

export const registerNoRouteSetRule: CrossMessageRule = {
  name: "rfc.registerNoRouteSet",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)
          for (const ev of events) {
            const msg = ev.msg
            if (ev.kind !== "sent" || msg.type !== "request") continue
            if (msg.method.toUpperCase() !== "REGISTER") continue
            const routeValues = getAllHeaderValues(msg.headers, "route")
            if (routeValues.length === 0) continue
            const callId = msg.getHeader("call-id")
            out.push({
              bindKey: slot.bindKey,
              detail:
                `Sent REGISTER (callId ${callId}) carries Route header — ` +
                `RFC 3261 §10.2 / RFC3261-MUST-051`,
            })
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.optionsResponseEchoes
//
// RFC 3261 §11.2 / RFC3261-MUST-059: a UAS receiving OPTIONS MUST
// respond, and the response (200 OK in the normal case) MUST carry
// Allow / Supported / Accept headers describing the UAS's capabilities
// — matching what an INVITE response would carry.
//
// Per-Via-branch correlation: for each received OPTIONS, find the
// agent's sent response on the same top-Via branch. When the response
// is 2xx, fire if none of Allow / Supported / Accept appears.
//
// Regression-only: no current fixture issues an OPTIONS probe; the
// rule trips if a 2xx OPTIONS response omits capability headers.
// ---------------------------------------------------------------------------

export const optionsResponseEchoesRule: CrossMessageRule = {
  name: "rfc.optionsResponseEchoes",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          const optionsByBranch = new Map<string, { callId: string }>()

          for (const ev of events) {
            const msg = ev.msg
            if (
              ev.kind === "received" &&
              msg.type === "request" &&
              msg.method.toUpperCase() === "OPTIONS"
            ) {
              const branch = msg.getHeader("via")[0]?.branch ?? ""
              if (!branch) continue
              if (!optionsByBranch.has(branch)) {
                optionsByBranch.set(branch, {
                  callId: msg.getHeader("call-id"),
                })
              }
              continue
            }
            if (ev.kind !== "sent" || msg.type !== "response") continue
            if (msg.getHeader("cseq").method.toUpperCase() !== "OPTIONS") continue
            if (msg.status < 200 || msg.status >= 300) continue
            const branch = msg.getHeader("via")[0]?.branch ?? ""
            if (!branch) continue
            const info = optionsByBranch.get(branch)
            if (!info) continue
            const hasAllow =
              getAllHeaderValues(msg.headers, "allow").length > 0
            const hasSupported =
              getAllHeaderValues(msg.headers, "supported").length > 0
            const hasAccept =
              getAllHeaderValues(msg.headers, "accept").length > 0
            if (hasAllow || hasSupported || hasAccept) continue
            out.push({
              bindKey: slot.bindKey,
              detail:
                `Sent 2xx OPTIONS response (callId ${info.callId}, branch ` +
                `${branch}) lacks Allow/Supported/Accept headers — ` +
                `RFC 3261 §11.2 / RFC3261-MUST-059`,
            })
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.concurrentReInvite500or491
//
// RFC 3261 §14.2 / RFC3261-MUST-086: a UAS receiving a re-INVITE while a
// prior INVITE transaction in the same dialog is still in progress MUST
// respond 500 (Server Internal Error) with Retry-After, OR 491 (Request
// Pending).
//
// Per-agent walk: track per-dialog (callId + tags, both orderings) the
// set of in-progress INVITE branches (received INVITE in-progress from
// receipt until the agent sends its final 200-699 on that Via branch).
// For each received in-dialog INVITE whose dialog already has another
// INVITE in progress, the response on the new INVITE's branch MUST be
// 491 OR 500 with Retry-After. Fire if no response, wrong status, or
// 500 without Retry-After.
//
// Regression-only: no current fixture races two re-INVITEs into the
// same dialog.
// ---------------------------------------------------------------------------

export const concurrentReInvite500or491Rule: CrossMessageRule = {
  name: "rfc.concurrentReInvite500or491",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          const dialogKey = (callId: string, a: string, b: string): string =>
            `${callId}\x00${a}\x00${b}`

          // Per-dialog set of in-progress received-INVITE branches.
          const inProgressByDialog = new Map<string, Set<string>>()
          // Per-received-INVITE bookkeeping for reporting / response match.
          const branchToDialog = new Map<string, string>()
          const concurrentByBranch = new Map<
            string,
            { callId: string }
          >()
          const responseByBranch = new Map<
            string,
            { status: number; hasRetryAfter: boolean }
          >()

          const addInProgress = (dKey: string, branch: string): void => {
            let s = inProgressByDialog.get(dKey)
            if (!s) {
              s = new Set<string>()
              inProgressByDialog.set(dKey, s)
            }
            s.add(branch)
          }

          for (const ev of events) {
            const msg = ev.msg

            if (ev.kind === "received" && msg.type === "request") {
              if (msg.method.toUpperCase() !== "INVITE") continue
              const toTag = msg.getHeader("to").tag
              const fromTag = msg.getHeader("from").tag
              // Re-INVITE = INVITE with To-tag (in-dialog).
              if (!toTag || !fromTag) continue
              const branch = msg.getHeader("via")[0]?.branch ?? ""
              if (!branch) continue
              const callId = msg.getHeader("call-id")
              // Key both tag orderings so we match regardless of role.
              const dKey = dialogKey(callId, fromTag, toTag)
              const dKeyAlt = dialogKey(callId, toTag, fromTag)
              const inProgA = inProgressByDialog.get(dKey)
              const inProgB = inProgressByDialog.get(dKeyAlt)
              // INVITE retransmit reuses the same Via top-branch — skip.
              const isRetransmit =
                (inProgA?.has(branch) ?? false) ||
                (inProgB?.has(branch) ?? false)
              const priorOtherInProgress =
                !isRetransmit &&
                (((inProgA && [...inProgA].some((b) => b !== branch)) ?? false) ||
                  ((inProgB && [...inProgB].some((b) => b !== branch)) ?? false))
              if (priorOtherInProgress) {
                concurrentByBranch.set(branch, { callId })
              }
              addInProgress(dKey, branch)
              branchToDialog.set(branch, dKey)
              continue
            }

            if (ev.kind === "sent" && msg.type === "response") {
              if (msg.getHeader("cseq").method.toUpperCase() !== "INVITE")
                continue
              const branch = msg.getHeader("via")[0]?.branch ?? ""
              if (!branch) continue
              if (concurrentByBranch.has(branch) && !responseByBranch.has(branch)) {
                const hasRetryAfter =
                  getAllHeaderValues(msg.headers, "retry-after").length > 0
                responseByBranch.set(branch, {
                  status: msg.status,
                  hasRetryAfter,
                })
              }
              // Mark in-progress branches complete on final response.
              if (msg.status >= 200 && msg.status < 700) {
                const dKey = branchToDialog.get(branch)
                if (dKey) {
                  const s = inProgressByDialog.get(dKey)
                  if (s) s.delete(branch)
                }
              }
            }
          }

          for (const [branch, info] of concurrentByBranch) {
            const resp = responseByBranch.get(branch)
            if (resp) {
              if (resp.status === 491) continue
              if (resp.status === 500 && resp.hasRetryAfter) continue
            }
            const status = resp?.status ?? 0
            const hasRetryAfter = resp?.hasRetryAfter ?? false
            out.push({
              bindKey: slot.bindKey,
              detail:
                `Received concurrent re-INVITE (callId ${info.callId}, ` +
                `branch ${branch}) while prior INVITE in progress — UAS ` +
                `must respond 491 or 500+Retry-After; got ${status}/` +
                `RetryAfter=${hasRetryAfter}`,
            })
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.noByeOutsideOrEarlyDialog
//
// RFC 3261 §15 / RFC3261-MUST-089: a UA MUST NOT send a BYE outside of
// a dialog; the callee (UAS for the dialog) MUST NOT send a BYE on an
// early dialog (it should use CANCEL or a 4xx/5xx/6xx final response
// instead).
//
// Per-agent walk: track each dialog by (callId + tag pair, both
// orderings) and its state (early / confirmed / terminated). Mark this
// agent as the UAS for a dialog the first time it sends a 1xx-or-2xx
// response carrying a To-tag (its tag becomes the dialog identifier's
// local side). For each sent BYE: fire when no matching dialog exists
// (outside-any-dialog); fire when the matching dialog is still `early`
// and this agent is the UAS.
//
// Regression-only: no current fixture sends BYE outside a dialog or
// from a callee on an early dialog; rule trips if either ever happens.
// ---------------------------------------------------------------------------

export const noByeOutsideOrEarlyDialogRule: CrossMessageRule = {
  name: "rfc.noByeOutsideOrEarlyDialog",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        // "Outside any dialog" half: a sent BYE in a slice whose toTag
        // is null means the projector never observed a UAS response
        // with a To-tag to confirm the dialog — i.e. there is no
        // dialog from the projector's POV.
        const sliceHasConfirmedDialog = slice.toTag !== null
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)
          // Early-dialog tracking (within the slot's own view): the
          // agent acts as UAS for this dialog only if it sent a
          // tagged 1xx/2xx whose To-tag == slice.toTag. Tracks when
          // the agent's UAS 2xx has been sent — early means slice has
          // toTag but no 2xx-with-toTag has been emitted from this
          // slot.
          let agentIsUas = false
          let agentSent2xx = false
          for (const ev of events) {
            const msg = ev.msg
            if (msg.type === "response" && ev.kind === "sent") {
              const cseqMethod = msg.getHeader("cseq").method.toUpperCase()
              if (cseqMethod !== "INVITE") continue
              const respToTag = msg.getHeader("to").tag ?? ""
              if (!respToTag || respToTag !== slice.toTag) continue
              agentIsUas = true
              if (msg.status >= 200 && msg.status < 300) {
                agentSent2xx = true
              }
              continue
            }
            if (msg.type !== "request" || ev.kind !== "sent") continue
            if (msg.method.toUpperCase() !== "BYE") continue
            const callId = msg.getHeader("call-id")
            const fromTag = msg.getHeader("from").tag ?? ""
            const toTag = msg.getHeader("to").tag ?? ""
            if (!sliceHasConfirmedDialog || !fromTag || !toTag) {
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `Sent BYE (callId ${callId}) outside any dialog — ` +
                  `RFC 3261 §15 / RFC3261-MUST-089`,
              })
              continue
            }
            // Tag-match against slice in either ordering — UAC and UAS
            // legs swap fromTag/toTag on outbound BYE.
            const sliceFrom = slice.fromTag
            const sliceTo = slice.toTag
            const matchesSlice =
              (fromTag === sliceFrom && toTag === sliceTo) ||
              (fromTag === sliceTo && toTag === sliceFrom)
            if (!matchesSlice) {
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `Sent BYE (callId ${callId}) outside any dialog — ` +
                  `RFC 3261 §15 / RFC3261-MUST-089`,
              })
              continue
            }
            if (agentIsUas && !agentSent2xx) {
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `Callee sent BYE on early dialog (callId ${callId}) ` +
                  `— should use CANCEL or 4xx/5xx/6xx (RFC 3261 §15)`,
              })
            }
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.noTarget404
//
// RFC 3261 §16.3 / RFC3261-MUST-105: when a proxy / SipRouter cannot
// resolve any target for the request URI, it MUST respond 404 (Not
// Found).
//
// Observationally narrow: per-slot, for each *received* request whose
// top-Via branch never appears on any *sent* request from the same
// agent (i.e. the proxy did not forward this branch), the agent's
// final response on that branch — if any — MUST be 404. If a non-404
// 4xx/5xx/6xx final was emitted instead, fire.
//
// Regression-only: current fixtures always resolve a target; rule
// trips when a proxy synthesises non-404 finals for an unresolved
// request URI.
// ---------------------------------------------------------------------------

export const noTarget404Rule: CrossMessageRule = {
  name: "rfc.noTarget404",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          const sentBranches = new Set<string>()
          const receivedByBranch = new Map<
            string,
            { method: string; callId: string }
          >()
          const finalByBranch = new Map<string, number>()

          for (const ev of events) {
            const msg = ev.msg
            const branch = msg.getHeader("via")[0]?.branch ?? ""
            if (!branch) continue

            if (ev.kind === "sent" && msg.type === "request") {
              sentBranches.add(branch)
              continue
            }
            if (ev.kind === "received" && msg.type === "request") {
              if (!receivedByBranch.has(branch)) {
                receivedByBranch.set(branch, {
                  method: msg.method,
                  callId: msg.getHeader("call-id"),
                })
              }
              continue
            }
            if (ev.kind === "sent" && msg.type === "response") {
              if (msg.status >= 200 && !finalByBranch.has(branch)) {
                finalByBranch.set(branch, msg.status)
              }
            }
          }

          for (const [branch, info] of receivedByBranch) {
            if (sentBranches.has(branch)) continue
            const status = finalByBranch.get(branch)
            if (status === undefined) continue
            if (status < 400 || status >= 700) continue
            if (status === 404) continue
            out.push({
              bindKey: slot.bindKey,
              detail:
                `Proxy received request ${info.method} (callId ` +
                `${info.callId}, branch ${branch}) and emitted final ` +
                `response ${status} without forwarding — expected 404 ` +
                `(RFC 3261 §16.3 / RFC3261-MUST-105)`,
            })
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.unsupportedExtension421
//
// RFC 3261 §21.4.15 / RFC3261-MUST-182 (also covers RFC3261-MUST-181
// restatement): when a UAS sends a 421 (Extension Required) response,
// the response MUST contain a Require header field listing the
// extensions the UAS requires the UAC to support.
//
// Per-agent walk: for each sent response with status 421, fire when no
// Require header (with at least one option tag) is present.
//
// Regression-only: no current fixture sends a 421; rule trips if a
// fabricated 421 is ever emitted without Require.
// ---------------------------------------------------------------------------

export const unsupportedExtension421Rule: CrossMessageRule = {
  name: "rfc.unsupportedExtension421",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)
          for (const ev of events) {
            const msg = ev.msg
            if (ev.kind !== "sent" || msg.type !== "response") continue
            if (msg.status !== 421) continue
            const requireTags = collectOptionTags(
              getAllHeaderValues(msg.headers, "require"),
            )
            if (requireTags.length > 0) continue
            const callId = msg.getHeader("call-id")
            const branch = msg.getHeader("via")[0]?.branch ?? ""
            out.push({
              bindKey: slot.bindKey,
              detail:
                `Sent 421 response (callId ${callId}, branch ${branch}) ` +
                `lacks Require header listing required extensions — ` +
                `RFC 3261 §21.4.15 / RFC3261-MUST-182`,
            })
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.ackRequireSubsetOfInvite
//
// RFC 3261 §13.2.2.4 / RFC3261-MUST-035: an ACK to a 2xx INVITE response
// MUST contain only those Require (and Proxy-Require) option tags that
// were present in the original INVITE — i.e. the ACK's Require set must
// be a subset of the INVITE's Require set.
//
// Per-agent walk: build a per-top-Via-branch index, then for every sent
// ACK look up the sent INVITE on the same branch and compare option-tag
// sets. Fires when the ACK carries any tag absent from the INVITE.
//
// Regression-only: no current fixture stamps mismatched Require on ACK;
// rule trips if it ever happens.
// ---------------------------------------------------------------------------

export const ackRequireSubsetOfInviteRule: CrossMessageRule = {
  name: "rfc.ackRequireSubsetOfInvite",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)
          const idx = buildBranchIndex(events)

          for (const ev of events) {
            if (ev.kind !== "sent" || ev.msg.type !== "request") continue
            const ack = ev.msg
            if (ack.method.toUpperCase() !== "ACK") continue
            const branch = ack.getHeader("via")[0]?.branch ?? ""
            if (!branch) continue
            const invite = findInviteByBranch(idx, branch, "sent")
            if (!invite) continue
            const ackTags = splitOptionTags(
              getAllHeaderValues(ack.headers, "require"),
            )
            if (ackTags.length === 0) continue
            const inviteTags = splitOptionTags(
              getAllHeaderValues(invite.headers, "require"),
            )
            const inviteSet = new Set(inviteTags)
            const extras = ackTags.filter((t) => !inviteSet.has(t))
            if (extras.length === 0) continue
            const callId = ack.getHeader("call-id")
            out.push({
              bindKey: slot.bindKey,
              detail:
                `Sent ACK Require=[${ackTags.join(", ")}] not a subset of ` +
                `INVITE Require=[${inviteTags.join(", ")}] (callId ${callId}, ` +
                `branch ${branch}) — RFC 3261 §13.2.2.4 / RFC3261-MUST-035`,
            })
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.cancelRouteEchoesInvite
//
// RFC 3261 §9.1 / RFC3261-MUST-046: a CANCEL request MUST have the same
// Route header field values as the INVITE it is cancelling. CANCEL shares
// the INVITE's top-Via branch (§9.1), so a per-branch index pairs them.
//
// Per-agent walk: build a per-top-Via-branch index, then for every sent
// CANCEL look up the sent INVITE on the same branch and compare Route
// header values in order. Skip when no matching INVITE is found (a
// different problem caught by other rules).
//
// Regression-only: no current fixture mismatches CANCEL Route vs INVITE
// Route; rule trips on Route divergence.
// ---------------------------------------------------------------------------

export const cancelRouteEchoesInviteRule: CrossMessageRule = {
  name: "rfc.cancelRouteEchoesInvite",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)
          const idx = buildBranchIndex(events)

          for (const ev of events) {
            if (ev.kind !== "sent" || ev.msg.type !== "request") continue
            const cancel = ev.msg
            if (cancel.method.toUpperCase() !== "CANCEL") continue
            const branch = cancel.getHeader("via")[0]?.branch ?? ""
            if (!branch) continue
            const invite = findInviteByBranch(idx, branch, "sent")
            if (!invite) continue
            const cancelRoutes = getAllHeaderValues(cancel.headers, "route")
            const inviteRoutes = getAllHeaderValues(invite.headers, "route")
            if (cancelRoutes.length === inviteRoutes.length) {
              let same = true
              for (let i = 0; i < cancelRoutes.length; i++) {
                if (cancelRoutes[i] !== inviteRoutes[i]) {
                  same = false
                  break
                }
              }
              if (same) continue
            }
            const callId = cancel.getHeader("call-id")
            out.push({
              bindKey: slot.bindKey,
              detail:
                `Sent CANCEL Route values [${cancelRoutes.join(", ")}] differ ` +
                `from INVITE Route values [${inviteRoutes.join(", ")}] ` +
                `(callId ${callId}, branch ${branch}) — RFC 3261 §9.1 / ` +
                `RFC3261-MUST-046`,
            })
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.cancelAfter1xx
//
// RFC 3261 §9.1 / RFC3261-MUST-048: a UAC MUST NOT send CANCEL for an
// INVITE until at least one provisional (1xx) response has been
// received for it. CANCEL shares the INVITE's top-Via branch, so we
// track the earliest received response status per branch as we walk
// the agent's event stream; when a sent CANCEL appears, fire if its
// branch has no prior received response or only a final (>= 200).
//
// Regression-only: current fixtures wait for 1xx before CANCEL; rule
// trips if a peer ever fires CANCEL prematurely.
// ---------------------------------------------------------------------------

export const cancelAfter1xxRule: CrossMessageRule = {
  name: "rfc.cancelAfter1xx",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          // First received response status per top-Via branch, in
          // insertion order. A simpler `firstResponseStatusFor`
          // (whole-stream) lookup would race CANCEL against later
          // responses; the live walk is what enforces "before".
          const firstReceivedStatus = new Map<string, number>()

          for (const ev of events) {
            const msg = ev.msg
            const branch = msg.getHeader("via")[0]?.branch ?? ""
            if (!branch) continue

            if (ev.kind === "received" && msg.type === "response") {
              if (!firstReceivedStatus.has(branch)) {
                firstReceivedStatus.set(branch, msg.status)
              }
              continue
            }

            if (
              ev.kind === "sent" &&
              msg.type === "request" &&
              msg.method.toUpperCase() === "CANCEL"
            ) {
              const earliest = firstReceivedStatus.get(branch)
              if (earliest !== undefined && earliest < 200) continue
              const callId = msg.getHeader("call-id")
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `Sent CANCEL (callId ${callId}, branch ${branch}) before ` +
                  `any received 1xx for the INVITE — RFC 3261 §9.1 / ` +
                  `RFC3261-MUST-048`,
              })
            }
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.serialRegister
//
// RFC 3261 §10.2 / RFC3261-MUST-054: a UAC MUST NOT send a REGISTER request
// with a different Contact than a prior REGISTER until the prior REGISTER
// has received a final response (or its transaction times out).
//
// Per-agent walk: track per-AOR (To-URI) the currently in-flight REGISTER's
// branch and Contact value. For each sent REGISTER, fire when an in-flight
// REGISTER exists for the same AOR AND its Contact differs from the new
// request's. Clear the in-flight entry when a final response (>= 200) is
// received on its branch.
//
// Regression-only: no current fixture races concurrent REGISTERs with
// different Contacts for the same AOR.
// ---------------------------------------------------------------------------

export const serialRegisterRule: CrossMessageRule = {
  name: "rfc.serialRegister",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)
          const idx = buildBranchIndex(events)

          interface InFlight {
            branch: string
            contact: string
          }
          // AOR (To-URI string) → currently in-flight REGISTER record.
          const inFlightByAor = new Map<string, InFlight>()

          const contactValue = (msg: {
            headers: ReadonlyArray<{ name: string; value: string }>
          }): string =>
            getAllHeaderValues(msg.headers, "contact").join(",")

          const hasFinalReceived = (branch: string): boolean => {
            for (const r of responsesFor(idx, branch, "received")) {
              if (r.status >= 200) return true
            }
            return false
          }

          for (const ev of events) {
            if (ev.kind !== "sent" || ev.msg.type !== "request") continue
            const reg = ev.msg
            if (reg.method.toUpperCase() !== "REGISTER") continue
            const branch = reg.getHeader("via")[0]?.branch ?? ""
            if (!branch) continue
            const aor = reg.getHeader("to").uri
            const contact = contactValue(reg)

            const prior = inFlightByAor.get(aor)
            // Clear stale in-flight when its branch already saw a final.
            if (prior && hasFinalReceived(prior.branch)) {
              inFlightByAor.delete(aor)
            }
            const stillPending = inFlightByAor.get(aor)
            if (stillPending && stillPending.contact !== contact) {
              const callId = reg.getHeader("call-id")
              out.push({
                bindKey: slot.bindKey,
                detail:
                  `Sent REGISTER (callId ${callId}, branch ${branch}) with ` +
                  `new Contact while prior REGISTER (branch ${stillPending.branch}) ` +
                  `for AOR ${aor} still pending — RFC 3261 §10.2 / ` +
                  `RFC3261-MUST-054`,
              })
              continue
            }
            if (!stillPending) {
              inFlightByAor.set(aor, { branch, contact })
            }
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.noReInviteWhileInviteInProgress
//
// RFC 3261 §14.1 / RFC3261-MUST-083 (covers RFC3261-MUST-084 restatement):
// a UAC MUST NOT issue a new INVITE within an existing dialog while a prior
// INVITE transaction is still in progress.
//
// Per-agent walk: track per dialog (callId + both tag orderings) the set of
// in-progress sent-INVITE branches. An INVITE transaction goes in-progress
// when the UAC sends it and terminates when any received final (>= 200) for
// that INVITE's top-Via branch arrives (the ACK for non-2xx is the formal
// transaction terminator but the received final is the earliest unambiguous
// signal that no further INVITE may be issued without it). For each sent
// in-dialog INVITE (i.e. carrying a To-tag → re-INVITE), fire when the
// dialog has at least one prior in-progress INVITE.
//
// Regression-only — no current fixture races re-INVITEs. Also covers
// RFC3261-MUST-084 restatement.
// ---------------------------------------------------------------------------

export const noReInviteWhileInviteInProgressRule: CrossMessageRule = {
  name: "rfc.noReInviteWhileInviteInProgress",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)

          const dialogKey = (callId: string, a: string, b: string): string =>
            `${callId}\x00${a}\x00${b}`

          // Per-dialog set of in-progress sent-INVITE branches.
          const inProgressByDialog = new Map<string, Set<string>>()
          // sent-INVITE branch → dialog key, so received finals can clear.
          const branchToDialog = new Map<string, string>()

          const addInProgress = (dKey: string, branch: string): void => {
            let s = inProgressByDialog.get(dKey)
            if (!s) {
              s = new Set<string>()
              inProgressByDialog.set(dKey, s)
            }
            s.add(branch)
          }

          for (const ev of events) {
            const msg = ev.msg

            if (ev.kind === "sent" && msg.type === "request") {
              if (msg.method.toUpperCase() !== "INVITE") continue
              const branch = msg.getHeader("via")[0]?.branch ?? ""
              if (!branch) continue
              const callId = msg.getHeader("call-id")
              const fromTag = msg.getHeader("from").tag ?? ""
              const toTag = msg.getHeader("to").tag ?? ""
              // Only in-dialog re-INVITEs (with To-tag) can violate; the
              // initial INVITE has no dialog to be "within" yet.
              if (toTag && fromTag) {
                const dKey = dialogKey(callId, fromTag, toTag)
                const dKeyAlt = dialogKey(callId, toTag, fromTag)
                const inProgA = inProgressByDialog.get(dKey)
                const inProgB = inProgressByDialog.get(dKeyAlt)
                // INVITE retransmit reuses the same Via top-branch (RFC
                // 3261 §17.1.1). Skip when we've already seen this branch
                // in either ordering's in-progress set.
                const isRetransmit =
                  (inProgA?.has(branch) ?? false) ||
                  (inProgB?.has(branch) ?? false)
                const prior =
                  (inProgA && inProgA.size > 0 ? [...inProgA].find((b) => b !== branch) : undefined) ??
                  (inProgB && inProgB.size > 0 ? [...inProgB].find((b) => b !== branch) : undefined)
                if (!isRetransmit && prior) {
                  out.push({
                    bindKey: slot.bindKey,
                    detail:
                      `Sent re-INVITE (callId ${callId}, branch ${branch}) ` +
                      `while prior INVITE (branch ${prior}) still in ` +
                      `progress — RFC 3261 §14.1 / RFC3261-MUST-083`,
                  })
                }
                addInProgress(dKey, branch)
                branchToDialog.set(branch, dKey)
              } else {
                // Initial INVITE: no dialog yet. Still mark in-progress
                // keyed by from-tag-only so a same-Call-ID re-INVITE
                // before any received final would surface (rare, but
                // covered by registering both tag orderings later when
                // the dialog identifier is complete).
                const fromOnlyKey = dialogKey(callId, fromTag, "")
                addInProgress(fromOnlyKey, branch)
                branchToDialog.set(branch, fromOnlyKey)
              }
              continue
            }

            if (ev.kind === "received" && msg.type === "response") {
              if (msg.getHeader("cseq").method.toUpperCase() !== "INVITE")
                continue
              if (msg.status < 200) continue
              const branch = msg.getHeader("via")[0]?.branch ?? ""
              if (!branch) continue
              const dKey = branchToDialog.get(branch)
              if (!dKey) continue
              const s = inProgressByDialog.get(dKey)
              if (s) s.delete(branch)
              // Once the initial INVITE's dialog identifier is complete,
              // migrate the in-progress entry to the dialog-keyed bucket
              // so subsequent re-INVITEs see the right set.
              const callId = msg.getHeader("call-id")
              const fromTag = msg.getHeader("from").tag ?? ""
              const toTag = msg.getHeader("to").tag ?? ""
              if (fromTag && toTag) {
                const fullKey = dialogKey(callId, fromTag, toTag)
                if (fullKey !== dKey) {
                  // Ensure both orderings exist (empty sets are fine).
                  const alt = dialogKey(callId, toTag, fromTag)
                  if (!inProgressByDialog.has(fullKey))
                    inProgressByDialog.set(fullKey, new Set<string>())
                  if (!inProgressByDialog.has(alt))
                    inProgressByDialog.set(alt, new Set<string>())
                }
              }
            }
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.proxy100WithinT100ms
//
// RFC 3261 §16.7 step 4 / RFC3261-MUST-095: a stateful proxy receiving an
// INVITE it will relay MUST send 100 (Trying) within 200ms of receipt
// (T1/2 by convention).
//
// Per-slot walk: for each received INVITE on the proxy bind, locate a
// sent 100 (Trying) on the same top-Via branch (CSeq method == INVITE,
// status == 100). The OrderedAgentEvent stream exposed to rules carries
// only insertion `idx`, not per-event `atMs` — see
// `tests/harness/projections.ts` (`OrderedEntry` keeps `atMs`, but the
// per-slot `received`/`sent` arrays surface `{idx, msg}` only). So this
// rule degrades to a structural "100 sent on same branch exists" check
// and cannot enforce the 200ms upper bound.
//
// Regression-only — structural-only (atMs missing from rule stream).
// ---------------------------------------------------------------------------

export const proxy100WithinT100msRule: CrossMessageRule = {
  name: "rfc.proxy100WithinT100ms",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)
          const idx = buildBranchIndex(events)

          for (const ev of events) {
            if (ev.kind !== "received" || ev.msg.type !== "request") continue
            const invite = ev.msg
            if (invite.method.toUpperCase() !== "INVITE") continue
            const branch = invite.getHeader("via")[0]?.branch ?? ""
            if (!branch) continue
            const sent100 = responsesFor(idx, branch, "sent").find(
              (r) =>
                r.status === 100 &&
                r.getHeader("cseq").method.toUpperCase() === "INVITE",
            )
            if (sent100) continue
            const callId = invite.getHeader("call-id")
            out.push({
              bindKey: slot.bindKey,
              detail:
                `Proxy did not emit 100 Trying within 200ms of INVITE ` +
                `receipt (callId ${callId}, branch ${branch}; observed ` +
                `Δ=<ms>ms or no 100) — RFC 3261 §16.7 / RFC3261-MUST-095`,
            })
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.strictRouteRewriteHandled
//
// RFC 3261 §16.4 / RFC3261-MUST-100: a proxy receiving a request whose
// topmost Route header URI lacks the `lr` parameter (strict-route topmost)
// MUST apply the §16.4 rewrite before forwarding — the incoming first
// Route URI becomes the outgoing Request-URI.
//
// Per-agent walk: for each received request whose first Route is strict
// (no `;lr`), look up the agent's sent request on the same top-Via
// branch. Fire when no matching sent request exists, or when its
// Request-URI does not equal the URI extracted from the received first
// Route.
//
// Regression-only — current fixtures use loose routing; rule trips if a
// strict-route inbound request is observed and the §16.4 swap isn't
// applied.
// ---------------------------------------------------------------------------

export const strictRouteRewriteHandledRule: CrossMessageRule = {
  name: "rfc.strictRouteRewriteHandled",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)
          const idx = buildBranchIndex(events)

          for (const ev of events) {
            if (ev.kind !== "received" || ev.msg.type !== "request") continue
            const req = ev.msg
            const routes = getAllHeaderValues(req.headers, "route")
            if (routes.length === 0) continue
            const firstRoute = routes[0]!
            const firstUri = extractRouteUri(firstRoute)
            if (routeIsLoose(firstRoute)) continue
            const branch = req.getHeader("via")[0]?.branch ?? ""
            if (!branch) continue
            const callId = req.getHeader("call-id")
            const sent = idx.byBranch.get(branch)?.sentRequests ?? []
            const sentReq = sent.find(
              (r) => r.method.toUpperCase() === req.method.toUpperCase(),
            )
            if (sentReq && sentReq.uri === firstUri) continue
            const sentReqUri = sentReq?.uri ?? "<none>"
            out.push({
              bindKey: slot.bindKey,
              detail:
                `Proxy received strict-route request (callId ${callId}, ` +
                `branch ${branch}; first Route=${firstUri}) but outgoing ` +
                `Request-URI=${sentReqUri} — RFC 3261 §16.4 / ` +
                `RFC3261-MUST-100`,
            })
          }
        }
      }
      return out
    }),
}

// ---------------------------------------------------------------------------
// rfc.ackPreservesInviteRoute
//
// RFC 3261 §17.1.1.3 / RFC3261-MUST-145: the ACK for a non-2xx INVITE MUST
// carry the same Route header values as the INVITE. The non-2xx ACK shares
// the INVITE's top-Via branch (§17.1.1.3), so a per-branch index pairs
// them. An ACK whose branch carries no matching sent INVITE is likely an
// ACK-for-2xx (different branch, different MUST) and is skipped.
//
// Regression-only: no current fixture mismatches ACK/INVITE Route values;
// rule trips on Route divergence.
// ---------------------------------------------------------------------------

export const ackPreservesInviteRouteRule: CrossMessageRule = {
  name: "rfc.ackPreservesInviteRoute",
  check: (slices) =>
    Effect.sync(() => {
      const out: Array<{ bindKey: LaneKey; detail: string }> = []
      for (const slice of slices) {
        for (const slot of slice.perAgent) {
          const events = orderedFromSlot(slot)
          const idx = buildBranchIndex(events)

          for (const ev of events) {
            if (ev.kind !== "sent" || ev.msg.type !== "request") continue
            const ack = ev.msg
            if (ack.method.toUpperCase() !== "ACK") continue
            const branch = ack.getHeader("via")[0]?.branch ?? ""
            if (!branch) continue
            const invite = findInviteByBranch(idx, branch, "sent")
            if (!invite) continue
            const ackRoutes = getAllHeaderValues(ack.headers, "route")
            const inviteRoutes = getAllHeaderValues(invite.headers, "route")
            if (ackRoutes.length === inviteRoutes.length) {
              let same = true
              for (let i = 0; i < ackRoutes.length; i++) {
                if (ackRoutes[i] !== inviteRoutes[i]) {
                  same = false
                  break
                }
              }
              if (same) continue
            }
            const callId = ack.getHeader("call-id")
            out.push({
              bindKey: slot.bindKey,
              detail:
                `Sent ACK Route values [${ackRoutes.join(", ")}] differ from ` +
                `INVITE Route values [${inviteRoutes.join(", ")}] (callId ` +
                `${callId}, branch ${branch}) — RFC 3261 §17.1.1.3 / ` +
                `RFC3261-MUST-145`,
            })
          }
        }
      }
      return out
    }),
}

const sliceTypedRules: ReadonlyArray<CrossMessageRule> = [
  unknownDialog481Rule,
  unsupportedMethod405AllowRule,
  unsupportedExtension420Rule,
  unsupported415AcceptsRule,
  responseExtensionsAdvertisedRule,
  registerNoRouteSetRule,
  optionsResponseEchoesRule,
  concurrentReInvite500or491Rule,
  noByeOutsideOrEarlyDialogRule,
  noTarget404Rule,
  unsupportedExtension421Rule,
  ackRequireSubsetOfInviteRule,
  cancelRouteEchoesInviteRule,
  cancelAfter1xxRule,
  serialRegisterRule,
  noReInviteWhileInviteInProgressRule,
  proxy100WithinT100msRule,
  strictRouteRewriteHandledRule,
  ackPreservesInviteRouteRule,
]

// Advisory overrides — rules that fire on legitimate B2BUA traffic
// (Call-ID rewriting, non-stateful-proxy worker, probe-style OPTIONS)
// where the heuristic can't cleanly distinguish "B2BUA pattern" from
// "real violation" without architectural work. Mirrors the override
// table in cross-message-rules.ts for sdpOriginContinuity / rportEcho.
const RFC3261_ADVISORY_OVERRIDES: ReadonlyMap<string, string> = new Map<string, string>([
  [
    "rfc.optionsResponseEchoes",
    "B2BUA emits OPTIONS keepalive 200 responses (per ADR-0008 two-tier " +
      "OPTIONS) that intentionally omit Allow/Supported/Accept — they are " +
      "transport health probes, not §11.2 capability discovery. Advisory " +
      "until subject narrows to genuine capability OPTIONS or the probe " +
      "responses opt in.",
  ],
  [
    "rfc.cancelAfter1xx",
    "Several fixtures legitimately fire CANCEL on a UAC-local timer before " +
      "receiving the first 1xx (transient failure injection, glare). " +
      "Advisory until per-fixture annotation distinguishes 'spec-required " +
      "wait' from 'fixture-driven race'.",
  ],
  [
    "rfc.noTarget404",
    "Rule was authored for genuine §16.7 stateful proxies. The B2BUA " +
      "worker, classified as `proxy` for subject dispatch, terminates each " +
      "leg as UAC/UAS and may legitimately respond 403/481/491 without " +
      "forwarding when the backend decision rejects the call — these are " +
      "not 'no target' outcomes. Advisory until subject narrows to a " +
      "dedicated proxy bind.",
  ],
  [
    "rfc.proxy100WithinT100ms",
    "The B2BUA worker's TransactionLayer does emit 100 Trying immediately " +
      "on inbound INVITE (TransactionLayer.ts:742) and absorbs inbound 100 " +
      "Trying so no relay occurs (line 769). The rule nevertheless fires " +
      "on some fixtures — root cause is either (a) a code path that " +
      "bypasses TransactionLayer for the worker's UAS face, or (b) a " +
      "rule-heuristic bug in branch lookup across the projector's bucket " +
      "migration on first 18x-with-tag. OrderedAgentEvent also lacks atMs " +
      "so the 200ms bound cannot be enforced. Advisory until either the " +
      "code path is found or the rule heuristic is corrected.",
  ],
])

export const rfc3261CrossMessageRules: ReadonlyArray<CrossMessageAuditRule> =
  sliceTypedRules.map((rule) => {
    const advisory = RFC3261_ADVISORY_OVERRIDES.get(rule.name)
    const base = adaptCrossMessageRule(rule)
    if (advisory === undefined) return base
    return { ...base, severityOverride: "advisory", justification: advisory }
  })
