/**
 * AST types for the SIP E2E test framework.
 *
 * The scenario DSL builds a Step[] array (the AST), which is then
 * consumed by pluggable backends (simulated, live UDP, SIPp export).
 */

import type { Effect, Layer, Scope } from "effect"
import { Data } from "effect"
import type { SipHeader, SipMessage } from "../../sip/types.js"
import type { NetworkTraceEntry, NetworkTraceSequencer } from "../../sip/SignalingNetwork.js"
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

// ---------------------------------------------------------------------------
// K8s cluster steps (slice 3b — failover harness DSL extensions)
// ---------------------------------------------------------------------------

/**
 * Per-phase timing knobs for `K8sStep.kill`. Mirrors `KillTiming` in
 * [tests/support/SimulatedK8sCluster.ts](../../support/SimulatedK8sCluster.ts) — duplicated
 * here so the framework AST stays free of cluster-specific imports.
 */
export interface K8sKillTiming {
  readonly drainHoldMs?: number
  readonly disconnectGapMs?: number
  readonly fabricKillDelayMs?: number
}

export type K8sKillPhase = "drain" | "disconnect" | "registry" | "fabric"

export type K8sPartitionDirection = "from-to" | "to-from" | "both"

export type K8sStepAction =
  | { readonly kind: "kill"; readonly workerId: string; readonly timing?: K8sKillTiming }
  | {
      readonly kind: "respawn"
      readonly workerId: string
      /**
       * When true, simulate §11.1 of `docs/replication/call-cache-backup.md`:
       * the worker process restarts but its sidecar Redis content is
       * preserved (`pri:{self}:` keys survive). When omitted/false, the
       * sidecar is wiped (§11.2).
       */
      readonly preserveStorage?: boolean
    }
  | { readonly kind: "disconnect"; readonly workerId: string }
  | { readonly kind: "reconnect"; readonly workerId: string }
  | {
      readonly kind: "partition"
      readonly from: string
      readonly to: string
      readonly direction: K8sPartitionDirection
    }
  | { readonly kind: "heal"; readonly a: string; readonly b: string }
  | {
      readonly kind: "expectReplicatedTo"
      readonly workerId: string
      readonly primary: string
      readonly callRef?: string
    }
  | {
      readonly kind: "expectCallStateOn"
      readonly workerId: string
      readonly partition: "pri" | "bak"
      readonly owner: string
      readonly callRef?: string
      readonly present?: boolean
    }
  | {
      readonly kind: "expectKillPhase"
      readonly workerId: string
      readonly phase: K8sKillPhase
      readonly minAtMs?: number
      readonly maxAtMs?: number
    }
  | {
      /**
       * Assert that, since the previous baseline (auto-snapshotted at
       * scenario start or at the prior `expectRoutedTo` call), the proxy
       * recorded at least `minCount` (default 1) routing decisions of
       * the given kind that hit `workerId`.
       *
       * Backed by `sipfp_decode_forward_promoted_total` and
       * `sip_routing_decision_total` snapshots. The `decision` field
       * narrows the kind being asserted.
       */
      readonly kind: "expectRoutedTo"
      readonly workerId: string
      readonly decision: K8sRoutingDecisionKind
      readonly minCount?: number
    }
  | {
      /**
       * Slice B′ — replication-gap diagnostic. For every ordered pair
       * (producer, consumer) where producer != consumer, assert
       * consumer-side `replpos:{producer}.lastSeq` ≥ producer-side
       * `propagate_seq:{consumer}` head. Equivalent to "lag_seq == 0
       * on every directed edge of the worker graph". Inspects
       * `PeerFabricControl.snapshotPeer` directly so the assertion
       * doesn't require a wired `ReplMetrics` service in the fake
       * stack.
       *
       * `peers` lists every workerId participating in the assertion.
       * The interpreter expands this into N×(N-1) directed pairs.
       */
      readonly kind: "expectLagSeqZero"
      readonly peers: ReadonlyArray<string>
    }
  | {
      /**
       * Assert that worker `workerId`'s sidecar holds the
       * SIP-derived index `idx:leg:{callId}|{tag}`. Used to verify
       * replication delivered the index alongside the call body —
       * the missing storage-side index is what drove production's
       * `decode_forward_backup → 481` storm. `tag` may be omitted
       * when the test does not pin the From-tag (random-generated
       * by the framework); the assertion then matches any tag.
       */
      readonly kind: "expectIndexOnBackup"
      readonly workerId: string
      readonly callId: string
      readonly tag?: string
      readonly present?: boolean
    }
  | {
      /**
       * Assert the cluster-shared CallLimiter holds `expected`
       * inflight count for `limiterId`, summed across the active
       * windows the same way `CallLimiter.checkAndIncrement` reads.
       * Direct introspection of the shared MutableHashMap.
       */
      readonly kind: "expectLimiterCount"
      readonly limiterId: string
      readonly expected: number
    }

/**
 * Routing-decision kinds the failover matrix asserts on. Mirrors the
 * proxy-side `RoutingDecisionKind` enum but kept here so the framework
 * AST stays free of cross-package imports.
 */
export type K8sRoutingDecisionKind =
  | "select_new"
  | "decode_forward"
  | "decode_forward_backup"
  | "decode_reject"
  | "decode_unknown"
  | "cancel_lookup_hit"
  | "cancel_lookup_miss"

/**
 * Cluster lifecycle / assertion step. Dispatched by the interpreter to
 * the `SimulatedK8sCluster` service (provided by the k8s SUT layer).
 * Skipped with a "skip" status when no cluster is in scope (so legacy
 * SUTs accept these scenarios as no-ops with a clear marker).
 */
export interface K8sStep {
  readonly type: "k8s"
  readonly action: K8sStepAction
  readonly ref: StepRef
  /** Parallel group index (set by parallel() composition). */
  readonly group?: number
}

export type Step = SendStep | ExpectStep | PauseStep | InfraStep | K8sStep

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

/**
 * Which transport stack a scenario ran on. Set at `TestTransport`
 * construction time (one per backend), surfaced on `ScenarioResult` so
 * the report renderer can show a `[FAKE NET]` / `[LIVE UDP]` /
 * `[HYBRID]` chip and tint the diagram canvas.
 *
 * `"hybrid"` is reserved for scenarios that compose both fake and live
 * fabrics in one timeline (currently only the registrar-fakeExt /
 * realCore kind harness).
 */
export type TransportKind = "fake" | "live" | "hybrid"

/**
 * Participant entry in `ScenarioResult.participants` — name + network.
 *
 * @deprecated Lane identity moved to `(ip,port)` (see `Lane`). The
 * renderer and text-report no longer read this type; it is retained on
 * `ScenarioResult` for one release so external consumers can migrate.
 * Replace any read of `participants` with `lanes` and, when you need a
 * name string, take `lane.names[0]` (or render `lane.ip:lane.port` when
 * the lane is anonymous). Scheduled for removal — see
 * `docs/external-usage/test-harness.md` § "Migrating off `participants`".
 */
export interface Participant {
  readonly name: string
  readonly network: NetworkTag
}

/**
 * Lane key — `"<ip>:<port>"` form for `MutableHashMap` / index lookups
 * keyed by wire address.
 */
export type LaneKey = string

export const laneKey = (ip: string, port: number): LaneKey => `${ip}:${port}`

/**
 * A column in the rendered sequence diagram. Identified by `(ip, port)`;
 * names are decorations attached via the recorder's `registerLane`
 * (Slice 1) or, in this slice, derived from the trace's `from`/`to`
 * name fields after the lanes are materialised from addresses.
 *
 * Multiple names on one lane → either a legitimate alias (e.g.
 * "proxy" and "proxy(ext)" share a socket) or a real data anomaly.
 * `killedAt` accumulates kill-event timestamps so the renderer can
 * paint a red dashed band on the lifeline without spawning a new
 * column.
 */
export interface Lane {
  readonly ip: string
  readonly port: number
  readonly names: ReadonlyArray<string>
  readonly network: NetworkTag
  readonly killedAt: ReadonlyArray<number>
}

/**
 * Soft warnings surfaced in a "data anomalies" panel of the report.
 * Distinct from step failures — these are recorder-data issues, not
 * test assertions. Currently emitted only by the Recorder service
 * (Slice 1); the Slice-2-light interpreter does not synthesise them
 * yet.
 */
export type RecordedAnomaly =
  | {
      readonly kind: "nameConflict"
      readonly laneKey: LaneKey
      readonly names: ReadonlyArray<string>
    }
  | {
      readonly kind: "orphanReplPod"
      readonly pod: string
    }
  | {
      readonly kind: "signalingAudit"
      readonly check: string
      readonly detail: string
      readonly bindKey?: LaneKey
      /**
       * `deferred-fail` surfaces at scope close via the wrapper's
       * `Data.TaggedError`; `advisory` is recorded silently. `fatal`
       * never makes it here — fatal violations short-circuit before
       * the anomaly is appended.
       */
      readonly severity: "deferred-fail" | "advisory"
    }
  | {
      readonly kind: "undeliverable"
      readonly src: { readonly ip: string; readonly port: number }
      readonly dst: { readonly ip: string; readonly port: number }
      readonly atMs: number
      readonly seq: number
      readonly severity: "deferred-fail" | "advisory"
    }
  | {
      readonly kind: "queueLeak"
      readonly bindKey: LaneKey
      readonly queueDepth: number
      readonly atMs: number
      readonly seq: number
      readonly severity: "deferred-fail" | "advisory"
    }
  | {
      readonly kind: "inFlightImbalance"
      readonly inFlight: number
      readonly atMs: number
      readonly seq: number
      readonly severity: "deferred-fail" | "advisory"
    }
  | {
      readonly kind: "codecPropertyViolation"
      readonly propertyId: string
      readonly detail: string
      readonly callRef?: string
      readonly severity: "fatal" | "deferred-fail" | "advisory"
    }
  | {
      readonly kind: "codecParanoidInput"
      readonly check: string
      readonly detail: string
      readonly severity: "fatal" | "deferred-fail" | "advisory"
    }
  | {
      readonly kind: "codecParity"
      readonly side: "blue-vs-input" | "green-vs-input" | "blue-vs-green"
      readonly detail: string
      readonly callRef?: string
      readonly severity: "fatal" | "deferred-fail" | "advisory"
    }
  | {
      readonly kind: "codecAudit"
      readonly check: string
      readonly detail: string
      readonly severity: "fatal" | "deferred-fail" | "advisory"
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
export type Sut =
  | "b2bonly"
  | "proxy+b2b"
  | "sipproxyHA"
  | "registrarFrontProxy"
  | "k8sFailover"

/**
 * Curated matrix of SUTs the e2e-fake-clock loop iterates. The `Sut`
 * type also includes `k8sFailover`, but that one is only consumed by
 * focused failover tests under `tests/sip-front-proxy/failover/` —
 * they construct their own runner with `sut: "k8sFailover"`. Keeping
 * it out of `ALL_SUTS` avoids spawning empty `describe` blocks on the
 * matrix-driven test files.
 */
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

/**
 * One observation in the replication-frame trace: a decoded NDJSON
 * frame the consumer worker received from the source worker over the
 * simulated `/replog` HTTP transport. Carried alongside the SIP trace
 * in `ScenarioResult.replicationTrace` and rendered as a separate
 * lane in the HTML report so cross-worker state-mutation flow is
 * visually correlated with SIP message flow.
 *
 * `frame` is left as the structural decoded object — the renderer
 * stringifies it into the click-to-inspect JSON panel without further
 * decoration.
 */
export interface ReplicationTraceEntry {
  readonly timestamp: number
  /** Source peer ordinal (the worker whose `/replog` produced the frame). */
  readonly from: string
  /** Consumer peer ordinal (the worker pulling from `from`). */
  readonly to: string
  readonly frame: unknown
  /**
   * Monotonic capture-order tiebreaker from the shared `EventSequencer`.
   * Renderers tiebreak on this when `timestamp` collides with a SIP entry
   * or another replication frame at the same ms.
   */
  readonly seq: number
}

export interface TraceEntry {
  /**
   * Primary timestamp used for ordering/display. For send entries this is
   * the sender's clock when the agent queued the packet; for receive entries
   * this is the arrival time stamped at the receiver's queue. Preserved for
   * callers that want a single scalar clock.
   */
  readonly timestamp: number
  /**
   * Monotonic capture-order tiebreaker allocated from the harness's shared
   * `EventSequencer` at recording time. Used by the renderers as the
   * secondary sort key — guarantees a deterministic ordering even when
   * two entries share the same `timestamp` ms (TestClock bursts, or
   * collisions between real and fake clocks under the hybrid stack).
   */
  readonly seq: number
  /** Virtual-clock instant the sender placed the packet on the wire. */
  readonly sentMs: number
  /** Virtual-clock instant the receiver observed the packet. */
  readonly receivedMs: number
  /**
   * @deprecated Name strings on `TraceEntry` are scheduled for removal.
   * Internal renderers now resolve names from the lane registry via
   * `fromAddr` / `toAddr`. Use `lanes` to look up a name for an
   * address (`lane.names[0]`) instead of reading this field. See
   * `docs/external-usage/test-harness.md` § "Migrating off
   * `participants`".
   */
  readonly from: string
  /** @deprecated See `TraceEntry.from`. */
  readonly to: string
  /**
   * Wire-level addresses. Required and authoritative — the renderer
   * keys lanes on `(ip,port)`, never on the deprecated `from` / `to`
   * name strings. This is the structural defense against "report
   * invents names/IPs".
   *
   * For synthesized placeholder entries (dangling-offer / dangling-PRACK
   * sentinels emitted at scenario end) the addresses are derived from
   * the agent's configured bind and SUT target so they still anchor on
   * real lanes even though no packet actually crossed the wire.
   */
  readonly fromAddr: { readonly ip: string; readonly port: number }
  readonly toAddr: { readonly ip: string; readonly port: number }
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
  /**
   * Which transport stack this scenario ran on. Copied from the
   * `TestTransport.kind` field at scenario end so the HTML renderer can
   * show the `[FAKE NET]` / `[LIVE UDP]` / `[HYBRID]` chip.
   */
  readonly transportKind: TransportKind
  readonly stepResults: readonly StepResult[]
  readonly trace: readonly TraceEntry[]
  /**
   * Replication frames captured during the scenario. Present when the
   * SUT wires the simulated `/replog` HTTP transport (currently only
   * `sipproxyHA`); empty / undefined for SUTs without replication.
   * The HTML / text reports render this as a distinct lane.
   */
  readonly replicationTrace?: readonly ReplicationTraceEntry[]
  /**
   * Ordered participant list for the sequence-diagram lifelines. Each
   * entry carries its `network` so the HTML renderer can group / colour
   * lanes by fabric. Order is "first appearance in the trace" so the
   * SVG lays out columns in the order the conversation flows.
   *
   * @deprecated Scheduled for removal. Use `lanes` instead — it is
   * keyed by `(ip,port)` and immune to name fabrication. To get a name
   * string for display, read `lane.names[0]` (may be empty for
   * anonymous lanes; fall back to `lane.ip:lane.port`). Internal
   * renderers (`html-report.ts`, `text-report.ts`) no longer read this
   * field. See `docs/external-usage/test-harness.md`
   * § "Migrating off `participants`" for grep patterns and rewrites.
   */
  readonly participants: ReadonlyArray<Participant>
  /**
   * `(ip,port)`-keyed lanes. The canonical column identity used by every
   * internal renderer; names attached to a lane decorate the lane header
   * but are never the lookup key. Ordering: by `NetworkTag` group
   * (`ext` left, `core` right), then first appearance within the group.
   */
  readonly lanes: ReadonlyArray<Lane>
  /**
   * Soft data-quality warnings (name conflicts, orphan replication
   * pods) surfaced in the report's "data anomalies" panel. Empty when
   * the recorder is not wired (Slice-2-light path).
   */
  readonly anomalies: ReadonlyArray<RecordedAnomaly>
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
   * Structural fake/live tag — set by each transport factory at
   * construction time (`"fake"` in `simulated-backend`, `"live"` in
   * `live-backend`, `"hybrid"` in `hybrid-runner`). Threaded onto
   * `ScenarioResult.transportKind` so the renderer can show a chip /
   * canvas tint without inferring from optional fields like
   * `drainNetworkTrace`.
   */
  readonly kind: TransportKind
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
   * Optional: drain the simulated replication-HTTP trace at the end of
   * the scenario. Non-empty only for SUTs that wire per-worker pullers
   * through the simulated `/replog` transport (currently `sipproxyHA` /
   * `k8sFailover`, fed by the `PartitionedRelayStorage` typed channel's
   * `repl.frameReceived` projector). Each event is one decoded Data
   * frame the consumer received from the source peer; the renderer
   * emits these as a separate replication lane in the HTML report
   * alongside the SIP timeline.
   */
  readonly drainReplicationTrace?: () => ReadonlyArray<ReplicationTraceEntry>
  /**
   * Optional shared monotonic sequencer used by the interpreter to stamp
   * `seq` on every `TraceEntry` it pushes (send/receive step events). The
   * same instance is given to the underlying SignalingNetwork(s) so all
   * recording layers contribute to a single ordering — the renderers
   * tiebreak `(timestamp, seq)`.
   *
   * When `undefined`, the interpreter falls back to `seq: 0`. This is
   * acceptable for transports that don't render reports (e.g. transports
   * built ad-hoc by low-level unit tests); the renderer's sort then
   * degrades to pure-timestamp order, same as before this field existed.
   */
  readonly traceSequencer?: NetworkTraceSequencer
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
