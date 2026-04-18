/**
 * Simulated backend — mock UdpTransport, in-process B2BUA, TestClock.
 *
 * Routes SIP buffers between test agents and the B2BUA through Effect Queues.
 * No real UDP sockets. Suitable for fast, deterministic tests.
 */

import { Cause, Clock, Data, Effect, Layer, Option, Queue, Stream } from "effect"
import type { AgentInfo, ReceivedPacket, TestTransport } from "./types.js"
import { TransportError } from "./types.js"
import { UdpTransport, type UdpPacket } from "../../../src/sip/UdpTransport.js"
import { OverloadController } from "../../../src/b2bua/OverloadController.js"
import { MetricsRegistry } from "../../../src/observability/MetricsRegistry.js"
import { SipRouter } from "../../../src/sip/SipRouter.js"
import { AppConfig, type AppConfigData } from "../../../src/config/AppConfig.js"
import { CallState } from "../../../src/call/CallState.js"
import { CallStateCache } from "../../../src/call/CallStateCache.js"
import { CallLimiter } from "../../../src/call/CallLimiter.js"
import { TimerService } from "../../../src/call/TimerService.js"
import { CdrWriter } from "../../../src/cdr/CdrWriter.js"
import { RedisClient } from "../../../src/redis/RedisClient.js"
import { TracingService } from "../../../src/tracing/TracingService.js"
import { MockCallControlLayer } from "./MockCallControlLayer.js"
import { buildHandlers, ruleRegistry, B2buaCoreLayer } from "../../../src/b2bua/B2buaCore.js"
import {
  disableRule,
  transformRegistry,
  type RuleRegistry,
} from "../../../src/b2bua/rules/framework/RuleRegistry.js"
import { customParser } from "../../../src/sip/parsers/custom/index.js"
import { getHeader } from "../../../src/sip/MessageFactory.js"
import { recordFiring } from "./rule-usage-collector.js"

// ---------------------------------------------------------------------------
// Test rule registry: disable-on-env + handle-firing tracker
// ---------------------------------------------------------------------------

/**
 * Build a HandlerRegistry for tests. Wraps the production rule registry so:
 *   1. If `KILL_RULE` is set, that rule's matches() is forced to false.
 *   2. Every non-undefined handle() result records a firing on the
 *      rule-usage collector, attributed to the current scenario.
 * Production B2buaCore.handlers is untouched.
 */
function buildTestHandlers() {
  let registry: RuleRegistry = ruleRegistry
  const killId = process.env.KILL_RULE
  if (killId !== undefined && killId.length > 0) {
    registry = disableRule(registry, killId)
  }
  registry = transformRegistry(registry, {
    wrapHandle: (rule, original) => (ctx, state, params) =>
      Effect.map(original(ctx, state, params), (outcome) => {
        if (outcome !== undefined && outcome !== null) {
          recordFiring(rule.id)
        }
        return outcome
      }),
  })
  return buildHandlers(registry)
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Simulated network propagation delay applied to every SIP message in
 * both directions (test agent ↔ B2BUA). Forked so the sender is not
 * blocked; the receiver observes the packet `NETWORK_DELAY_MS` after
 * the sender's send call.
 */
const NETWORK_DELAY_MS = 15

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort: parse a SIP buffer and register its Call-ID under the
 * given agent. Synchronous JS try/catch is used here because the
 * customParser throws on malformed input — wrapping in Effect would
 * just add ceremony for a fire-and-forget side-effect.
 */
function indexCallIdForAgent(
  state: { callIdToAgent: Map<string, string> },
  buf: Buffer,
  agentName: string
): void {
  try {
    const parsed = customParser.parse(buf)
    const callId = getHeader(parsed.headers, "Call-ID")
    if (callId !== undefined) {
      state.callIdToAgent.set(callId, agentName)
    }
  } catch (err) {
    console.warn(`[test] indexCallIdForAgent: parse failure for "${agentName}": ${String(err)}`)
  }
}

/**
 * Tagged defect raised when a B2BUA-emitted message fails to parse.
 * orDie'd at the call site so it surfaces as an unhandled defect, matching
 * the pre-refactor behavior where `throw new Error(...)` from inside
 * `Effect.sync` produced a Cause.Die.
 */
class DemuxParseError extends Data.TaggedError("DemuxParseError")<{
  readonly message: string
  readonly cause: unknown
}> {}

/**
 * Parse an outbound B2BUA message for demux. Uses `Effect.try` (not a bare
 * `try/catch` inside `Effect.sync`) to avoid the `effect(tryCatchInEffectGen)`
 * lint hint. `orDie` preserves the original "defect on malformed SIP"
 * semantics — the B2BUA must never emit unparseable messages.
 */
const parseOutboundForDemux = (msg: Buffer) =>
  Effect.try({
    try: () => customParser.parse(msg),
    catch: (err) => {
      const cr = msg.indexOf(0x0d)
      const summary = msg
        .subarray(0, cr > 0 ? Math.min(cr, 200) : Math.min(msg.length, 200))
        .toString("utf-8")
      return new DemuxParseError({
        message: `Simulated transport: outbound B2BUA message failed to parse: ${String(err)}. First line: ${summary}`,
        cause: err,
      })
    },
  }).pipe(Effect.orDie)

// ---------------------------------------------------------------------------
// Mock transport state
// ---------------------------------------------------------------------------

interface MockTransportState {
  /** Queue of packets destined for the B2BUA (from test agents). */
  toB2bua: Queue.Queue<UdpPacket, Cause.Done> | undefined
  /** Per-agent Effect queues of packets from the B2BUA. */
  readonly fromB2bua: Map<string, Queue.Queue<ReceivedPacket>>
  /** Call-ID → agent name mapping (for demuxing shared ports). */
  readonly callIdToAgent: Map<string, string>
  /** Agent name → address mapping. */
  readonly agentAddrs: Map<string, { ip: string; port: number }>
  /** Captured service references for post-scenario state verification. */
  callStateRef: CallState["Service"] | undefined
  timerServiceRef: TimerService["Service"] | undefined
}

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

function testAppConfig(sipPort: number, httpPort: number, overrides?: Partial<AppConfigData>): AppConfigData {
  return {
    sipLocalIp: "127.0.0.1",
    sipLocalPort: sipPort,
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    redisKeyPrefix: `test-${Date.now()}`,
    limiterWindowSeconds: 300,
    limiterActiveWindows: 3,
    limiterTtlSeconds: 1200,
    noAnswerTimeoutSec: 30,
    keepaliveIntervalSec: 900,
    keepaliveTimeoutSec: 10,
    callMaxDurationSec: 7200,
    cdrFilePath: "/tmp/test-cdr.jsonl",
    httpStatusPort: httpPort,
    callControlUrl: `http://localhost:${httpPort}`,
    redisFlushIdleMs: 2000,
    traceSampleRate: 0,
    otelTracesUrl: "http://localhost:4318/v1/traces",
    clusterWorkers: 0,
    workerIndex: -1,
    callContextTtlSec: 1800,
    callCleanupDelaySec: 0,
    udpQueueMax: 100,
    udpQueueTier1ThresholdPct: 70,
    workerQueueEmergencyMax: 500,
    workerQueueInDialogMax: 400,
    workerQueueNewCallMax: 100,
    workerInDialogFullKillAfterMs: 60000,
    cpsBucketSize: 1000,
    cpsBucketRate: 500,
    overloadLoopLagSoftMs: 50,
    overloadLoopLagHardMs: 200,
    overloadRoutingNewCallSoftMs: 200,
    overloadRoutingNewCallHardMs: 1000,
    retryAfterBaseSec: 5,
    retryAfterJitterSec: 5,
    emergencyListenerEnabled: false,
    emergencyListenerHost: "127.0.0.1",
    emergencyListenerPort: 5070,
    referSubscriptionExpirySec: 60,
    referReinviteAnswerSec: 32,
    referOverallSafetySec: 120,
    otelMaxAttributeValueLength: 32768,
    scrubHeaders: [],
    traceTombstoneEnabled: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// No-op tracing layer
// ---------------------------------------------------------------------------

const NoOpTracingLayer = Layer.succeed(TracingService, {
  decideSampling: () => false,
  withRootSpan: <A, E, R>(opts: {
    readonly name: string
    readonly sampled: boolean
    readonly attributes: Record<string, unknown>
    readonly effect: Effect.Effect<A, E, R>
  }): Effect.Effect<{ readonly result: A; readonly traceId: string; readonly spanId: string }, E, R> =>
    Effect.map(opts.effect, (result) => ({ result, traceId: "", spanId: "" })),
  withProcessingSpan: <A, E, R>(opts: {
    readonly call: any
    readonly name: string
    readonly attributes: Record<string, unknown>
    readonly effect: Effect.Effect<A, E, R>
  }): Effect.Effect<A, E, R> => opts.effect,
  emitSendSpan: () => Effect.void,
  emitTombstone: () => Effect.void,
  withErrorSpan: <A, E, R>(
    _name: string,
    _attributes: Record<string, unknown>,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> => effect,
  emitSpanEvents: () => Effect.void,
  scrubMessage: (raw: string) => raw,
})

// ---------------------------------------------------------------------------
// No-op CDR layer
// ---------------------------------------------------------------------------

const NoOpCdrLayer = Layer.succeed(CdrWriter, {
  write: (_call: any) => Effect.void,
})

// ---------------------------------------------------------------------------
// Simulated transport implementation
// ---------------------------------------------------------------------------

export function createSimulatedTransport(opts?: {
  sipPort?: number
  httpPort?: number
  configOverrides?: Partial<AppConfigData>
  /**
   * How to advance time inside `receive` while polling for a queued
   * packet. Under TestClock-driven tests (the default) this must call
   * `TestClock.adjust` so the forked {@link NETWORK_DELAY_MS}-delayed
   * delivery fibers can wake up and offer their packets. Under real-
   * clock mode the harness passes a `Effect.sleep`-based variant.
   */
  clockSleep?: (ms: number) => Effect.Effect<void>
}): TestTransport {
  const sipPort = opts?.sipPort ?? 15060
  const httpPort = opts?.httpPort ?? 13002
  const clockSleep = opts?.clockSleep ?? ((ms: number) => Effect.sleep(`${ms} millis`))

  const mockState: MockTransportState = {
    toB2bua: undefined,
    fromB2bua: new Map(),
    callIdToAgent: new Map(),
    agentAddrs: new Map(),
    callStateRef: undefined,
    timerServiceRef: undefined,
  }

  return {
    setup: (agents, _b2buaTarget) =>
      Effect.gen(function* () {
        const agentInfos: Record<string, AgentInfo> = {}
        let portCounter = 15661

        // Register agents — each must have a unique ip:port.
        const addrToAgent = new Map<string, string>()
        for (const [name, config] of Object.entries(agents)) {
          const port = config.port ?? portCounter++
          const ip = "127.0.0.1"
          const key = `${ip}:${port}`
          if (addrToAgent.has(key)) {
            return yield* new TransportError({
              message:
                `Port collision: agents "${addrToAgent.get(key)}" and "${name}" both use ${key}. ` +
                `Each test agent must have a unique ip:port.`,
            })
          }
          addrToAgent.set(key, name)

          mockState.agentAddrs.set(name, { ip, port })
          const q = yield* Queue.unbounded<ReceivedPacket>()
          mockState.fromB2bua.set(name, q)

          agentInfos[name] = {
            ip,
            port,
            uri: config.uri,
            contact: `<sip:${ip}:${port};transport=udp>`,
          }
        }

        // Build the in-process B2BUA stack inside the surrounding scope so
        // its fibers (TimerService, TransactionLayer, HTTP server) share
        // the same Effect runtime/clock as the test — required for
        // TestClock to drive simulated time end-to-end.
        const config = testAppConfig(sipPort, httpPort, opts?.configOverrides)
        const AppConfigLayer = Layer.succeed(AppConfig, config)

        const toB2bua = yield* Queue.unbounded<UdpPacket, Cause.Done>()
        mockState.toB2bua = toB2bua

        const mockTransportLayer = Layer.succeed(UdpTransport, {
          send: (msg: Buffer, port: number, address: string) =>
            parseOutboundForDemux(msg).pipe(
              Effect.flatMap((parsed) =>
                Effect.sync(() => {
                  // Demux outbound packets by Call-ID → agent mapping
                  const callId = getHeader(parsed.headers, "Call-ID")
                  const testAgent = getHeader(parsed.headers, "X-Test-Agent")
                  if (callId === undefined) return undefined

                  let agentName = mockState.callIdToAgent.get(callId)
                  if (agentName === undefined && testAgent !== undefined) {
                    // First message for this Call-ID — learn mapping from X-Test-Agent header
                    mockState.callIdToAgent.set(callId, testAgent)
                    agentName = testAgent
                  }
                  if (agentName === undefined) {
                    // Fallback: address-based routing for tests without X-Test-Agent
                    const key = `${address}:${port}`
                    const candidates: string[] = []
                    for (const [name, addr] of mockState.agentAddrs) {
                      if (`${addr.ip}:${addr.port}` === key) candidates.push(name)
                    }
                    if (candidates.length === 1) {
                      agentName = candidates[0]!
                      mockState.callIdToAgent.set(callId, agentName)
                    } else if (candidates.length > 1) {
                      throw new Error(
                        `Demux error: multiple agents at ${key} (${candidates.join(", ")}) ` +
                        `for Call-ID "${callId}" — add X-Test-Agent header to disambiguate`
                      )
                    } else {
                      throw new Error(
                        `Demux error: no agent at ${key} for Call-ID "${callId}"`
                      )
                    }
                  }
                  // agentName is guaranteed defined here: either from callIdToAgent, X-Test-Agent, or address fallback (which throws on failure)
                  const queue = mockState.fromB2bua.get(agentName!)
                  if (queue === undefined) {
                    throw new Error(
                      `Demux error: agent "${agentName}" not registered (Call-ID "${callId}")`
                    )
                  }
                  return queue
                })
              ),
              // Simulate 15ms network propagation before the test agent
              // observes the packet. Fork so the B2BUA's send-side fiber
              // is not blocked — under TestClock, a blocking sleep would
              // stall subsequent sends until the next clock adjust.
              // `arrivalMs` is stamped inside the forked fiber, after the
              // delay, so the receiver's trace reflects the enqueue time
              // rather than the send time.
              Effect.flatMap((queue) =>
                queue === undefined
                  ? Effect.void
                  : Effect.forkDetach(
                      Effect.sleep(`${NETWORK_DELAY_MS} millis`).pipe(
                        Effect.andThen(Clock.currentTimeMillis),
                        Effect.flatMap((arrivalMs) =>
                          Effect.sync(() =>
                            Queue.offerUnsafe(queue, {
                              raw: msg,
                              rinfo: { address: "127.0.0.1", port: sipPort },
                              arrivalMs,
                            })
                          )
                        )
                      )
                    ).pipe(Effect.asVoid)
              )
            ),
          messages: Stream.fromQueue(toB2bua),
          metrics: {
            queueDepth: 0,
            queueMax: config.udpQueueMax,
            dropsTier1Brake: 0,
            dropsTailDrop: 0,
            tier1RejectSent: 0,
          },
          localAddress: { ip: config.sipLocalIp, port: config.sipLocalPort },
        })

        const RedisLayer = RedisClient.layer.pipe(Layer.provide(AppConfigLayer))

        const CallLimiterLayer = CallLimiter.layer.pipe(
          Layer.provide(AppConfigLayer),
          Layer.provide(RedisLayer)
        )

        const CallStateCacheLayer = CallStateCache.redisLayer.pipe(
          Layer.provide(RedisLayer)
        )

        const MetricsRegistryLayer = MetricsRegistry.layer

        const OverloadControllerLayer = OverloadController.layer.pipe(
          Layer.provide(AppConfigLayer),
          Layer.provide(MetricsRegistryLayer)
        )

        // Compose B2BUA core with test-specific deps (mock transport,
        // mock call control, noop tracing/CDR).
        const SipLayer = B2buaCoreLayer.pipe(
          Layer.provide(AppConfigLayer),
          Layer.provide(mockTransportLayer),
          Layer.provide(OverloadControllerLayer),
          Layer.provide(CallStateCacheLayer),
          Layer.provide(CallLimiterLayer),
          Layer.provide(MockCallControlLayer),
          Layer.provide(NoOpTracingLayer),
          Layer.provide(NoOpCdrLayer),
        )

        // Capture service references for post-scenario state verification.
        // Use standalone layers (not the full SipLayer) to avoid building
        // and tearing down scoped resources (TransactionLayer, OverloadController)
        // before the router starts.
        const CallStateLayer = CallState.layer.pipe(
          Layer.provide(AppConfigLayer),
          Layer.provide(CallStateCacheLayer)
        )
        mockState.callStateRef = yield* Effect.gen(function* () {
          return yield* CallState
        }).pipe(Effect.provide(CallStateLayer))
        mockState.timerServiceRef = yield* Effect.gen(function* () {
          return yield* TimerService
        }).pipe(Effect.provide(TimerService.layer))

        // Fork SipRouter inside the surrounding scope so it's cancelled
        // automatically when the test scope closes. Use test handlers
        // (tracks rule firings, optionally disables one rule per KILL_RULE).
        const testHandlers = buildTestHandlers()
        const routerProgram = Effect.gen(function* () {
          const router = yield* SipRouter
          return yield* router.start(testHandlers)
        }).pipe(Effect.provide(SipLayer))
        yield* Effect.forkScoped(routerProgram)

        // Wait via real setTimeout (NOT Effect.sleep) so the SipRouter
        // stream wiring completes before the first test step.
        yield* Effect.callback<void>((resume) => {
          setTimeout(() => resume(Effect.void), 50)
        })

        // When the surrounding scope closes, clear the mock state.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            mockState.toB2bua = undefined
            mockState.fromB2bua.clear()
            mockState.callIdToAgent.clear()
            mockState.agentAddrs.clear()
          })
        )

        return agentInfos
      }),

    send: (agentName, buf, _port, _address) =>
      Effect.gen(function* () {
        const toB2bua = mockState.toB2bua
        if (!toB2bua) {
          return yield* new TransportError({ message: "Transport not set up" })
        }
        const agentAddr = mockState.agentAddrs.get(agentName)
        if (!agentAddr) {
          return yield* new TransportError({ message: `Unknown agent "${agentName}"` })
        }

        // Register Call-ID → agent mapping for A-side demuxing.
        // Parse failures are tolerated — we still send the packet and
        // let the B2BUA handle the malformed input.
        indexCallIdForAgent(mockState, buf, agentName)

        const packet: UdpPacket = {
          raw: buf,
          rinfo: { address: agentAddr.ip, port: agentAddr.port },
        }
        // Simulate 15ms network propagation before the B2BUA observes
        // the packet (see NETWORK_DELAY_MS). Forked so the test agent's
        // send returns immediately — under TestClock a blocking sleep
        // would stall the scenario interpreter.
        yield* Effect.forkDetach(
          Effect.sleep(`${NETWORK_DELAY_MS} millis`).pipe(
            Effect.andThen(Effect.sync(() => Queue.offerUnsafe(toB2bua, packet)))
          )
        )
      }),

    receive: (agentName, timeoutMs) =>
      Effect.gen(function* () {
        const queue = mockState.fromB2bua.get(agentName)
        if (!queue) {
          return yield* new TransportError({ message: `Unknown agent "${agentName}"` })
        }

        // Non-blocking poll path: required for the drain phase under
        // TestClock — a blocking sleep would never complete on its own
        // because nothing is advancing the test clock at drain time.
        if (timeoutMs <= 0) {
          const polled = yield* Queue.poll(queue)
          return Option.getOrNull(polled)
        }

        // Poll in small clock-advancing steps. Under TestClock, the
        // forked NETWORK_DELAY_MS-delayed offer needs the virtual clock
        // to advance before it can deliver — a plain Effect.race with
        // Effect.sleep would stall because nothing else advances time
        // during an expect step. The `clockSleep` knob is TestClock-
        // aware under simulated runs and wall-clock-based under live.
        let remaining = timeoutMs
        while (remaining > 0) {
          const polled = yield* Queue.poll(queue)
          if (Option.isSome(polled)) return polled.value
          const step = remaining < 1 ? remaining : 1
          yield* clockSleep(step)
          remaining -= step
        }
        const last = yield* Queue.poll(queue)
        return Option.getOrNull(last)
      }),

    settle: () =>
      // Yield the fiber scheduler enough times for any queued work
      // (notably TransactionLayer auto-ACK generation for non-2xx final
      // responses, which happens asynchronously after the response is
      // received) to complete before we sweep for unexpected messages.
      // 20 yields is empirically enough for multi-hop rule chains.
      Effect.gen(function* () {
        for (let i = 0; i < 20; i++) {
          yield* Effect.yieldNow
        }
      }),

    verifyCleanState: () =>
      Effect.gen(function* () {
        const errors: string[] = []
        const cs = mockState.callStateRef
        if (cs) {
          const { concurrent, total } = yield* cs.stats()
          if (concurrent > 0) {
            errors.push(
              `CallState leak: ${concurrent} call(s) still in memory ` +
              `(total created: ${total}). All calls should be removed after ` +
              `scenario completion — the "terminating" state should have resolved.`
            )
          }
        }
        const ts = mockState.timerServiceRef
        if (ts) {
          const active = yield* ts.activeCount()
          if (active > 0) {
            errors.push(
              `TimerService leak: ${active} timer(s) still active. ` +
              `All timers should be cancelled during call cleanup.`
            )
          }
        }
        return errors
      }),

    networkDelayMs: NETWORK_DELAY_MS,
  }
}
