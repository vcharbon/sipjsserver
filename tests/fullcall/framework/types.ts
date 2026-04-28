/**
 * AST types for the SIP E2E test framework.
 *
 * The scenario DSL builds a Step[] array (the AST), which is then
 * consumed by pluggable backends (simulated, live UDP, SIPp export).
 */

import type { Effect, Layer, Scope } from "effect"
import { Data } from "effect"
import type { SipHeader, SipMessage } from "../../../src/sip/types.js"
import type { NetworkTraceEntry } from "../../../src/sip/SignalingNetwork.js"
import type { ValidationCheckName, ValidationOverrides } from "./validation.js"

// ---------------------------------------------------------------------------
// Transport-level errors
// ---------------------------------------------------------------------------

export class TransportError extends Data.TaggedError("TransportError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * A packet received by a test agent from the B2BUA (simulated or live backend).
 *
 * `arrivalMs` is stamped at ingress inside `SignalingNetwork` — i.e. the
 * wall-clock (`Clock.currentTimeMillis`) instant the packet was observed,
 * before it landed on the endpoint queue. Under TestClock this is virtual
 * time. Structurally compatible with `UdpPacket` so backends can return
 * endpoint packets directly.
 */
export interface ReceivedPacket {
  readonly raw: Buffer
  readonly rinfo: { readonly address: string; readonly port: number }
  readonly arrivalMs: number
}

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
  /** Skip specific validation checks for this send step. */
  readonly skipValidation?: readonly ValidationCheckName[]
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
// Network tag (slice 1 of REGISTER + double-stack proxy)
// ---------------------------------------------------------------------------

/**
 * Identifies which signalling fabric a participant lives on.
 *
 *   - `"ext"`  — endpoint-facing fabric (Alice / Bob and the legacy
 *                K8s-LB front-proxy ingress all live here).
 *   - `"core"` — K8s-server-facing fabric used by the registrar proxy
 *                slice 2 introduces. Slice 1 plumbs the type through
 *                every layer; no production scenario uses `"core"` yet.
 *
 * Defaulted everywhere to `"ext"` so existing scenarios stay byte-
 * identical until they explicitly opt in.
 */
export type NetworkTag = "ext" | "core"

export const DEFAULT_NETWORK: NetworkTag = "ext"

/** Participant entry in `ScenarioResult.participants` — name + network. */
export interface Participant {
  readonly name: string
  readonly network: NetworkTag
}

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

export interface AgentConfig {
  readonly uri: string
  readonly port?: number
  readonly sutTarget?: SutTarget
  /**
   * Bind IP for this agent. Defaults to 127.0.0.1. Only supported by the
   * simulated backend, where the `SignalingNetwork` fabric routes purely by
   * `dstIp:dstPort` so tests can pin different agents to distinct fake IPs
   * (e.g. 10.0.0.1, 10.0.0.2).
   */
  readonly ip?: string
  /**
   * Hybrid-runner override: IP to advertise in this agent's Contact / Via /
   * From URIs without changing the actual bind address. Used by the
   * register-fakeExt-realCore harness so an agent can bind on the host
   * (e.g. 0.0.0.0) but advertise a host-reachable IP that pods inside
   * a kind cluster can route back to (the docker bridge gateway, or
   * host.docker.internal). Undefined → use the bound IP unchanged.
   */
  readonly advertisedIp?: string
  /**
   * Pre-assigned `Call-ID` for this agent's first outbound dialog. Used
   * by HA scenarios that need to deterministically steer a call to a
   * specific worker via the proxy's HRW Call-ID hash. When omitted the
   * framework auto-generates a random Call-ID (existing behavior).
   */
  readonly callId?: string
  /**
   * Which signalling fabric this agent binds on. Defaults to `"ext"` so
   * every existing scenario runs unchanged. Slice 2 of the REGISTER +
   * double-stack proxy work wires `"core"` end-to-end; slice 1 only
   * exposes the type through the harness so the API and trace shape
   * are stable when slice 2 lands.
   */
  readonly network?: NetworkTag
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

/**
 * Scenario duration tier — budgets the real wall-clock time the scenario
 * is expected to take on the live backend. Fake-clock runs ignore this
 * (virtual time). Drives the `test:live:{short,medium,long}` npm scripts.
 *
 *   short  (default)  ≤ 2s    happy path, basic signaling, BYE. No retransmit reliance.
 *   medium            ≤ 30s   first INVITE retransmit (T1=500ms), Timer E/F, one limiter window.
 *   long              > 30s   Timer B/H (32s), noAnswerTimeoutSec, keepalive timeout.
 */
export type ScenarioTier = "short" | "medium" | "long"

/**
 * SUT topologies the matrix-driven runner can exercise.
 *
 *   - `b2bonly`              — single B2BUA, no proxy.
 *   - `proxy+b2b`            — `ProxyCore` in front of one B2BUA worker.
 *   - `sipproxyHA`           — `ProxyCore` in front of TWO B2BUA workers,
 *                              with `HealthProbe` wired so workers admit
 *                              as `unknown` and transition to `alive`
 *                              after the first OPTIONS round-trip. Used
 *                              for HA / takeover scenarios.
 *   - `registrarFrontProxy`  — `ProxyCore` in registrar mode (dual ext +
 *                              core endpoints, in-memory `Registrar`,
 *                              `inMemoryRegistrar` + `registrarLookup`
 *                              strategies). No B2BUA. Slice 3 of the
 *                              REGISTER + double-stack work; scenarios
 *                              opt in via `.runOn(["registrarFrontProxy"])`.
 *
 * `ALL_SUTS` is the full matrix iterated by `e2e-fake-clock.test.ts`.
 * `DEFAULT_APPLICABLE_SUTS` is what a scenario opts into by default
 * when no explicit `.runOn(...)` is supplied — sipproxyHA and
 * registrarFrontProxy are excluded because legacy scenarios hardcode
 * the loopback ingress address (and registrarFrontProxy doesn't run a
 * B2BUA at all). Topology-specific scenarios opt in via
 * `.runOn([...])`.
 */
export type Sut = "b2bonly" | "proxy+b2b" | "sipproxyHA" | "registrarFrontProxy"

export const ALL_SUTS: readonly Sut[] = [
  "b2bonly",
  "proxy+b2b",
  "sipproxyHA",
  "registrarFrontProxy",
]

export const DEFAULT_APPLICABLE_SUTS: readonly Sut[] = ["b2bonly", "proxy+b2b"]

export interface Scenario {
  readonly name: string
  readonly agents: Record<string, AgentConfig>
  readonly steps: readonly Step[]
  readonly sippCompliant: boolean
  readonly allowedExtras?: readonly AllowedExtraPattern[] | undefined
  /**
   * Human-readable description of what the scenario simulates.
   * Emitted at the top of the generated text reports so a reviewer reading
   * a .global.txt or per-agent .txt file can understand the intent of the
   * test — particularly useful for scenarios that deliberately simulate
   * misbehaving agents (retransmissions, bad tags, stalled HTTP, ...).
   */
  readonly description?: string | undefined
  /** Duration tier — defaults to "short" when omitted. */
  readonly tier?: ScenarioTier | undefined
  /**
   * Which SUT topologies this scenario applies to. Defaults to both
   * (`b2bonly` and `proxy+b2b`). Scenarios that codify behavior only
   * meaningful under one topology (e.g. asserting absence of proxy-
   * inserted Record-Route on a bare B2BUA) narrow this list via the
   * DSL's `.runOn(...)` builder.
   */
  readonly runOn?: readonly Sut[] | undefined
  /**
   * Opt out of the end-of-scenario 24h TestClock sweep and the
   * subsequent `verifyCleanState` check. Use for scenarios that
   * deliberately leave CallState/TimerService dirty (e.g. a test that
   * simulates a caller walking away mid-dialog with no BYE).
   *
   * A scenario that simply forgot to send BYE should add `.bye()`
   * instead — that's the default path. This flag exists for genuine
   * "not our job to clean up" shapes.
   */
  readonly skipFinalSweep?: boolean | undefined
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
  /**
   * Primary timestamp used for ordering/display. For send entries this is
   * the sender's clock when the agent queued the packet; for receive entries
   * this is the arrival time stamped at the receiver's queue. Preserved for
   * callers that want a single scalar clock.
   */
  readonly timestamp: number
  /** Virtual-clock instant the sender placed the packet on the wire. */
  readonly sentMs: number
  /** Virtual-clock instant the receiver observed the packet. */
  readonly receivedMs: number
  readonly from: string
  readonly to: string
  /**
   * Optional wire-level addresses corresponding to `from` / `to`. Carried
   * separately so the rule engine can key on the bare name (`from`) while
   * the renderer can show `name (ip:port)` to disambiguate look-alike
   * names (e.g. proxy-ext vs proxy-core both labelled "proxy" by the
   * transport's `participantLabel`). Undefined when the originator is a
   * test agent (whose name is already address-disambiguated by port).
   */
  readonly fromAddr?: { readonly ip: string; readonly port: number }
  readonly toAddr?: { readonly ip: string; readonly port: number }
  readonly direction: "send" | "receive"
  readonly stepIndex: number
  readonly status: TraceStatus
  readonly message: SipMessage
  readonly durationMs?: number
  /**
   * Which signalling fabric carried this packet. Both endpoints of a
   * single hop always share a fabric, so a single tag suffices. Slice 1
   * stamps every entry with `"ext"` (only fabric in use); slice 2 uses
   * `"core"` for traffic on the K8s-facing side.
   */
  readonly network: NetworkTag
}

export interface ScenarioResult {
  readonly scenarioName: string
  readonly scenarioDescription?: string | undefined
  readonly stepResults: readonly StepResult[]
  readonly trace: readonly TraceEntry[]
  /**
   * Ordered participant list for the sequence-diagram lifelines. Each
   * entry carries its `network` so the HTML renderer can group / colour
   * lanes by fabric. Order is "first appearance in the trace" so the
   * SVG lays out columns in the order the conversation flows.
   */
  readonly participants: ReadonlyArray<Participant>
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
  /**
   * Optional layer to provide around the whole scenario (fake backend only).
   * Applied at the outer scope so layer-scoped resources (UdpTransport's
   * bound endpoint, forked router fibers) live for the test lifetime,
   * not just for setup's lifetime. Live backend leaves this undefined.
   */
  readonly stackLayer?: Layer.Layer<never>
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
  ) => Effect.Effect<ReceivedPacket | null, TransportError>
  /**
   * Optional: map an `(ip, port)` pair to a human-readable participant
   * label (`alice`, `bob`, `proxy`, `worker-1`, ...). Used by the report
   * renderer to label network-trace entries that originate from
   * non-agent SIP nodes (proxy, worker behind a proxy). Returns
   * `undefined` for unknown addresses; the renderer falls back to
   * `<ip>:<port>` in that case.
   */
  readonly participantLabel?: (ip: string, port: number) => string | undefined
  /**
   * Optional: map an `(ip, port)` pair to a `NetworkTag`. Returns
   * `undefined` for unknown addresses (the interpreter falls back to the
   * default network). Slice 1 only exposes `"ext"`; slice 2 lets the
   * registrar proxy expose participants on `"core"` as well.
   */
  readonly participantNetwork?: (ip: string, port: number) => NetworkTag | undefined
  /**
   * Optional: drain the simulated network's delivery trace at the end
   * of a scenario. Only implemented by the simulated backend; lets the
   * interpreter splice internal proxy↔worker hops into the trace that
   * agent-level send/receive recording would miss. Live backend
   * returns `undefined` (no tap).
   */
  readonly drainNetworkTrace?: () => Effect.Effect<ReadonlyArray<NetworkTraceEntry>>
  /**
   * Optional post-scenario verification: asserts that all internal state
   * (callsMap, limiter counters, timer fibers) is fully empty after the
   * scenario completes. Only implemented by the simulated backend.
   * Returns an array of error strings (empty = clean).
   *
   * Currently checked by the simulated backend:
   *   - `CallState.stats()` → `concurrent === 0` (no live calls leaked)
   *   - `TimerService.activeCount()` → `=== 0` (no pending timer fibers)
   *   - `SignalingNetwork.drainUndeliverable()` → `length === 0`
   *     (no packet sent to an unbound peer)
   *
   * To add a new check, push into `errors` inside the simulated-backend
   * `verifyCleanState` implementation; the interpreter will surface every
   * entry at once rather than short-circuiting on the first.
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
  readonly settle?: () => Effect.Effect<void, never, any>
  /**
   * Simulated propagation delay between an agent's wire-send and the peer's
   * observation of the packet. Used by the trace renderer to compute the
   * receiver-side timestamp for send events (and the sender-side timestamp
   * for receive events) from a single captured clock reading. Undefined on
   * the live backend, where each side's clock is stamped directly.
   */
  readonly networkDelayMs?: number
}
