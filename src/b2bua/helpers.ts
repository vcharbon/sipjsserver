/**
 * Shared B2BUA helpers — canonical cleanup effects, b-leg creation for failover.
 */

import type { Call, Dialog, InviteTxnHandle, Leg, TimerEntry } from "../call/CallModel.js"
import { addBLeg, addCdrEvent, makeEmptyDialog, randomInitialCSeq } from "../call/CallModel.js"
import {
  emptyEffects,
  type HandlerEffects,
  type CriticalStateEffect,
  type SoftBoundedEffect,
  type BufferedObservabilityEffect,
  type OutboundSipEffect,
} from "../sip/SipRouter.js"
import type { SipRequest } from "../sip/types.js"
import type { AppConfigData } from "../config/AppConfig.js"
import { getHeader, newBranch, newTag, stripTag } from "../sip/MessageHelpers.js"
import {
  extractNonStructuralHeaders,
  generateOutOfDialogRequest,
} from "../sip/generators.js"
import type { SipHeader } from "../sip/types.js"
import { generateBLegCallId } from "./HashUtils.js"
import { buildCallVia, buildCallContact } from "./stack-identity.js"

// ---------------------------------------------------------------------------
// Canonical cleanup effects — used by ALL call termination paths
// ---------------------------------------------------------------------------
//
// Each effect kind belongs to exactly one safety category — see
// docs/adr/0003-must-run-effects-under-interruption.md. The interpreter
// (SipRouter.processResult) wraps each slot with its prescribed primitive.
//   - critical: schedule/cancel timers, flush-redis, remove-call
//   - soft:     decrement-limiter (self-repairing, bounded by Phase 7)
//   - buffered: write-cdr (drop-on-overload acceptable per Phase 3)

/**
 * Returns the FULL canonical effects record for immediate call termination.
 * Used by termination paths that skip the "terminating" state because no
 * outstanding BYE transactions need resolution:
 *   - Initial INVITE rejection (503/486)
 *   - Transaction timeout (far side already unresponsive 32s)
 *   - B-leg INVITE failure without failover (4xx/5xx/6xx, no BYE was sent)
 *
 * Paths that send outbound BYEs should use beginTerminationEffects() instead
 * and defer final cleanup to finalCleanupEffects() when all legs resolve.
 */
export function terminateCallEffects(call: Call): HandlerEffects {
  // Skip entries whose INCR never landed (fail-open admission). Decrementing
  // those would drift the cluster-wide counter negative. See
  // `CallLimiterState.incrementSucceeded` and ADR-0003 / cascade-fix plan.
  // Older replicated entries omit the flag (`undefined`) and reflect
  // successful INCRs — only explicit `false` means skip.
  const soft: SoftBoundedEffect[] = call.limiterEntries
    .filter((e) => e.incrementSucceeded !== false)
    .map((e) => ({
      type: "decrement-limiter" as const,
      limiterId: e.limiterId,
      window: e.originWindow,
    }))
  const critical: CriticalStateEffect[] = [
    { type: "cancel-all-timers" },
    { type: "remove-call" },
  ]
  const buffered: BufferedObservabilityEffect[] = [{ type: "write-cdr" }]
  return { ...emptyEffects, critical, soft, buffered }
}

/**
 * Effects for entering the "terminating" state — BYE(s) have been sent,
 * waiting for far-side responses. Call stays in memory and Redis.
 *
 * Cancels all timers (except the terminating_timeout safety net, which
 * the caller schedules separately) and flushes to Redis so the
 * terminating state survives a crash. CDR is NOT written here — it fires
 * exactly once when the call transitions to "terminated"
 * (InvariantEnforcer injects `write-cdr` then). Writing CDR at both
 * points produced a duplicate record per call.
 *
 * Does NOT remove the call or decrement limiters — those happen in
 * finalCleanupEffects() when all legs are resolved.
 *
 * @param callRef - needed to build the terminating_timeout timer ID
 * @param nowMs - current wall-clock time for timer fireAt
 */
export function beginTerminationEffects(callRef: string, nowMs: number): HandlerEffects {
  // 64s = 2× RFC 3261 Timer B/F (32s). Gives plenty of margin for the
  // far side to respond to our BYE before we force-clean.
  const TERMINATING_TIMEOUT_MS = 64_000
  const safetyTimer: TimerEntry = {
    id: `terminating-timeout-${callRef}`,
    type: "terminating_timeout",
    fireAt: nowMs + TERMINATING_TIMEOUT_MS,
  }
  const critical: CriticalStateEffect[] = [
    { type: "cancel-all-timers" },
    { type: "schedule-timer", timer: safetyTimer },
    { type: "flush-redis" },
  ]
  return { ...emptyEffects, critical }
}

/**
 * Effects for final call cleanup after all legs are resolved (all
 * byeDispositions are terminal). The call transitions from "terminating"
 * to "terminated" and is removed from memory and Redis.
 *
 * Also decrements limiters — deferred to this point so that a call in
 * "terminating" state still holds its limiter slot until fully cleaned up.
 */
export function finalCleanupEffects(call: Call): HandlerEffects {
  // See `terminateCallEffects` — skip fail-open admissions.
  const soft: SoftBoundedEffect[] = call.limiterEntries
    .filter((e) => e.incrementSucceeded !== false)
    .map((e) => ({
      type: "decrement-limiter" as const,
      limiterId: e.limiterId,
      window: e.originWindow,
    }))
  const critical: CriticalStateEffect[] = [
    { type: "cancel-all-timers" },
    { type: "remove-call" },
  ]
  return { ...emptyEffects, critical, soft }
}

// ---------------------------------------------------------------------------
// B-leg creation helper — used for initial routing and failover
// ---------------------------------------------------------------------------

export interface RouteParams {
  readonly destination: { readonly host: string; readonly port: number }
  readonly new_ruri?: string | undefined
  readonly update_headers?: Record<string, string | null> | undefined
  readonly no_answer_timeout_sec?: number | undefined
  readonly call_limiter?: ReadonlyArray<{ readonly id: string; readonly limit: number }> | undefined
  readonly callback_context?: string | undefined
}

/** Options for creating a new b-leg. */
export interface CreateBLegOptions {
  readonly call: Call
  /** Base INVITE to clone for the outbound b-leg INVITE. When undefined,
   *  the b-leg Leg entry is created but no INVITE is sent (used when
   *  the rule engine defers sending). */
  readonly baseInvite: SipRequest | undefined
  readonly route: RouteParams
  readonly config: AppConfigData
  readonly nowMs: number
}

/**
 * Strip a `tag=…` parameter from a header value (Issue 6 of the
 * upstream-consumer plan). The B2BUA owns the From-tag and the dialog
 * carries the remote To-tag from the 200 OK; consumer-supplied tags in
 * `update_headers["From"]`/`["To"]` would corrupt §12.1.1 ownership.
 *
 * Returns the cleaned value plus a flag indicating whether a tag was
 * actually present (so callers can decide whether to log a warning).
 */
function stripTagWithFlag(headerValue: string): { value: string; stripped: boolean } {
  const cleaned = stripTag(headerValue)
  return { value: cleaned, stripped: cleaned !== headerValue }
}

/**
 * Create a new b-leg from routing parameters.
 * Returns the updated call, outbound INVITE envelope (if baseInvite provided),
 * side effects (timer + flush), and any consumer-facing warnings the
 * caller should surface via `Effect.logWarning`.
 *
 * Single source of truth for b-leg creation — used by InitialInviteHandler
 * (first b-leg), limiter failover, and the rule engine's create-leg action.
 */
export function createBLegFromRoute(
  opts: CreateBLegOptions
): { call: Call; outbound: OutboundSipEffect[]; effects: HandlerEffects; warnings: string[] } {
  const { call, baseInvite, route, config, nowMs } = opts
  const legNumber = call.bLegs.length + 1
  const legId = `b-${legNumber}`
  const bLegFromTag = newTag()
  const warnings: string[] = []

  const bLegCallId = config.workerIndex >= 0
    ? generateBLegCallId(legNumber, config.workerIndex, config.clusterWorkers, config.sipLocalIp)
    : `${legNumber}-${call.aLeg.callId}`

  const initialCSeq = randomInitialCSeq()

  // RFC 3261 §12.2.1.1: track local/remote URIs for in-dialog header
  // construction. B2BUA is UAC on b-leg: localUri = From (Alice's
  // identity, possibly overridden by the consumer), remoteUri = To.
  // Default seed comes from the A-leg headers; if `baseInvite` is given
  // and the consumer overrides From / To via `update_headers`, the
  // post-override values are stamped further down. Issue 6 of the
  // upstream-consumer plan: ACK / BYE must use the post-override URIs;
  // pre-override stamping silently reverted them.
  const aLegFrom = getHeader(call.aLegInvite.headers, "from") ?? ""
  const aLegTo = getHeader(call.aLegInvite.headers, "to") ?? ""
  let localUri = stripTag(aLegFrom)
  let remoteUri = stripTag(aLegTo)

  const requestUri = route.new_ruri ?? baseInvite?.uri
  const isEmergency = call.emergency === true

  const outbound: OutboundSipEffect[] = []
  let pendingInviteTxn: InviteTxnHandle | undefined

  if (baseInvite !== undefined) {
    // Merge policy-level header overrides (e.g. strip 100rel from Supported)
    // with route-level overrides. Route headers take precedence.
    let mergedHeaders: Record<string, string | null> | undefined =
      (call.policyUpdateHeaders || route.update_headers)
        ? { ...(call.policyUpdateHeaders as Record<string, string | null> ?? {}),
            ...(route.update_headers as Record<string, string | null> ?? {}) }
        : undefined

    // Issue 6 — strip consumer-supplied From-tag / To-tag.
    // From-tag is owned by the B2BUA (RFC 3261 §12.1.1 — it IS the
    // dialog's local tag, generated above as `bLegFromTag`). To-tag on
    // an initial INVITE has no value (RFC 3261 §8.1.1.2); the dialog's
    // remoteTag is later carried from the 200 OK. Either way, an
    // override-supplied tag is invalid.
    if (mergedHeaders !== undefined) {
      const tagWarnings: { header: "From" | "To"; original: string; cleaned: string }[] = []
      const next: Record<string, string | null> = { ...mergedHeaders }
      for (const key of Object.keys(next)) {
        const lower = key.toLowerCase()
        if (lower !== "from" && lower !== "to") continue
        const value = next[key]
        if (value === null || value === undefined) continue
        const { value: cleaned, stripped } = stripTagWithFlag(value)
        if (stripped) {
          next[key] = cleaned
          tagWarnings.push({
            header: lower === "from" ? "From" : "To",
            original: value,
            cleaned,
          })
        }
      }
      mergedHeaders = next
      for (const w of tagWarnings) {
        warnings.push(
          `update_headers["${w.header}"] contained a tag= param — stripped (B2BUA owns dialog tags). value="${w.original}" → "${w.cleaned}"`,
        )
      }
    }

    const baseFromRaw = getHeader(baseInvite.headers, "from") ?? "unknown"
    const baseToRaw = getHeader(baseInvite.headers, "to") ?? baseInvite.uri
    const maxForwardsRaw = getHeader(baseInvite.headers, "max-forwards")
    const maxForwards = Math.max(0, parseInt(maxForwardsRaw ?? "70", 10) - 1)

    const bLegInviteBranch = newBranch()
    const via = buildCallVia({
      localIp: config.sipLocalIp,
      localPort: config.sipLocalPort,
      callRef: call.callRef,
      leg: legId,
      isEmergency,
      branch: bLegInviteBranch,
    })
    const contact = buildCallContact({
      localIp: config.sipLocalIp,
      localPort: config.sipLocalPort,
      callRef: call.callRef,
      leg: legId,
      isEmergency,
    })

    const contentTypeHeader = getHeader(baseInvite.headers, "content-type")
    const contentTypeOpt: { contentType: string } | Record<string, never> =
      contentTypeHeader !== undefined ? { contentType: contentTypeHeader } : {}
    let bLegInvite: SipRequest = generateOutOfDialogRequest("INVITE", {
      requestUri: route.new_ruri ?? baseInvite.uri,
      callId: bLegCallId,
      fromUri: stripTag(baseFromRaw),
      fromTag: bLegFromTag,
      toUri: stripTag(baseToRaw),
      cseq: initialCSeq,
      via,
      contact,
      maxForwards,
      body: baseInvite.body,
      ...contentTypeOpt,
      extraHeaders: extractNonStructuralHeaders(baseInvite),
    })

    if (mergedHeaders !== undefined) {
      const applied: SipHeader[] = []
      const overrides = new Map<string, string | null>()
      for (const [name, value] of Object.entries(mergedHeaders)) {
        overrides.set(name.toLowerCase(), value)
      }
      const seen = new Set<string>()
      for (const hdr of bLegInvite.headers) {
        const lower = hdr.name.toLowerCase()
        if (overrides.has(lower)) {
          const v = overrides.get(lower)!
          seen.add(lower)
          if (v === null) continue
          applied.push({ name: hdr.name, value: v })
        } else {
          applied.push(hdr)
        }
      }
      for (const [lower, v] of overrides) {
        if (seen.has(lower) || v === null) continue
        const originalName = Object.keys(mergedHeaders).find((n) => n.toLowerCase() === lower) ?? lower
        applied.push({ name: originalName, value: v })
      }
      bLegInvite = { ...bLegInvite, headers: applied }
    }

    // Issue 6 — stamp the leg/dialog URIs from the POST-override From / To
    // headers so subsequent ACK and BYE (which read `dialog.localUri` /
    // `dialog.remoteUri` in `src/sip/generators.ts`) don't silently
    // revert to the A-leg values. We strip the From-tag we just attached
    // because `localUri` is consumed by generators that will re-append
    // `;tag=${dialog.localTag}`.
    const postFrom = getHeader(bLegInvite.headers, "from")
    const postTo = getHeader(bLegInvite.headers, "to")
    if (postFrom !== undefined) localUri = stripTag(postFrom)
    if (postTo !== undefined) remoteUri = stripTag(postTo)

    // ── Outbound proxy support ────────────────────────────────────────
    // When the worker is deployed behind the SIP front proxy
    // (`config.b2bOutboundProxy` set), pre-load a `Route` header pointing
    // at the proxy with `;outbound` so the proxy recognises the flow as
    // worker→external (skip LB; insert R-R encoding the *source* worker;
    // forward to R-URI). Wire-level destination becomes the proxy; R-URI
    // stays at Bob (controller-supplied logical truth).
    //
    // RFC 3261 §16.12: a UAC with an outbound proxy in its preloaded
    // route set sends the request to the top Route's URI, keeping the
    // remote target in the Request-URI.
    const outboundProxy = config.b2bOutboundProxy
    let wireDestination = route.destination
    if (outboundProxy !== undefined) {
      const routeHeader: SipHeader = {
        name: "Route",
        value: `<sip:${outboundProxy.host}:${outboundProxy.port};lr;outbound>`,
      }
      bLegInvite = { ...bLegInvite, headers: [routeHeader, ...bLegInvite.headers] }
      wireDestination = { host: outboundProxy.host, port: outboundProxy.port }
    }

    pendingInviteTxn = {
      kind: "invite",
      branch: bLegInviteBranch,
      originalInvite: bLegInvite,
      destination: wireDestination,
    }

    outbound.push({
      type: "send-sip",
      message: bLegInvite,
      destination: wireDestination,
      label: `send ${legId} INVITE`,
      legId,
    })
  }

  // RFC 3261 §12.2.1.1: CSeq is dialog-scoped. Seed a placeholder dialog
  // (remoteTag="") on the b-leg carrying the INVITE's CSeq — used for CANCEL
  // (RFC 3261 §9.1: CANCEL CSeq must equal the INVITE's) and as the seed
  // for any forked early dialog spawned later from a 1xx response.
  // Built AFTER `localUri`/`remoteUri` are settled (Issue 6) so any
  // consumer-supplied From/To override is reflected in the dialog from
  // the start.
  const emptyDialog = makeEmptyDialog({
    callId: bLegCallId,
    localUri,
    remoteUri,
    localTag: bLegFromTag,
    remoteTag: "",
  })
  const placeholderDialog: Dialog = {
    ...emptyDialog,
    sip: { ...emptyDialog.sip, localCSeq: initialCSeq },
    ext: emptyDialog.ext,
  }

  const bLeg: Leg = {
    legId,
    callId: bLegCallId,
    fromTag: bLegFromTag,
    source: { address: config.sipLocalIp, port: config.sipLocalPort },
    state: "trying",
    disposition: "pending",
    dialogs: [placeholderDialog],
    noAnswerTimeoutSec: route.no_answer_timeout_sec ?? config.noAnswerTimeoutSec,
    localUri,
    remoteUri,
    // RFC 3261 §9.1: CANCEL must copy Request-URI from original INVITE
    inviteRequestUri: requestUri,
    ...(pendingInviteTxn !== undefined ? { pendingInviteTxn } : {}),
  }

  let updated = addBLeg(call, bLeg)
  updated = addCdrEvent(updated, { type: "invite_sent", timestamp: nowMs, legId })

  if (route.callback_context !== undefined) {
    updated = { ...updated, callbackContext: route.callback_context }
  }

  const noAnswerTimeout = route.no_answer_timeout_sec ?? config.noAnswerTimeoutSec
  const noAnswerTimer: TimerEntry = {
    id: `no-answer-${call.callRef}-${legId}`,
    type: "no_answer",
    fireAt: nowMs + noAnswerTimeout * 1000,
    legId
  }
  updated = { ...updated, timers: [...updated.timers, noAnswerTimer] }

  const critical: CriticalStateEffect[] = [
    { type: "schedule-timer", timer: noAnswerTimer },
    { type: "flush-redis" },
  ]
  const effects: HandlerEffects = { ...emptyEffects, critical }

  return { call: updated, outbound, effects, warnings }
}
