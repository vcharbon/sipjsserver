/**
 * RuleRegistry — holds all registered rule definitions.
 * Built at startup; immutable after construction.
 */

import type { AnyRuleDefinition, Match } from "./RuleDefinition.js"
import type { PolicyModule } from "./PolicyModule.js"
import { specificityScore } from "./Matcher.js"

export interface RuleRegistry {
  readonly definitions: ReadonlyMap<string, AnyRuleDefinition>
}

/**
 * Create a rule registry from built-in rules and optional policy modules.
 *
 * Built-in rules are registered as-is (they are alwaysActive by definition).
 * Policy module rules have their module's guard applied to matches() and are
 * set to alwaysActive — the guard is the activation mechanism.
 */
export function createRuleRegistry(
  builtinRules: ReadonlyArray<AnyRuleDefinition>,
  policyModules?: ReadonlyArray<PolicyModule>,
): RuleRegistry {
  const allRules: AnyRuleDefinition[] = [...builtinRules]

  // Flatten policy modules — apply guard to each rule's matches() AND to
  // its declarative match descriptor's filter, so the new specificity-based
  // Matcher respects policy activation the same way the imperative path does.
  for (const mod of (policyModules ?? [])) {
    for (const rule of mod.rules) {
      const originalMatches = rule.matches
      const originalMatch = rule.match
      const wrappedMatches = (ctx: Parameters<typeof mod.guard>[0]): boolean =>
        mod.guard(ctx) && originalMatches(ctx)

      if (originalMatch === undefined) {
        allRules.push({ ...rule, alwaysActive: true, matches: wrappedMatches })
      } else {
        const originalFilter = originalMatch.filter
        const guardedFilter = originalFilter !== undefined
          ? (ctx: Parameters<typeof mod.guard>[0]) =>
              mod.guard(ctx) && originalFilter(ctx)
          : mod.guard
        allRules.push({
          ...rule,
          alwaysActive: true,
          matches: wrappedMatches,
          match: { ...originalMatch, filter: guardedFilter },
        })
      }
    }
  }

  const map = new Map<string, AnyRuleDefinition>()
  for (const rule of allRules) {
    if (map.has(rule.id)) {
      throw new Error(`Duplicate rule ID: ${rule.id}`)
    }
    map.set(rule.id, rule)
  }

  // Warn on alwaysActive rules sharing a priority.
  // Same-priority rules are tie-broken by registration order, which is fragile
  // and has caused real bugs (e.g. retransmit-200 consuming re-INVITE responses).
  // This is a warning rather than fatal because some priority bands (e.g. 900)
  // contain many rules with non-overlapping match criteria where ordering is safe.
  const priorityToIds = new Map<number, string[]>()
  for (const rule of allRules) {
    if (!rule.alwaysActive) continue
    const p = rule.defaultPriority ?? 900
    const ids = priorityToIds.get(p)
    if (ids !== undefined) {
      ids.push(rule.id)
    } else {
      priorityToIds.set(p, [rule.id])
    }
  }
  for (const [priority, ids] of priorityToIds) {
    if (ids.length > 1) {
      console.warn(
        `[RuleRegistry] Priority collision: alwaysActive rules [${ids.join(", ")}] share priority ${priority}. ` +
        `If these rules can match the same event, assign distinct priorities.`
      )
    }
  }

  // Validate the new declarative match schemas (Phase A: warnings, not errors).
  // In Phase C (cutover) these become fatal.
  validateMatchSchemas(allRules)

  return { definitions: map }
}

// ── Match schema validation (shadow / reachability) ───────────────────────

/**
 * Structural signature of a Match: same kind + same set of columns that
 * are set + same filter-presence. Two rules sharing a signature are
 * shadow-candidates and must either have disjoint value domains or
 * declare explicit priority/overrides/composesWith.
 */
function matchSignature(m: Match): string {
  const filter = m.filter !== undefined ? "+f" : "-f"
  switch (m.kind) {
    case "request":
      return `req|${cols([m.method, m.callState, m.legState, m.legDisposition, m.direction])}|${filter}`
    case "response":
      return `resp|${cols([
        m.cseqMethod,
        m.status !== undefined ? "status" : m.statusClass,
        m.callState,
        m.legState,
        m.legDisposition,
        m.direction,
      ])}|${filter}`
    case "timer":
      return `tmr|${cols([m.timerType, m.callState])}|${filter}`
    case "timeout":
      return `to|${cols([m.method])}|${filter}`
    case "cancelled":
      return `canc|${filter}`
  }
}

function cols(vs: ReadonlyArray<unknown>): string {
  return vs.map((v) => (v === undefined ? "_" : "X")).join(",")
}

/** Do two column values share any concrete value? */
function valuesOverlap(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return true
  const arrA = Array.isArray(a) ? (a as ReadonlyArray<unknown>) : [a]
  const arrB = Array.isArray(b) ? (b as ReadonlyArray<unknown>) : [b]
  for (const va of arrA) if (arrB.includes(va)) return true
  return false
}

/** Return true if two same-kind match descriptors can match a common event. */
function matchesOverlap(a: Match, b: Match): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case "request": {
      const bb = b as typeof a
      return (
        valuesOverlap(a.method, bb.method) &&
        valuesOverlap(a.callState, bb.callState) &&
        valuesOverlap(a.legState, bb.legState) &&
        valuesOverlap(a.legDisposition, bb.legDisposition) &&
        valuesOverlap(a.direction, bb.direction)
      )
    }
    case "response": {
      const bb = b as typeof a
      if (!valuesOverlap(a.cseqMethod, bb.cseqMethod)) return false
      // status vs statusClass — compare conservatively (assume overlap unless both are exact and differ)
      if (a.status !== undefined && bb.status !== undefined && a.status !== bb.status) return false
      if (a.status !== undefined && bb.statusClass !== undefined) {
        // exact a.status must fall into bb.statusClass range
        const cls = Math.floor(a.status / 100) + "xx"
        if (!valuesOverlap(bb.statusClass, cls)) return false
      }
      if (bb.status !== undefined && a.statusClass !== undefined) {
        const cls = Math.floor(bb.status / 100) + "xx"
        if (!valuesOverlap(a.statusClass, cls)) return false
      }
      if (a.statusClass !== undefined && bb.statusClass !== undefined &&
          !valuesOverlap(a.statusClass, bb.statusClass)) return false
      return (
        valuesOverlap(a.callState, bb.callState) &&
        valuesOverlap(a.legState, bb.legState) &&
        valuesOverlap(a.legDisposition, bb.legDisposition) &&
        valuesOverlap(a.direction, bb.direction)
      )
    }
    case "timer": {
      const bb = b as typeof a
      return valuesOverlap(a.timerType, bb.timerType) && valuesOverlap(a.callState, bb.callState)
    }
    case "timeout": {
      const bb = b as typeof a
      return valuesOverlap(a.method, bb.method)
    }
    case "cancelled":
      return true
  }
}

/**
 * Warn if two rules have overlapping match sets + equal specificity score +
 * no explicit ordering (priority differs OR overrides/composesWith declared).
 * Phase A: warning. Phase C: fatal.
 */
function validateMatchSchemas(rules: ReadonlyArray<AnyRuleDefinition>): void {
  const withMatch = rules.filter((r) => r.match !== undefined) as ReadonlyArray<
    AnyRuleDefinition & { match: Match }
  >

  // Group by signature for quick pair-up. Rules with different signatures but
  // overlapping sets still get checked via the cross-pair loop below.
  const bySignature = new Map<string, typeof withMatch[number][]>()
  for (const r of withMatch) {
    const sig = matchSignature(r.match)
    const bucket = bySignature.get(sig)
    if (bucket) bucket.push(r)
    else bySignature.set(sig, [r])
  }

  for (const bucket of bySignature.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!, b = bucket[j]!
        if (!matchesOverlap(a.match, b.match)) continue
        const aScore = specificityScore(a.match)
        const bScore = specificityScore(b.match)
        if (aScore !== bScore) continue // deterministic winner by specificity
        const aPrio = a.defaultPriority
        const bPrio = b.defaultPriority
        const overrideDeclared =
          a.overrides === b.id || b.overrides === a.id ||
          a.composesWith === b.id || b.composesWith === a.id
        if (overrideDeclared) continue
        if (aPrio !== undefined && bPrio !== undefined && aPrio !== bPrio) continue
        console.warn(
          `[RuleRegistry] Match shadow: rules '${a.id}' and '${b.id}' have overlapping ` +
          `match sets with equal specificity and no explicit ordering ` +
          `(priority differ OR overrides/composesWith). At least one may be unreachable.`
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Registry transforms
// ---------------------------------------------------------------------------

/**
 * Composable wrappers over a registry's rule definitions. Used by the e2e
 * harness for coverage tracking (wrapHandle) and by the rule-kill script
 * for mutation testing (wrapMatches). Production code does not transform
 * the registry.
 */
export interface RegistryTransform {
  readonly wrapMatches?: (
    rule: AnyRuleDefinition,
    original: AnyRuleDefinition["matches"],
  ) => AnyRuleDefinition["matches"]
  readonly wrapHandle?: (
    rule: AnyRuleDefinition,
    original: AnyRuleDefinition["handle"],
  ) => AnyRuleDefinition["handle"]
}

/**
 * Return a new registry with each rule's matches/handle optionally wrapped.
 * The input registry is not mutated. Duplicate-id validation is not re-run
 * (input was already validated by createRuleRegistry).
 */
export function transformRegistry(
  registry: RuleRegistry,
  transform: RegistryTransform,
): RuleRegistry {
  const map = new Map<string, AnyRuleDefinition>()
  for (const [id, rule] of registry.definitions) {
    let wrapped = rule
    if (transform.wrapMatches !== undefined) {
      wrapped = { ...wrapped, matches: transform.wrapMatches(rule, rule.matches) }
    }
    if (transform.wrapHandle !== undefined) {
      wrapped = { ...wrapped, handle: transform.wrapHandle(rule, rule.handle) }
    }
    map.set(id, wrapped)
  }
  return { definitions: map }
}

/**
 * Return a new registry where the named rule's `matches()` is forced to
 * always return false — i.e. the rule is disabled for the whole run.
 * Used by the rule-kill mutation harness. If the id is not registered,
 * the registry is returned unchanged.
 */
export function disableRule(registry: RuleRegistry, ruleId: string): RuleRegistry {
  if (!registry.definitions.has(ruleId)) return registry
  return transformRegistry(registry, {
    wrapMatches: (rule, original) => rule.id === ruleId ? () => false : original,
  })
}
