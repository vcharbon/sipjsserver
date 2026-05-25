/**
 * Drive-only runner — takes a `ScenarioScript` factory, runs it via the
 * scenario interpreter (with inline validation forcibly disabled), then
 * derives per-call `RuleTrace[]` from the `Recorder` channels and runs
 * the post-hoc `RuleEngine` over them.
 *
 * Trace flow:
 *   - `executeScenario` produces a `ScenarioResult.trace` of wire-level
 *     SIP entries (sent/received). Per-call bucketing keys on Call-ID,
 *     collapsing B-leg `${legNumber}-${aLegCallId}` minted Call-IDs to
 *     the A-leg's logical id.
 *   - The `SipHarness` typed channel carries driver-side timeouts +
 *     markers. They splice onto the first per-call bucket (refined
 *     attribution requires per-event callId hints — outstanding work).
 */

import { Buffer } from "node:buffer"
import { Effect, Option } from "effect"
import type { Layer, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import type { AppConfigData } from "../../src/config/AppConfig.js"
import { executeScenario } from "../../src/test-harness/framework/interpreter.js"
import { createSimulatedTransport } from "../fullcall/framework/simulated-backend.js"
import { getHeader } from "../../src/sip/MessageHelpers.js"
import { serialize } from "../../src/sip/Serializer.js"
import type {
  ComposableScenario,
} from "../../src/test-harness/framework/dsl.js"
import type {
  ExpectStep,
  Scenario,
  ScenarioResult,
  SendStep,
  Step,
  TestTransport,
  TraceEntry,
} from "../../src/test-harness/framework/types.js"
import type { ValidationCheckName } from "../../src/test-harness/framework/validation.js"
import { Recorder } from "../../src/test-harness/framework/report-recorder/Recorder.js"
import type { RecordedStamps } from "../../src/test-harness/framework/report-recorder/types.js"
import {
  SipHarness,
  type SipHarnessEvent,
} from "../../src/test-harness/framework/SipHarness.js"
import {
  RuleEngine,
  type Rule,
  type RuleEngineResult,
  type RuleTrace,
  type RuleTraceEntry,
  type RuleTraceMarker,
  type RuleTraceMessage,
  type RuleTraceTimeout,
} from "./rules/types.js"
import type { ServiceCase } from "./service-case/types.js"

// ---------------------------------------------------------------------------
// Drive-only step rewriting
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
  "noContactOnBye",
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
     * call-shape rules rather than blocking inline.
     */
    skipFinalSweep: true,
  }
}

// ---------------------------------------------------------------------------
// Label registry — StepRef.id → label
// ---------------------------------------------------------------------------

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
// Runner API
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
  readonly clockSleep?: (ms: number) => Effect.Effect<void>
  readonly realClock?: boolean
  /**
   * Inject a custom transport. When set, runner skips building a
   * simulated transport and uses this instance directly.
   */
  readonly transport?: TestTransport
  /** SIP target address — overrides {host:127.0.0.1,port:sipPort}. */
  readonly target?: { readonly host: string; readonly port: number }
}

export interface DriveOnlyRunResult {
  readonly recordings: ReadonlyArray<RuleTrace>
  readonly engineResult: RuleEngineResult
  readonly scenarioResult: ScenarioResult
}

/**
 * Default TestClock-aware sleep: advances virtual time in 100ms chunks
 * so simulated-network delivery fibers observe intermediate values.
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
    // Drive-only sets `skipFinalSweep` to bypass verifyCleanState (those
    // checks moved to call-shape rules). But that flag also short-circuits
    // the interpreter's `transport.settle()` call — and the layer-scope
    // audits (CallLimiter ADR-0004, PartitionedRelayStorage, etc.) fire at
    // scope close regardless. Without a settle, parallel sub-scenarios
    // whose BYE-decrement is still in flight when the last `expect` resolves
    // trip the audits as false positives. Explicitly settle here so the
    // typed-channel snapshots the audits read are quiescent.
    if (transport.settle !== undefined) {
      yield* transport.settle()
    }
    const labels = built.labels
    const labelsByStepIndex = labels !== undefined
      ? (stepIndex: number): string | undefined => {
          const step = driveScenario.steps[stepIndex]
          if (!step) return undefined
          const ref = (step as { ref?: { id: number } }).ref
          if (!ref) return undefined
          return labels.get(ref.id)
        }
      : undefined

    const baseRecordings = buildRecordings(result, {
      scenarioId: opts.scenarioId,
      serviceCaseId: opts.serviceCase.id,
      ...(labelsByStepIndex !== undefined ? { labelOfStep: labelsByStepIndex } : {}),
    })
    const recordings = yield* mergeSipHarnessEntries(baseRecordings)
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
    : (program as unknown as Effect.Effect<DriveOnlyRunResult, never, Scope.Scope>)
  return Effect.orDie(Effect.scoped(provided as unknown as Effect.Effect<DriveOnlyRunResult, unknown, Scope.Scope>))
}

// ---------------------------------------------------------------------------
// Per-call bucketing — converts TraceEntry[] → RuleTrace[]
// ---------------------------------------------------------------------------

const PRE_CALL_KEY = "<pre-call>"

interface BuildOpts {
  readonly scenarioId: string
  readonly serviceCaseId: string | null
  readonly labelOfStep?: (stepIndex: number) => string | undefined
}

interface MutableTrace {
  callId: string
  startMs: number
  entries: RuleTraceEntry[]
}

/**
 * B-leg Call-IDs are minted as `${legNumber}-${aLegCallId}` by
 * [src/b2bua/helpers.ts]. For per-call rule evaluation we group both
 * legs under the A-leg's logical id.
 */
function logicalCallId(raw: string): string {
  const m = /^\d+-(.+)$/.exec(raw)
  return m?.[1] ?? raw
}

function buildRecordings(
  result: ScenarioResult,
  opts: BuildOpts,
): RuleTrace[] {
  const buckets = new Map<string, MutableTrace>()

  for (const entry of result.trace) {
    if (entry.message === undefined) continue
    const rawCallId = getHeader(entry.message.headers, "call-id") ?? PRE_CALL_KEY
    const callId = rawCallId === PRE_CALL_KEY ? rawCallId : logicalCallId(rawCallId)
    let bucket = buckets.get(callId)
    if (!bucket) {
      bucket = { callId, startMs: entry.sentMs, entries: [] }
      buckets.set(callId, bucket)
    }
    bucket.startMs = Math.min(bucket.startMs, entry.sentMs)
    bucket.entries.push(toMessage(entry, opts.labelOfStep))
  }

  const out: RuleTrace[] = []
  for (const bucket of buckets.values()) {
    out.push({
      scenarioId: opts.scenarioId,
      serviceCaseId: opts.serviceCaseId,
      callId: bucket.callId,
      startMs: bucket.startMs,
      entries: bucket.entries,
    })
  }
  out.sort((a, b) =>
    a.startMs === b.startMs ? a.callId.localeCompare(b.callId) : a.startMs - b.startMs
  )
  return out
}

function toMessage(
  entry: TraceEntry,
  labelOfStep?: (stepIndex: number) => string | undefined,
): RuleTraceMessage {
  const direction: RuleTraceMessage["direction"] =
    entry.direction === "send" ? "sent" : "received"
  const label = labelOfStep?.(entry.stepIndex)
  const raw = Buffer.from(serialize(entry.message!)).toString("utf8")
  const unexpected = entry.status === "unexpected"
  const base: RuleTraceMessage = {
    kind: "message",
    direction,
    from: entry.from,
    to: entry.to,
    sentMs: entry.sentMs,
    receivedMs: entry.receivedMs,
    raw,
    parsed: entry.message!,
  }
  const withLabel = label !== undefined ? { ...base, label } : base
  return unexpected ? { ...withLabel, unexpected: true } : withLabel
}

// ---------------------------------------------------------------------------
// SipHarness channel splicing
// ---------------------------------------------------------------------------

/**
 * Drain the SipHarness typed channel and splice timeout/marker entries
 * onto the first per-call bucket. Returns the recordings unchanged when
 * the Recorder isn't in scope.
 *
 * Refined per-call attribution requires per-event callId hints on
 * SipHarness payloads — outstanding follow-up.
 */
function mergeSipHarnessEntries(
  recordings: ReadonlyArray<RuleTrace>,
): Effect.Effect<ReadonlyArray<RuleTrace>, never> {
  return Effect.gen(function* () {
    const recOpt = yield* Effect.serviceOption(Recorder)
    if (Option.isNone(recOpt)) return recordings
    const channel = recOpt.value.forTag<SipHarness, SipHarnessEvent>(SipHarness)
    const events = yield* channel.snapshot
    if (events.length === 0) return recordings
    const projected = projectHarnessEntries(events)
    if (projected.length === 0) return recordings
    if (recordings.length === 0) {
      return [
        {
          scenarioId: "",
          serviceCaseId: null,
          callId: PRE_CALL_KEY,
          startMs: 0,
          entries: projected,
        },
      ]
    }
    const out: RuleTrace[] = []
    for (let i = 0; i < recordings.length; i++) {
      const rec = recordings[i]!
      if (i === 0) {
        out.push({ ...rec, entries: [...rec.entries, ...projected] })
      } else {
        out.push(rec)
      }
    }
    return out
  })
}

function projectHarnessEntries(
  events: ReadonlyArray<SipHarnessEvent & RecordedStamps>,
): RuleTraceEntry[] {
  const out: RuleTraceEntry[] = []
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  for (const e of sorted) {
    if (e.tag === "timeout") {
      const t: RuleTraceTimeout = {
        kind: "timeout",
        agent: e.agent,
        waitingFor: e.waitingFor,
        atMs: e.atMs,
        label: e.expectStepId,
      }
      out.push(t)
      continue
    }
    if (e.tag === "marker") {
      const m: RuleTraceMarker = e.note !== undefined
        ? { kind: "marker", atMs: e.atMs, label: e.phase, note: e.note }
        : { kind: "marker", atMs: e.atMs, label: e.phase }
      out.push(m)
      continue
    }
    // linkObservedToExpect — correlation metadata only; not user-visible.
  }
  return out
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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
