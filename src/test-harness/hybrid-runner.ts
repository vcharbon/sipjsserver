/**
 * Hybrid runner — fake in-process SIP agents (alice / bob1 / bob2 …) AND
 * an in-process register-proxy (dual-endpoint, registrar mode) on real
 * UDP sockets, with the kind-cluster b2bua stack as an opaque "core"
 * peer.
 *
 *   alice / bob ↔ proxy(ext)  ←─── proxy(core) ↔ kind hostPort:5060
 *                  ▲                                       │
 *                  │ shared SignalingNetwork.real          │
 *                  │ trace buffer                          ▼
 *                  └────── drainTrace() ──────►  in-cluster sip-front-proxy
 *                                                + b2bua-worker StatefulSet
 *                                                + mock call-control
 *
 * Why in-process: every UDP hop on both ext and core traverses the test
 * process, so `SignalingNetwork.real`'s built-in per-instance trace
 * buffer captures everything. The in-cluster LB → worker exchange is
 * intentionally invisible — it's "inside" the opaque core peer.
 *
 * Networking:
 *   - alice/bob bind on `0.0.0.0:<port>`, advertise `<bridge-gateway>:<port>`
 *     so kind pods can address them back.
 *   - proxy ext binds on `0.0.0.0:<EXT_PORT>`, advertised same way.
 *   - proxy core binds on `0.0.0.0:<CORE_PORT>`, advertised on the bridge
 *     gateway so the b2bua-worker (inside kind) can reach it for b-leg
 *     INVITE delivery.
 *   - proxy.coreDestination = kind hostPort `127.0.0.1:5060` (NodePort
 *     30060 → in-cluster sip-front-proxy).
 *
 * Reports land under `test-results/real-clock/registrarFrontProxy-kind/`.
 */

import { Data, Effect, Layer } from "effect"
import type { Scope } from "effect"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { executeScenario } from "./framework/interpreter.js"
import { createLiveTransport } from "./framework/live-backend.js"
import { formatReport } from "./framework/report.js"
import {
  writeScenarioReport,
  writeIndexReport,
} from "./framework/html-report.js"
import { writeTextReports } from "./framework/text-report.js"
import type {
  NetworkTag,
  Scenario,
  ScenarioResult,
  TestTransport,
} from "./framework/types.js"
import {
  ProxyCore,
  type SocketAddr,
} from "../sip-front-proxy/index.js"
import {
  SignalingNetwork,
  type NetworkTraceEntry,
} from "../sip/SignalingNetwork.js"
import type { AppConfigData } from "../config/AppConfig.js"
import { registrarFrontProxyHybridStackLayer } from "./hybrid-stacks/registrar-front-proxy.js"

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Result collection
// ---------------------------------------------------------------------------

const resultsByDir = new Map<string, ScenarioResult[]>()

function recordResult(result: ScenarioResult, outputDir: string): void {
  const textFilenames = writeTextReports(result, outputDir)
  writeScenarioReport(result, outputDir, textFilenames)
  let arr = resultsByDir.get(outputDir)
  if (!arr) {
    arr = []
    resultsByDir.set(outputDir, arr)
  }
  arr.push(result)
}

export function flushHybridIndexReport(outputDir: string): void {
  const results = resultsByDir.get(outputDir) ?? []
  if (results.length > 0) {
    writeIndexReport(results, outputDir)
  }
}

// ---------------------------------------------------------------------------
// Host-reachable IP discovery (kind docker bridge gateway)
// ---------------------------------------------------------------------------

export class HostReachableIpError extends Data.TaggedError("HostReachableIpError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class HybridScenarioFailure extends Data.TaggedError("HybridScenarioFailure")<{
  readonly scenarioName: string
  readonly report: string
}> {}

export const discoverHostReachableIp = Effect.tryPromise({
  try: async () => {
    const { stdout } = await execFileAsync("docker", [
      "network",
      "inspect",
      "kind",
      "--format",
      "{{range .IPAM.Config}}{{.Gateway}}\n{{end}}",
    ])
    const lines = stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    const ipv4 = lines.find((l) => !l.includes(":") && l.length > 0)
    if (!ipv4) {
      throw new HostReachableIpError({
        message: `Could not determine kind network gateway (got: ${JSON.stringify(lines)})`,
      })
    }
    return ipv4
  },
  catch: (err) =>
    new HostReachableIpError({
      message: `discoverHostReachableIp failed: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    }),
})

// ---------------------------------------------------------------------------
// Default test app config (used by the proxy SUT layer for queue sizing
// only — registrar mode doesn't run a B2BUA, so most fields are inert).
// ---------------------------------------------------------------------------

function defaultHybridAppConfig(): AppConfigData {
  return {
    sipLocalIp: "0.0.0.0",
    sipLocalPort: 5060,
    workerServiceName: "b2bua-worker",
    redisUrl: "redis://unused",
    limiterRedisUrl: "redis://unused",
    redisKeyPrefix: "hybrid",
    limiterWindowSeconds: 300,
    limiterActiveWindows: 3,
    limiterTtlSeconds: 1200,
    noAnswerTimeoutSec: 30,
    keepaliveIntervalSec: 900,
    keepaliveTimeoutSec: 10,
    callMaxDurationSec: 7200,
    cdrFilePath: "/tmp/hybrid-cdr.jsonl",
    httpStatusPort: 0,
    callControlUrl: "http://unused",
    callControlNewCallTimeoutMs: 5000,
    callControlFailureTimeoutMs: 5000,
    callControlReferTimeoutMs: 5000,
    redisFlushIdleMs: 2000,
    traceSampleRate: 0,
    otelTracesUrl: "http://unused",
    clusterWorkers: 0,
    workerIndex: -1,
    callContextTtlSec: 1800,
    callCleanupDelaySec: 32,
    udpQueueMax: 1024,
    udpQueueTier1ThresholdPct: 70,
    workerQueueEmergencyMax: 500,
    workerQueueInDialogMax: 400,
    workerQueueNewCallMax: 100,
    workerInDialogFullKillAfterMs: 60_000,
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
    scrubHeaders: [],
    otelMaxAttributeValueLength: 32_768,
    traceTombstoneEnabled: false,
  }
}

// ---------------------------------------------------------------------------
// Hybrid endpoints
// ---------------------------------------------------------------------------

export interface HybridEndpoints {
  /** Proxy ext bind (alice/bob send REGISTER + INVITE here). */
  readonly extBind: SocketAddr
  /** Proxy ext advertised host:port (what alice sees in Record-Route, etc.). */
  readonly extAdvertised: SocketAddr
  /** Proxy core bind (k8s SBC sends b-leg INVITE here). */
  readonly coreBind: SocketAddr
  /** Proxy core advertised host:port (kind-reachable). */
  readonly coreAdvertised: SocketAddr
  /** Where the proxy forwards out-of-registrar INVITEs (kind hostPort). */
  readonly coreDestination: SocketAddr
}

export interface HybridRunnerOptions {
  /** Discovered docker bridge gateway IP — host-reachable from kind pods. */
  readonly advertisedIp: string
  /** Proxy ext UDP port. Default 25080. */
  readonly extPort?: number
  /** Proxy core UDP port. Default 25081. */
  readonly corePort?: number
  /** Kind hostPort that maps to proxy NodePort. Default 127.0.0.1:5060. */
  readonly kindHost?: string
  readonly kindPort?: number
  /** Output directory for HTML / global.txt reports. */
  readonly outputDir?: string
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function createHybridRunner(opts: HybridRunnerOptions) {
  const extPort = opts.extPort ?? 25080
  const corePort = opts.corePort ?? 25081
  const kindHost = opts.kindHost ?? "127.0.0.1"
  const kindPort = opts.kindPort ?? 5060
  const outputDir =
    opts.outputDir ?? "test-results/real-clock/registrarFrontProxy-kind"

  const endpoints: HybridEndpoints = {
    extBind: { host: "0.0.0.0", port: extPort },
    extAdvertised: { host: opts.advertisedIp, port: extPort },
    coreBind: { host: "0.0.0.0", port: corePort },
    coreAdvertised: { host: opts.advertisedIp, port: corePort },
    coreDestination: { host: kindHost, port: kindPort },
  }

  const labelKey = (ip: string, port: number) => `${ip}:${port}`
  // Identify the proxy's own bind addresses + the kind-cluster ingress so
  // the trace renderer can paint them with meaningful names. The
  // advertised gateway IP also resolves to "proxy" (because that's what
  // the b-leg sees as the proxy's source).
  const labels = new Map<string, string>([
    [labelKey("0.0.0.0", extPort), "proxy(ext)"],
    [labelKey("0.0.0.0", corePort), "proxy(core)"],
    [labelKey(opts.advertisedIp, extPort), "proxy(ext)"],
    [labelKey(opts.advertisedIp, corePort), "proxy(core)"],
    [labelKey(kindHost, kindPort), "k8s-ingress"],
  ])
  const networks = new Map<string, NetworkTag>([
    [labelKey("0.0.0.0", extPort), "ext"],
    [labelKey("0.0.0.0", corePort), "core"],
    [labelKey(opts.advertisedIp, extPort), "ext"],
    [labelKey(opts.advertisedIp, corePort), "core"],
    [labelKey(kindHost, kindPort), "core"],
  ])

  const transportBase = createLiveTransport({
    bindIp: "0.0.0.0",
    advertisedIp: opts.advertisedIp,
    useExternalNetwork: true,
    participantLabels: labels,
    participantNetworkOverrides: networks,
  })
  const target = { host: endpoints.extAdvertised.host, port: endpoints.extAdvertised.port }

  // Build the proxy SUT layer (requires SignalingNetwork from R) and the
  // shared `SignalingNetwork.realTracing` layer; merge them so the
  // network is built ONCE and shared between the proxy and the agent
  // transport. `realTracing` (not `real`): this runner calls
  // `drainTrace()` at line 296 below to render hop-by-hop reports;
  // production layers MUST use `real` (recording disabled).
  const sharedNetworkLayer = SignalingNetwork.realTracing
  const proxySutLayer = registrarFrontProxyHybridStackLayer({
    config: defaultHybridAppConfig(),
    extBind: endpoints.extBind,
    extAdvertised: endpoints.extAdvertised,
    coreBind: endpoints.coreBind,
    coreAdvertised: endpoints.coreAdvertised,
    coreDestination: endpoints.coreDestination,
  })
  // Layer.provideMerge: the proxy gets SignalingNetwork from the shared
  // layer AND the shared layer is re-exported, so the outer effect can
  // also `yield* SignalingNetwork` to get the same instance for the
  // agent transport.
  const stackLayer = proxySutLayer.pipe(
    Layer.provideMerge(sharedNetworkLayer),
  )

  return (scenario: Scenario): Effect.Effect<void> => {
    const program = Effect.gen(function* () {
      const proxy = yield* ProxyCore
      yield* Effect.logInfo(
        `[hybrid-proxy] ext=${proxy.localAddress.ip}:${proxy.localAddress.port} ` +
          `core=${proxy.coreLocalAddress?.ip ?? "-"}:${proxy.coreLocalAddress?.port ?? "-"} ` +
          `→ core-dest=${endpoints.coreDestination.host}:${endpoints.coreDestination.port}`,
      )

      // Wrap the live transport so its drainNetworkTrace pulls from
      // the shared SignalingNetwork's per-instance buffer. Same-host
      // sender+receiver pairs record the same packet twice; dedupe on
      // `raw` and drop any entry that has no known participant on
      // either side (those are recv-side records using kernel-reported
      // ephemeral peer addresses that aren't in our label registry).
      const network = yield* SignalingNetwork
      const labelKeyOf = (ip: string, port: number) => `${ip}:${port}`
      const transport: TestTransport = {
        ...transportBase,
        drainNetworkTrace: () =>
          network.drainTrace().pipe(
            Effect.map((entries) => {
              const seen = new Set<string>()
              return entries.filter((e) => {
                const k = e.raw.toString("binary")
                if (seen.has(k)) return false
                seen.add(k)
                const srcKnown = labels.has(labelKeyOf(e.src.ip, e.src.port))
                const dstKnown = labels.has(labelKeyOf(e.dst.ip, e.dst.port))
                return srcKnown || dstKnown
              }) as ReadonlyArray<NetworkTraceEntry>
            }),
          ),
      }

      const result = yield* executeScenario(scenario, transport, target)
      console.log(formatReport(result))
      recordResult(result, outputDir)
      if (result.failed > 0) {
        const report = formatReport(result)
        return yield* new HybridScenarioFailure({
          scenarioName: result.scenarioName,
          report,
        })
      }
    })

    return Effect.orDie(
      Effect.scoped(
        program.pipe(Effect.provide(stackLayer)) as Effect.Effect<
          void,
          unknown,
          Scope.Scope
        >,
      ),
    )
  }
}

// ---------------------------------------------------------------------------
// Re-export the proxy endpoint addresses so scenarios can build X-Api-Call
// destinations pointing at the proxy's core endpoint.
// ---------------------------------------------------------------------------

/** Compute the proxy core destination as it must appear in X-Api-Call. */
export function hybridProxyCoreDestination(
  advertisedIp: string,
  corePort: number = 25081,
): { readonly host: string; readonly port: number } {
  return { host: advertisedIp, port: corePort }
}

// ---------------------------------------------------------------------------
// Consumer-facing convenience wrapper
// ---------------------------------------------------------------------------

export interface RegistrarTestProxyRunnerOptions {
  /**
   * Where the in-process registrar front-proxy forwards out-of-registrar
   * INVITEs — the consumer's third-party SUT (PBX / SBC / b2bua) on a
   * real IP:port.
   */
  readonly coreDestination: SocketAddr
  /**
   * IP address that alice / bob and the proxy advertise in Contact / Via /
   * From URIs. Must be reachable from the consumer's SUT for in-bound SIP
   * to come back. Default `127.0.0.1` (local-only test SUTs).
   */
  readonly advertisedIp?: string
  /** Proxy ext UDP port (where alice/bob send REGISTER + INVITE). */
  readonly extPort?: number
  /** Proxy core UDP port (where the SUT sends b-leg traffic). */
  readonly corePort?: number
  /** Output directory for HTML / global.txt reports. */
  readonly outputDir?: string
}

/**
 * One-call factory for the use-case-#1 hybrid harness:
 * fake in-process alice/bob agents + an in-process registrar front-proxy
 * that forwards out-of-registrar INVITEs to the consumer's real SIP
 * system at `opts.coreDestination`. Returns a function that takes a
 * `Scenario` and returns an `Effect<void>`; awaiting it runs the
 * scenario and writes reports into `opts.outputDir`.
 *
 * Use [flushHybridIndexReport] in an `afterAll` hook to emit the
 * combined HTML index for all scenarios that landed in the same
 * `outputDir`.
 */
export function createRegistrarTestProxyRunner(
  opts: RegistrarTestProxyRunnerOptions,
) {
  return createHybridRunner({
    advertisedIp: opts.advertisedIp ?? "127.0.0.1",
    extPort: opts.extPort ?? 25080,
    corePort: opts.corePort ?? 25081,
    kindHost: opts.coreDestination.host,
    kindPort: opts.coreDestination.port,
    outputDir: opts.outputDir ?? "test-results/registrar-test-proxy",
  })
}
