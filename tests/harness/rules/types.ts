/**
 * Rule and RuleEngine — post-hoc verification over CallRecording[].
 *
 * Per Q3: three rule packages with a unified Rule interface (rfc /
 * call-shape / service-case / cross-call). Per Q13: findings are binary
 * pass/fail per rule.
 */

import type { CallRecording } from "../recording.js"
import type { ServiceCase } from "../service-case/types.js"

export type RuleFamily = "rfc" | "call-shape" | "service-case" | "cross-call"

/** A failure detail (a single message-or-marker concretization of a rule miss). */
export interface RuleViolation {
  readonly message: string
  /** Index into recording.entries, when applicable. */
  readonly entryIndex?: number
  /** Free-form structured details for reporters. */
  readonly details?: Readonly<Record<string, unknown>>
}

/** A finding emitted by a single rule against a single recording. */
export interface RuleFinding {
  readonly ruleName: string
  readonly family: RuleFamily
  /** Pass = no violations; fail = at least one. */
  readonly status: "pass" | "fail"
  readonly violations: ReadonlyArray<RuleViolation>
  /** scenarioId × callId scoping (for cross-call rules, callId may be ""). */
  readonly scenarioId: string
  readonly callId: string
  readonly serviceCaseId: string | null
}

/** Rule context — everything a rule may inspect. */
export interface RuleCtx {
  readonly recording: CallRecording
  /** ServiceCase paired with this recording (null if none). */
  readonly serviceCase: ServiceCase | null
}

/** A single-recording rule (RFC / call-shape / service-case). */
export interface PerCallRule {
  readonly name: string
  readonly family: Exclude<RuleFamily, "cross-call">
  readonly description?: string
  /** Returns violations; empty = pass. */
  evaluate(ctx: RuleCtx): ReadonlyArray<RuleViolation>
}

/** Cross-call evaluation context — all recordings + the paired ServiceCase. */
export interface CrossCallCtx {
  readonly recordings: ReadonlyArray<CallRecording>
  readonly serviceCase: ServiceCase | null
}

/** A multi-recording aggregator rule. */
export interface CrossCallRule {
  readonly name: string
  readonly family: "cross-call"
  readonly description?: string
  evaluate(ctx: CrossCallCtx): ReadonlyArray<RuleViolation>
}

export type Rule = PerCallRule | CrossCallRule

/** Aggregated rule run output for a scenario × ServiceCase. */
export interface RuleEngineResult {
  readonly findings: ReadonlyArray<RuleFinding>
  /** True iff every per-call & cross-call rule passed (after escape hatches). */
  readonly passed: boolean
}

export interface RuleEngineOpts {
  /** Rule names to skip globally for this run. */
  readonly disableRules?: ReadonlyArray<string>
  /** Rule names that MUST violate; passing such a rule becomes a failure. */
  readonly expectViolations?: ReadonlyArray<string>
}

export class RuleEngine {
  private readonly perCall: ReadonlyArray<PerCallRule>
  private readonly crossCall: ReadonlyArray<CrossCallRule>

  constructor(rules: ReadonlyArray<Rule>) {
    const per: PerCallRule[] = []
    const cross: CrossCallRule[] = []
    for (const r of rules) {
      if (r.family === "cross-call") cross.push(r as CrossCallRule)
      else per.push(r as PerCallRule)
    }
    this.perCall = per
    this.crossCall = cross
  }

  run(
    recordings: ReadonlyArray<CallRecording>,
    serviceCase: ServiceCase | null,
    opts: RuleEngineOpts = {}
  ): RuleEngineResult {
    const disabled = new Set(opts.disableRules ?? [])
    const expected = new Set(opts.expectViolations ?? [])
    const findings: RuleFinding[] = []

    for (const rec of recordings) {
      for (const rule of this.perCall) {
        if (disabled.has(rule.name)) continue
        const violations = rule.evaluate({ recording: rec, serviceCase })
        const rawStatus: "pass" | "fail" = violations.length === 0 ? "pass" : "fail"
        const status = applyExpected(rule.name, rawStatus, expected)
        findings.push({
          ruleName: rule.name,
          family: rule.family,
          status,
          violations,
          scenarioId: rec.scenarioId,
          callId: rec.callId,
          serviceCaseId: rec.serviceCaseId,
        })
      }
    }

    if (recordings.length > 0) {
      const scenarioId = recordings[0]!.scenarioId
      const serviceCaseId = recordings[0]!.serviceCaseId
      for (const rule of this.crossCall) {
        if (disabled.has(rule.name)) continue
        const violations = rule.evaluate({ recordings, serviceCase })
        const rawStatus: "pass" | "fail" = violations.length === 0 ? "pass" : "fail"
        const status = applyExpected(rule.name, rawStatus, expected)
        findings.push({
          ruleName: rule.name,
          family: rule.family,
          status,
          violations,
          scenarioId,
          callId: "",
          serviceCaseId,
        })
      }
    }

    return {
      findings,
      passed: findings.every((f) => f.status === "pass"),
    }
  }
}

function applyExpected(
  name: string,
  raw: "pass" | "fail",
  expected: ReadonlySet<string>
): "pass" | "fail" {
  if (!expected.has(name)) return raw
  // Inverted: a rule we EXPECT to violate must violate. If it passed, that's the failure.
  return raw === "fail" ? "pass" : "fail"
}
