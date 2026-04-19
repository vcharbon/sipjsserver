/**
 * Interpreter — two-phase execution engine for scenario ASTs.
 *
 * Phase 1 (Prepare): Pre-register all expect listeners, validate step refs.
 * Phase 2 (Execute): Walk steps in order, send/expect/pause with the backend transport.
 *
 * Shared by both simulated and live backends — only the transport differs.
 */

import { Clock, Effect } from "effect"
import type { SipMessage } from "../../../src/sip/types.js"
import { SipParser } from "../../../src/sip/Parser.js"
import { getHeaders } from "../../../src/sip/MessageFactory.js"
import type {
  AgentConfig,
  AgentInfo,
  ExpectStep,
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
  readonly b2buaTarget: { host: string; port: number }
  readonly targetFor: (agent: string) => { host: string; port: number }
  /** Sleep that respects the active clock — TestClock under simulated, real under live. */
  readonly sleep: (ms: number) => Effect.Effect<void>
  /** Resolved SUT participant name per agent. */
  readonly sutNames: Record<string, string>
  /** Messages received during expect steps that didn't match the expected pattern. */
  readonly unexpectedMessages: Array<{ agent: string; msg: SipMessage }>
  /** Patterns marked allowedReemission — matching messages are silently ignored in the unexpected check. */
  readonly allowedReemission: Array<{ agent: string; method?: string | undefined; statusCode?: number | undefined }>
  /** RFC 3264 offer/answer correlation tracker shared across agents. */
  readonly offerAnswer: OfferAnswerTracker
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

  const state: InterpreterState = {
    agentInfos,
    agentConfigs: scenario.agents,
    dialogStates,
    results: [],
    trace: [],
    failedRefs: new Set(),
    resolvedMessages: new Map(),
    b2buaTarget,
    targetFor: resolveTarget,
    sleep: sleepMs,
    sutNames,
    unexpectedMessages: [],
    allowedReemission: [...(scenario.allowedExtras ?? [])],
    offerAnswer: new OfferAnswerTracker(),
    callNumber: 0,
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
      return Effect.sync(() => {
        state.results.push(makeStepResult({
          stepIndex: index,
          step,
          status: "skip",
          error: "Infrastructure steps not yet implemented",
        }))
      })
  }
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

    // Build message context — use dialogState's callId (may have been updated)
    const tgt = state.targetFor(step.agent)
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
      const toHdr = msg.headers.find((hdr) => hdr.name.toLowerCase() === "to")?.value ?? ""
      const tagMatch = /;tag=([^\s;,>]+)/i.exec(toHdr)
      if (tagMatch?.[1]) {
        dialogState.localTags.add(tagMatch[1])
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
          const cseqRaw = msg.headers.find((h) => h.name.toLowerCase() === "cseq")?.value ?? ""
          const cseqNum = parseInt(cseqRaw.trim().split(/\s+/)[0] ?? "0", 10)
          const viaHdr = msg.headers.find((h) => h.name.toLowerCase() === "via")?.value ?? ""
          const branchMatch = /;branch=([^\s;,>]+)/i.exec(viaHdr)
          dialogState.pendingReliableProvisionals.push({
            rseq: rseqNum,
            inviteCSeq: cseqNum,
            statusCode: step.statusCode,
            branch: branchMatch?.[1] ?? "",
          })
        }
      }
    }

    // Confirm Call-ID on first sent request (A-side agents use their own Call-ID)
    if (msg.type === "request" && !dialogState.callIdConfirmed) {
      dialogState.callIdConfirmed = true
    }

    // Track the To URI from sent INVITE as the dialog's remote URI (UAC side).
    // RFC 3261 §12.1.2: remote URI = URI in the To field of the initial request.
    if (msg.type === "request" && msg.method === "INVITE" && !dialogState.dialogRemoteUri) {
      const toHdr = msg.headers.find((h) => h.name.toLowerCase() === "to")?.value ?? ""
      const toUriMatch = /<([^>]+)>/.exec(toHdr)
      if (toUriMatch?.[1]) {
        dialogState.dialogRemoteUri = toUriMatch[1]
      }
    }

    // Track sent requests for response correlation
    if (msg.type === "request") {
      const cseqRaw = msg.headers.find((h) => h.name.toLowerCase() === "cseq")?.value ?? ""
      const cseqParts = cseqRaw.trim().split(/\s+/)
      const cseqNum = parseInt(cseqParts[0] ?? "0", 10)
      const viaHeader = msg.headers.find((h) => h.name.toLowerCase() === "via")?.value ?? ""
      const branchMatch = /;branch=([^\s;,>]+)/i.exec(viaHeader)
      dialogState.sentRequests.push({
        msg,
        method: msg.method,
        cseqNumber: cseqNum,
        viaBranch: branchMatch?.[1] ?? "",
      })
    }

    const durationMs = Date.now() - startTime
    const sendStatus: StepStatus = outboundOaErrors.length > 0 ? "fail" : "pass"

    // Trace: agent → SUT
    const netDelay = transport.networkDelayMs ?? 0
    state.trace.push(defined({
      timestamp: clockTs,
      sentMs: clockTs,
      receivedMs: clockTs + netDelay,
      from: step.agent,
      to: state.sutNames[step.agent] ?? "B2BUA",
      direction: "send" as const,
      stepIndex: index,
      status: sendStatus as TraceStatus,
      message: msg,
      durationMs,
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
          const rack = msg.headers.find((h) => h.name.toLowerCase() === "rack")?.value ?? ""
          const parts = rack.trim().split(/\s+/)
          const rseqAck = parseInt(parts[0] ?? "", 10)
          const cseqAck = parseInt(parts[1] ?? "", 10)
          if (Number.isFinite(rseqAck) && Number.isFinite(cseqAck)) {
            const idx = dialogState.pendingReliableProvisionals.findIndex(
              (p) => p.rseq === rseqAck && p.inviteCSeq === cseqAck,
            )
            if (idx >= 0) dialogState.pendingReliableProvisionals.splice(idx, 1)
          }
        }
        continue
      }

      // Message matches the expect step
      matched = msg
      matchedArrivalMs = packet.arrivalMs

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

    const sutName = state.sutNames[step.agent] ?? "B2BUA"

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

    // Record the matched message
    state.resolvedMessages.set(step.ref.id, matched)
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
      const cseqRaw = matched.headers.find((h) => h.name.toLowerCase() === "cseq")?.value ?? ""
      const cseqMethod = (cseqRaw.trim().split(/\s+/)[1] ?? "").toUpperCase()
      const callId = matched.headers.find((h) => h.name.toLowerCase() === "call-id")?.value ?? ""
      if (cseqMethod === "INVITE" && callId) {
        state.offerAnswer.markConnected(callId)
      }
    }

    // Update dialog state from received message
    updateDialogState(dialogState, matched)

    // Track received requests as pending (ACK excluded — never gets a response)
    if (matched.type === "request" && matched.method !== "ACK") {
      const cseqRaw = matched.headers.find((h) => h.name.toLowerCase() === "cseq")?.value ?? ""
      const cseqNum = parseInt(cseqRaw.trim().split(/\s+/)[0] ?? "0", 10)
      dialogState.pendingRequests.push({
        refId: step.ref.id,
        msg: matched,
        method: matched.method,
        cseqNumber: cseqNum,
        finalResponseSent: false,
      })
    }

    // Clear any pending reliable provisional whose RAck matches an incoming PRACK.
    // RFC 3262 §7.2: PRACK's RAck is "<response-num> <cseq-num> <method>".
    if (matched.type === "request" && matched.method === "PRACK") {
      const rack = matched.headers.find((h) => h.name.toLowerCase() === "rack")?.value ?? ""
      const parts = rack.trim().split(/\s+/)
      const rseqAck = parseInt(parts[0] ?? "", 10)
      const cseqAck = parseInt(parts[1] ?? "", 10)
      if (Number.isFinite(rseqAck) && Number.isFinite(cseqAck)) {
        const idx = dialogState.pendingReliableProvisionals.findIndex(
          (p) => p.rseq === rseqAck && p.inviteCSeq === cseqAck
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
  const toHeader = msg.headers.find((h) => h.name.toLowerCase() === "to")?.value ?? ""
  const fromHeader = msg.headers.find((h) => h.name.toLowerCase() === "from")?.value ?? ""
  const callIdHeader = msg.headers.find((h) => h.name.toLowerCase() === "call-id")?.value

  // For received INVITE: adopt the incoming Call-ID as our dialog's Call-ID
  // This is critical for B-side agents who need to reply with the B2BUA's Call-ID
  if (msg.type === "request" && msg.method === "INVITE" && callIdHeader) {
    ds.callId = callIdHeader
    ds.callIdConfirmed = true
    // Capture INVITE Request-URI and Via branch for CANCEL validation (RFC 3261 §9.1)
    ds.receivedInviteUri = msg.uri
    const viaHeader = msg.headers.find((h) => h.name.toLowerCase() === "via")?.value ?? ""
    const branchMatch = /;branch=([^\s;,>]+)/i.exec(viaHeader)
    if (branchMatch?.[1]) {
      ds.receivedInviteBranch = branchMatch[1]
    }
  }

  // Track the remote URI from received INVITE (UAS side).
  // RFC 3261 §12.1.2: remote URI = URI in the From field of the initial request.
  if (msg.type === "request" && msg.method === "INVITE" && !ds.dialogRemoteUri) {
    const fromUriMatch = /<([^>]+)>/.exec(fromHeader)
    if (fromUriMatch?.[1]) {
      ds.dialogRemoteUri = fromUriMatch[1]
    }
  }

  if (msg.type === "response") {
    const tagMatch = /;tag=([^\s;,>]+)/i.exec(toHeader)
    if (tagMatch?.[1] && !ds.remoteTag) {
      ds.remoteTag = tagMatch[1]
    }
    // Also adopt Call-ID from first response if not already set from an INVITE
    if (callIdHeader && ds.callId !== callIdHeader) {
      // For the A-side: responses come back with the A-leg Call-ID we sent
      // No need to change — we keep our own Call-ID
    }
  } else {
    const tagMatch = /;tag=([^\s;,>]+)/i.exec(fromHeader)
    if (tagMatch?.[1] && !ds.remoteTag) {
      ds.remoteTag = tagMatch[1]
    }
  }

  if (msg.type === "request") {
    const cseqRaw = msg.headers.find((h) => h.name.toLowerCase() === "cseq")?.value ?? ""
    const cseqParts = cseqRaw.trim().split(/\s+/)
    const cseqNum = parseInt(cseqParts[0] ?? "0", 10)
    const cseqMethod = cseqParts[1] ?? ""
    if (ds.remoteCSeq === undefined || cseqNum > ds.remoteCSeq) {
      ds.remoteCSeq = cseqNum
    }

    // Capture INVITE baseline per Call-ID (RFC 3261 §12.2.1.1 baseline
    // for all dialogs — forked early dialogs share this baseline).
    if (msg.method === "INVITE" && callIdHeader) {
      if (!ds.inviteCSeqByCallId.has(callIdHeader)) {
        ds.inviteCSeqByCallId.set(callIdHeader, cseqNum)
      }
    }

    // Per-dialog CSeq tracking — skip CANCEL/ACK (they reuse INVITE CSeq)
    // and messages without a full tag pair (out-of-dialog).
    if (msg.method !== "CANCEL" && cseqMethod !== "ACK") {
      const fromTag = /;tag=([^\s;,>]+)/i.exec(fromHeader)?.[1]
      const toTag = /;tag=([^\s;,>]+)/i.exec(toHeader)?.[1]
      if (callIdHeader && fromTag && toTag) {
        const key = `${callIdHeader}|${fromTag}|${toTag}`
        const prev = ds.remoteCSeqByDialog.get(key)
        if (prev === undefined || cseqNum > prev) {
          ds.remoteCSeqByDialog.set(key, cseqNum)
        }
      }
    }
  }

  // Track remote Contact URI for in-dialog request routing
  const contactHeader = msg.headers.find((h) => h.name.toLowerCase() === "contact")?.value ?? ""
  const contactUri = /^<([^>]+)>/.exec(contactHeader)?.[1] ?? contactHeader.split(/[;,\s]/)[0]
  if (contactUri && !ds.remoteContact) {
    ds.remoteContact = contactUri
  }

  // Populate route set from Record-Route in responses (RFC 3261 §12.1.2)
  // UAC reverses the Record-Route order; UAS keeps it as-is.
  // Since test agents act as UAC (they sent the INVITE and receive responses),
  // we reverse the order to form the Route set for subsequent requests.
  if (msg.type === "response" && ds.routeSet.length === 0) {
    const rr = getHeaders(msg.headers, "record-route")
    if (rr.length > 0) {
      ds.routeSet = [...rr].reverse()
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
 */
function buildParticipantList(state: InterpreterState): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []

  for (const entry of state.trace) {
    for (const name of [entry.from, entry.to]) {
      if (!seen.has(name)) {
        seen.add(name)
        ordered.push(name)
      }
    }
  }

  // If trace is empty, fall back to agent names with SUT in the middle
  if (ordered.length === 0) {
    const agentNames = Object.keys(state.agentInfos)
    const sutNamesSet = new Set(Object.values(state.sutNames))
    // Interleave: first agent, then SUTs, then remaining agents
    if (agentNames.length > 0) {
      ordered.push(agentNames[0]!)
      for (const sut of sutNamesSet) ordered.push(sut)
      for (let i = 1; i < agentNames.length; i++) ordered.push(agentNames[i]!)
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
        message: {
          type: "request",
          method: "SDP-ANSWER",
          uri: "",
          version: "SIP/2.0",
          headers: [],
          body: new Uint8Array(),
        },
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
          message: {
            type: "request",
            method: "PRACK",
            uri: "",
            version: "SIP/2.0",
            headers: [],
            body: new Uint8Array(),
          },
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
          })
        }
      }
    }
  })
}
