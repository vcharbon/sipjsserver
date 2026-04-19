/**
 * Simulated backend — SignalingNetwork-driven in-process B2BUA, TestClock.
 *
 * Each test agent binds a real `UdpEndpoint` on the shared simulated
 * `SignalingNetwork` fabric at `{agentIp, agentPort}`. The B2BUA's own
 * `UdpTransport` facade binds at `{sipLocalIp, sipLocalPort}` on the same
 * fabric. Routing is purely by `dstIp:dstPort` — no Call-ID demux, no
 * `X-Test-Agent` fallback; agents appear to the B2BUA exactly the way a
 * real UDP stack would expose them.
 */

import { Clock, Effect, Layer, Option, Queue, Stream } from "effect"
import type { AgentInfo, ReceivedPacket, TestTransport } from "./types.js"
import { TransportError } from "./types.js"
import { UdpTransport } from "../../../src/sip/UdpTransport.js"
import { SignalingNetwork, type UdpEndpoint, type UdpPacket } from "../../../src/sip/SignalingNetwork.js"
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
import { recordFiring } from "./rule-usage-collector.js"

// ---------------------------------------------------------------------------
// Test rule registry: disable-on-env + handle-firing tracker
// ---------------------------------------------------------------------------

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
 * both directions. Wired to `SignalingNetwork.simulated({ transitDelayMs })`
 * — every endpoint-to-endpoint hop honors this delay.
 */
const NETWORK_DELAY_MS = 15

/**
 * Per-agent ingress queue capacity. Bounded by the `SignalingNetwork`
 * fabric's UdpEndpoint contract — picked high enough that no test runs
 * out of slack under plausible fan-in.
 */
const AGENT_QUEUE_MAX = 1024

// ---------------------------------------------------------------------------
// Per-agent record
// ---------------------------------------------------------------------------

interface AgentRecord {
  readonly ip: string
  readonly port: number
  readonly endpoint: UdpEndpoint
  readonly recvQueue: Queue.Queue<ReceivedPacket>
}

// ---------------------------------------------------------------------------
// Mock transport state
// ---------------------------------------------------------------------------

interface MockTransportState {
  readonly agents: Map<string, AgentRecord>
  /** Shared fabric reference — captured at setup, drained by verifyCleanState. */
  network: SignalingNetwork["Service"] | undefined
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
   * packet. Under TestClock-driven tests the harness passes a TestClock-
   * aware variant so the simulated-network delivery fibers can wake up.
   */
  clockSleep?: (ms: number) => Effect.Effect<void>
}): TestTransport {
  const sipPort = opts?.sipPort ?? 15060
  const httpPort = opts?.httpPort ?? 13002
  const clockSleep = opts?.clockSleep ?? ((ms: number) => Effect.sleep(`${ms} millis`))

  const mockState: MockTransportState = {
    agents: new Map(),
    network: undefined,
    callStateRef: undefined,
    timerServiceRef: undefined,
  }

  return {
    setup: (agentConfigs, _b2buaTarget) =>
      Effect.gen(function* () {
        const config = testAppConfig(sipPort, httpPort, opts?.configOverrides)
        const AppConfigLayer = Layer.succeed(AppConfig, config)

        // Yield the simulated fabric once — we share the same instance
        // between the B2BUA's UdpTransport and every per-agent endpoint
        // by re-providing it as Layer.succeed(SignalingNetwork, network)
        // when composing the B2BUA stack below.
        const network = yield* SignalingNetwork
        mockState.network = network
        const SharedNetworkLayer = Layer.succeed(SignalingNetwork, network)

        // Bind every agent on the fabric at its {ip, port}. Default ip
        // is 127.0.0.1 (matches legacy behavior — many scenarios hardcode
        // that host in routing responses). Default port auto-increments
        // from 15661 to avoid collision with the B2BUA's sipPort.
        let portCounter = 15661
        const agentInfos: Record<string, AgentInfo> = {}
        for (const [name, agentConfig] of Object.entries(agentConfigs)) {
          const ip = agentConfig.ip ?? "127.0.0.1"
          const port = agentConfig.port ?? portCounter++

          const endpoint = yield* network.bindUdp({
            ip,
            port,
            queueMax: AGENT_QUEUE_MAX,
          }).pipe(
            Effect.catch((err) =>
              new TransportError({
                message:
                  `Failed to bind agent "${name}" at ${ip}:${port}: ${err.message}`,
                cause: err,
              })
            )
          )

          const recvQueue = yield* Queue.unbounded<ReceivedPacket>()

          // Drain the endpoint's ingress stream into the per-agent
          // ReceivedPacket queue, stamping arrivalMs at dequeue time.
          // forkScoped so the drain fiber dies with the test scope.
          yield* Effect.forkScoped(
            Stream.runForEach(endpoint.messages, (pkt: UdpPacket) =>
              Effect.gen(function* () {
                const arrivalMs = yield* Clock.currentTimeMillis
                Queue.offerUnsafe(recvQueue, {
                  raw: pkt.raw,
                  rinfo: pkt.rinfo,
                  arrivalMs,
                })
              })
            )
          )

          mockState.agents.set(name, { ip, port, endpoint, recvQueue })
          agentInfos[name] = {
            ip,
            port,
            uri: agentConfig.uri,
            contact: `<sip:${ip}:${port};transport=udp>`,
          }
        }

        // Build the in-process B2BUA stack. UdpTransport binds on the
        // same fabric (via SharedNetworkLayer), so its ingress queue
        // receives everything an agent sends to {sipLocalIp, sipLocalPort}.
        const MetricsRegistryLayer = MetricsRegistry.layer

        const UdpLayer = UdpTransport.layer.pipe(
          Layer.provide(AppConfigLayer),
          Layer.provide(MetricsRegistryLayer),
          Layer.provide(SharedNetworkLayer)
        )

        const RedisLayer = RedisClient.layer.pipe(Layer.provide(AppConfigLayer))

        const CallLimiterLayer = CallLimiter.redisLayer.pipe(
          Layer.provide(AppConfigLayer),
          Layer.provide(RedisLayer)
        )

        const CallStateCacheLayer = CallStateCache.redisLayer.pipe(
          Layer.provide(RedisLayer)
        )

        const OverloadControllerLayer = OverloadController.layer.pipe(
          Layer.provide(AppConfigLayer),
          Layer.provide(MetricsRegistryLayer)
        )

        const SipLayer = B2buaCoreLayer.pipe(
          Layer.provide(AppConfigLayer),
          Layer.provide(UdpLayer),
          Layer.provide(OverloadControllerLayer),
          Layer.provide(CallStateCacheLayer),
          Layer.provide(CallLimiterLayer),
          Layer.provide(MockCallControlLayer),
          Layer.provide(NoOpTracingLayer),
          Layer.provide(NoOpCdrLayer),
        )

        // Capture service references for post-scenario state verification.
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
        // automatically when the test scope closes.
        const testHandlers = buildTestHandlers()
        const routerProgram = Effect.gen(function* () {
          const router = yield* SipRouter
          return yield* router.start(testHandlers)
        }).pipe(Effect.provide(SipLayer))
        yield* Effect.forkScoped(routerProgram)

        // Wait via real setTimeout (NOT Effect.sleep) so the SipRouter
        // stream wiring completes before the first test step — under
        // TestClock, Effect.sleep would block on virtual time that isn't
        // advancing yet.
        yield* Effect.callback<void>((resume) => {
          setTimeout(() => resume(Effect.void), 50)
        })

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            mockState.agents.clear()
            mockState.network = undefined
          })
        )

        return agentInfos
      }).pipe(Effect.provide(SignalingNetwork.simulated({ transitDelayMs: NETWORK_DELAY_MS }))),

    send: (agentName, buf, port, address) =>
      Effect.gen(function* () {
        const agent = mockState.agents.get(agentName)
        if (!agent) {
          return yield* new TransportError({ message: `Unknown agent "${agentName}"` })
        }
        // SendError on the simulated fabric is structurally impossible
        // (the fabric never fails send) — orDie to flatten the channel.
        yield* agent.endpoint.send(buf, port, address).pipe(Effect.orDie)
      }),

    receive: (agentName, timeoutMs) =>
      Effect.gen(function* () {
        const agent = mockState.agents.get(agentName)
        if (!agent) {
          return yield* new TransportError({ message: `Unknown agent "${agentName}"` })
        }

        if (timeoutMs <= 0) {
          const polled = yield* Queue.poll(agent.recvQueue)
          return Option.getOrNull(polled)
        }

        // Poll in small clock-advancing steps. Under TestClock the
        // fabric's forked delivery fibers need virtual time to advance
        // before they can enqueue; under real clock `clockSleep` is a
        // wall-clock `Effect.sleep`.
        let remaining = timeoutMs
        while (remaining > 0) {
          const polled = yield* Queue.poll(agent.recvQueue)
          if (Option.isSome(polled)) return polled.value
          const step = remaining < 1 ? remaining : 1
          yield* clockSleep(step)
          remaining -= step
        }
        const last = yield* Queue.poll(agent.recvQueue)
        return Option.getOrNull(last)
      }),

    settle: () =>
      // Yield the fiber scheduler enough times for any queued work
      // (notably TransactionLayer auto-ACK generation for non-2xx final
      // responses, which happens asynchronously after the response is
      // received) to complete before we sweep for unexpected messages.
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
        const network = mockState.network
        if (network) {
          const undelivered = yield* network.drainUndeliverable()
          if (undelivered.length > 0) {
            const summary = undelivered
              .map((p) => `${p.src.ip}:${p.src.port} → ${p.dst.ip}:${p.dst.port}`)
              .join(", ")
            errors.push(
              `SignalingNetwork: ${undelivered.length} undeliverable packet(s) ` +
              `(no endpoint bound at destination): ${summary}`
            )
          }
        }
        return errors
      }),

    networkDelayMs: NETWORK_DELAY_MS,
  }
}
