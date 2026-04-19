/**
 * Simulated backend — SignalingNetwork-driven in-process B2BUA, TestClock.
 *
 * The service stack itself lives in [tests/support/fakeStack.ts] — this
 * module is only the `TestTransport` shim that wires the scenario
 * interpreter up to that stack: binds a per-agent `UdpEndpoint` on the
 * shared fabric, forks `SipRouter.start`, and implements `send`/
 * `receive`/`verifyCleanState` against the shared service instances.
 *
 * Routing is purely by `dstIp:dstPort` — no Call-ID demux, no
 * `X-Test-Agent` fallback; agents appear to the B2BUA exactly the way a
 * real UDP stack would expose them.
 */

import { Effect } from "effect"
import type { AgentInfo, TestTransport } from "./types.js"
import { TransportError } from "./types.js"
import type { UdpEndpoint } from "../../../src/sip/SignalingNetwork.js"
import { SignalingNetwork } from "../../../src/sip/SignalingNetwork.js"
import { SipRouter } from "../../../src/sip/SipRouter.js"
import { type AppConfigData } from "../../../src/config/AppConfig.js"
import { testAppConfigDefaults } from "../../support/testAppConfigDefaults.js"
import { CallState } from "../../../src/call/CallState.js"
import { TimerService } from "../../../src/call/TimerService.js"
import { buildHandlers, ruleRegistry } from "../../../src/b2bua/B2buaCore.js"
import {
  disableRule,
  transformRegistry,
  type RuleRegistry,
} from "../../../src/b2bua/rules/framework/RuleRegistry.js"
import { recordFiring } from "./rule-usage-collector.js"
import { DEFAULT_TRANSIT_DELAY_MS, fakeStackLayer } from "../../support/fakeStack.js"

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
  return testAppConfigDefaults({
    sipLocalPort: sipPort,
    httpStatusPort: httpPort,
    callControlUrl: `http://localhost:${httpPort}`,
    ...overrides,
  })
}

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

  const config = testAppConfig(sipPort, httpPort, opts?.configOverrides)
  const StackLayer = fakeStackLayer({ config })

  const mockState: MockTransportState = {
    agents: new Map(),
    network: undefined,
    callStateRef: undefined,
    timerServiceRef: undefined,
  }

  return {
    stackLayer: StackLayer,
    setup: (agentConfigs, _b2buaTarget) =>
      Effect.gen(function* () {
        // All services come out of the single FakeStackLayer, so the
        // SignalingNetwork the agents bind on and the SignalingNetwork
        // inside the B2BUA's UdpTransport are guaranteed to be the same
        // instance. Ditto CallState / TimerService — we read the router's
        // actual instances for verifyCleanState, not a disconnected
        // second copy.
        //
        // StackLayer is provided at the *outer* scope by the runner (see
        // `createSimulatedRunner`) — NOT via `.pipe(Effect.provide(...))`
        // on this setup effect. Layer-scoped resources (UdpTransport's
        // bound endpoint; the forked router) must outlive setup() itself;
        // piping the provide here would finalize UdpTransport as soon as
        // setup returns and every subsequent packet would bounce as
        // undeliverable.
        const network = yield* SignalingNetwork
        const callState = yield* CallState
        const timerService = yield* TimerService
        const router = yield* SipRouter

        mockState.network = network
        mockState.callStateRef = callState
        mockState.timerServiceRef = timerService

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

          // No per-agent ReceivedPacket queue: arrivalMs is stamped at
          // ingress by SignalingNetwork, and the harness reads straight
          // off endpoint.poll() / endpoint.take().
          mockState.agents.set(name, { ip, port, endpoint })
          agentInfos[name] = {
            ip,
            port,
            uri: agentConfig.uri,
            contact: `<sip:${ip}:${port};transport=udp>`,
          }
        }

        // Fork SipRouter inside the surrounding scope so it's cancelled
        // automatically when the test scope closes.
        const testHandlers = buildTestHandlers()
        yield* Effect.forkScoped(router.start(testHandlers))

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
            mockState.callStateRef = undefined
            mockState.timerServiceRef = undefined
          })
        )

        return agentInfos
      }),

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
          return yield* agent.endpoint.poll()
        }

        // Poll in small clock-advancing steps. Under TestClock the
        // fabric's forked delivery fibers need virtual time to advance
        // before they can enqueue; under real clock `clockSleep` is a
        // wall-clock `Effect.sleep`.
        let remaining = timeoutMs
        while (remaining > 0) {
          const polled = yield* agent.endpoint.poll()
          if (polled !== null) return polled
          const step = remaining < 1 ? remaining : 1
          yield* clockSleep(step)
          remaining -= step
        }
        return yield* agent.endpoint.poll()
      }),

    settle: () =>
      // Yield the fiber scheduler enough times for any queued work
      // (notably TransactionLayer auto-ACK generation for non-2xx final
      // responses, which happens asynchronously after the response is
      // received) to complete before we sweep for unexpected messages.
      //
      // Under TestClock we additionally advance virtual time by a small
      // amount so that post-final-response cleanup timers (e.g. the
      // "terminating" state drop, non-INVITE transaction Timer K) can
      // fire before `verifyCleanState` reads CallState/TimerService.
      // 500ms is comfortably larger than any finalization timer in the
      // pipeline while staying well below the smallest scenario pause.
      Effect.gen(function* () {
        for (let i = 0; i < 20; i++) {
          yield* Effect.yieldNow
        }
        yield* clockSleep(500)
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

    // M3: read transit delay off the service instead of a file-local
    // constant. The simulated layer always sets it; if someone later
    // swaps in a layer without a transit delay, we fall back to the
    // default so the trace renderer has a usable value.
    get networkDelayMs() {
      return mockState.network?.transitDelayMs ?? DEFAULT_TRANSIT_DELAY_MS
    },
  }
}
