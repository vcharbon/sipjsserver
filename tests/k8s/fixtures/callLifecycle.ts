import type { CallOutcome, SippOutcome } from "./sippOutcomes.js"
import type { RoutingDecision } from "./proxyLogs.js"

/**
 * The four buckets a Call-ID falls into relative to a single
 * `(killedWorkerIp, T_kill)` pair. Together with the call's
 * `SippOutcome` this forms the headline 5×4 matrix in
 * `failoverReport.writeFailoverReport`.
 */
export type LifecycleState =
  | "unaffected"
  | "established-on-dying"
  | "in-flight-on-dying"
  | "pre-routed-on-dying"

export interface ClassifiedCall {
  readonly callId: string
  readonly state: LifecycleState
  readonly outcome: SippOutcome
  readonly retransmits: number
}

export interface ClassifyCallsInput {
  readonly decisions: ReadonlyArray<RoutingDecision>
  readonly outcomes: ReadonlyMap<string, CallOutcome>
  /** IP of the worker pod that was killed. */
  readonly killedWorkerIp: string
  /** Wall-clock instant the kill was issued. */
  readonly tKill: Date
}

interface InvitePoint {
  readonly workerIp: string
  /**
   * Best estimate of when the proxy routed the INVITE. Prefer the
   * proxy log timestamp (`d.tDecided`); fall back to the sipp INVITE
   * send timestamp if the log line had no parseable bracket.
   */
  readonly t: Date | undefined
}

/**
 * Pick the INVITE routing point for a Call-ID. There may be multiple
 * decisions per call (re-INVITE, in-dialog requests, etc.); the *first*
 * INVITE is the one that pins the call to a worker.
 */
const firstInvite = (
  decisions: ReadonlyArray<RoutingDecision>,
  callId: string,
  fallback: Date | undefined,
): InvitePoint | undefined => {
  let chosen: RoutingDecision | undefined
  let chosenT: Date | undefined
  for (const d of decisions) {
    if (d.callId !== callId || d.method !== "INVITE") continue
    const t = d.tDecided ?? fallback
    if (
      chosen === undefined ||
      (t !== undefined && chosenT !== undefined && t.getTime() < chosenT.getTime()) ||
      (t !== undefined && chosenT === undefined)
    ) {
      chosen = d
      chosenT = t
    }
  }
  if (!chosen) return undefined
  return { workerIp: chosen.workerIp, t: chosenT }
}

/**
 * Join routing decisions + sipp outcomes + `T_kill` into one
 * classified row per Call-ID.
 *
 * Bucketing rules (per `docs/plan/proper-end-to-end-cheerful-lobster.md`):
 *
 * - `unaffected` — INVITE was not routed to the killed worker (or the
 *   call has no routing decision at all, which is treated as
 *   unaffected: the proxy never touched it).
 * - `established-on-dying` — INVITE routed to the killed worker AND
 *   the ACK was sent before `T_kill`.
 * - `in-flight-on-dying` — INVITE routed to the killed worker AND the
 *   INVITE timestamp is before `T_kill` AND no ACK observed before
 *   `T_kill`.
 * - `pre-routed-on-dying` — INVITE routed to the killed worker AND the
 *   INVITE timestamp is at-or-after `T_kill`. This is the post-kill
 *   sticky-routing window: the proxy hadn't yet marked the worker
 *   dead, so the INVITE went there.
 *
 * The output covers every Call-ID present in `outcomes` (the source of
 * truth for "what calls actually existed") merged with calls visible
 * only in proxy decisions but missing from the sipp outcome map (rare;
 * happens if the sipp message log was truncated).
 */
export const classifyCalls = (input: ClassifyCallsInput): Array<ClassifiedCall> => {
  const { decisions, outcomes, killedWorkerIp, tKill } = input
  const tKillMs = tKill.getTime()
  const out: Array<ClassifiedCall> = []

  const seenCallIds = new Set<string>()
  for (const callId of outcomes.keys()) seenCallIds.add(callId)
  for (const d of decisions) seenCallIds.add(d.callId)

  for (const callId of seenCallIds) {
    const outcome = outcomes.get(callId)
    const sippOutcome: SippOutcome = outcome?.outcome ?? "establish-failed"
    const retransmits = outcome?.retransmits ?? 0
    const invite = firstInvite(decisions, callId, outcome?.tFirstInvite)

    let state: LifecycleState
    if (invite === undefined || invite.workerIp !== killedWorkerIp) {
      state = "unaffected"
    } else if (outcome?.tAck !== undefined && outcome.tAck.getTime() < tKillMs) {
      state = "established-on-dying"
    } else if (invite.t !== undefined && invite.t.getTime() < tKillMs) {
      state = "in-flight-on-dying"
    } else if (invite.t !== undefined && invite.t.getTime() >= tKillMs) {
      state = "pre-routed-on-dying"
    } else {
      // No usable timestamp on either side; conservatively treat as
      // pre-routed (the proxy was still routing to the dying worker
      // somewhere in the test window).
      state = "pre-routed-on-dying"
    }

    out.push({ callId, state, outcome: sippOutcome, retransmits })
  }

  return out
}
