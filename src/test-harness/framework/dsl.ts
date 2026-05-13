/**
 * DSL — public API for defining scenarios and composing them.
 *
 * scenario()   — define a standalone scenario
 * sequence()   — define a reusable fragment
 * or()         — branching: first branch whose first expect matches wins
 * andThen()    — sequential composition (available as method on ComposableScenario)
 * rename()     — remap agent names for reuse
 */

import type {
  AgentConfig,
  AllowedExtraPattern,
  OrBranch,
  Scenario,
  ScenarioTier,
  Step,
  Sut,
  SutTarget,
} from "./types.js"
import { ALL_SUTS, DEFAULT_APPLICABLE_SUTS } from "./types.js"
import { record, type ScenarioContext } from "./recorder.js"

// ---------------------------------------------------------------------------
// Composable scenario (the unit of composition)
// ---------------------------------------------------------------------------

export class ComposableScenario {
  // Mutable to allow `registerScenarios(module)` to backfill an empty name
  // from the module's export key. Once set to a non-empty string, attempts
  // to overwrite throw.
  name: string

  constructor(
    name: string,
    readonly agents: Record<string, AgentConfig>,
    readonly steps: readonly Step[],
    /**
     * Whether this scenario can be exported to SIPp XML.
     * Automatically set to `false` if any step uses a `build(ctx)` callback,
     * since SIPp cannot execute dynamic TypeScript. Composed scenarios
     * (`andThen`, `or`) are compliant only if all parts are compliant.
     */
    readonly sippCompliant: boolean,
    /** Patterns for messages that may arrive but should not be flagged as unexpected. */
    readonly allowedExtras: readonly AllowedExtraPattern[] = [],
    /**
     * Human-readable description of the scenario — surfaced at the top of
     * every generated text report (global + per-agent) so a reviewer can
     * see what the test simulates without re-reading the DSL source. Most
     * useful for scenarios that deliberately simulate bad-actor agents.
     */
    readonly description: string | undefined = undefined,
    /** Duration tier — metadata for `test:live:{short,medium,long}` gating. */
    readonly scenarioTier: ScenarioTier = "short",
    /** Opt out of the end-of-scenario 24h TestClock sweep + verifyCleanState. */
    readonly skipFinalSweepFlag: boolean = false,
    /**
     * SUT topologies this scenario applies to. Defaults to all SUTs;
     * narrow via `.runOn(...)` for scenarios meaningful only on one
     * topology (e.g. asserting B2BUA-only header semantics).
     */
    readonly applicableSuts: readonly Sut[] = DEFAULT_APPLICABLE_SUTS,
    /**
     * Human-readable title used as the vitest `it.effect(...)` name when
     * the test file iterates a scenario barrel. Distinct from `name`
     * (kebab-case identifier used for reports/file output) and from
     * `description` (long-form scenario commentary). Set via `.title(...)`.
     */
    readonly displayTitle: string | undefined = undefined,
  ) {
    this.name = name
  }

  /**
   * Internal: assign a name to a scenario that was constructed without one
   * (i.e. via `scenario(builder)` rather than `scenario(name, builder)`).
   * Called by `registerScenarios()` to derive the name from the module
   * export key. Throws if the name has already been set.
   */
  _setName(name: string): void {
    if (this.name !== "") {
      throw new Error(`ComposableScenario._setName: name already set to "${this.name}"`)
    }
    this.name = name
  }

  /** Attach a vitest test title. Returns a new immutable scenario. */
  title(displayTitle: string): ComposableScenario {
    return new ComposableScenario(
      this.name,
      this.agents,
      this.steps,
      this.sippCompliant,
      this.allowedExtras,
      this.description,
      this.scenarioTier,
      this.skipFinalSweepFlag,
      this.applicableSuts,
      displayTitle,
    )
  }

  /** Attach a human-readable description. Returns a new immutable scenario. */
  describe(description: string): ComposableScenario {
    return new ComposableScenario(
      this.name,
      this.agents,
      this.steps,
      this.sippCompliant,
      this.allowedExtras,
      description,
      this.scenarioTier,
      this.skipFinalSweepFlag,
      this.applicableSuts,
      this.displayTitle,
    )
  }

  /**
   * Set the scenario duration tier. Affects which `test:live:*` npm
   * script runs this scenario. Has no runtime effect under fake-clock.
   */
  tier(t: ScenarioTier): ComposableScenario {
    return new ComposableScenario(
      this.name,
      this.agents,
      this.steps,
      this.sippCompliant,
      this.allowedExtras,
      this.description,
      t,
      this.skipFinalSweepFlag,
      this.applicableSuts,
      this.displayTitle,
    )
  }

  /**
   * Restrict this scenario to a subset of SUT topologies. Default is
   * both `b2bonly` and `proxy+b2b`. Pass a narrower list when the
   * scenario codifies behavior only meaningful under one SUT.
   */
  runOn(suts: readonly Sut[]): ComposableScenario {
    return new ComposableScenario(
      this.name,
      this.agents,
      this.steps,
      this.sippCompliant,
      this.allowedExtras,
      this.description,
      this.scenarioTier,
      this.skipFinalSweepFlag,
      suts,
      this.displayTitle,
    )
  }

  /** True if this scenario should run on the given SUT. */
  appliesTo(sut: Sut): boolean {
    return this.applicableSuts.includes(sut)
  }

  /**
   * Opt out of the 24h TestClock sweep + verifyCleanState at scenario
   * end. Use only for scenarios that deliberately leave CallState or
   * TimerService dirty (e.g. simulating a caller walking off mid-call
   * with no BYE). Normal scenarios that "forgot" to hang up should add
   * `.bye()` instead.
   */
  skipFinalSweep(): ComposableScenario {
    return new ComposableScenario(
      this.name,
      this.agents,
      this.steps,
      this.sippCompliant,
      this.allowedExtras,
      this.description,
      this.scenarioTier,
      true,
      this.applicableSuts,
      this.displayTitle,
    )
  }

  /** Sequential composition — agents carry dialog state across the boundary. */
  andThen(other: ComposableScenario): ComposableScenario {
    const mergedAgents = { ...this.agents, ...other.agents }
    const mergedDescription =
      this.description !== undefined && other.description !== undefined
        ? `${this.description}\n\nthen:\n\n${other.description}`
        : this.description ?? other.description
    // Composed tier = max(self, other). If either side opts out of the
    // final sweep, the composition does too (mid-call joins can't be
    // cleaner than their loosest part).
    return new ComposableScenario(
      `${this.name}+${other.name}`,
      mergedAgents,
      [...this.steps, ...other.steps],
      this.sippCompliant && other.sippCompliant,
      [...this.allowedExtras, ...other.allowedExtras],
      mergedDescription,
      maxTier(this.scenarioTier, other.scenarioTier),
      this.skipFinalSweepFlag || other.skipFinalSweepFlag,
      intersectSuts(this.applicableSuts, other.applicableSuts),
      // andThen-composed scenarios drop the test title: the composed
      // result is rarely the direct subject of an it.effect() call.
      undefined,
    )
  }

  /** Remap agent names. Returns a new immutable scenario. */
  rename(mapping: Record<string, string>): ComposableScenario {
    const renamedAgents: Record<string, AgentConfig> = {}
    for (const [name, config] of Object.entries(this.agents)) {
      const newName = mapping[name] ?? name
      renamedAgents[newName] = config
    }

    const renamedSteps = this.steps.map((step) => renameStepAgent(step, mapping))

    const renamedExtras = this.allowedExtras.map((e) => ({
      ...e,
      agent: mapping[e.agent] ?? e.agent,
    }))

    return new ComposableScenario(
      this.name,
      renamedAgents,
      renamedSteps,
      this.sippCompliant,
      renamedExtras,
      this.description,
      this.scenarioTier,
      this.skipFinalSweepFlag,
      this.applicableSuts,
      this.displayTitle,
    )
  }

  /** Override the SUT target for a specific agent. Returns a new immutable scenario. */
  withSut(agentName: string, sutTarget: SutTarget): ComposableScenario {
    const agent = this.agents[agentName]
    if (!agent) {
      throw new Error(`withSut: unknown agent "${agentName}"`)
    }
    return new ComposableScenario(
      this.name,
      { ...this.agents, [agentName]: { ...agent, sutTarget } },
      this.steps,
      this.sippCompliant,
      this.allowedExtras,
      this.description,
      this.scenarioTier,
      this.skipFinalSweepFlag,
      this.applicableSuts,
      this.displayTitle,
    )
  }

  /** Convert to a full Scenario (for execution). */
  toScenario(): Scenario {
    return {
      name: this.name,
      agents: this.agents,
      steps: this.steps,
      sippCompliant: this.sippCompliant,
      allowedExtras: this.allowedExtras.length > 0 ? this.allowedExtras : undefined,
      description: this.description,
      tier: this.scenarioTier,
      skipFinalSweep: this.skipFinalSweepFlag || undefined,
      runOn: this.applicableSuts,
    }
  }
}

function maxTier(a: ScenarioTier, b: ScenarioTier): ScenarioTier {
  const rank = { short: 0, medium: 1, long: 2 } as const
  return rank[a] >= rank[b] ? a : b
}

/**
 * Intersect two SUT applicability lists. Composition can only run on a
 * SUT supported by every part — narrowing is monotonic.
 */
function intersectSuts(a: readonly Sut[], b: readonly Sut[]): readonly Sut[] {
  return a.filter((s) => b.includes(s))
}

// ---------------------------------------------------------------------------
// Or-branch composition
// ---------------------------------------------------------------------------

export class OrComposable {
  readonly _tag = "OrComposable" as const

  constructor(readonly branches: readonly ComposableScenario[]) {
    // Validate: every branch must start with an expect step
    for (const branch of branches) {
      if (branch.steps.length === 0 || branch.steps[0]!.type !== "expect") {
        throw new Error(
          `or() branch "${branch.name}" must start with an expect step, ` +
          `got "${branch.steps[0]?.type ?? "empty"}"`
        )
      }
    }
  }

  /** Rename agents across all branches. */
  rename(mapping: Record<string, string>): OrComposable {
    return new OrComposable(this.branches.map((b) => b.rename(mapping)))
  }

  /** Convert branches to OrBranch[] for the interpreter. */
  toOrBranches(): readonly OrBranch[] {
    return this.branches.map((b) => ({
      name: b.name,
      steps: b.steps,
    }))
  }
}

// ---------------------------------------------------------------------------
// Public DSL functions
// ---------------------------------------------------------------------------

/**
 * Define a standalone scenario.
 * The builder function runs in record mode — no SIP messages are sent.
 *
 * Two forms:
 *   - `scenario(builder)` — name is derived from the module export key at
 *     `registerScenarios()` time. Standard form for new scenarios.
 *   - `scenario(name, builder)` — explicit kebab-case name. Use when the
 *     canonical name cannot be derived from the variable identifier
 *     (e.g. p2pDirectCall → variable→kebab yields `p-2p-direct-call`
 *     but you want `p2p-direct-call`).
 */
export function scenario(builder: (s: ScenarioContext) => void): ComposableScenario
export function scenario(name: string, builder: (s: ScenarioContext) => void): ComposableScenario
export function scenario(
  nameOrBuilder: string | ((s: ScenarioContext) => void),
  maybeBuilder?: (s: ScenarioContext) => void,
): ComposableScenario {
  const name = typeof nameOrBuilder === "string" ? nameOrBuilder : ""
  const builder = typeof nameOrBuilder === "string" ? maybeBuilder! : nameOrBuilder
  const result = record(builder)
  return new ComposableScenario(
    name,
    result.agents,
    result.steps,
    !result.hasBuildCallbacks,
    result.allowedExtras
  )
}

/**
 * Define a reusable scenario fragment.
 * Identical to scenario() but named differently for clarity.
 */
export function sequence(builder: (s: ScenarioContext) => void): ComposableScenario
export function sequence(name: string, builder: (s: ScenarioContext) => void): ComposableScenario
export function sequence(
  nameOrBuilder: string | ((s: ScenarioContext) => void),
  maybeBuilder?: (s: ScenarioContext) => void,
): ComposableScenario {
  if (typeof nameOrBuilder === "string") {
    return scenario(nameOrBuilder, maybeBuilder!)
  }
  return scenario(nameOrBuilder)
}

/**
 * Branching — first branch whose first expect matches wins.
 * Every branch must start with an expect step.
 *
 * @experimental Not yet implemented. The interpreter does not support
 * runtime branch selection. Use separate scenarios instead.
 */
export function or(...branches: ComposableScenario[]): OrComposable {
  return new OrComposable(branches)
}

/**
 * Flatten an OrComposable into a ComposableScenario for use with andThen().
 *
 * @experimental Not implemented — silently drops all branches except the first.
 * The interpreter has no branch selection logic. Use separate scenarios instead.
 */
export function withOr(
  _base: ComposableScenario,
  _orBlock: OrComposable
): ComposableScenario {
  throw new Error(
    "withOr() is not implemented. The interpreter does not support runtime branch selection. " +
    "Use separate scenarios for each branch instead."
  )
}

// ---------------------------------------------------------------------------
// Parallel composition
// ---------------------------------------------------------------------------

/**
 * Parallel composition — run multiple scenarios concurrently against the
 * same B2BUA instance. Agent names must be unique across all sub-scenarios.
 *
 * Each sub-scenario's steps are tagged with a group index. The interpreter
 * runs each group as a concurrent fiber with independent dialog state.
 */
export function parallel(...scenarios: ComposableScenario[]): ComposableScenario
export function parallel(name: string, ...scenarios: ComposableScenario[]): ComposableScenario
export function parallel(
  nameOrFirst: string | ComposableScenario,
  ...rest: ComposableScenario[]
): ComposableScenario {
  const name = typeof nameOrFirst === "string" ? nameOrFirst : ""
  const scenarios = typeof nameOrFirst === "string" ? rest : [nameOrFirst, ...rest]

  // Validate: no agent name collisions across sub-scenarios
  const seenAgents = new Set<string>()
  for (const s of scenarios) {
    for (const agentName of Object.keys(s.agents)) {
      if (seenAgents.has(agentName)) {
        throw new Error(
          `parallel(): agent "${agentName}" appears in multiple sub-scenarios. ` +
          `Use unique names (e.g., alice1, alice2) for parallel calls.`
        )
      }
      seenAgents.add(agentName)
    }
  }

  // Merge agents from all sub-scenarios
  const mergedAgents: Record<string, AgentConfig> = {}
  for (const s of scenarios) {
    Object.assign(mergedAgents, s.agents)
  }

  // Tag each sub-scenario's steps with a group index and concatenate
  const allSteps: Step[] = []
  for (let groupIdx = 0; groupIdx < scenarios.length; groupIdx++) {
    for (const step of scenarios[groupIdx]!.steps) {
      allSteps.push({ ...step, group: groupIdx } as Step)
    }
  }

  // Merge allowedExtras from all sub-scenarios
  const mergedExtras: AllowedExtraPattern[] = []
  for (const s of scenarios) {
    mergedExtras.push(...s.allowedExtras)
  }

  // Composed tier = max across branches; composed skipFinalSweep = any.
  const composedTier = scenarios.reduce<ScenarioTier>(
    (acc, s) => maxTier(acc, s.scenarioTier),
    "short"
  )
  const composedSkip = scenarios.some((s) => s.skipFinalSweepFlag)
  const composedSuts = scenarios.reduce<readonly Sut[]>(
    (acc, s) => intersectSuts(acc, s.applicableSuts),
    ALL_SUTS,
  )

  return new ComposableScenario(
    name,
    mergedAgents,
    allSteps,
    scenarios.every((s) => s.sippCompliant),
    mergedExtras,
    undefined,
    composedTier,
    composedSkip,
    composedSuts,
    undefined,
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renameStepAgent(step: Step, mapping: Record<string, string>): Step {
  switch (step.type) {
    case "send":
      return { ...step, agent: mapping[step.agent] ?? step.agent }
    case "expect":
      return { ...step, agent: mapping[step.agent] ?? step.agent }
    case "pause":
      return step
    case "infra":
      return { ...step, target: mapping[step.target] ?? step.target }
    case "k8s":
      // Worker IDs are not agent names — k8s steps are addressed by
      // their cluster-side worker id (`b2b-1`, etc.) rather than the
      // logical agent identifier the rename mapping operates on.
      return step
  }
}

// ---------------------------------------------------------------------------
// Scenario registry — derive names from module export keys
// ---------------------------------------------------------------------------

/**
 * Convert a camelCase identifier to kebab-case. Splits at:
 *   - lowercase/digit → uppercase boundaries (`fooBar` → `foo-bar`)
 *   - letter → digit boundaries (`suppress18x` → `suppress-18x`,
 *     `referAllowC486` → `refer-allow-c-486`)
 *
 * Does NOT split digit → letter boundaries, so `18x`, `200ok`, `481` etc.
 * stay glued in the natural reading direction. Scenarios whose variable
 * name doesn't fit this scheme should pass an explicit name to
 * `scenario("explicit-name", ...)`.
 */
function camelToKebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([a-zA-Z])(\d)/g, "$1-$2")
    .toLowerCase()
}

/**
 * Walk a module-shaped object (e.g. `import * as S from "./index.js"`),
 * assign a kebab-case name (derived from the export key) to every
 * `ComposableScenario` constructed without one, and throw on duplicate
 * canonical names.
 *
 * Call this from the scenario barrel at module-evaluation time, before
 * any test file iterates the registered scenarios.
 */
export function registerScenarios(module: Record<string, unknown>): void {
  const seenNames = new Map<string, string>() // name -> export key
  for (const [key, val] of Object.entries(module)) {
    if (!(val instanceof ComposableScenario)) continue
    if (val.name === "") {
      val._setName(camelToKebab(key))
    }
    const prevKey = seenNames.get(val.name)
    if (prevKey !== undefined && prevKey !== key) {
      throw new Error(
        `registerScenarios: duplicate scenario name "${val.name}" ` +
        `from exports "${prevKey}" and "${key}"`,
      )
    }
    seenNames.set(val.name, key)
  }
}
