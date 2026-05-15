/**
 * Evaluates `ExpectedImpact` rules against actual run data and emits
 * per-rule pass/fail/warn results.
 *
 * Pure: input data in, evaluation out. The analyzer (post-SOAK
 * verdict) and the run-chaos sub-command (per-event iteration verdict)
 * share this module.
 */

import type { CallOutcome } from "../fixtures/sippOutcomes.js"
import type { ChaosEventType } from "./chaosOps.js"
import {
  EXPECTED_IMPACT,
  type ExpectedImpact,
  type ImpactBound,
  type ImpactMetric,
  type ImpactRule,
} from "./expectedImpact.js"

export interface LimiterSample {
  readonly tScrape: Date
  readonly inflight: number
}

export interface EvaluateInputs {
  /** Map of sipp Call-ID to outcome (parsed from sipp msg.log.gz). */
  readonly outcomes: ReadonlyMap<string, CallOutcome>
  readonly limiter: ReadonlyArray<LimiterSample>
  /** Names of sipp Jobs in the run, used to match stream substrings. */
  readonly streamJobNames: ReadonlyArray<string>
}

export interface ChaosEventForEval {
  readonly type: ChaosEventType
  readonly tFire: Date
  readonly tRecovered: Date
}

export type RuleStatus = "pass" | "fail" | "warn" | "no-data"

export interface RuleResult {
  readonly description: string
  readonly status: RuleStatus
  /** Default-applied severity for this rule (echo of the catalog). */
  readonly severity: "fail" | "warn"
  readonly metric: ImpactMetric
  readonly bound: ImpactBound
  readonly observedValue: number | undefined
  /** Population size the metric was computed over (calls / samples). */
  readonly sampleSize: number
  readonly windowStart: string
  readonly windowEnd: string
  /** "no-data" reason, or an explanation when status === "warn". */
  readonly note?: string
}

export interface EventEvalResult {
  readonly eventIndex: number
  readonly type: ChaosEventType
  readonly hasSpec: boolean
  readonly rules: ReadonlyArray<RuleResult>
}

const defaultSeverity = (rule: ImpactRule): "fail" | "warn" =>
  rule.severity ?? "fail"

export const evaluateEvent = (
  eventIndex: number,
  event: ChaosEventForEval,
  inputs: EvaluateInputs,
): EventEvalResult => {
  const spec: ExpectedImpact | undefined = EXPECTED_IMPACT[event.type]
  if (spec === undefined || spec.rules.length === 0) {
    return {
      eventIndex,
      type: event.type,
      hasSpec: false,
      rules: [],
    }
  }
  const rules: Array<RuleResult> = []
  for (const rule of spec.rules) {
    rules.push(evaluateRule(rule, event, inputs))
  }
  return { eventIndex, type: event.type, hasSpec: true, rules }
}

const evaluateRule = (
  rule: ImpactRule,
  event: ChaosEventForEval,
  inputs: EvaluateInputs,
): RuleResult => {
  const anchorMs =
    rule.window.anchor === "tFire"
      ? event.tFire.getTime()
      : event.tRecovered.getTime()
  const windowStart = anchorMs + rule.window.startOffsetMs
  const windowEnd = windowStart + rule.window.durationMs
  const observed = computeMetric(rule.metric, windowStart, windowEnd, inputs)
  const status = applyBound(observed.value, rule.bound, defaultSeverity(rule), observed.sampleSize)
  return {
    description: rule.description,
    status: status.status,
    severity: defaultSeverity(rule),
    metric: rule.metric,
    bound: rule.bound,
    observedValue: observed.value,
    sampleSize: observed.sampleSize,
    windowStart: new Date(windowStart).toISOString(),
    windowEnd: new Date(windowEnd).toISOString(),
    ...(status.note !== undefined && { note: status.note }),
  }
}

interface MetricOutput {
  readonly value: number | undefined
  readonly sampleSize: number
}

const computeMetric = (
  metric: ImpactMetric,
  windowStart: number,
  windowEnd: number,
  inputs: EvaluateInputs,
): MetricOutput => {
  switch (metric.kind) {
    case "failureRate":
      return computeFailureRate(
        metric.stream,
        metric.codes,
        metric.codesExclude,
        windowStart,
        windowEnd,
        inputs,
        false,
      )
    case "midDialogFailureRate":
      return computeFailureRate(
        metric.stream,
        metric.codes,
        metric.codesExclude,
        windowStart,
        windowEnd,
        inputs,
        true,
      )
    case "stream503Rate":
      return computeFailureRate(
        metric.stream,
        [503],
        undefined,
        windowStart,
        windowEnd,
        inputs,
        false,
      )
    case "limiterInflight":
      return computeLimiterInflight(windowStart, windowEnd, inputs)
    case "concurrentCalls":
      return computeConcurrentCalls(
        metric.stream,
        metric.assumedHoldMs ?? 10_000,
        windowStart,
        windowEnd,
        inputs,
      )
  }
}

const matchesStream = (callId: string, stream: string): boolean =>
  callId.includes(stream)

const isSuccess = (o: CallOutcome): boolean =>
  o.outcome === "clean" || o.outcome === "retransmitted"

const computeFailureRate = (
  stream: string,
  codes: ReadonlyArray<number> | undefined,
  codesExclude: ReadonlyArray<number> | undefined,
  windowStart: number,
  windowEnd: number,
  inputs: EvaluateInputs,
  midDialogOnly: boolean,
): MetricOutput => {
  let total = 0
  let failures = 0
  for (const [callId, outcome] of inputs.outcomes) {
    if (!matchesStream(callId, stream)) continue
    const tInvite = outcome.tFirstInvite?.getTime()
    const tAck = outcome.tAck?.getTime()
    if (tInvite === undefined) continue
    // For mid-dialog: the call established (tAck present) AND the
    // failure/end happened in the window. We approximate "end happened
    // in window" by "tFirstInvite < windowStart AND tAck ≤ windowEnd".
    // For initial: tFirstInvite must be in the window.
    if (midDialogOnly) {
      if (tAck === undefined) continue
      if (tInvite >= windowStart) continue
      if (tAck > windowEnd) continue
    } else {
      if (tInvite < windowStart || tInvite > windowEnd) continue
    }
    total += 1
    if (isSuccess(outcome)) continue
    if (codes !== undefined && codes.length > 0) {
      if (outcome.lastResponse === undefined) continue
      if (!codes.includes(outcome.lastResponse)) continue
    }
    if (codesExclude !== undefined && codesExclude.length > 0) {
      // A failure with `lastResponse` in `codesExclude` is treated as
      // baseline noise and not counted. A failure with no
      // `lastResponse` (e.g. timeout / never reached the SUT) is the
      // chaos signal we want to keep — counted.
      if (
        outcome.lastResponse !== undefined &&
        codesExclude.includes(outcome.lastResponse)
      ) {
        continue
      }
    }
    failures += 1
  }
  if (total === 0) return { value: undefined, sampleSize: 0 }
  return { value: failures / total, sampleSize: total }
}

const computeLimiterInflight = (
  windowStart: number,
  windowEnd: number,
  inputs: EvaluateInputs,
): MetricOutput => {
  let max = 0
  let count = 0
  for (const s of inputs.limiter) {
    const t = s.tScrape.getTime()
    if (t < windowStart || t > windowEnd) continue
    count += 1
    if (s.inflight > max) max = s.inflight
  }
  if (count === 0) return { value: undefined, sampleSize: 0 }
  return { value: max, sampleSize: count }
}

const computeConcurrentCalls = (
  stream: string,
  assumedHoldMs: number,
  windowStart: number,
  windowEnd: number,
  inputs: EvaluateInputs,
): MetricOutput => {
  // Concurrent gauge sampled at the window midpoint. A call is "in
  // flight" at time t iff tFirstInvite ≤ t ≤ tEnd, where tEnd is
  // approximated as tAck + assumedHoldMs (with a small grace for BYE
  // transit). Calls that never established (no tAck) are excluded.
  const sampleTime = windowStart + Math.floor((windowEnd - windowStart) / 2)
  let active = 0
  let considered = 0
  for (const [callId, outcome] of inputs.outcomes) {
    if (!matchesStream(callId, stream)) continue
    const tInvite = outcome.tFirstInvite?.getTime()
    const tAck = outcome.tAck?.getTime()
    if (tInvite === undefined || tAck === undefined) continue
    considered += 1
    const tEnd = tAck + assumedHoldMs + 500
    if (tInvite <= sampleTime && sampleTime <= tEnd) {
      active += 1
    }
  }
  return { value: active, sampleSize: considered }
}

interface BoundResult {
  readonly status: RuleStatus
  readonly note?: string
}

const applyBound = (
  observed: number | undefined,
  bound: ImpactBound,
  severity: "fail" | "warn",
  sampleSize: number,
): BoundResult => {
  if (observed === undefined) {
    return {
      status: "no-data",
      note: `no samples in window (sampleSize=${sampleSize})`,
    }
  }
  const passes = checkBound(observed, bound)
  if (passes) return { status: "pass" }
  return { status: severity }
}

const checkBound = (value: number, bound: ImpactBound): boolean => {
  switch (bound.kind) {
    case "lessThan":
      return value < bound.value
    case "greaterThan":
      return value > bound.value
    case "around":
      return Math.abs(value - bound.target) <= bound.tolerance
  }
}

/* ------------------------------------------------------------------ */
/* Aggregate verdict                                                   */
/* ------------------------------------------------------------------ */

export type RunOutcomeKind = "PASS" | "WARN" | "FAIL"

export interface ImpactAggregate {
  readonly outcome: RunOutcomeKind
  readonly events: ReadonlyArray<EventEvalResult>
  readonly counts: {
    readonly pass: number
    readonly warn: number
    readonly fail: number
    readonly noData: number
    /** Events fired whose ExpectedImpact spec is still a TODO stub. */
    readonly eventsWithoutSpec: number
  }
}

export const aggregateImpact = (
  events: ReadonlyArray<EventEvalResult>,
): ImpactAggregate => {
  let pass = 0
  let warn = 0
  let fail = 0
  let noData = 0
  let eventsWithoutSpec = 0
  for (const e of events) {
    if (!e.hasSpec) eventsWithoutSpec += 1
    for (const r of e.rules) {
      if (r.status === "pass") pass += 1
      else if (r.status === "warn") warn += 1
      else if (r.status === "fail") fail += 1
      else if (r.status === "no-data") noData += 1
    }
  }
  const outcome: RunOutcomeKind =
    fail > 0 ? "FAIL" : warn > 0 || eventsWithoutSpec > 0 ? "WARN" : "PASS"
  return {
    outcome,
    events,
    counts: { pass, warn, fail, noData, eventsWithoutSpec },
  }
}
