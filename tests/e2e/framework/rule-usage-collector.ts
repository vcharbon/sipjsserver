/**
 * Rule usage collector — module-level singleton that records which rules
 * fire in which e2e scenario. Populated by a registry `wrapHandle`
 * transform in simulated-backend.ts; consumed by writeIndexReport to
 * render the rule-coverage section of the HTML index.
 *
 * Singleton-by-design: the e2e suite runs one test process at a time and
 * we want a global snapshot across every scenario. Kept separate from the
 * B2BUA runtime so production code never touches it.
 */

let currentScenario: string | null = null

/** Rule id → set of scenario names that made the rule's handle return a non-undefined result. */
const firings = new Map<string, Set<string>>()

/** Called by the interpreter before each scenario. Firings after this call
 *  will be attributed to the given scenario. */
export function setCurrentScenario(name: string): void {
  currentScenario = name
}

/** Called by the registry wrapper when a rule's handle returns non-undefined. */
export function recordFiring(ruleId: string): void {
  if (currentScenario === null) return
  let set = firings.get(ruleId)
  if (set === undefined) {
    set = new Set()
    firings.set(ruleId, set)
  }
  set.add(currentScenario)
}

/** Read-only snapshot of (ruleId → scenarios) for reporting. */
export function snapshot(): ReadonlyMap<string, ReadonlySet<string>> {
  return firings
}

/** Clear all state — call at the start of a run if you need a clean slate. */
export function reset(): void {
  currentScenario = null
  firings.clear()
}
