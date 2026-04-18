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
  Step,
  SutTarget,
} from "./types.js"
import { record, type ScenarioContext } from "./recorder.js"

// ---------------------------------------------------------------------------
// Composable scenario (the unit of composition)
// ---------------------------------------------------------------------------

export class ComposableScenario {
  constructor(
    readonly name: string,
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
    readonly description: string | undefined = undefined
  ) {}

  /** Attach a human-readable description. Returns a new immutable scenario. */
  describe(description: string): ComposableScenario {
    return new ComposableScenario(
      this.name,
      this.agents,
      this.steps,
      this.sippCompliant,
      this.allowedExtras,
      description
    )
  }

  /** Sequential composition — agents carry dialog state across the boundary. */
  andThen(other: ComposableScenario): ComposableScenario {
    const mergedAgents = { ...this.agents, ...other.agents }
    const mergedDescription =
      this.description !== undefined && other.description !== undefined
        ? `${this.description}\n\nthen:\n\n${other.description}`
        : this.description ?? other.description
    return new ComposableScenario(
      `${this.name}+${other.name}`,
      mergedAgents,
      [...this.steps, ...other.steps],
      this.sippCompliant && other.sippCompliant,
      [...this.allowedExtras, ...other.allowedExtras],
      mergedDescription
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
      this.description
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
      this.description
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
    }
  }
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
 */
export function scenario(
  name: string,
  builder: (s: ScenarioContext) => void
): ComposableScenario {
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
export function sequence(
  name: string,
  builder: (s: ScenarioContext) => void
): ComposableScenario {
  return scenario(name, builder)
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
export function parallel(
  name: string,
  ...scenarios: ComposableScenario[]
): ComposableScenario {
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

  return new ComposableScenario(
    name,
    mergedAgents,
    allSteps,
    scenarios.every((s) => s.sippCompliant),
    mergedExtras
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
  }
}
