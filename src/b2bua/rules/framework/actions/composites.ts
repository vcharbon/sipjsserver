/**
 * Composite factories for rule-action sequences (Slice B of the
 * rule-framework refactor).
 *
 * Primitives have a single, narrow reach (see ActionExecutor reach comments).
 * Composites bundle primitives into the action sequences that real rules
 * emit, so rule bodies stay declarative.
 *
 * Every composite is pure: given its inputs it returns a deterministic
 * ReadonlyArray<RuleAction>. Any runtime lookups the composite needs
 * (e.g. "does a tag mapping already exist?") must be performed by the
 * caller and passed in — composites never read rule context directly.
 */

import type { RuleAction } from "../RuleDefinition.js"

// ── confirmBridgedCall ────────────────────────────────────────────────────

/**
 * Emit the primitive sequence that confirms an A↔B bridged dialog on a
 * 200 OK INVITE arriving from the source (B) leg.
 *
 * Aggregated reach (across the emitted primitives):
 *   legs.{sourceLegId}.{state, disposition, dialogs[0]}
 *   legs.{aLegId}.{state, dialogs[0].toTag}
 *   tagMap (only when `mappingAlreadyExists === false`)
 *
 * Rule responsibilities:
 *   - Resolve `aFacingTag` before calling: look up an existing
 *     `findByBTag(call, sourceLegId, sourceTag)`; reuse its `aTag` when
 *     present (policy modules such as `relayFirst18xTo180` pre-seed the
 *     mapping), otherwise generate a fresh tag via `newTag()`.
 *   - Pass `mappingAlreadyExists: true` when a mapping was found so the
 *     redundant `add-tag-mapping` primitive is skipped. (addTagMapping is
 *     idempotent by (bLegId, bTag), so the redundant emit is safe — but
 *     explicit is easier to reason about in traces.)
 */
export function confirmBridgedCall(args: {
  readonly sourceLegId: string
  readonly sourceTag: string
  readonly aFacingTag: string
  readonly aLegId: string
  readonly mappingAlreadyExists: boolean
}): ReadonlyArray<RuleAction> {
  const actions: RuleAction[] = [
    {
      type: "update-leg-state",
      legId: args.sourceLegId,
      state: "confirmed",
      disposition: "bridged",
    },
    { type: "confirm-dialog", legId: args.sourceLegId },
  ]

  if (!args.mappingAlreadyExists) {
    actions.push({
      type: "add-tag-mapping",
      aTag: args.aFacingTag,
      bLegId: args.sourceLegId,
      bTag: args.sourceTag,
    })
  }

  actions.push(
    { type: "update-leg-state", legId: args.aLegId, state: "confirmed" },
    { type: "stamp-dialog-to-tag", legId: args.aLegId, toTag: args.aFacingTag },
  )

  return actions
}
