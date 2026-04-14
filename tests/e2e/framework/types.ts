/**
 * AST types for the SIP E2E test framework.
 *
 * The scenario DSL builds a Step[] array (the AST), which is then
 * consumed by pluggable backends (simulated, live UDP, SIPp export).
 */

import type { Effect, Scope } from "effect"
import { Data } from "effect"
import type { SipHeader, SipMessage } from "../../../src/sip/types.js"
import type { ValidationCheckName, ValidationOverrides } from "./validation.js"

// ---------------------------------------------------------------------------
// Transport-level errors
// ---------------------------------------------------------------------------

export class TransportError extends Data.TaggedError("TransportError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

// ---------------------------------------------------------------------------
// Step references
// ---------------------------------------------------------------------------

/** Opaque handle returned by expect/send for cross-step references. */
export interface StepRef {
  readonly _tag: "StepRef"
  readonly id: number
}

/** Extended handle returned by expect() — adds `.reply()` for explicit response-to-request binding. */
export interface ExpectRef extends StepRef {
  reply(
    statusCode: number,
    opts?: {
      reason?: string
      delay?: number
      overrides?: HeaderOverrides
      build?: (ctx: MessageContext) => HeaderOverrides
      body?: Uint8Array
    }
  ): StepRef
}

let nextStepRefId = 0
export function makeStepRef(): StepRef {
  return { _tag: "StepRef", id: nextStepRefId++ }
}

/** Reset the ID counter (call between scenario recordings). */
export function resetStepRefIds(): void {
  nextStepRefId = 0
}

// ---------------------------------------------------------------------------
// Message context (available inside build() callbacks)
// ---------------------------------------------------------------------------

export interface AgentInfo {
  readonly contact: string
  readonly uri: string
  readonly ip: string
  readonly port: number
}

export interface LastMessageInfo {
  readonly from: string
  readonly to: string
  readonly via: string[]
  readonly cseq: number
  readonly cseqMethod: string
  readonly callId: string
  readonly method?: string
  readonly statusCode?: number
  readonly headers: ReadonlyArray<SipHeader>
  readonly body: Uint8Array
}

export interface DialogInfo {
  readonly localTag: string
  readonly remoteTag: string
  readonly routeSet: string[]
  readonly localCSeq: number
  readonly remoteCSeq: number | undefined
  /** Remote URI from dialog establishment (RFC 3261 §12.2.1.1). */
  readonly remoteUri: string
}

export interface MessageContext {
  readonly local: AgentInfo & { readonly tag: string; readonly callId: string }
  readonly remote: { readonly ip: string; readonly port: number }
  readonly last: LastMessageInfo
  readonly dialog: DialogInfo
  readonly call: { readonly number: number; readonly branch: () => string }
  readonly agent: (name: string) => AgentInfo
}

// ---------------------------------------------------------------------------
// Header overrides
// ---------------------------------------------------------------------------

export interface HeaderOverrides {
  readonly cseq?: number
  readonly from?: string
  readonly to?: string
  readonly contact?: string
  readonly headers?: Record<string, string>
  /** Extra headers appended after defaults — supports multi-valued headers like Record-Route. */
  readonly extraHeaders?: ReadonlyArray<{ readonly name: string; readonly value: string }>
  readonly body?: Uint8Array
}

// ---------------------------------------------------------------------------
// Steps (the AST nodes)
// ---------------------------------------------------------------------------

export interface SendStep {
  readonly type: "send"
  readonly agent: string
  readonly method?: string
  readonly statusCode?: number
  readonly reason?: string
  readonly uri?: string
  readonly inResponseTo?: StepRef
  readonly delay?: number
  readonly overrides?: HeaderOverrides
  readonly build?: (ctx: MessageContext) => HeaderOverrides
  readonly ref: StepRef
  /** Parallel group index (set by parallel() composition). */
  readonly group?: number
}

export interface ExpectStep {
  readonly type: "expect"
  readonly agent: string
  readonly match: {
    readonly method?: string
    readonly statusCode?: number
    readonly predicate?: (msg: SipMessage, ctx: MessageContext) => boolean
  }
  readonly timeout?: number
  /** When true, additional messages matching this pattern are silently ignored (not flagged as unexpected). */
  readonly allowReemission?: boolean
  /** Skip specific validation checks for this step. */
  readonly skipValidation?: readonly ValidationCheckName[]
  /** Override specific validation check functions for this step. */
  readonly validation?: ValidationOverrides
  readonly ref: StepRef
  /** Parallel group index (set by parallel() composition). */
  readonly group?: number
}

export interface PauseStep {
  readonly type: "pause"
  readonly duration: number
  /** Parallel group index (set by parallel() composition). */
  readonly group?: number
}

export interface InfraStep {
  readonly type: "infra"
  readonly action: "crash" | "restart" | "partition"
  readonly target: string
  readonly ref: StepRef
  /** Parallel group index (set by parallel() composition). */
  readonly group?: number
}

export type Step = SendStep | ExpectStep | PauseStep | InfraStep

// ---------------------------------------------------------------------------
// SUT (System Under Test) target
// ---------------------------------------------------------------------------

export interface SutTarget {
  readonly name: string
  readonly host: string
  readonly port: number
}

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

export interface AgentConfig {
  readonly uri: string
  readonly port?: number
  readonly sutTarget?: SutTarget
}

// ---------------------------------------------------------------------------
// Scenario (the full AST)
// ---------------------------------------------------------------------------

/** Pattern for messages that may arrive but should not be flagged as unexpected. */
export interface AllowedExtraPattern {
  readonly agent: string
  readonly method?: string | undefined
  readonly statusCode?: number | undefined
}

export interface Scenario {
  readonly name: string
  readonly agents: Record<string, AgentConfig>
  readonly steps: readonly Step[]
  readonly sippCompliant: boolean
  readonly allowedExtras?: readonly AllowedExtraPattern[] | undefined
}

// ---------------------------------------------------------------------------
// Or-branch wrapper
// ---------------------------------------------------------------------------

export interface OrBranch {
  readonly name: string
  readonly steps: readonly Step[]
}

// ---------------------------------------------------------------------------
// Execution results
// ---------------------------------------------------------------------------

export type StepStatus = "pass" | "fail" | "skip"
export type TraceStatus = StepStatus | "unexpected"

export interface StepResult {
  readonly stepIndex: number
  readonly step: Step
  readonly status: StepStatus
  readonly durationMs?: number
  readonly error?: string
  readonly dependsOn?: number
  readonly assertionErrors?: string[]
}

export interface TraceEntry {
  readonly timestamp: number
  readonly from: string
  readonly to: string
  readonly direction: "send" | "receive"
  readonly stepIndex: number
  readonly status: TraceStatus
  readonly message: SipMessage
  readonly durationMs?: number
}

export interface ScenarioResult {
  readonly scenarioName: string
  readonly stepResults: readonly StepResult[]
  readonly trace: readonly TraceEntry[]
  readonly participants: readonly string[]
  readonly passed: number
  readonly failed: number
  readonly skipped: number
}

// ---------------------------------------------------------------------------
// Backend transport interface
// ---------------------------------------------------------------------------

/**
 * Effect-based transport interface.
 *
 * - `setup` is a Scoped effect: any forked fibers (B2BUA, HTTP server)
 *   live for the duration of the surrounding scope and are cleaned up
 *   automatically when the scope closes — there's no separate teardown.
 * - `receive` returns the next packet for the agent within `timeoutMs`.
 *   Pass `timeoutMs === 0` for a non-blocking poll (used by the drain
 *   phase): under TestClock, blocking sleeps never fire on their own,
 *   so the drain MUST use the non-blocking variant.
 */
export interface TestTransport {
  readonly setup: (
    agents: Record<string, AgentConfig>,
    b2buaTarget: { host: string; port: number }
  ) => Effect.Effect<Record<string, AgentInfo>, TransportError, Scope.Scope>
  readonly send: (
    agentName: string,
    buf: Buffer,
    port: number,
    address: string
  ) => Effect.Effect<void, TransportError>
  readonly receive: (
    agentName: string,
    timeoutMs: number
  ) => Effect.Effect<{ raw: Buffer; rinfo: { address: string; port: number } } | null, TransportError>
  /**
   * Optional post-scenario verification: asserts that all internal state
   * (callsMap, limiter counters, timer fibers) is fully empty after the
   * scenario completes. Only implemented by the simulated backend.
   * Returns an array of error strings (empty = clean).
   */
  readonly verifyCleanState?: () => Effect.Effect<string[]>
  /**
   * Optional settle hook: yields the fiber scheduler repeatedly to let
   * any queued work drain before a check-for-unexpected-messages sweep.
   *
   * Required for deterministic detection of forgotten `allowExtra("ACK")`
   * assertions — without a settle period, tests that end before the
   * TransactionLayer has queued its auto-ACK (for non-2xx final responses)
   * would silently pass.
   */
  readonly settle?: () => Effect.Effect<void>
}
