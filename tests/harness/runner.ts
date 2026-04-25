/**
 * Drive-only runner — Slice 0/1 wiring.
 *
 * Takes a ScenarioScript factory `(sc) => ComposableScenario`, runs it
 * via the existing interpreter (with all inline validation forcibly
 * disabled — that's the "drive-only" promise), then converts the trace
 * into CallRecording[] and runs the RuleEngine over it.
 *
 * Per Q2 / Q11: rule findings are surfaced post-hoc; `disableRules` and
 * `expectViolations` come from the ServiceCase or runtime opts.
 */

import { Effect } from "effect"
import type { Layer, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import type { AppConfigData } from "../../src/config/AppConfig.js"
import { executeScenario } from "../fullcall/framework/interpreter.js"
import { createSimulatedTransport } from "../fullcall/framework/simulated-backend.js"
import {
  type ComposableScenario,
} from "../fullcall/framework/dsl.js"
import type {
  ExpectStep,
  Scenario,
  ScenarioResult,
  SendStep,
  Step,
  TestTransport,
} from "../fullcall/framework/types.js"
import type { ValidationCheckName } from "../fullcall/framework/validation.js"
import { extractRecordings } from "./recording-extractor.js"
import type { CallRecording } from "./recording.js"
import {
  RuleEngine,
  type Rule,
  type RuleEngineResult,
} from "./rules/types.js"
import type { ServiceCase } from "./service-case/types.js"

// ---------------------------------------------------------------------------
// All-validation-skip set (used to force drive-only semantics)
// ---------------------------------------------------------------------------

const ALL_CHECKS: ReadonlyArray<ValidationCheckName> = [
  "tags",
  "cseq",
  "via",
  "callId",
  "maxForwards",
  "contentLength",
  "contentType",
  "contactPresence",
  "toTagPresence",
  "branchPrefix",
  "dialogUri",
  "recordRoute",
  "cancelRequestUri",
  "cancelViaBranch",
  "responseCorrelation",
  "rackCorrelation",
  "tagConsistency",
  "offerAnswer",
]

function stripValidation(step: Step): Step {
  if (step.type === "expect") {
    const next: ExpectStep = {
      ...step,
      skipValidation: ALL_CHECKS,
      ...(step.allowReemission !== undefined ? { allowReemission: step.allowReemission } : {}),
    }
    return next
  }
  if (step.type === "send") {
    const next: SendStep = { ...step, skipValidation: ALL_CHECKS }
    return next
  }
  return step
}

function toDriveOnly(scenario: Scenario): Scenario {
  return {
    ...scenario,
    steps: scenario.steps.map(stripValidation),
    /**
     * Drive-only runs deliberately skip the interpreter's
     * verifyCleanState + 24h sweep. Cleanup-style assertions live in
     * call-shape rules (see Slice 1) rather than blocking inline.
     */
    skipFinalSweep: true,
  }
}

// ---------------------------------------------------------------------------
// Label registry (StepRef.id → label)
// ---------------------------------------------------------------------------

/**
 * Driver scripts attach human-readable labels to specific expect/send
 * steps via this registry. The runner consults it when extracting
 * recordings so labels propagate into the YAML output.
 *
 * Keyed by StepRef.id which the existing recorder mints on every send/
 * expect call.
 */
export class LabelRegistry {
  private readonly map = new Map<number, string>()
  set(refId: number, label: string): void {
    this.map.set(refId, label)
  }
  get(refId: number): string | undefined {
    return this.map.get(refId)
  }
}

// ---------------------------------------------------------------------------
// Public runner API
// ---------------------------------------------------------------------------

export interface ScenarioBuildResult {
  readonly scenario: ComposableScenario
  readonly labels?: LabelRegistry
}

export type ScenarioScript = (sc: ServiceCase) => ScenarioBuildResult

export interface DriveOnlyRunOpts {
  readonly scenarioId: string
  readonly serviceCase: ServiceCase
  readonly script: ScenarioScript
  readonly rules: ReadonlyArray<Rule>
  readonly sipPort?: number
  readonly httpPort?: number
  readonly configOverrides?: Partial<AppConfigData>
  readonly disableRules?: ReadonlyArray<string>
  readonly expectViolations?: ReadonlyArray<string>
  /** Override clockSleep — defaults to TestClock-aware. */
  readonly clockSleep?: (ms: number) => Effect.Effect<void>
  readonly realClock?: boolean
  /**
   * Inject a custom transport. When set, runner skips building a
   * simulated transport and uses this instance directly. Used by the
   * UDP DUT path (see [tests/harness/dut/udp.ts]).
   *
   * The transport's `dutEndpoint` is taken as the SIP target address;
   * `sipPort` is ignored when this is set.
   */
  readonly transport?: TestTransport
  /** SIP target address — overrides {host:127.0.0.1,port:sipPort}. */
  readonly target?: { readonly host: string; readonly port: number }
}

export interface DriveOnlyRunResult {
  readonly recordings: ReadonlyArray<CallRecording>
  readonly engineResult: RuleEngineResult
  readonly scenarioResult: ScenarioResult
}

/**
 * Default TestClock-aware sleep: advances virtual time in 100ms chunks
 * so simulated-network delivery fibers observe intermediate values
 * (mirrors the existing harness pattern in [tests/support/harness.ts]).
 */
const defaultClockSleep = (ms: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    let remaining = ms
    while (remaining > 0) {
      const step = remaining < 100 ? remaining : 100
      yield* TestClock.adjust(`${step} millis`)
      remaining -= step
    }
  })

export function runDriveOnly(
  opts: DriveOnlyRunOpts
): Effect.Effect<DriveOnlyRunResult, never> {
  const sipPort = opts.sipPort ?? 15060
  const httpPort = opts.httpPort ?? 13002
  const clockSleep = opts.clockSleep ?? (opts.realClock
    ? (ms: number) => Effect.sleep(`${ms} millis`)
    : defaultClockSleep)
  let transport: TestTransport
  if (opts.transport !== undefined) {
    transport = opts.transport
  } else {
    const transportOpts: Parameters<typeof createSimulatedTransport>[0] = {
      sipPort,
      httpPort,
      clockSleep,
      ...(opts.realClock !== undefined ? { realClock: opts.realClock } : {}),
      ...(opts.configOverrides !== undefined ? { configOverrides: opts.configOverrides } : {}),
    }
    transport = createSimulatedTransport(transportOpts)
  }
  const target = opts.target ?? { host: "127.0.0.1", port: sipPort }

  const built = opts.script(opts.serviceCase)
  const composable = built.scenario
  const baseScenario = composable.toScenario()
  const driveScenario = toDriveOnly(baseScenario)

  const program = Effect.gen(function* () {
    const result = yield* executeScenario(
      driveScenario,
      transport,
      target,
      undefined,
      clockSleep
    )
    const labels = built.labels
    const labelOf = labels !== undefined
      ? (refId: number) => {
          for (const step of baseScenario.steps) {
            const stepRef = (step as { ref?: { id: number } }).ref
            if (stepRef && stepRef.id === refId) {
              return labels.get(refId)
            }
          }
          return undefined
        }
      : undefined

    const labelsByStepIndex = (stepIndex: number): string | undefined => {
      const step = driveScenario.steps[stepIndex]
      if (!step) return undefined
      const ref = (step as { ref?: { id: number } }).ref
      if (!ref) return undefined
      return labelOf?.(ref.id)
    }

    const extractOpts: Parameters<typeof extractRecordings>[1] = labels !== undefined
      ? {
          scenarioId: opts.scenarioId,
          serviceCaseId: opts.serviceCase.id,
          labelOfStep: labelsByStepIndex,
        }
      : {
          scenarioId: opts.scenarioId,
          serviceCaseId: opts.serviceCase.id,
        }
    const recordings = extractRecordings(result, extractOpts)
    const engine = new RuleEngine(opts.rules)
    const engineOpts: Parameters<typeof engine.run>[2] = {
      ...(opts.disableRules !== undefined
        ? { disableRules: opts.disableRules }
        : opts.serviceCase.disableRules !== undefined
          ? { disableRules: opts.serviceCase.disableRules }
          : {}),
      ...(opts.expectViolations !== undefined
        ? { expectViolations: opts.expectViolations }
        : opts.serviceCase.expectViolations !== undefined
          ? { expectViolations: opts.serviceCase.expectViolations }
          : {}),
    }
    const engineResult = engine.run(recordings, opts.serviceCase, engineOpts)
    return { recordings, engineResult, scenarioResult: result }
  })

  const layer: Layer.Layer<never> | undefined = transport.stackLayer
  const provided = layer
    ? program.pipe(Effect.provide(layer))
    : (program as Effect.Effect<DriveOnlyRunResult, never, Scope.Scope>)
  return Effect.orDie(Effect.scoped(provided as Effect.Effect<DriveOnlyRunResult, unknown, Scope.Scope>))
}

/** Helper used by tests to assert pass and surface failures. */
export function assertEnginePassed(result: DriveOnlyRunResult): void {
  if (result.engineResult.passed) return
  const lines: string[] = []
  for (const f of result.engineResult.findings) {
    if (f.status === "pass") continue
    lines.push(
      `[${f.family}] ${f.ruleName} (${f.scenarioId}, callId=${f.callId})`
    )
    for (const v of f.violations) {
      lines.push(`    - ${v.message}`)
    }
    if (f.violations.length === 0) {
      lines.push(`    - (expected violation, but rule passed)`)
    }
  }
  throw new Error(`Rule failures:\n${lines.join("\n")}`)
}
