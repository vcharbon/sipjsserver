/**
 * Interpreter — two-phase execution engine for scenario ASTs.
 *
 * Phase 1 (Prepare): Pre-register all expect listeners, validate step refs.
 * Phase 2 (Execute): Walk steps in order, send/expect/pause with the backend transport.
 *
 * Shared by both simulated and live backends — only the transport differs.
 */

import { Cause, Clock, Effect, Fiber, Option, Result } from "effect"
import type { SipMessage, SipRequest } from "../../../src/sip/types.js"
import { SipParser } from "../../../src/sip/Parser.js"
import { hydrateRequest } from "../../../src/sip/parsers/extract-fields.js"
import { PeerFabricControl } from "../../../src/cache/PeerFabric.js"
import { WorkerOrdinal } from "../../../src/cache/PeerCachePort.js"
import { WorkerId } from "../../../src/sip-front-proxy/index.js"
import {
  SimulatedK8sCluster,
  type KillEvent,
  type RoutingDecisionKind,
  type RoutingMetricsSnapshot,
} from "../../support/SimulatedK8sCluster.js"

/**
 * Build a synthetic placeholder request for trace entries that record an
 * absent message (e.g. an offer/answer that never arrived). Carries the
 * minimum mandatory header set so it satisfies the SipMessage type
 * contract; consumers display these only as failure markers.
 */
function makePlaceholderRequest(method: string): SipRequest {
  return hydrateRequest({
    method,
    uri: "sip:placeholder@invalid",
    headers: [
      { name: "Via", value: "SIP/2.0/UDP placeholder.invalid:0;branch=z9hG4bK-placeholder" },
      { name: "From", value: "<sip:placeholder@invalid>;tag=placeholder" },
      { name: "To", value: "<sip:placeholder@invalid>" },
      { name: "Call-ID", value: "placeholder" },
      { name: "CSeq", value: `0 ${method}` },
    ],
    body: new Uint8Array(),
    raw: Buffer.alloc(0),
  })
}
import { getHeaders } from "../../../src/sip/MessageHelpers.js"
import type {
  AgentConfig,
  AgentInfo,
  ExpectStep,
  K8sStep,
  NetworkTag,
  Participant,
  Scenario,
  ScenarioResult,
  SendStep,
  Step,
  StepResult,
  StepStatus,
  TestTransport,
  TraceEntry,
  TraceStatus,
} from "./types.js"
import { DEFAULT_NETWORK } from "./types.js"
import { setCurrentScenario } from "./rule-usage-collector.js"
import {
  buildMessageContext,
  buildRequest,
  buildResponse,
  createAgentDialogState,
  resolvePlaceholders,
  type AgentDialogState,
} from "./message-builder.js"
import { defined } from "./utils.js"
import {
  runValidationChecks,
  correlateResponse,
  autoResolveInResponseTo,
  type ValidationCheckName,
} from "./validation.js"
import { OfferAnswerTracker } from "./offer-answer-tracker.js"

// ---------------------------------------------------------------------------
// Interpreter state
// ---------------------------------------------------------------------------

interface InterpreterState {
  readonly agentInfos: Record<string, AgentInfo & { tag: string; callId: string }>
  readonly agentConfigs: Record<string, AgentConfig>
  readonly dialogStates: Record<string, AgentDialogState>
  readonly results: StepResult[]
  readonly trace: TraceEntry[]
  readonly failedRefs: Set<number>
  readonly resolvedMessages: Map<number, SipMessage>
  /**
   * Actual UDP source address per received message (keyed by step ref id).
   * Used by the response-target computation so a UAS can reply via the
   * NAT-translated source rather than only the topmost Via — needed for
   * the hybrid kind-cluster harness where the worker's Via carries an
   * unroutable pod IP.
   */
  readonly resolvedSources: Map<number, { ip: string; port: number }>
  readonly b2buaTarget: { host: string; port: number }
  readonly targetFor: (agent: string) => { host: string; port: number }
  /** Sleep that respects the active clock — TestClock under simulated, real under live. */
  readonly sleep: (ms: number) => Effect.Effect<void>
  /** Resolved SUT participant name per agent. */
  readonly sutNames: Record<string, string>
  /**
   * Resolve a participant name (an agent name, an SUT label like "B2BUA"
   * or "proxy", or an internal-hop label) to its `NetworkTag`. Used by
   * the trace-stamping path to record which fabric carried each hop.
   */
  readonly networkOf: (participantName: string) => NetworkTag
  /** Messages received during expect steps that didn't match the expected pattern. */
  readonly unexpectedMessages: Array<{ agent: string; msg: SipMessage }>
  /** Patterns marked allowedReemission — matching messages are silently ignored in the unexpected check. */
  readonly allowedReemission: Array<{ agent: string; method?: string | undefined; statusCode?: number | undefined }>
  /** RFC 3264 offer/answer correlation tracker shared across agents. */
  readonly offerAnswer: OfferAnswerTracker
  /**
   * Slice 3b: accumulating kill-phase log. We drain `SimulatedK8sCluster
   * .drainKillEvents` lazily (right before each `expectKillPhase`) and
   * append into this list so multiple assertions on the same kill don't
   * fight over a one-shot drain.
   */
  readonly k8sKillEvents: KillEvent[]
  /**
   * Slice 4b: rolling routing-metrics baseline. Captured lazily on the
   * first `expectRoutedTo` call (or when explicitly reset), then replaced
   * after each successful assertion so consecutive `expectRoutedTo` calls
   * each measure the delta since the previous one.
   */
  routingMetricsBaseline?: RoutingMetricsSnapshot | undefined
  callNumber: number
}

// ---------------------------------------------------------------------------
// StepResult builder (avoids exactOptionalPropertyTypes issues)
// ---------------------------------------------------------------------------

function makeStepResult(fields: {
  stepIndex: number
  step: Step
  status: StepStatus
  durationMs?: number
  error?: string
  dependsOn?: number
  assertionErrors?: string[]
}): StepResult {
  return defined({
    stepIndex: fields.stepIndex,
    step: fields.step,
    status: fields.status,
    durationMs: fields.durationMs,
    error: fields.error,
    dependsOn: fields.dependsOn,
    assertionErrors: fields.assertionErrors,
  }) as StepResult
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a scenario against a transport backend.
 * Returns the aggregated result (pass/fail/skip per step).
 */
export const executeScenario = Effect.fn("executeScenario")(function* (
  scenario: Scenario,
  transport: TestTransport,
  b2buaTarget: { host: string; port: number },
  targetFor?: (agent: string) => { host: string; port: number },
  clockSleep?: (ms: number) => Effect.Effect<void>
) {
  // Attribute rule firings happening during this scenario to scenario.name.
  yield* Effect.sync(() => setCurrentScenario(scenario.name))
  const resolveTarget = targetFor ?? (() => b2buaTarget)
  const sleepMs = clockSleep ?? ((ms: number) => Effect.sleep(`${ms} millis`))
  // --- Setup transport and get agent infos (Scoped: cleanup is automatic) ---
  const rawInfos = yield* transport.setup(scenario.agents, b2buaTarget)

  // Build full agent infos with dialog state
  const agentInfos: Record<string, AgentInfo & { tag: string; callId: string }> = {}
  const dialogStates: Record<string, AgentDialogState> = {}

  for (const [name, info] of Object.entries(rawInfos)) {
    const ds = createAgentDialogState(info.ip)
    // Apply pre-assigned Call-ID from AgentConfig if present. HA
    // scenarios use this to steer dialogs to specific workers via the
    // proxy's HRW hash. Existing scenarios omit `callId` and fall
    // through to the auto-generated value.
    const cfgCallId = scenario.agents[name]?.callId
    if (typeof cfgCallId === "string" && cfgCallId.length > 0) {
      ds.callId = cfgCallId
    }
    dialogStates[name] = ds
    agentInfos[name] = {
      ...info,
      tag: ds.localTag,
      callId: ds.callId,
    }
  }

  // Resolve SUT participant names per agent.
  // Agents sharing the same SUT host:port get the same participant name.
  const sutNames: Record<string, string> = {}
  for (const [name, config] of Object.entries(scenario.agents)) {
    if (config.sutTarget) {
      sutNames[name] = config.sutTarget.name
    } else {
      sutNames[name] = "B2BUA"
    }
  }

  // Pre-compute participant → network. Agents come straight from their
  // config (default `"ext"`); SUT-side labels are the proxy / worker
  // names exposed by the transport — slice 1 places all of them on
  // `"ext"` and slice 2 will surface a `"core"` proxy-side endpoint.
  // We compute it lazily so unknown labels (e.g. `<ip>:<port>` for
  // unrecognised hops) still resolve to the safe default.
  const networkOf = (participantName: string): NetworkTag => {
    const cfg = scenario.agents[participantName]
    if (cfg !== undefined) {
      return cfg.network ?? DEFAULT_NETWORK
    }
    return DEFAULT_NETWORK
  }

  const state: InterpreterState = {
    agentInfos,
    agentConfigs: scenario.agents,
    dialogStates,
    results: [],
    trace: [],
    failedRefs: new Set(),
    resolvedMessages: new Map(),
    resolvedSources: new Map(),
    b2buaTarget,
    targetFor: resolveTarget,
    sleep: sleepMs,
    sutNames,
    networkOf,
    unexpectedMessages: [],
    allowedReemission: [...(scenario.allowedExtras ?? [])],
    offerAnswer: new OfferAnswerTracker(),
    k8sKillEvents: [],
    callNumber: 0,
  }

  // --- Capture routing-metrics baseline BEFORE any step runs ---
  //
  // The first `expectRoutedTo` in the scenario asserts a delta against
  // this baseline; subsequent `expectRoutedTo` calls re-baseline after
  // each successful assertion. We snapshot here (rather than lazily on
  // first assertion) because the proxy may have already incremented
  // counters by the time the assertion is reached — any pre-assertion
  // routing decisions must contribute to the delta the test cares about.
  //
  // Skipped when the scenario has no `expectRoutedTo` step OR when the
  // SimulatedK8sCluster service isn't in scope (non-k8s SUT).
  const needsRoutingBaseline = scenario.steps.some(
    (s) => s.type === "k8s" && s.action.kind === "expectRoutedTo"
  )
  if (needsRoutingBaseline) {
    const clusterOpt = yield* Effect.serviceOption(SimulatedK8sCluster)
    if (Option.isSome(clusterOpt)) {
      state.routingMetricsBaseline =
        yield* clusterOpt.value.snapshotRoutingMetrics
    }
  }

  // --- Execute steps ---
  const hasGroups = scenario.steps.some((s) => s.group !== undefined)

  if (hasGroups) {
    // Parallel execution: split steps by group and run each group concurrently
    const groupMap = new Map<number, { step: Step; globalIndex: number }[]>()
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i]!
      const group = step.group ?? 0
      if (!groupMap.has(group)) groupMap.set(group, [])
      groupMap.get(group)!.push({ step, globalIndex: i })
    }

    const groupFibers = [...groupMap.values()].map((groupSteps) =>
      Effect.gen(function* () {
        for (const { step, globalIndex } of groupSteps) {
          yield* executeStep(step, globalIndex, state, transport)
        }
      })
    )

    yield* Effect.all(groupFibers, { concurrency: "unbounded" })
  } else {
    // Sequential execution (original path)
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i]!
      yield* executeStep(step, i, state, transport)
    }
  }

  // --- Check for unexpected messages ---
  // Settle any pending fibers (retransmits, deferred B2BUA sends,
  // TransactionLayer auto-ACK-for-non-2xx) and — under fake clock —
  // advance virtual time 24h so every pending SIP timer, CallState
  // "terminating" drop, and limiter window migration fires before
  // drain-for-unexpected and verifyCleanState observe the stack.
  //
  // Scenarios marked `skipFinalSweep` opt out of both the sweep and
  // verifyCleanState — used when the scenario deliberately leaves
  // CallState dirty (no BYE) as part of its shape.
  yield* Effect.yieldNow
  if (!scenario.skipFinalSweep && transport.settle !== undefined) {
    yield* transport.settle()
  }
  yield* checkUnexpectedMessages(state, transport)
  yield* checkDanglingReliableProvisionals(state)
  yield* checkDanglingOffers(state)

  // --- Verify internal state is clean (no leaked calls/timers) ---
  if (!scenario.skipFinalSweep && transport.verifyCleanState) {
    const stateErrors = yield* transport.verifyCleanState()
    for (const err of stateErrors) {
      state.results.push(makeStepResult({
        stepIndex: state.results.length,
        step: {
          type: "expect",
          agent: "B2BUA",
          match: {},
          ref: { _tag: "StepRef", id: -2 },
        },
        status: "fail",
        error: err,
      }))
    }
  }

  // No explicit teardown — the transport's setup is Scoped and its
  // finalizers run automatically when the surrounding scope closes.

  // --- Splice internal hops from the network trace ---
  // The agent-perspective entries pushed during executeStep only capture
  // the *first hop* each agent talks to. Internal SIP nodes (proxy →
  // worker) are invisible from the agent side. Drain the simulated
  // fabric's delivery trace and add entries for hops where neither end
  // is a known agent — these are the rows the report would otherwise
  // miss. Hops involving an agent are skipped to avoid duplicating the
  // existing send/receive entries.
  if (transport.drainNetworkTrace !== undefined) {
    const netTrace = yield* transport.drainNetworkTrace()
    const agentNames = new Set(Object.keys(state.agentInfos))
    const labelFor = (ip: string, port: number): string =>
      transport.participantLabel?.(ip, port) ?? `${ip}:${port}`
    const parsed = yield* Effect.gen(function* () {
      const parser = yield* SipParser
      const out: TraceEntry[] = []
      for (const entry of netTrace) {
        const from = labelFor(entry.src.ip, entry.src.port)
        const to = labelFor(entry.dst.ip, entry.dst.port)
        // Skip if either side is an agent — already captured at the
        // step level. Internal hops (proxy↔worker, b2bua↔bob in
        // b2bonly with a forwarding hop, ...) flow through.
        if (agentNames.has(from) || agentNames.has(to)) continue
        const result = yield* parser.parse(entry.raw).pipe(Effect.result)
        if (result._tag === "Failure") continue
        const msg = result.success
        // Internal hops live entirely on the SUT side; both endpoints
        // share the fabric the source is bound on. Resolve via the
        // transport's per-(ip,port) network registry (slice 1: every
        // SUT participant is on `ext`).
        const hopNet: NetworkTag =
          transport.participantNetwork?.(entry.src.ip, entry.src.port)
            ?? transport.participantNetwork?.(entry.dst.ip, entry.dst.port)
            ?? DEFAULT_NETWORK
        out.push({
          timestamp: entry.deliveredMs,
          sentMs: entry.sentMs,
          receivedMs: entry.deliveredMs,
          from,
          to,
          fromAddr: { ip: entry.src.ip, port: entry.src.port },
          toAddr: { ip: entry.dst.ip, port: entry.dst.port },
          direction: "send",
          stepIndex: -1,
          status: "pass",
          message: msg,
          network: hopNet,
        })
      }
      return out
    }).pipe(Effect.provide(SipParser.layer))
    state.trace.push(...parsed)
    // Re-sort by timestamp so internal hops interleave correctly with
    // the agent-perspective entries.
    state.trace.sort((a, b) => a.timestamp - b.timestamp)
  }

  // --- Aggregate results ---
  const passed = state.results.filter((r) => r.status === "pass").length
  const failed = state.results.filter((r) => r.status === "fail").length
  const skipped = state.results.filter((r) => r.status === "skip").length

  // Build ordered participant list: agents and SUT names by first appearance in trace
  const participants = buildParticipantList(state)

  const result: ScenarioResult = {
    scenarioName: scenario.name,
    scenarioDescription: scenario.description,
    stepResults: state.results,
    trace: state.trace,
    participants,
    passed,
    failed,
    skipped,
  }

  return result
})

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

function executeStep(
  step: Step,
  index: number,
  state: InterpreterState,
  transport: TestTransport
): Effect.Effect<void> {
  switch (step.type) {
    case "send":
      return executeSend(step, index, state, transport)
    case "expect":
      return executeExpect(step, index, state, transport)
    case "pause":
      return executePause(step, index, state)
    case "infra":
      return executeInfra(step, index, state)
    case "k8s":
      return executeK8s(step, index, state)
  }
}

// Slice 5 phase E: dispatch InfraStep against `PeerFabricControl` when
// it's in the environment (sipproxyHA SUT provides it). For
// non-fabric scenarios, fall back to the original "skip" behaviour so
// existing tests keep working. The chaos primitives that need extra
// args (latency / errorRate / partition between two named peers) are
// out of scope here — those are slice 7/8 territory and need a
// richer DSL surface than the current InfraStep type carries.
function executeInfra(
  step: import("./types.js").InfraStep,
  index: number,
  state: InterpreterState
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const ctlOpt = yield* Effect.serviceOption(PeerFabricControl)
    if (Option.isNone(ctlOpt)) {
      state.results.push(makeStepResult({
        stepIndex: index,
        step,
        status: "skip",
        error: "PeerFabricControl not provided — InfraStep skipped",
      }))
      return
    }
    const ctl = ctlOpt.value
    const peer = WorkerOrdinal(step.target)
    switch (step.action) {
      case "crash":
        yield* ctl.killWorker(peer)
        state.results.push(makeStepResult({ stepIndex: index, step, status: "ok" }))
        return
      case "restart":
        yield* ctl.rebootWorker(peer)
        state.results.push(makeStepResult({ stepIndex: index, step, status: "ok" }))
        return
      case "partition":
        // The current InfraStep type carries only one `target`. Real
        // partition between two named peers needs (a, b) — defer to
        // a future DSL extension. Mark skip for visibility.
        state.results.push(makeStepResult({
          stepIndex: index,
          step,
          status: "skip",
          error: "InfraStep partition needs two targets — DSL extension pending",
        }))
        return
    }
  })
}

// ---------------------------------------------------------------------------
// Slice 3b: k8s cluster step dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a `K8sStep` action against the `SimulatedK8sCluster` service
 * provided by the `k8sFailover` SUT layer. When the service is absent
 * (any non-k8s SUT) every k8s step is recorded as `skip` with a clear
 * note — that lets the same scenario run unchanged across SUTs without
 * the assertions silently passing.
 *
 * `kill` is special: any non-zero `KillTiming` gap blocks on
 * `Effect.sleep`, which under TestClock would deadlock if we awaited
 * inline. We fork the kill, advance the clock by the configured total,
 * then join — the cluster's internal `recordPhase` log is consumed
 * later by `expectKillPhase` via `drainKillEvents`.
 */
function executeK8s(
  step: K8sStep,
  index: number,
  state: InterpreterState
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const clusterOpt = yield* Effect.serviceOption(SimulatedK8sCluster)
    if (Option.isNone(clusterOpt)) {
      state.results.push(makeStepResult({
        stepIndex: index,
        step,
        status: "skip",
        error:
          `K8sStep "${step.action.kind}" — no SimulatedK8sCluster in scope; ` +
          `scenario should run on the k8sFailover SUT.`,
      }))
      return
    }
    const cluster = clusterOpt.value
    const a = step.action

    switch (a.kind) {
      case "kill": {
        const t = a.timing ?? {}
        const total =
          (t.drainHoldMs ?? 0) +
          (t.disconnectGapMs ?? 0) +
          (t.fabricKillDelayMs ?? 0)
        if (total === 0) {
          yield* cluster.kill(WorkerId(a.workerId), t)
        } else {
          const fiber = yield* Effect.forkScoped(
            cluster.kill(WorkerId(a.workerId), t)
          )
          // Advance virtual time enough to cover every non-zero gap.
          // A small +5ms buffer lets the post-fabric finalizer settle.
          yield* state.sleep(total + 5)
          yield* Fiber.join(fiber)
        }
        state.results.push(makeStepResult({ stepIndex: index, step, status: "pass" }))
        return
      }
      case "respawn": {
        yield* cluster.respawn(WorkerId(a.workerId))
        state.results.push(makeStepResult({ stepIndex: index, step, status: "pass" }))
        return
      }
      case "disconnect": {
        yield* cluster.disconnect(WorkerId(a.workerId))
        state.results.push(makeStepResult({ stepIndex: index, step, status: "pass" }))
        return
      }
      case "reconnect": {
        yield* cluster.reconnect(WorkerId(a.workerId))
        state.results.push(makeStepResult({ stepIndex: index, step, status: "pass" }))
        return
      }
      case "partition": {
        yield* cluster.partition({
          from: WorkerId(a.from),
          to: WorkerId(a.to),
          direction: a.direction,
        })
        state.results.push(makeStepResult({ stepIndex: index, step, status: "pass" }))
        return
      }
      case "heal": {
        yield* cluster.heal(WorkerId(a.a), WorkerId(a.b))
        state.results.push(makeStepResult({ stepIndex: index, step, status: "pass" }))
        return
      }
      case "expectReplicatedTo": {
        const peerId = WorkerId(a.workerId)
        const primaryId = WorkerId(a.primary)
        if (a.callRef !== undefined) {
          const exit = yield* Effect.exit(
            cluster.expectReplicatedTo(peerId, {
              callRef: a.callRef,
              primary: primaryId,
            })
          )
          if (exit._tag === "Failure") {
            state.results.push(makeStepResult({
              stepIndex: index,
              step,
              status: "fail",
              error: `expectReplicatedTo failed: ${formatCause(exit.cause)}`,
            }))
            return
          }
        } else {
          // No callRef → assert at least one bak:{primary}: entry on
          // the named peer. Useful when the scenario doesn't pre-compute
          // the exact callRef (random from-tag).
          const snap = yield* cluster.snapshotPeer(peerId)
          const prefix = `bak:${a.primary}:call:`
          const found = snap.entries.some((e) => e.key.startsWith(prefix))
          if (!found) {
            const known = snap.entries.map((e) => e.key).join(", ")
            state.results.push(makeStepResult({
              stepIndex: index,
              step,
              status: "fail",
              error:
                `expectReplicatedTo: peer ${a.workerId} has no entry under ` +
                `"${prefix}*". Present: [${known}]`,
            }))
            return
          }
        }
        state.results.push(makeStepResult({ stepIndex: index, step, status: "pass" }))
        return
      }
      case "expectCallStateOn": {
        const peerId = WorkerId(a.workerId)
        const ownerId = WorkerId(a.owner)
        const present = a.present ?? true
        if (a.callRef !== undefined) {
          const exit = yield* Effect.exit(
            cluster.expectCallStateOn(peerId, {
              callRef: a.callRef,
              partition: a.partition,
              owner: ownerId,
              present,
            })
          )
          if (exit._tag === "Failure") {
            state.results.push(makeStepResult({
              stepIndex: index,
              step,
              status: "fail",
              error: `expectCallStateOn failed: ${formatCause(exit.cause)}`,
            }))
            return
          }
        } else {
          const snap = yield* cluster.snapshotPeer(peerId)
          const prefix = `${a.partition}:${a.owner}:call:`
          const found = snap.entries.some((e) => e.key.startsWith(prefix))
          if (present && !found) {
            const known = snap.entries.map((e) => e.key).join(", ")
            state.results.push(makeStepResult({
              stepIndex: index,
              step,
              status: "fail",
              error:
                `expectCallStateOn: peer ${a.workerId} has no entry under ` +
                `"${prefix}*". Present: [${known}]`,
            }))
            return
          }
          if (!present && found) {
            state.results.push(makeStepResult({
              stepIndex: index,
              step,
              status: "fail",
              error:
                `expectCallStateOn: peer ${a.workerId} unexpectedly has an ` +
                `entry matching "${prefix}*".`,
            }))
            return
          }
        }
        state.results.push(makeStepResult({ stepIndex: index, step, status: "pass" }))
        return
      }
      case "expectKillPhase": {
        // Drain whatever the cluster has accumulated since the last
        // call and fold it into the running log. Multiple assertions
        // on the same kill timeline therefore observe a stable view.
        const fresh = yield* cluster.drainKillEvents
        for (const e of fresh) state.k8sKillEvents.push(e)
        const match = state.k8sKillEvents.find(
          (e) =>
            (e.workerId as unknown as string) === a.workerId &&
            e.phase === a.phase
        )
        if (match === undefined) {
          state.results.push(makeStepResult({
            stepIndex: index,
            step,
            status: "fail",
            error:
              `expectKillPhase: no "${a.phase}" event recorded for worker ` +
              `${a.workerId}. Recorded: ` +
              state.k8sKillEvents
                .map((e) => `${e.workerId as unknown as string}:${e.phase}@${e.atMs}`)
                .join(", "),
          }))
          return
        }
        if (a.minAtMs !== undefined && match.atMs < a.minAtMs) {
          state.results.push(makeStepResult({
            stepIndex: index,
            step,
            status: "fail",
            error: `expectKillPhase: phase "${a.phase}" fired at t=${match.atMs} but expected ≥ ${a.minAtMs}`,
          }))
          return
        }
        if (a.maxAtMs !== undefined && match.atMs > a.maxAtMs) {
          state.results.push(makeStepResult({
            stepIndex: index,
            step,
            status: "fail",
            error: `expectKillPhase: phase "${a.phase}" fired at t=${match.atMs} but expected ≤ ${a.maxAtMs}`,
          }))
          return
        }
        state.results.push(makeStepResult({ stepIndex: index, step, status: "pass" }))
        return
      }
      case "expectRoutedTo": {
        const minCount = a.minCount ?? 1
        const decision = a.decision as RoutingDecisionKind
        // Per-decision baseline: each decision kind tracks its own
        // rolling counter so back-to-back assertions on different
        // decision kinds at the end of a scenario both observe the
        // full scenario's delta from their respective starting points.
        const baseline = state.routingMetricsBaseline ?? {
          decisionTotalsByKind: new Map<RoutingDecisionKind, number>(),
          promotedTotal: 0,
        }
        const after = yield* cluster.snapshotRoutingMetrics
        const delta =
          (after.decisionTotalsByKind.get(decision) ?? 0) -
          (baseline.decisionTotalsByKind.get(decision) ?? 0)
        if (delta < minCount) {
          state.results.push(makeStepResult({
            stepIndex: index,
            step,
            status: "fail",
            error:
              `expectRoutedTo: decision="${decision}" delta=${delta}, expected ≥ ${minCount}`,
          }))
          return
        }
        // Roll the baseline forward only for THIS decision kind.
        // Other decisions keep their original starting point so a
        // subsequent assertion on a different kind measures the
        // full scenario's delta, not the gap since this assertion.
        const nextDecisionTotals = new Map(baseline.decisionTotalsByKind)
        nextDecisionTotals.set(
          decision,
          after.decisionTotalsByKind.get(decision) ?? 0,
        )
        state.routingMetricsBaseline = {
          decisionTotalsByKind: nextDecisionTotals,
          promotedTotal: baseline.promotedTotal,
        }
        state.results.push(makeStepResult({ stepIndex: index, step, status: "pass" }))
        return
      }
    }
  })
}

/** Best-effort cause → string for assertion error messages. */
function formatCause<E>(cause: Cause.Cause<E>): string {
  return Cause.pretty(cause)
}

function executeSend(
  step: SendStep,
  index: number,
  state: InterpreterState,
  transport: TestTransport
): Effect.Effect<void> {
  return Effect.gen(function* () {
    // Check if this step depends on a failed expect
    if (step.inResponseTo && state.failedRefs.has(step.inResponseTo.id)) {
      state.results.push(makeStepResult({
        stepIndex: index,
        step,
        status: "skip",
        dependsOn: step.inResponseTo.id,
      }))
      return
    }

    // Apply delay if specified
    if (step.delay) {
      yield* state.sleep(step.delay)
    }

    const agentInfo = state.agentInfos[step.agent]
    const dialogState = state.dialogStates[step.agent]
    if (!agentInfo || !dialogState) {
      state.results.push(makeStepResult({
        stepIndex: index,
        step,
        status: "fail",
        error: `Unknown agent "${step.agent}"`,
      }))
      return
    }

    // Resolve inResponseTo — auto-resolve for responses when not explicit
    let resolvedInResponseTo = step.inResponseTo
    if (!resolvedInResponseTo && step.statusCode !== undefined) {
      const autoRefId = autoResolveInResponseTo(step.agent, dialogState)
      resolvedInResponseTo = { _tag: "StepRef" as const, id: autoRefId }
    }

    // Check if auto-resolved ref failed
    if (resolvedInResponseTo && state.failedRefs.has(resolvedInResponseTo.id)) {
      state.results.push(makeStepResult({
        stepIndex: index,
        step,
        status: "skip",
        dependsOn: resolvedInResponseTo.id,
      }))
      return
    }

    const inResponseToMsg = resolvedInResponseTo
      ? state.resolvedMessages.get(resolvedInResponseTo.id)
      : undefined

    // Build message context — use dialogState's callId (may have been updated).
    //
    // RFC 3261 §18.2.2 / §17.2.6: a UAS sends a response to the address in the
    // top Via of the matched request (using `received` / `rport` when present).
    // The default `targetFor` returns the SUT ingress, which is correct for
    // requests but wrong for responses on a B-leg behind a proxy: the worker is
    // the top Via, not the proxy. Honour the top Via for response sends so the
    // test agent (Bob) replies to whichever SIP node forwarded the request to
    // it, not blindly to the SUT ingress.
    const baseTgt = state.targetFor(step.agent)
    const tgt = (() => {
      if (step.statusCode === undefined) return baseTgt
      const reqMsg = inResponseToMsg
      if (reqMsg === undefined || reqMsg.type !== "request") return baseTgt
      // Prefer the actual UDP source of the inbound request when known —
      // the framework recorded it at receive time. This is the
      // RFC-3261 §18.2 "received from" address and matches what the
      // RFC-3581 rport/received params would carry on a NAT-aware peer.
      // It's the only target that works for the hybrid kind-cluster
      // harness, where the worker's Via host is an unroutable pod IP.
      if (resolvedInResponseTo !== undefined) {
        const src = state.resolvedSources.get(resolvedInResponseTo.id)
        if (src !== undefined) return { host: src.ip, port: src.port }
      }
      const top = reqMsg.parsed.via
      if (top === undefined) return baseTgt
      const receivedRaw = top.params?.["received"]
      const rportRaw = top.params?.["rport"]
      const host =
        typeof receivedRaw === "string" && receivedRaw.length > 0
          ? receivedRaw
          : top.host
      const port =
        typeof rportRaw === "string" && rportRaw.length > 0
          ? Number.parseInt(rportRaw, 10)
          : (top.port ?? baseTgt.port)
      return { host, port }
    })()
    const target = { ip: tgt.host, port: tgt.port }
    const currentAgentInfo = { ...agentInfo, callId: dialogState.callId }
    const ctx = buildMessageContext(
      step.agent,
      currentAgentInfo,
      target,
      dialogState,
      inResponseToMsg,
      state.agentInfos,
      {},
      state.callNumber
    )

    const clockTs = yield* Clock.currentTimeMillis
    const startTime = Date.now()

    const buildResult = yield* Effect.try({
      try: () => {
        if (step.statusCode !== undefined) {
          const result = buildResponse(step, ctx, dialogState)
          const resolvedHeaders = resolvePlaceholders([...result.msg.headers], state.agentInfos)
          return { msg: { ...result.msg, headers: resolvedHeaders } as SipMessage, buf: result.buf }
        } else {
          const result = buildRequest(step, ctx, dialogState)
          const resolvedHeaders = resolvePlaceholders([...result.msg.headers], state.agentInfos)
          return { msg: { ...result.msg, headers: resolvedHeaders } as SipMessage, buf: result.buf }
        }
      },
      catch: (err) => ({ _tag: "BuildError" as const, message: err instanceof Error ? err.message : String(err) }),
    }).pipe(Effect.result)

    if (buildResult._tag === "Failure") {
      state.failedRefs.add(step.ref.id)
      state.results.push(makeStepResult({
        stepIndex: index,
        step,
        status: "fail",
        error: `Build error: ${buildResult.failure.message}`,
      }))
      return
    }

    const { msg, buf } = buildResult.success

    // Send via transport. Transport-level errors (e.g. socket closed)
    // are programmer errors here, not test assertion failures —
    // promote them to defects.
    yield* Effect.orDie(transport.send(step.agent, buf, tgt.port, tgt.host))

    // Track SDP offer/answer on outbound messages (RFC 3264 §5).
    const outboundOaSkip = (step.skipValidation ?? []).includes("offerAnswer")
    const outboundOaErrors = state.offerAnswer.observe(msg, step.agent, index, outboundOaSkip)

    // Record the sent message
    state.resolvedMessages.set(step.ref.id, msg)
    dialogState.lastMessage = msg
    dialogState.messagesByRef.set(step.ref.id, msg)

    // Track To-tags used in sent responses (for forking scenarios with custom tags)
    if (msg.type === "response") {
      const sentToTag = msg.parsed.to.tag
      if (sentToTag) {
        dialogState.localTags.add(sentToTag)
      }

      // Mark pending request as responded (final responses only)
      if (step.statusCode !== undefined && step.statusCode >= 200 && resolvedInResponseTo) {
        const pending = dialogState.pendingRequests.find(
          (p) => p.refId === resolvedInResponseTo!.id && !p.finalResponseSent
        )
        if (pending) {
          pending.finalResponseSent = true
        }
      }

      // Track reliable provisional 1xx (Require:100rel + RSeq) — RFC 3262 §3.
      // Expect a PRACK from the peer; scenario-end check flags dangling entries.
      if (step.statusCode !== undefined && step.statusCode > 100 && step.statusCode < 200) {
        const requireVal = msg.headers.find((h) => h.name.toLowerCase() === "require")?.value ?? ""
        const hasRel = requireVal.toLowerCase().split(",").some((t) => t.trim() === "100rel")
        const rseqVal = msg.headers.find((h) => h.name.toLowerCase() === "rseq")?.value
        const rseqNum = rseqVal !== undefined ? parseInt(rseqVal.trim(), 10) : NaN
        if (hasRel && Number.isFinite(rseqNum)) {
          dialogState.pendingReliableProvisionals.push({
            rseq: rseqNum,
            inviteCSeq: msg.parsed.cseq.seq,
            statusCode: step.statusCode,
            branch: msg.parsed.via.branch ?? "",
          })
        }
      }
    }

    // Confirm Call-ID on first sent dialog-establishing request — that pins
    // the A-side agent's Call-ID for the rest of the dialog. Out-of-dialog
    // sends (REGISTER, OPTIONS) MUST NOT pin it: if they did, an agent that
    // registers and then later acts as a UAS for an unrelated incoming
    // INVITE would reject the new dialog's Call-ID via the validator.
    if (
      msg.type === "request" &&
      msg.method === "INVITE" &&
      !dialogState.callIdConfirmed
    ) {
      dialogState.callIdConfirmed = true
    }

    // Track the dialog URIs from the sent INVITE (UAC side).
    // RFC 3261 §12.1.2: remote URI = To, local URI = From of the initial request.
    if (msg.type === "request" && msg.method === "INVITE" && !dialogState.dialogRemoteUri) {
      dialogState.dialogRemoteUri = msg.parsed.to.uri
    }
    if (msg.type === "request" && msg.method === "INVITE" && !dialogState.dialogLocalUri) {
      dialogState.dialogLocalUri = msg.parsed.from.uri
    }

    // Track sent requests for response correlation
    if (msg.type === "request") {
      dialogState.sentRequests.push({
        msg,
        method: msg.method,
        cseqNumber: msg.parsed.cseq.seq,
        viaBranch: msg.parsed.via.branch ?? "",
      })
    }

    const durationMs = Date.now() - startTime
    const sendStatus: StepStatus = outboundOaErrors.length > 0 ? "fail" : "pass"

    // Trace: agent → SUT. Prefer the SUT label resolved from the actual
    // wire-level destination so the report shows e.g. `alice → proxy` on
    // proxy+b2b, not the generic `B2BUA` precomputed label.
    const netDelay = transport.networkDelayMs ?? 0
    const sutLabel =
      transport.participantLabel?.(tgt.host, tgt.port)
        ?? state.sutNames[step.agent]
        ?? "B2BUA"
    const sendNetwork: NetworkTag =
      transport.participantNetwork?.(tgt.host, tgt.port)
        ?? state.networkOf(step.agent)
    state.trace.push(defined({
      timestamp: clockTs,
      sentMs: clockTs,
      receivedMs: clockTs + netDelay,
      from: step.agent,
      to: sutLabel,
      direction: "send" as const,
      stepIndex: index,
      status: sendStatus as TraceStatus,
      message: msg,
      durationMs,
      network: sendNetwork,
    }) as TraceEntry)

    if (sendStatus === "fail") {
      state.results.push(makeStepResult({
        stepIndex: index,
        step,
        status: "fail",
        durationMs,
        assertionErrors: outboundOaErrors,
      }))
    } else {
      state.results.push(makeStepResult({
        stepIndex: index,
        step,
        status: "pass",
        durationMs,
      }))
    }
  })
}

function executeExpect(
  step: ExpectStep,
  index: number,
  state: InterpreterState,
  transport: TestTransport
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const timeout = step.timeout ?? 5000
    const clockTs = yield* Clock.currentTimeMillis
    const startTime = Date.now()

    const agentInfo = state.agentInfos[step.agent]
    const dialogState = state.dialogStates[step.agent]
    if (!agentInfo || !dialogState) {
      state.results.push(makeStepResult({
        stepIndex: index,
        step,
        status: "fail",
        error: `Unknown agent "${step.agent}"`,
      }))
      state.failedRefs.add(step.ref.id)
      return
    }

    // Poll for matching message from transport
    const deadline = Date.now() + timeout
    let matched: SipMessage | undefined
    let matchedArrivalMs: number | undefined
    let matchedRinfo: { ip: string; port: number } | undefined
    const assertionErrors: string[] = []

    while (Date.now() < deadline) {
      const remaining = Math.max(100, deadline - Date.now())
      const packet = yield* Effect.orDie(
        transport.receive(step.agent, Math.min(remaining, 500))
      )

      if (!packet) continue

      // Parse the received message
      const parseResult = yield* Effect.gen(function* () {
        const parser = yield* SipParser
        return yield* parser.parse(packet.raw)
      }).pipe(
        Effect.provide(SipParser.layer),
        Effect.result
      )

      if (parseResult._tag === "Failure") continue

      const msg = parseResult.success

      // Non-matching messages are unexpected — collect them (unless allowed reemission)
      if (!matchesExpect(step, msg)) {
        if (!isAllowedReemission(state, step.agent, msg)) {
          state.unexpectedMessages.push({ agent: step.agent, msg })
        }
        // Regardless of whether the PRACK is "expected" by a step, RFC 3262 §3-4
        // reliability tracking still credits the ack — clear the pending entry.
        if (msg.type === "request" && msg.method === "PRACK") {
          const rackResult = msg.lazy.rack()
          const rack = Result.isSuccess(rackResult) ? rackResult.success : undefined
          if (rack !== undefined) {
            const idx = dialogState.pendingReliableProvisionals.findIndex(
              (p) => p.rseq === rack.rseq && p.inviteCSeq === rack.seq,
            )
            if (idx >= 0) dialogState.pendingReliableProvisionals.splice(idx, 1)
          }
        }
        continue
      }

      // Message matches the expect step
      matched = msg
      matchedArrivalMs = packet.arrivalMs
      matchedRinfo = { ip: packet.rinfo.address, port: packet.rinfo.port }

      // Run predicate if provided
      if (step.match.predicate) {
        const tgt = state.targetFor(step.agent)
        const target = { ip: tgt.host, port: tgt.port }
        const ctx = buildMessageContext(
          step.agent,
          agentInfo,
          target,
          dialogState,
          msg,
          state.agentInfos,
          {},
          state.callNumber
        )
        const predicateResult = yield* Effect.try({
          try: () => step.match.predicate!(msg, ctx),
          catch: (err) => ({ _tag: "BuildError" as const, message: err instanceof Error ? err.message : String(err) }),
        }).pipe(Effect.result)

        if (predicateResult._tag === "Failure") {
          assertionErrors.push(`Predicate threw: ${predicateResult.failure.message}`)
        } else if (!predicateResult.success) {
          assertionErrors.push("Predicate returned false")
        }
      }

      break
    }

    const durationMs = Date.now() - startTime

    // Resolve the SUT label from the actual sender's address when available
    // (network-tap-aware; falls back to the precomputed per-agent name).
    const sutName =
      (matchedRinfo !== undefined
        ? transport.participantLabel?.(matchedRinfo.ip, matchedRinfo.port)
        : undefined)
        ?? state.sutNames[step.agent]
        ?? "B2BUA"

    if (!matched) {
      state.failedRefs.add(step.ref.id)
      const expectDesc = step.match.method ?? `${step.match.statusCode}`
      state.results.push(makeStepResult({
        stepIndex: index,
        step,
        status: "fail",
        durationMs,
        error: `Timeout after ${timeout}ms waiting for ${expectDesc}`,
      }))
      return
    }

    // Record the matched message + the actual UDP source for response routing.
    state.resolvedMessages.set(step.ref.id, matched)
    if (matchedRinfo !== undefined) {
      state.resolvedSources.set(step.ref.id, matchedRinfo)
    }
    dialogState.lastMessage = matched
    dialogState.messagesByRef.set(step.ref.id, matched)

    // Register allowedReemission pattern so duplicates are silently ignored
    if (step.allowReemission) {
      state.allowedReemission.push({
        agent: step.agent,
        method: step.match.method,
        statusCode: step.match.statusCode,
      })
    }

    // Correlate received response with the sent request (for CSeq/Via validation)
    const correlatedRequest = matched.type === "response"
      ? correlateResponse(matched, dialogState)
      : undefined

    // Run all enabled validation checks
    const skipSet = new Set<ValidationCheckName>(step.skipValidation ?? [])
    runValidationChecks(matched, dialogState, correlatedRequest, skipSet, step.validation, assertionErrors)

    // Track the connected-dialog flag from incoming 2xx-to-INVITE even though
    // we do not classify SDP on the inbound side — the flag gates the
    // "early-dialog answer" exception. Offer/answer matching itself is driven
    // off outbound observations only (see executeSend).
    if (
      matched.type === "response" &&
      matched.status >= 200 && matched.status < 300
    ) {
      if (matched.parsed.cseq.method.toUpperCase() === "INVITE") {
        state.offerAnswer.markConnected(matched.parsed.callId)
      }
    }

    // Update dialog state from received message
    updateDialogState(dialogState, matched)

    // Track received requests as pending (ACK excluded — never gets a response)
    if (matched.type === "request" && matched.method !== "ACK") {
      dialogState.pendingRequests.push({
        refId: step.ref.id,
        msg: matched,
        method: matched.method,
        cseqNumber: matched.parsed.cseq.seq,
        finalResponseSent: false,
      })
    }

    // Clear any pending reliable provisional whose RAck matches an incoming PRACK.
    // RFC 3262 §7.2: PRACK's RAck is "<response-num> <cseq-num> <method>".
    if (matched.type === "request" && matched.method === "PRACK") {
      const rackResult = matched.lazy.rack()
      const rack = Result.isSuccess(rackResult) ? rackResult.success : undefined
      if (rack !== undefined) {
        const idx = dialogState.pendingReliableProvisionals.findIndex(
          (p) => p.rseq === rack.rseq && p.inviteCSeq === rack.seq
        )
        if (idx >= 0) {
          dialogState.pendingReliableProvisionals.splice(idx, 1)
        }
      }
    }

    const status: StepStatus = assertionErrors.length > 0 ? "fail" : "pass"

    // Trace: SUT → agent. Stamp with the packet's arrival time (set by
    // the transport when the receiver's queue was offered the packet) so
    // the call-flow report shows the virtual clock moment the UAS/UAC
    // saw the message — not the moment executeExpect started polling.
    const netDelayR = transport.networkDelayMs ?? 0
    const arrivalTs = matchedArrivalMs ?? clockTs
    const recvNetwork: NetworkTag =
      (matchedRinfo !== undefined
        ? transport.participantNetwork?.(matchedRinfo.ip, matchedRinfo.port)
        : undefined)
        ?? state.networkOf(step.agent)
    state.trace.push(defined({
      timestamp: arrivalTs,
      sentMs: arrivalTs - netDelayR,
      receivedMs: arrivalTs,
      from: sutName,
      to: step.agent,
      direction: "receive" as const,
      stepIndex: index,
      status: status as TraceStatus,
      message: matched,
      durationMs,
      network: recvNetwork,
    }) as TraceEntry)

    if (assertionErrors.length > 0) {
      state.results.push(makeStepResult({
        stepIndex: index,
        step,
        status,
        durationMs,
        assertionErrors,
      }))
    } else {
      state.results.push(makeStepResult({
        stepIndex: index,
        step,
        status,
        durationMs,
      }))
    }
  })
}

function executePause(
  step: Step & { type: "pause" },
  index: number,
  state: InterpreterState
): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* state.sleep(step.duration)
    state.results.push(makeStepResult({
      stepIndex: index,
      step,
      status: "pass",
      durationMs: step.duration,
    }))
  })
}

// ---------------------------------------------------------------------------
// Message matching
// ---------------------------------------------------------------------------

/** Check if a message matches an allowedReemission pattern for the given agent. */
function isAllowedReemission(state: InterpreterState, agent: string, msg: SipMessage): boolean {
  return state.allowedReemission.some((pattern) => {
    if (pattern.agent !== agent) return false
    if (pattern.method !== undefined) {
      return msg.type === "request" && msg.method === pattern.method
    }
    if (pattern.statusCode !== undefined) {
      return msg.type === "response" && msg.status === pattern.statusCode
    }
    return false
  })
}

function matchesExpect(step: ExpectStep, msg: SipMessage): boolean {
  if (step.match.method !== undefined) {
    if (msg.type !== "request") return false
    if (msg.method !== step.match.method) return false
  }
  if (step.match.statusCode !== undefined) {
    if (msg.type !== "response") return false
    if (msg.status !== step.match.statusCode) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Dialog state updates
// ---------------------------------------------------------------------------

function updateDialogState(ds: AgentDialogState, msg: SipMessage): void {
  const callIdHeader = msg.parsed.callId

  // For received INVITE: adopt the incoming Call-ID as our dialog's Call-ID
  // This is critical for B-side agents who need to reply with the B2BUA's Call-ID
  if (msg.type === "request" && msg.method === "INVITE") {
    ds.callId = callIdHeader
    ds.callIdConfirmed = true
    // Capture INVITE Request-URI and Via branch for CANCEL validation (RFC 3261 §9.1)
    ds.receivedInviteUri = msg.uri
    if (msg.parsed.via.branch) {
      ds.receivedInviteBranch = msg.parsed.via.branch
    }
  }

  // Track the dialog URIs from received INVITE (UAS side).
  // RFC 3261 §12.1.2: remote URI = From, local URI = To of the initial request.
  if (msg.type === "request" && msg.method === "INVITE" && !ds.dialogRemoteUri) {
    ds.dialogRemoteUri = msg.parsed.from.uri
  }
  if (msg.type === "request" && msg.method === "INVITE" && !ds.dialogLocalUri) {
    ds.dialogLocalUri = msg.parsed.to.uri
  }

  if (msg.type === "response") {
    const toTag = msg.parsed.to.tag
    // Only adopt remoteTag from responses to dialog-establishing requests
    // (RFC 3261 §12.1: INVITE establishes a dialog; REGISTER/OPTIONS/MESSAGE
    // do not). Without this guard the To-tag stamped by a registrar on the
    // 200 OK to REGISTER would leak into a subsequent out-of-dialog INVITE
    // sent by the same agent.
    const cseqMethod = msg.parsed.cseq.method
    if (toTag && !ds.remoteTag && cseqMethod === "INVITE") {
      ds.remoteTag = toTag
    }
    // Also adopt Call-ID from first response if not already set from an INVITE
    // For the A-side: responses come back with the A-leg Call-ID we sent
    // No need to change — we keep our own Call-ID
  } else {
    const fromTag = msg.parsed.from.tag
    // UAS side: only adopt remoteTag when receiving a dialog-establishing
    // INVITE. A prior out-of-dialog REGISTER/OPTIONS round-trip on the same
    // agent would otherwise have already populated `remoteTag` and the
    // `!ds.remoteTag` guard would block the correct INVITE-side capture.
    if (fromTag && !ds.remoteTag && msg.method === "INVITE") {
      ds.remoteTag = fromTag
    }
  }

  if (msg.type === "request") {
    const cseqNum = msg.parsed.cseq.seq
    const cseqMethod = msg.parsed.cseq.method
    if (ds.remoteCSeq === undefined || cseqNum > ds.remoteCSeq) {
      ds.remoteCSeq = cseqNum
    }

    // Capture INVITE baseline per Call-ID (RFC 3261 §12.2.1.1 baseline
    // for all dialogs — forked early dialogs share this baseline).
    if (msg.method === "INVITE") {
      if (!ds.inviteCSeqByCallId.has(callIdHeader)) {
        ds.inviteCSeqByCallId.set(callIdHeader, cseqNum)
      }
    }

    // Per-dialog CSeq tracking — skip CANCEL/ACK (they reuse INVITE CSeq)
    // and messages without a full tag pair (out-of-dialog).
    if (msg.method !== "CANCEL" && cseqMethod !== "ACK") {
      const fromTag = msg.parsed.from.tag
      const toTag = msg.parsed.to.tag
      if (fromTag && toTag) {
        const key = `${callIdHeader}|${fromTag}|${toTag}`
        const prev = ds.remoteCSeqByDialog.get(key)
        if (prev === undefined || cseqNum > prev) {
          ds.remoteCSeqByDialog.set(key, cseqNum)
        }
      }
    }
  }

  // Track remote Contact URI for in-dialog request routing.
  // Per RFC 3261 §12.2.1.1, the dialog's remote target is the Contact of the
  // dialog-establishing INVITE (UAC reads from the response, UAS from the
  // request). Out-of-dialog REGISTER/OPTIONS responses also carry a Contact
  // (the registrar echoes the binding, the UA advertises its own) but those
  // must NOT seed the dialog target — otherwise a subsequent in-dialog
  // request on the same agent would address its own contact instead of the
  // peer's.
  //
  // RFC 3261 §12.2.1.2 also defines "target refresh": a 2xx response to an
  // in-dialog re-INVITE / UPDATE updates the dialog's remote target to the
  // response's Contact. We cover that case by always updating the target on
  // an INVITE 2xx response (initial AND re-INVITE) — the same field
  // captures both flows. Important for failover scenarios where a re-INVITE
  // 200 OK from a backup-promoted worker carries that worker's contact, and
  // the subsequent ACK MUST target that contact, not the original primary's.
  const contactUri = msg.parsed.contact?.uri
  const cseqForContact = msg.type === "response" ? msg.parsed.cseq.method : undefined
  const isDialogEstablishingRequest =
    msg.type === "request" && msg.method === "INVITE"
  const isInviteOrUpdate2xx =
    msg.type === "response" &&
    msg.status >= 200 &&
    msg.status < 300 &&
    (cseqForContact === "INVITE" || cseqForContact === "UPDATE")
  if (contactUri && isDialogEstablishingRequest && !ds.remoteContact) {
    ds.remoteContact = contactUri
  } else if (contactUri && isInviteOrUpdate2xx) {
    // Target refresh OR initial-dialog 2xx — always update so re-INVITEs
    // routed via a different worker after failover land on the right
    // contact for subsequent in-dialog requests.
    ds.remoteContact = contactUri
  }

  // Populate route set from Record-Route per RFC 3261 §12.1.
  //   UAC (§12.1.2): build from response R-R in *reverse* order.
  //   UAS (§12.1.1): build from request R-R in *received* order.
  // The agent identity here is implicit — whichever side first observes a
  // dialog-creating message captures its route set. UAC = first dialog-
  // creating message is a response (the 200 OK to its outgoing INVITE).
  // UAS = first dialog-creating message is a request (the incoming INVITE).
  // Gate on dialog-establishing methods so a Record-Route reflected on a
  // REGISTER/OPTIONS response can't seed an unrelated dialog's route set.
  if (ds.routeSet.length === 0) {
    if (msg.type === "response" && msg.parsed.cseq.method === "INVITE") {
      // UAC side: reverse received order so routeSet[0] is the UAC's first
      // hop downstream (the proxy that should be the top Route on outgoing
      // in-dialog requests).
      const rr = getHeaders(msg.headers, "record-route")
      if (rr.length > 0) {
        ds.routeSet = [...rr].reverse()
      }
    } else if (msg.type === "request" && msg.method === "INVITE") {
      // UAS side: keep received order — routeSet[0] is the UAS's first hop
      // downstream when initiating an in-dialog request (BYE, re-INVITE).
      const rr = getHeaders(msg.headers, "record-route")
      if (rr.length > 0) {
        ds.routeSet = [...rr]
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Unexpected message check
// ---------------------------------------------------------------------------

function describeMessage(msg: SipMessage): string {
  return msg.type === "request" ? msg.method : `${msg.status}`
}

/**
 * Build an ordered participant list from the trace.
 * Order: by first appearance in trace entries, preserving from→to ordering.
 * SUT participants with the same host:port are collapsed into one name.
 *
 * Each participant is tagged with its `network` (so the renderer can
 * group / colour lanes by fabric). The network of a participant is
 * inferred from the first trace entry that mentions it — both ends of
 * a single hop always share a fabric, so either side gives the right
 * answer.
 */
function buildParticipantList(state: InterpreterState): Participant[] {
  const seen = new Map<string, NetworkTag>()
  const ordered: Participant[] = []

  for (const entry of state.trace) {
    for (const name of [entry.from, entry.to]) {
      if (!seen.has(name)) {
        seen.set(name, entry.network)
        ordered.push({ name, network: entry.network })
      }
    }
  }

  // If trace is empty, fall back to agent names with SUT in the middle.
  if (ordered.length === 0) {
    const agentNames = Object.keys(state.agentInfos)
    const sutNamesSet = new Set(Object.values(state.sutNames))
    if (agentNames.length > 0) {
      const first = agentNames[0]!
      ordered.push({ name: first, network: state.networkOf(first) })
      // SUTs land on `ext` in slice 1; slice 2 will surface a `core` SUT
      // participant via `transport.participantNetwork`.
      for (const sut of sutNamesSet) ordered.push({ name: sut, network: DEFAULT_NETWORK })
      for (let i = 1; i < agentNames.length; i++) {
        const name = agentNames[i]!
        ordered.push({ name, network: state.networkOf(name) })
      }
    }
  }

  return ordered
}

/**
 * RFC 3262 §3-4: every reliable provisional response MUST be acknowledged by
 * a PRACK. If an agent has sent a reliable 1xx and no matching PRACK arrived
 * by scenario end, the peer (typically the B2BUA) failed to ack — flag each
 * dangling entry as a failure so regressions on H5 are caught automatically.
 */
/**
 * RFC 3264 §5: every SDP offer must be answered. If a scenario ends with open
 * pending offers on any Call-ID, the exchange was never completed — flag each
 * as a failure so regressions in offer/answer modeling are caught automatically.
 */
function checkDanglingOffers(state: InterpreterState): Effect.Effect<void> {
  return Effect.gen(function* () {
    const clockTs = yield* Clock.currentTimeMillis
    for (const pending of state.offerAnswer.danglingOffers()) {
      const stepIndex = state.results.length
      state.results.push(makeStepResult({
        stepIndex,
        step: {
          type: "expect",
          agent: pending.party,
          match: {},
          ref: { _tag: "StepRef", id: -4 },
        },
        status: "fail",
        error:
          `SDP offer from ${pending.party} (callId=${pending.callId}, ` +
          `CSeq=${pending.cseqNum} ${pending.cseqMethod}, port=${pending.port}, nonce="${pending.nonce}") ` +
          `was never answered — RFC 3264 §5`,
      }))
      state.trace.push({
        timestamp: clockTs,
        sentMs: clockTs,
        receivedMs: clockTs,
        from: state.sutNames[pending.party] ?? "B2BUA",
        to: pending.party,
        direction: "receive",
        stepIndex,
        status: "unexpected",
        message: makePlaceholderRequest("SDP-ANSWER"),
        network: state.networkOf(pending.party),
      })
    }
  })
}

function checkDanglingReliableProvisionals(state: InterpreterState): Effect.Effect<void> {
  return Effect.gen(function* () {
    const clockTs = yield* Clock.currentTimeMillis
    for (const [agent, dialogState] of Object.entries(state.dialogStates)) {
      for (const pending of dialogState.pendingReliableProvisionals) {
        const stepIndex = state.results.length
        state.results.push(makeStepResult({
          stepIndex,
          step: {
            type: "expect",
            agent,
            match: { method: "PRACK" },
            ref: { _tag: "StepRef", id: -3 },
          },
          status: "fail",
          error: `Reliable 1xx sent by ${agent} (${pending.statusCode}, RSeq=${pending.rseq}, CSeq=${pending.inviteCSeq}) was never PRACKed — RFC 3262 §3-4`,
        }))
        state.trace.push({
          timestamp: clockTs,
          sentMs: clockTs,
          receivedMs: clockTs,
          from: state.sutNames[agent] ?? "B2BUA",
          to: agent,
          direction: "receive",
          stepIndex,
          status: "unexpected",
          message: makePlaceholderRequest("PRACK"),
          network: state.networkOf(agent),
        })
      }
    }
  })
}

function checkUnexpectedMessages(
  state: InterpreterState,
  transport: TestTransport
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const clockTs = yield* Clock.currentTimeMillis

    // Report messages collected during expect steps that didn't match
    // (filter out allowed reemissions that may have slipped through)
    for (const { agent, msg } of state.unexpectedMessages.filter((u) => !isAllowedReemission(state, u.agent, u.msg))) {
      const stepIndex = state.results.length
      state.results.push(makeStepResult({
        stepIndex,
        step: {
          type: "expect",
          agent,
          match: {},
          ref: { _tag: "StepRef", id: -1 },
        },
        status: "fail",
        error: `Unexpected message received by ${agent}: ${describeMessage(msg)}`,
      }))

      // Trace: unexpected message
      state.trace.push({
        timestamp: clockTs,
        sentMs: clockTs,
        receivedMs: clockTs,
        from: state.sutNames[agent] ?? "B2BUA",
        to: agent,
        direction: "receive",
        stepIndex,
        status: "unexpected",
        message: msg,
        network: state.networkOf(agent),
      })
    }

    // Drain all remaining messages from every agent
    for (const agentName of Object.keys(state.agentInfos)) {
      let hasMore = true
      while (hasMore) {
        // Non-blocking poll: drain whatever's already buffered. Under
        // TestClock a blocking sleep would never fire on its own, so we
        // must use the timeout=0 path.
        const packet = yield* Effect.orDie(transport.receive(agentName, 0))
        if (!packet) {
          hasMore = false
          continue
        }

        const parseResult = yield* Effect.gen(function* () {
          const parser = yield* SipParser
          return yield* parser.parse(packet.raw)
        }).pipe(
          Effect.provide(SipParser.layer),
          Effect.result
        )

        // Allowed reemissions still go to the trace so the capture is
        // complete for downstream review (e.g. hop-by-hop ACK for non-2xx
        // via allowExtra("ACK")), but they do NOT fail the test.
        if (parseResult._tag === "Success" && isAllowedReemission(state, agentName, parseResult.success)) {
          const dD = transport.networkDelayMs ?? 0
          const reemNet =
            transport.participantNetwork?.(packet.rinfo.address, packet.rinfo.port)
              ?? state.networkOf(agentName)
          state.trace.push({
            timestamp: packet.arrivalMs,
            sentMs: packet.arrivalMs - dD,
            receivedMs: packet.arrivalMs,
            from: state.sutNames[agentName] ?? "B2BUA",
            to: agentName,
            direction: "receive",
            stepIndex: -1,
            status: "pass",
            message: parseResult.success,
            network: reemNet,
          })
          continue
        }

        const desc = parseResult._tag === "Success"
          ? describeMessage(parseResult.success)
          : "unparseable"

        const drainStepIndex = state.results.length
        state.results.push(makeStepResult({
          stepIndex: drainStepIndex,
          step: {
            type: "expect",
            agent: agentName,
            match: {},
            ref: { _tag: "StepRef", id: -1 },
          },
          status: "fail",
          error: `Unexpected message received by ${agentName}: ${desc}`,
        }))

        // Trace: unexpected drained message
        if (parseResult._tag === "Success") {
          const dD2 = transport.networkDelayMs ?? 0
          const drainNet =
            transport.participantNetwork?.(packet.rinfo.address, packet.rinfo.port)
              ?? state.networkOf(agentName)
          state.trace.push({
            timestamp: packet.arrivalMs,
            sentMs: packet.arrivalMs - dD2,
            receivedMs: packet.arrivalMs,
            from: state.sutNames[agentName] ?? "B2BUA",
            to: agentName,
            direction: "receive",
            stepIndex: drainStepIndex,
            status: "unexpected",
            message: parseResult.success,
            network: drainNet,
          })
        }
      }
    }
  })
}
