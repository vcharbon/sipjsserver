/**
 * ShadowMatcher — dual-path rule-selection verifier.
 *
 * Phase B of the rule-reification migration. The authoritative path is the
 * legacy imperative `matches()` iteration (priority-sorted, first-match-wins).
 * Alongside it we call the new declarative `Matcher.pick()` and compare
 * results. Divergences are logged at ERROR and counted in a process-local
 * gauge that tests can assert on.
 *
 * Removed in Phase D once the new Matcher is authoritative and every rule
 * has a complete `match` descriptor.
 */

import { Effect } from "effect"
import type { AnyRuleDefinition, RuleContext } from "./RuleDefinition.js"
import { pick as matcherPick } from "./Matcher.js"

// ── Divergence counter + sample records (process-local) ──────────────────

let divergenceCount = 0

export interface DivergenceRecord {
  readonly oldWinnerId: string | undefined
  readonly newWinnerId: string | undefined
  readonly eventSummary: string
  readonly callRef: string
}

const divergenceSamples: DivergenceRecord[] = []
const DIVERGENCE_SAMPLE_LIMIT = 30

/** Read the divergence counter. Exposed for tests. */
export function getRuleMatcherDivergenceCount(): number {
  return divergenceCount
}

/** Read up to DIVERGENCE_SAMPLE_LIMIT divergence samples. Exposed for tests. */
export function getRuleMatcherDivergenceSamples(): ReadonlyArray<DivergenceRecord> {
  return divergenceSamples
}

/** Reset the divergence counter. Exposed for tests that want a clean baseline. */
export function resetRuleMatcherDivergenceCount(): void {
  divergenceCount = 0
  divergenceSamples.length = 0
}

// ── Compare old vs new winner ────────────────────────────────────────────

/**
 * Run the new Matcher alongside the old imperative path's outcome.
 *
 * Inputs:
 *  - rules: the merged priority-sorted rule list the old executor iterated
 *  - composedBaseIds: base-rule ids consumed by composition for this event
 *    (we must skip them in the new path too so composition doesn't show
 *    false divergence)
 *  - oldWinnerId: id of the rule that actually handled the event in the
 *    old path (handle() returned non-undefined). `undefined` if the old
 *    path fell through to the default handler.
 *  - ctx: RuleContext for the event
 *
 * Behavior:
 *  - Calls Matcher.pick on the eligible rule subset.
 *  - If the new winner id differs from `oldWinnerId`, logs an error and
 *    increments the process-local divergence counter.
 */
export const shadowCompare = (
  rules: ReadonlyArray<AnyRuleDefinition>,
  composedBaseIds: ReadonlySet<string>,
  oldWinnerId: string | undefined,
  ctx: RuleContext,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const eligible = rules.filter((r) => !composedBaseIds.has(r.id))
    const newWinner = matcherPick(eligible, ctx)
    const newId = newWinner?.id

    if (newId === oldWinnerId) return

    divergenceCount += 1
    const eventSummary = summarizeEvent(ctx)

    if (divergenceSamples.length < DIVERGENCE_SAMPLE_LIMIT) {
      divergenceSamples.push({
        oldWinnerId,
        newWinnerId: newId,
        eventSummary,
        callRef: ctx.callRef,
      })
    }

    yield* Effect.logError(
      `[ShadowMatcher] divergence: old=${oldWinnerId ?? "(default)"} ` +
      `new=${newId ?? "(none)"} callRef=${ctx.callRef} event=${eventSummary}`,
    )
  })

// ── Event summary for diagnostics ────────────────────────────────────────

function summarizeEvent(ctx: RuleContext): string {
  const ev = ctx.event
  switch (ev.type) {
    case "sip": {
      const msg = ev.message
      if (msg.type === "request") return `request ${msg.method} dir=${ctx.direction}`
      return `response ${msg.status} dir=${ctx.direction}`
    }
    case "timer":    return `timer ${ev.timerType}`
    case "timeout":  return `timeout method=${ev.method ?? "?"}`
    case "cancelled": return "cancelled"
  }
}
