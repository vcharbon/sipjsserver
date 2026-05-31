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

import { Effect, Layer, Option, type Scope } from "effect"
import type {
  AgentInfo,
  NetworkTag,
  ReplicationTraceEntry,
  TestTransport,
} from "../../../src/test-harness/framework/types.js"
import { DEFAULT_NETWORK } from "../../../src/test-harness/framework/types.js"
import { pumpAll } from "../../support/pumpAll.js"
import { TransportError } from "../../../src/test-harness/framework/types.js"
import type { UdpEndpoint } from "../../../src/sip/SignalingNetwork.js"
import { SignalingNetwork } from "../../../src/sip/SignalingNetwork.js"
import { MediaEndpointTs } from "../../../src/media/ts/MediaEndpointTs.js"
import { SipRouter } from "../../../src/sip/SipRouter.js"
import { type AppConfigData } from "../../../src/config/AppConfig.js"
import { testAppConfigDefaults } from "../../../src/test-harness/config-defaults.js"
import { CallState } from "../../../src/call/CallState.js"
import { TimerService } from "../../../src/call/TimerService.js"
import { SimulatedK8sCluster } from "../../../src/test-harness/internal/SimulatedK8sCluster.js"
import { buildHandlers, ruleRegistry } from "../../../src/b2bua/B2buaCore.js"
import {
  createRuleRegistry,
  disableRule,
  transformRegistry,
  type RuleRegistry,
} from "../../../src/b2bua/rules/framework/RuleRegistry.js"
import type { PolicyModule } from "../../../src/b2bua/rules/framework/PolicyModule.js"
import { defaultRules } from "../../../src/b2bua/rules/defaults/index.js"
import { relayFirst18xTo180 } from "../../../src/b2bua/rules/custom/relayFirst18xTo180.js"
import { promote18xPemTo200 } from "../../../src/b2bua/rules/custom/promote18xPemTo200.js"
import { referTransfer } from "../../../src/b2bua/rules/custom/referTransfer.js"
import { recordFiring } from "../../../src/test-harness/framework/rule-usage-collector.js"
import { DEFAULT_TRANSIT_DELAY_MS, fakeStackLayer } from "../../support/fakeStack.js"
import {
  HA_PROXY_ADDR,
  HA_WORKER_ADDR,
  INGRESS_ADDR as PROXY_B2B_INGRESS,
  WORKER_ADDR as PROXY_B2B_WORKER,
  proxyB2bFakeStackLayer,
  sipproxyHAFakeStackLayer,
} from "../../support/proxyB2bFakeStack.js"
import { PartitionedRelayStorage } from "../../../src/cache/PartitionedRelayStorage.js"
import {
  type PartitionedRelayStorageChannel,
  type PartitionedRelayStorageEvent,
  toReplTrace,
} from "../../../src/cache/PartitionedRelayStorage.contracts.js"
import { makeRecorderApi } from "../../../src/test-harness/framework/report-recorder/Recorder.js"
import type { RecordedStamps } from "../../../src/test-harness/framework/report-recorder/types.js"
import {
  CORE_INGRESS as REGISTRAR_CORE_INGRESS,
  EXT_INGRESS as REGISTRAR_EXT_INGRESS,
  registrarFrontProxyFakeStackLayer,
} from "../../support/registrarFrontProxyFakeStack.js"
import {
  K8S_PROXY_ADDR,
  k8sFakeStackLayer,
  k8sWorkerAddr,
  k8sWorkerId,
} from "../../support/k8sFakeStack.js"
import { ProxyCore } from "../../../src/sip-front-proxy/index.js"

export type Sut =
  | "b2bonly"
  | "proxy+b2b"
  | "sipproxyHA"
  | "registrarFrontProxy"
  | "k8sFailover"

// ---------------------------------------------------------------------------
// Test rule registry: disable-on-env + handle-firing tracker
// ---------------------------------------------------------------------------

function buildTestHandlers(policyModules?: ReadonlyArray<PolicyModule>) {
  // A consumer passing `policyModules` gets a registry built the same way
  // production does (core defaults + the two shipped customs + REFER) with
  // their modules layered on top — proving an integrator's policy at the
  // wire level. Otherwise reuse the canonical production registry.
  let registry: RuleRegistry =
    policyModules !== undefined && policyModules.length > 0
      ? createRuleRegistry(defaultRules, [
          relayFirst18xTo180,
          promote18xPemTo200,
          referTransfer,
          ...policyModules,
        ])
      : ruleRegistry
  const killId = process.env.KILL_RULE
  if (killId !== undefined && killId.length > 0) {
    registry = disableRule(registry, killId)
  }
  registry = transformRegistry(registry, {
    wrapHandle: (rule, original) => (ctx) =>
      Effect.map(original(ctx), (outcome) => {
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
  readonly network: NetworkTag
}

// ---------------------------------------------------------------------------
// Mock transport state
// ---------------------------------------------------------------------------

interface MockTransportState {
  readonly agents: Map<string, AgentRecord>
  /**
   * `ext` fabric — the SignalingNetwork from the FakeStackLayer the
   * B2BUA / front-proxy bind on. Captured at setup, drained by
   * verifyCleanState.
   */
  extNetwork: SignalingNetwork["Service"] | undefined
  /**
   * `core` fabric — lazily materialized in setup() if any agent declares
   * `network: "core"`. Slice 1: nothing in production code uses this
   * fabric yet (no proxy is bound on it); the harness builds it so the
   * report path round-trips traces tagged with the `core` network.
   * Slice 2 wires the registrar proxy's K8s-facing endpoint here.
   */
  coreNetwork: SignalingNetwork["Service"] | undefined
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
  /**
   * True when the surrounding vitest runner is `it.live` (real clock +
   * real UDP). Drives the end-of-scenario settle: fake tests get a 24h
   * TestClock sweep; real tests get a short wall-clock sleep.
   */
  realClock?: boolean
  /**
   * SUT topology under test. `b2bonly` is the canonical fake stack:
   * agents talk to a single B2BUA. `proxy+b2b` puts a `ProxyCore` in
   * front of one B2BUA worker on the same SignalingNetwork — the
   * scenario body is unchanged; only the topology around it differs.
   */
  sut?: Sut
  /**
   * When true, the SUT's worker config(s) do NOT receive
   * `b2bOutboundProxy`. Reproduces the k8s production-deployment shape
   * that omitted `B2B_OUTBOUND_PROXY`. Only meaningful for SUTs that
   * include a proxy (`proxy+b2b`, `sipproxyHA`, `k8sFailover`). See
   * `keepalive-via-proxy.ts` for the regression-guard scenario.
   */
  simulateMissingOutboundProxy?: boolean
  /**
   * Integrator policy modules / callflow services to layer on top of the
   * production registry, so a consumer can run a wire-level e2e of their own
   * policy (`createSimulatedRunner({ policyModules: [myPolicy] })`). When set,
   * the registry is rebuilt from core defaults + the shipped customs + these
   * modules; otherwise the production registry is reused.
   */
  policyModules?: ReadonlyArray<PolicyModule>
}): TestTransport {
  const sipPort = opts?.sipPort ?? 15060
  const httpPort = opts?.httpPort ?? 13002
  const clockSleep = opts?.clockSleep ?? ((ms: number) => Effect.sleep(`${ms} millis`))
  const sut: Sut = opts?.sut ?? "b2bonly"
  const simulateMissingOutboundProxy = opts?.simulateMissingOutboundProxy === true

  const config = testAppConfig(sipPort, httpPort, opts?.configOverrides)

  // Replication-frame channel: captures every Data frame the simulated
  // `/replog` HTTP transport emits between workers. Backed by a
  // self-contained `Recorder.forTag(PartitionedRelayStorage)` instance —
  // the simulated-backend owns the buffer lifecycle (the SUT stack
  // layers below do not yet require a `Recorder` service). Currently
  // wired only for SUTs that run replication via a per-worker puller
  // fiber. Drained at scenario end through the typed-channel projector
  // and surfaced as `ScenarioResult.replicationTrace` for the report.
  const replicationRecorderApi =
    sut === "sipproxyHA" || sut === "k8sFailover"
      ? makeRecorderApi("fake")
      : undefined
  const replicationTraceChannel: PartitionedRelayStorageChannel | undefined =
    replicationRecorderApi !== undefined
      ? replicationRecorderApi.forTag<
          PartitionedRelayStorage,
          PartitionedRelayStorageEvent
        >(PartitionedRelayStorage)
      : undefined

  const StackLayer =
    sut === "sipproxyHA"
      ? sipproxyHAFakeStackLayer({
          config,
          handlers: buildTestHandlers(opts?.policyModules),
          simulateMissingOutboundProxy,
          ...(replicationTraceChannel !== undefined
            ? { replicationTraceChannel }
            : {}),
        })
      : sut === "k8sFailover"
        ? k8sFakeStackLayer({
            config,
            handlers: buildTestHandlers(opts?.policyModules),
            simulateMissingOutboundProxy,
            ...(replicationTraceChannel !== undefined
              ? { replicationTraceChannel }
              : {}),
          })
        : sut === "proxy+b2b"
          ? proxyB2bFakeStackLayer({ config, simulateMissingOutboundProxy })
          : sut === "registrarFrontProxy"
            ? registrarFrontProxyFakeStackLayer({ config, recordRoute: true })
            : fakeStackLayer({ config, realClock: opts?.realClock === true })

  // MediaEndpoint rides the SAME SignalingNetwork the stack exposes (one
  // build → memoised → shared instance), so RTP shares the agents' fabric.
  // Raw binds keep RTP out of the SIP audit channel + tracer. Inert until a
  // scenario opens a transport — media is opt-in per test (ADR-0017).
  //
  // `StackLayer` is a union across SUT variants; the cast collapses it to a
  // single SignalingNetwork-providing shape so `provideMerge` typechecks.
  // It changes nothing at runtime — provideMerge merges StackLayer's full
  // built environment, so every stack service still flows through.
  const StackLayerWithMedia = MediaEndpointTs.pipe(
    Layer.provideMerge(StackLayer as unknown as Layer.Layer<SignalingNetwork>),
  )

  const mockState: MockTransportState = {
    agents: new Map(),
    extNetwork: undefined,
    coreNetwork: undefined,
    callStateRef: undefined,
    timerServiceRef: undefined,
  }

  // (ip,port) → NetworkTag. Slice 1: every entry is "ext" (the SUT's
  // ingress and every test agent live there). Slice 2 will register
  // proxy participants on "core" too. Built alongside `participantLabels`
  // and queried by the report renderer to colour lanes by fabric.
  const participantNetworks = new Map<string, NetworkTag>()

  // Participant registry: (ip,port) → label. Seeded with SUT-side
  // participants (proxy / worker / b2bua) up-front, then extended in
  // setup() with each agent's bind address. Used by the report renderer
  // to label network-trace entries that don't originate from an agent.
  const participantLabels = new Map<string, string>()
  const labelKey = (ip: string, port: number) => `${ip}:${port}`
  if (sut === "proxy+b2b") {
    const proxyKey = labelKey(PROXY_B2B_INGRESS.host, PROXY_B2B_INGRESS.port)
    const workerKey = labelKey(PROXY_B2B_WORKER.host, PROXY_B2B_WORKER.port)
    participantLabels.set(proxyKey, "proxy")
    participantLabels.set(workerKey, "worker-1")
    participantNetworks.set(proxyKey, "ext")
    participantNetworks.set(workerKey, "ext")
  } else if (sut === "registrarFrontProxy") {
    // Registrar mode: the proxy participates on BOTH fabrics. Seed
    // distinct labels so the report renderer can identify the same
    // logical proxy at two different (ip,port) pairs and paint each
    // lane with the corresponding network.
    const extKey = labelKey(REGISTRAR_EXT_INGRESS.host, REGISTRAR_EXT_INGRESS.port)
    const coreKey = labelKey(REGISTRAR_CORE_INGRESS.host, REGISTRAR_CORE_INGRESS.port)
    participantLabels.set(extKey, "proxy(ext)")
    participantLabels.set(coreKey, "proxy(core)")
    participantNetworks.set(extKey, "ext")
    participantNetworks.set(coreKey, "core")
  } else if (sut === "sipproxyHA") {
    const proxyKey = labelKey(HA_PROXY_ADDR.host, HA_PROXY_ADDR.port)
    participantLabels.set(proxyKey, "proxy")
    participantNetworks.set(proxyKey, "ext")
    const w1 = HA_WORKER_ADDR(1)
    const w2 = HA_WORKER_ADDR(2)
    const w1Key = labelKey(w1.host, w1.port)
    const w2Key = labelKey(w2.host, w2.port)
    participantLabels.set(w1Key, "b2b-1")
    participantLabels.set(w2Key, "b2b-2")
    participantNetworks.set(w1Key, "ext")
    participantNetworks.set(w2Key, "ext")
  } else if (sut === "k8sFailover") {
    // Same subnet conventions as sipproxyHA — proxy on 10.10, workers
    // on 10.20.0.{ordinal}. Hard-coded for the default `workerCount=2`
    // the failover-harness layer pre-allocates; if a future scenario
    // bumps the count, extend the seed here.
    const proxyKey = labelKey(K8S_PROXY_ADDR.host, K8S_PROXY_ADDR.port)
    participantLabels.set(proxyKey, "proxy")
    participantNetworks.set(proxyKey, "ext")
    for (let n = 1; n <= 2; n++) {
      const addr = k8sWorkerAddr(n)
      const key = labelKey(addr.host, addr.port)
      participantLabels.set(key, k8sWorkerId(n) as unknown as string)
      participantNetworks.set(key, "ext")
    }
  } else {
    const k = labelKey("127.0.0.1", sipPort)
    participantLabels.set(k, "B2BUA")
    participantNetworks.set(k, "ext")
  }

  return {
    kind: "fake" as const,
    // `TestTransport.stackLayer` is the marker type `Layer<never>`; the fully
    // built fake stack provides a service union, which the runner provides and
    // casts away (harness.ts). Narrow to the field's marker type here.
    stackLayer: StackLayerWithMedia as Layer.Layer<never>,
    setup: (agentConfigs, _b2buaTarget) =>
      (Effect.gen(function* () {
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
        mockState.extNetwork = network

        // Slice 3 reconciliation: the registrar proxy SUT binds BOTH its
        // ext and core endpoints on the single layer-provided
        // `SignalingNetwork`, with the "fabric" boundary encoded in IP
        // subnets (10.30/10.40, like sipproxyHA's encoding). So core
        // agents share the same fabric as ext agents — the
        // `agentConfig.network` tag is purely informational for trace /
        // report partitioning. A future "real-ext + simulated-core"
        // hybrid would re-introduce a second materialised
        // `SignalingNetwork`; that's out of scope until a deployment
        // actually needs it.

        if (sut === "sipproxyHA" || sut === "k8sFailover") {
          // Both HA SUT layers auto-start their worker SipRouters
          // and HealthProbe internally. Force-materialise ProxyCore
          // so its forked ingress fiber starts. Per-worker
          // CallState / TimerService instances live inside the SUT
          // layer's scope and aren't exposed outward, so HA-style
          // scenarios opt into `skipFinalSweep` to skip the
          // verifyCleanState pass that targets the missing handles.
          yield* ProxyCore
        } else if (sut === "registrarFrontProxy") {
          // Registrar mode: ProxyCore-only. No B2BUA, no SipRouter,
          // no CallState — force-materialise the proxy so its dual-
          // endpoint ingress fibers (ext + core) bind on the shared
          // simulated fabric. Scenarios opt into `skipFinalSweep` so
          // the harness doesn't try to verifyCleanState on
          // CallState/TimerService that don't exist in this SUT.
          yield* ProxyCore
        } else {
          // Legacy SUTs (b2bonly, proxy+b2b): the worker's SipRouter
          // is exposed by the layer; yield it and fork
          // `router.start` here. Snapshot CallState/TimerService for
          // verifyCleanState while we have them.
          const callState = yield* CallState
          const timerService = yield* TimerService
          const router = yield* SipRouter

          if (sut === "proxy+b2b") {
            // Force ProxyCore to materialize so its forked ingress
            // fiber starts. (See ProxyCore.ts:274.)
            yield* ProxyCore
          }

          mockState.callStateRef = callState
          mockState.timerServiceRef = timerService

          const testHandlers = buildTestHandlers(opts?.policyModules)
          yield* Effect.forkScoped(router.start(testHandlers))
        }

        // Bind every agent on the fabric at its {ip, port}. Default ip
        // is 127.0.0.1 (matches legacy behavior — many scenarios hardcode
        // that host in routing responses). Default port auto-increments
        // from 15661 to avoid collision with the B2BUA's sipPort.
        let portCounter = 15661
        const agentInfos: Record<string, AgentInfo> = {}
        for (const [name, agentConfig] of Object.entries(agentConfigs)) {
          const ip = agentConfig.ip ?? "127.0.0.1"
          const port = agentConfig.port ?? portCounter++
          const agentNetwork: NetworkTag = agentConfig.network ?? DEFAULT_NETWORK

          const endpoint = yield* network.bindUdp({
            ip,
            port,
            queueMax: AGENT_QUEUE_MAX,
          }).pipe(
            Effect.catchTag("BindError", (err) =>
              Effect.fail(new TransportError({
                message:
                  `Failed to bind agent "${name}" at ${ip}:${port} on network ${agentNetwork}: ${err.message}`,
                cause: err,
              }))
            )
          )

          // No per-agent ReceivedPacket queue: arrivalMs is stamped at
          // ingress by SignalingNetwork, and the harness reads straight
          // off endpoint.poll() / endpoint.take().
          mockState.agents.set(name, { ip, port, endpoint, network: agentNetwork })
          participantLabels.set(labelKey(ip, port), name)
          participantNetworks.set(labelKey(ip, port), agentNetwork)
          agentInfos[name] = {
            ip,
            port,
            uri: agentConfig.uri,
            contact: `<sip:${ip}:${port};transport=udp>`,
          }
        }

        // (Per-SUT router-start handled above: legacy SUTs fork their
        // single exposed `SipRouter` early; sipproxyHA auto-starts
        // both workers inside the SUT layer.)

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
            mockState.extNetwork = undefined
            mockState.coreNetwork = undefined
            mockState.callStateRef = undefined
            mockState.timerServiceRef = undefined
          })
        )

        return agentInfos
      }) as Effect.Effect<Record<string, AgentInfo>, TransportError, Scope.Scope>),

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

    participantLabel: (ip: string, port: number) =>
      participantLabels.get(labelKey(ip, port)),

    drainNetworkTrace: () =>
      Effect.gen(function* () {
        // Concatenate trace from both fabrics. Slice 1: only `ext` ever
        // has traffic; slice 2's cross-fabric registrar tests will fill
        // the `core` side too. Order isn't guaranteed across fabrics —
        // the interpreter re-sorts by timestamp anyway.
        const ext = mockState.extNetwork
        const core = mockState.coreNetwork
        const out = ext === undefined ? [] : [...(yield* ext.drainTrace())]
        if (core !== undefined) {
          const coreEntries = yield* core.drainTrace()
          for (const e of coreEntries) out.push(e)
        }
        return out
      }),

    drainReplicationTrace: (): ReadonlyArray<ReplicationTraceEntry> => {
      if (replicationTraceChannel === undefined) return []
      const events = Effect.runSync(
        replicationTraceChannel.snapshot,
      ) as ReadonlyArray<PartitionedRelayStorageEvent & RecordedStamps>
      const projected = toReplTrace(events)
      return projected.replTrace ?? []
    },

    settle: () =>
      // End-of-scenario sweep — replaces the hand-tuned `20×yieldNow →
      // 10×(adjust 50ms) → adjust 24h → 20×yieldNow` pattern. Two
      // `pumpAll` rounds:
      //
      //   1. `within: 500ms` — drains in-flight transit + immediate
      //      protocol responses without yet firing SIP retransmit timers
      //      (T1=500ms is the smallest retransmit interval). This is what
      //      the old "first 500ms in 50ms steps" comment was protecting:
      //      transit must complete before retransmits race deliver fibers.
      //
      //   2. `within: 24 hours` — fires every pending finalization timer
      //      (Timer B/H, CallState "terminating" drop, limiter window
      //      migration, keepalive interval, ...) so verifyCleanState sees
      //      a clean stack.
      //
      // Under realClock there's no virtual clock to advance — poll
      // `CallState.concurrent` until the post-BYE rule chain has fired
      // (it writes the CDR and removes the call in the same path, so
      // quiescence implies the CDR-completeness assertion will succeed).
      // HA SUTs hide per-worker CallState behind the cluster — they opt
      // into skipFinalSweep, so this branch isn't reached for them.
      Effect.gen(function* () {
        if (opts?.realClock) {
          const cs = mockState.callStateRef
          if (cs !== undefined) {
            const deadline = Date.now() + 2000
            while (Date.now() < deadline) {
              const { concurrent } = yield* cs.stats()
              if (concurrent === 0) return
              yield* Effect.sleep("20 millis")
            }
          } else {
            yield* Effect.sleep("100 millis")
          }
          return
        }
        // Phase A: drain transit + immediate responses.
        yield* pumpAll({ within: "500 millis" })
        // Phase B: fire long-tail cleanup timers.
        const r = yield* pumpAll({ within: "24 hours" })
        if (r.realProbeWasUseful) {
          yield* Effect.logWarning(
            `[pumpAll/settle] real-clock probe surfaced new work — ` +
            `test depends on external blocking I/O. Pending after probe: ` +
            `${r.remainingDeadlines.length}`,
          )
        }
        if (r.periodicSuspects.length > 0) {
          yield* Effect.logWarning(
            `[pumpAll/settle] periodic timer suspects (durationMs → fires): ` +
            r.periodicSuspects.map((p) => `${p.durationMillis}→${p.count}`).join(", "),
          )
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
        // For k8sFailover, the per-worker CallState/TimerService refs
        // captured above are undefined — those instances live inside
        // each worker's child scope. Consult the cluster service which
        // walks every still-live worker handle and reports leaks.
        if (sut === "k8sFailover") {
          const clusterOpt = yield* Effect.serviceOption(SimulatedK8sCluster)
          if (Option.isSome(clusterOpt)) {
            const clusterErrors =
              yield* clusterOpt.value.verifyCleanStateOnAllWorkers()
            for (const err of clusterErrors) errors.push(err)
          }
        }
        for (const [tag, network] of [
          ["ext", mockState.extNetwork] as const,
          ["core", mockState.coreNetwork] as const,
        ]) {
          if (!network) continue
          const undelivered = yield* network.drainUndeliverable()
          if (undelivered.length > 0) {
            const summary = undelivered
              .map((p) => `${p.src.ip}:${p.src.port} → ${p.dst.ip}:${p.dst.port}`)
              .join(", ")
            errors.push(
              `SignalingNetwork[${tag}]: ${undelivered.length} undeliverable packet(s) ` +
              `(no endpoint bound at destination): ${summary}`
            )
          }
        }
        return errors
      }),

    // M3: read transit delay off the service instead of a file-local
    // constant. The simulated layer always sets it; if someone later
    // swaps in a layer without a transit delay, we fall back to the
    // default so the trace renderer has a usable value. Both fabrics use
    // the same configured delay so reading from `ext` is sufficient.
    get networkDelayMs() {
      return mockState.extNetwork?.transitDelayMs ?? DEFAULT_TRANSIT_DELAY_MS
    },

    participantNetwork: (ip: string, port: number) =>
      participantNetworks.get(labelKey(ip, port)),
  }
}
