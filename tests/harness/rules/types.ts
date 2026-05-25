/**
 * Rule and RuleEngine — post-hoc verification over per-call traces
 * derived from `Recorder.snapshot` plus the SipHarness channel.
 *
 * Three rule families flow through here:
 *   - call-shape  : per-call invariants over wire bytes.
 *   - service-case: per-call assertions parameterised by a ServiceCase.
 *   - cross-call  : multi-call aggregators (limiter concurrency,
 *                   Call-ID uniqueness).
 *
 * The rule engine is intentionally limited to these three families.
 * RFC-level rules moved to `SignalingNetwork.scopedAudit` (see
 * `tests/harness/rules/rfc/`); they no longer flow through here.
 *
 * Findings are binary pass/fail per rule; the runner aggregates them
 * into a single pass/fail result for the scenario.
 */

import type { SipMessage } from "../../../src/sip/types.js"
import type { ServiceCase } from "../service-case/types.js"

// ---------------------------------------------------------------------------
// Per-call trace shape (consumed by the three rule families above)
// ---------------------------------------------------------------------------

/** A SIP message captured at the wire boundary (sent or received). */
export interface RuleTraceMessage {
  readonly kind: "message"
  readonly direction: "sent" | "received"
  readonly from: string
  readonly to: string
  readonly label?: string
  readonly sentMs: number
  readonly receivedMs: number
  /** Verbatim wire bytes — rule predicates read this directly. */
  readonly raw: string
  /** Set by the runner when a message did not match any expect step. */
  readonly unexpected?: boolean
  /** Parsed SIP, when the runner already parsed; rules re-parse on demand otherwise. */
  readonly parsed?: SipMessage
}

/** A wait-deadline that fired without a matching message. */
export interface RuleTraceTimeout {
  readonly kind: "timeout"
  readonly agent: string
  readonly waitingFor: string
  readonly atMs: number
  readonly label?: string
}

/** Free-form driver-emitted marker (call-end, scenario-phase, etc.). */
export interface RuleTraceMarker {
  readonly kind: "marker"
  readonly atMs: number
  readonly label: string
  readonly note?: string
}

export type RuleTraceEntry = RuleTraceMessage | RuleTraceTimeout | RuleTraceMarker

/** Per-call trace (one per logical Call-ID). */
export interface RuleTrace {
  readonly scenarioId: string
  readonly serviceCaseId: string | null
  readonly callId: string
  readonly startMs: number
  readonly entries: ReadonlyArray<RuleTraceEntry>
}

// ---------------------------------------------------------------------------
// Rule shapes
// ---------------------------------------------------------------------------

export type RuleFamily = "call-shape" | "service-case" | "cross-call"

export interface RuleViolation {
  readonly message: string
  readonly entryIndex?: number
  readonly details?: Readonly<Record<string, unknown>>
}

export interface RuleFinding {
  readonly ruleName: string
  readonly family: RuleFamily
  readonly status: "pass" | "fail"
  readonly violations: ReadonlyArray<RuleViolation>
  readonly scenarioId: string
  readonly callId: string
  readonly serviceCaseId: string | null
}

export interface RuleCtx {
  readonly recording: RuleTrace
  readonly serviceCase: ServiceCase | null
}

/** A single-trace rule (call-shape / service-case). */
export interface PerCallRule {
  readonly name: string
  readonly family: Exclude<RuleFamily, "cross-call">
  readonly description?: string
  evaluate(ctx: RuleCtx): ReadonlyArray<RuleViolation>
}

export interface CrossCallCtx {
  readonly recordings: ReadonlyArray<RuleTrace>
  readonly serviceCase: ServiceCase | null
}

export interface CrossCallRule {
  readonly name: string
  readonly family: "cross-call"
  readonly description?: string
  evaluate(ctx: CrossCallCtx): ReadonlyArray<RuleViolation>
}

export type Rule = PerCallRule | CrossCallRule

export interface RuleEngineResult {
  readonly findings: ReadonlyArray<RuleFinding>
  readonly passed: boolean
}

export interface RuleEngineOpts {
  readonly disableRules?: ReadonlyArray<string>
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
    recordings: ReadonlyArray<RuleTrace>,
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
  return raw === "fail" ? "pass" : "fail"
}
