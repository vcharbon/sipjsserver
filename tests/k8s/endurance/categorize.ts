/**
 * Per-call categorization for the analyzer.
 *
 * Joins:
 *   - sipp's per-Call-ID outcome (from parseSippMessageTrace)
 *   - the chaos timeline (chaos-timeline.ndjson)
 *   - the run's phase boundaries (warmup-end, soak-start, soak-end, ...)
 *
 * Assigns each call exactly one category:
 *
 *   STEADY                     — establishes AND completes outside every chaos
 *                                impact window. **Hard fail target**.
 *   MID_DIALOG_DURING_CHAOS    — established before, BYE during, or held across
 *   ESTABLISHING_DURING_CHAOS  — INVITE/200/ACK overlaps an impact window
 *   POST_RECOVERY              — first 5s after recovery ends
 *   LIMITER_PROBE              — origin = limiter-probe stream (Call-ID prefix)
 *   PRE_WARMUP / POST_DRAIN    — outside SOAK; informational only
 */

import type { CallOutcome } from "../fixtures/sippOutcomes.js"

export type CallCategory =
  | "STEADY"
  | "MID_DIALOG_DURING_CHAOS"
  | "ESTABLISHING_DURING_CHAOS"
  | "POST_RECOVERY"
  | "LIMITER_PROBE"
  | "PRE_WARMUP"
  | "POST_DRAIN"

export interface ChaosImpactWindow {
  readonly tFire: Date
  readonly tRecovered: Date
  readonly type: string
  readonly target: string
}

export interface PhaseBounds {
  readonly tWarmupStart: Date
  readonly tSoakStart: Date
  readonly tSoakEnd: Date
  readonly tDrainEnd: Date
}

export interface CategorizeOpts {
  readonly outcomes: ReadonlyMap<string, CallOutcome>
  readonly chaos: ReadonlyArray<ChaosImpactWindow>
  readonly phase: PhaseBounds
  /**
   * Sipp Call-ID prefix that identifies a call as belonging to the
   * limiter-probe stream. Sipp's `-cid_str` is set to
   * `<jobName>-%u@det` so we match by Job-name prefix.
   */
  readonly limiterProbeCidPrefix: string
  /** Grace period after recovery during which calls count as POST_RECOVERY. */
  readonly postRecoveryGraceSec?: number
}

export interface CategorizedCall {
  readonly callId: string
  readonly category: CallCategory
  readonly outcome: CallOutcome
  /** True iff the outcome is a "successful" terminal state (clean / retransmitted). */
  readonly success: boolean
  /** Index of the chaos event that overlaps the call (when applicable). */
  readonly chaosEventIndex?: number
}

const POST_RECOVERY_GRACE_DEFAULT_SEC = 5

export const categorizeCalls = (opts: CategorizeOpts): ReadonlyArray<CategorizedCall> => {
  const grace = (opts.postRecoveryGraceSec ?? POST_RECOVERY_GRACE_DEFAULT_SEC) * 1000
  // Pre-compute impact windows including post-recovery grace.
  const windows = opts.chaos.map((c) => ({
    fire: c.tFire.getTime(),
    recovered: c.tRecovered.getTime(),
    postRecoveryEnd: c.tRecovered.getTime() + grace,
    type: c.type,
    target: c.target,
  }))
  const out: Array<CategorizedCall> = []
  for (const [callId, outcome] of opts.outcomes) {
    const cat = categorizeOne(callId, outcome, windows, opts)
    out.push(cat)
  }
  return out
}

interface InternalWindow {
  readonly fire: number
  readonly recovered: number
  readonly postRecoveryEnd: number
  readonly type: string
  readonly target: string
}

const categorizeOne = (
  callId: string,
  outcome: CallOutcome,
  windows: ReadonlyArray<InternalWindow>,
  opts: CategorizeOpts,
): CategorizedCall => {
  const success =
    outcome.outcome === "clean" || outcome.outcome === "retransmitted"

  if (callId.startsWith(opts.limiterProbeCidPrefix)) {
    return { callId, category: "LIMITER_PROBE", outcome, success }
  }

  const tInvite = outcome.tFirstInvite?.getTime()
  if (tInvite !== undefined && tInvite < opts.phase.tSoakStart.getTime()) {
    return { callId, category: "PRE_WARMUP", outcome, success }
  }
  if (tInvite !== undefined && tInvite > opts.phase.tSoakEnd.getTime()) {
    return { callId, category: "POST_DRAIN", outcome, success }
  }

  // For each window: does the call's [tInvite, tEnd] overlap?
  // tEnd = tAck if BYE not present (call still in establishing phase),
  // else "recently". Without explicit BYE timestamp we fall back to a
  // generous tInvite-bound check.
  const tStart = outcome.tFirstInvite?.getTime() ?? Number.POSITIVE_INFINITY
  // Approximate end of dialog: prefer tAck if present (covers
  // mid-dialog windows), else tInvite (treated as instantaneous call).
  const tEnd = outcome.tAck?.getTime() ?? tStart

  let bestMatch: { idx: number; cat: CallCategory } | undefined

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]!
    const overlapsImpact = tEnd >= w.fire && tStart <= w.recovered
    const startedDuring = tStart >= w.fire && tStart <= w.recovered
    const inPostRecovery = tStart > w.recovered && tStart <= w.postRecoveryEnd

    if (overlapsImpact) {
      // Establishing during the window if INVITE was sent inside it.
      if (startedDuring) {
        bestMatch = { idx: i, cat: "ESTABLISHING_DURING_CHAOS" }
        break
      }
      bestMatch = { idx: i, cat: "MID_DIALOG_DURING_CHAOS" }
      break
    }
    if (inPostRecovery && bestMatch === undefined) {
      bestMatch = { idx: i, cat: "POST_RECOVERY" }
      // Don't break — a later window with overlapsImpact takes precedence.
    }
  }

  if (bestMatch !== undefined) {
    return {
      callId,
      category: bestMatch.cat,
      outcome,
      success,
      chaosEventIndex: bestMatch.idx,
    }
  }
  return { callId, category: "STEADY", outcome, success }
}

/**
 * Aggregate per-event breakdown: for each chaos event, how many calls
 * succeeded / failed during the issue window AND in the
 * stabilized-after window. The "stabilized-after" window is defined
 * here as `(tRecovered + graceSec, tRecovered + 5min]`.
 */
export interface PerEventBreakdown {
  readonly index: number
  readonly type: string
  readonly target: string
  readonly tFire: string
  readonly tRecovered: string
  readonly impactWindow: { readonly start: string; readonly end: string }
  readonly stabilizedAfter: { readonly start: string; readonly end: string }
  readonly during_issue: { readonly ok: number; readonly failed: number; readonly by_category: Record<CallCategory, { ok: number; failed: number }> }
  readonly stabilized_after: { readonly ok: number; readonly failed: number }
}

export const buildPerEventBreakdown = (
  calls: ReadonlyArray<CategorizedCall>,
  chaos: ReadonlyArray<ChaosImpactWindow>,
  postRecoveryGraceSec = POST_RECOVERY_GRACE_DEFAULT_SEC,
  stabilizedAfterDurationSec = 5 * 60,
): ReadonlyArray<PerEventBreakdown> => {
  const out: Array<PerEventBreakdown> = []
  const graceMs = postRecoveryGraceSec * 1000
  const stableMs = stabilizedAfterDurationSec * 1000
  for (let i = 0; i < chaos.length; i++) {
    const c = chaos[i]!
    const fireMs = c.tFire.getTime()
    const recoveredMs = c.tRecovered.getTime()
    const stableStart = recoveredMs + graceMs
    const stableEnd = stableStart + stableMs

    // calls that resolved to this event's window (chaosEventIndex matches)
    const during = calls.filter((c) => c.chaosEventIndex === i)
    const duringOk = during.filter((c) => c.success).length
    const duringFailed = during.length - duringOk

    const byCategory: Record<CallCategory, { ok: number; failed: number }> = {
      STEADY: { ok: 0, failed: 0 },
      MID_DIALOG_DURING_CHAOS: { ok: 0, failed: 0 },
      ESTABLISHING_DURING_CHAOS: { ok: 0, failed: 0 },
      POST_RECOVERY: { ok: 0, failed: 0 },
      LIMITER_PROBE: { ok: 0, failed: 0 },
      PRE_WARMUP: { ok: 0, failed: 0 },
      POST_DRAIN: { ok: 0, failed: 0 },
    }
    for (const cc of during) {
      const slot = byCategory[cc.category]
      if (cc.success) slot.ok += 1
      else slot.failed += 1
    }

    // calls whose tFirstInvite landed in the stabilized-after window
    // and who are NOT classified as overlapping a chaos event
    const afterCalls = calls.filter((cc) => {
      if (cc.chaosEventIndex !== undefined) return false
      const t = cc.outcome.tFirstInvite?.getTime()
      if (t === undefined) return false
      return t >= stableStart && t <= stableEnd
    })
    const afterOk = afterCalls.filter((cc) => cc.success).length
    const afterFailed = afterCalls.length - afterOk

    out.push({
      index: i,
      type: c.type,
      target: c.target,
      tFire: c.tFire.toISOString(),
      tRecovered: c.tRecovered.toISOString(),
      impactWindow: {
        start: new Date(fireMs).toISOString(),
        end: new Date(recoveredMs + graceMs).toISOString(),
      },
      stabilizedAfter: {
        start: new Date(stableStart).toISOString(),
        end: new Date(stableEnd).toISOString(),
      },
      during_issue: { ok: duringOk, failed: duringFailed, by_category: byCategory },
      stabilized_after: { ok: afterOk, failed: afterFailed },
    })
  }
  return out
}
