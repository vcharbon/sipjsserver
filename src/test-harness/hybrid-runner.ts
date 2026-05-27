/**
 * Hybrid runner — fake in-process SIP agents + an in-process register-proxy,
 * with a dual-fabric topology:
 *
 *   ┌─────────────── ext (simulated fabric, in-memory) ───────────────┐
 *   │  alice (5.1.1.x:5060) ──┐                                       │
 *   │  bob   (5.1.2.x:5060) ──┼──► proxy(ext)  5.1.0.1:5060           │
 *   └─────────────────────────┴──────────────┬─────────────────────────┘
 *                                            │ same in-process proxy
 *   ┌─────────────────────── core (real UDP) ┴─────────────────────────┐
 *   │  proxy(core) <bridge-gw>:25081 ◄──► k8s-ingress 172.20.255.250:5060│
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Why dual-fabric: the ext side has NO real-network constraints —
 * `SignalingNetwork.simulated` routes purely by `ip:port` in an
 * in-memory table, so we pick deliberately exotic addresses
 * (`5.1.0.1` proxy, `5.1.1.x` alices, `5.1.2.x` bobs) that can't be
 * confused for a kind/WSL/RFC1918 host. The core side must talk to
 * real pods inside the kind cluster, so it uses
 * `SignalingNetworkCore.realTracing` bound on the docker-bridge
 * gateway IP discovered at startup. Both fabrics record per-instance
 * trace buffers; the runner drains both and merges by `sentMs` for
 * the unified hop-by-hop report.
 *
 *   ─ proxy(core) forwards out-of-registrar INVITEs to the kind
 *     cluster via the MetalLB VIP `172.20.255.250:5060` — same VIP
 *     `sipp -s uac 172.20.255.250:5060 -i <bridge-gw>` reaches.
 *     Override via `HybridRunnerOptions.kindHost` / `kindPort` or
 *     the `E2E_KIND_PROXY_HOST` / `E2E_KIND_PROXY_PORT` env vars.
 *   ─ The in-cluster LB → worker → mock-call-control exchange stays
 *     inside kind and is intentionally invisible — the proxy treats
 *     that as one opaque "core" peer.
 *
 * Reports land under `test-results/real-clock/registrarFrontProxy-kind/`.
 */

import { Data, Effect, Layer } from "effect"
import type { Scope } from "effect"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { makeEventSequencer } from "./framework/EventSequencer.js"
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
  SignalingNetworkCore,
  type NetworkTraceEntry,
  type NetworkTraceSequencer,
} from "../sip/SignalingNetwork.js"
import type { AppConfigData } from "../config/AppConfig.js"
import { registrarFrontProxyHybridStackLayer } from "./hybrid-stacks/registrar-front-proxy.js"

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Synthetic fake-fabric addressing convention
// ---------------------------------------------------------------------------

/** Proxy(ext) ingress on the simulated fabric. */
export const FAKE_PROXY_EXT_IP = "5.1.0.1"

/** Build an `alice<n>` synthetic IP on the simulated fabric. */
export const fakeAliceIp = (n: number): string => `5.1.1.${n}`

/** Build a `bob<n>` synthetic IP on the simulated fabric. */
export const fakeBobIp = (n: number): string => `5.1.2.${n}`

/**
 * Default UDP port for every endpoint on the simulated ext fabric.
 * The simulated fabric routes by `(ip, port)` so all participants can
 * share one port — the IPs disambiguate. We pick the SIP well-known
 * port `5060` here precisely because the fabric is in-memory: there's
 * no kernel-level conflict with the host's real `5060` socket (used
 * elsewhere), and using the canonical SIP port keeps the traces
 * looking like wire-level SIP without a contrived port suffix.
 */
export const FAKE_EXT_PORT = 5060

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
    sipUdpStack: "js",
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
    eventHandlerTimeoutMs: 10_000,
    timerHandlerTimeoutMs: 5_000,
    maxMessagesPerCall: 100,
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
    overloadPanicEluThreshold: 0.75,
    retryAfterBaseSec: 5,
    retryAfterJitterSec: 5,
    emergencyListenerEnabled: false,
    emergencyListenerHost: "127.0.0.1",
    emergencyListenerPort: 5070,
    referSubscriptionExpirySec: 60,
    referReinviteAnswerSec: 32,
    referOverallSafetySec: 120,
    scrubHeaders: [],
    workerAllowedTargetSuffixes: ["*"],
    proxyIngressConcurrency: 1,
    bufferedSendPerPeerQueueMax: 32,
    bufferedSendIdleTtlMs: 5_000,
    bufferedSendMaxPeers: 10_000,
    bufferedSendSweepIntervalMs: 1_000,
    cdrBufferQueueMax: 0,
    storageBufferQueueMax: 0,
    storageBufferDrainers: 4,
    storageDropFallbackMs: 1000,
    limiterDecrementTimeoutMs: 1000,
    eventDispatchConcurrency: 1024,
    perCallQueueCap: 200_000,
    perCallQueueDepth: 64,
    otelMaxAttributeValueLength: 32_768,
    traceTombstoneEnabled: false,
    replicationBootstrapTimeoutMs: 30_000,
  }
}

// ---------------------------------------------------------------------------
// Hybrid endpoints
// ---------------------------------------------------------------------------

export interface HybridEndpoints {
  /** Proxy ext bind (alice/bob send REGISTER + INVITE here). Simulated fabric. */
  readonly extBind: SocketAddr
  /** Proxy ext advertised host:port. Equals `extBind` — fabric is in-memory. */
  readonly extAdvertised: SocketAddr
  /** Proxy core bind (k8s SBC sends b-leg INVITE here). Real UDP. */
  readonly coreBind: SocketAddr
  /** Proxy core advertised host:port (kind-reachable, real UDP). */
  readonly coreAdvertised: SocketAddr
  /** Where the proxy forwards out-of-registrar INVITEs (real UDP, cluster ingress). */
  readonly coreDestination: SocketAddr
}

export interface HybridRunnerOptions {
  /**
   * Docker-bridge gateway IP discovered via `discoverHostReachableIp`.
   * Used as bind + advertised host for the REAL UDP core endpoint, so
   * kind pods can route their b-leg INVITE back to the host process.
   */
  readonly advertisedIp: string
  /**
   * Proxy core UDP port on the host. Real socket — must not conflict
   * with anything else listening on the host. Default 25081.
   */
  readonly corePort?: number
  /**
   * Cluster ingress host and port — typically the MetalLB-assigned VIP
   * for the in-cluster `sip-front-proxy` Service. Default
   * `172.20.255.250:5060` (the VIP `sipp` reaches in this lab).
   */
  readonly kindHost?: string
  readonly kindPort?: number
  /** Output directory for HTML / global.txt reports. */
  readonly outputDir?: string
  /**
   * Whether the proxy stamps Record-Route on dialog-creating requests.
   * `true` preserves existing register-proxy behaviour; `false` selects
   * the non-record-routing mode (in-dialog traffic bypasses the proxy).
   */
  readonly recordRoute: boolean
  /**
   * When `true`, the proxy reuses the ext fabric for the core endpoint —
   * `SignalingNetworkCore` is not provided to the layer composition and
   * ProxyCore falls back to the ext `SignalingNetwork` for both endpoints.
   * Use this for all-real-UDP single-fabric topologies where both proxy
   * endpoints and the agents share one routable address space.
   */
  readonly singleFabric?: boolean
  /** Override the proxy ext endpoint bind (default: synthetic 5.1.0.1:5060). */
  readonly extBind?: SocketAddr
  /** Override the proxy ext endpoint advertised address (default: same as extBind). */
  readonly extAdvertised?: SocketAddr
  /** Override the proxy core endpoint bind (default: {advertisedIp, corePort}). */
  readonly coreBind?: SocketAddr
  /** Override the proxy core endpoint advertised address (default: same as coreBind). */
  readonly coreAdvertised?: SocketAddr
  /**
   * Explicit ext-side fabric layer. Default: `SignalingNetwork.simulated`
   * with `transitDelayMs: 0` (the current dual-fabric default).
   */
  readonly extNetworkLayer?: Layer.Layer<SignalingNetwork>
  /**
   * Explicit core-side fabric layer. Default: `SignalingNetworkCore.realTracing`.
   * Ignored when `singleFabric === true`.
   */
  readonly coreNetworkLayer?: Layer.Layer<SignalingNetworkCore>
  /**
   * Shared trace sequencer for cross-fabric `NetworkTraceEntry.seq`
   * monotonicity. When the consumer also passes their own network
   * layers built with a sequencer, they MUST pass the same sequencer
   * here so the merged report orders events deterministically. One is
   * created internally if omitted.
   */
  readonly traceSequencer?: NetworkTraceSequencer
  /**
   * IPs the kernel uses as a "ghost" source alias for host-bound
   * traffic. WSL2 rewrites a host-bound source IP to `10.255.255.254`
   * on the docker bridge while preserving the port; the label lookup
   * then falls back to port-only matching for these IPs so the report
   * collapses ghosts onto their canonical participants. Default
   * includes the well-known WSL2 alias; pass a custom set for other
   * environments or to disable the fallback.
   */
  readonly ghostIps?: ReadonlySet<string>
  /**
   * Label assigned to any participant whose address isn't in our
   * explicit registry (agents + proxy endpoints + kind-ingress VIP).
   * Folds cluster-internal SNAT'd sources (e.g. the kind worker node
   * IP at 172.20.0.4 that b2bua-pod traffic appears to come from)
   * into a single lane in the report. Default `"k8s"`.
   */
  readonly clusterFallbackLabel?: string
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function createHybridRunner(opts: HybridRunnerOptions) {
  const corePort = opts.corePort ?? 25081
  const kindHost = opts.kindHost ?? "172.20.255.250"
  const kindPort = opts.kindPort ?? 5060
  const outputDir =
    opts.outputDir ?? "test-results/real-clock/registrarFrontProxy-kind"
  const singleFabric = opts.singleFabric === true

  const defaultExtBind: SocketAddr = { host: FAKE_PROXY_EXT_IP, port: FAKE_EXT_PORT }
  const extBind = opts.extBind ?? defaultExtBind
  const extAdvertised = opts.extAdvertised ?? extBind
  const defaultCoreBind: SocketAddr = { host: opts.advertisedIp, port: corePort }
  const coreBind = opts.coreBind ?? defaultCoreBind
  const coreAdvertised = opts.coreAdvertised ?? coreBind
  const endpoints: HybridEndpoints = {
    extBind,
    extAdvertised,
    coreBind,
    coreAdvertised,
    coreDestination: { host: kindHost, port: kindPort },
  }

  const labelKey = (ip: string, port: number) => `${ip}:${port}`
  // Static label registry for endpoints whose addresses don't appear in
  // the per-agent label map populated by live-backend (alice/bob auto-
  // register themselves). With dual fabrics there are no kernel-source-
  // address surprises — every recorded src/dst matches one of these.
  const labels = new Map<string, string>([
    [labelKey(endpoints.extBind.host, endpoints.extBind.port), "proxy(ext)"],
    [labelKey(endpoints.coreBind.host, endpoints.coreBind.port), "proxy(core)"],
    [labelKey(kindHost, kindPort), "k8s"],
  ])
  const networks = new Map<string, NetworkTag>([
    [labelKey(endpoints.extBind.host, endpoints.extBind.port), "ext"],
    [labelKey(endpoints.coreBind.host, endpoints.coreBind.port), "core"],
    [labelKey(kindHost, kindPort), "core"],
  ])

  // One sequencer per scenario, shared by every recording layer so the
  // renderers can break `timestamp` ties deterministically. Without this
  // the merged fake-ext + real-core trace would scramble whenever two
  // events landed on the same ms (TestClock bursts on ext, or whenever
  // the real core clock happened to align with an ext step). When the
  // consumer also passes pre-built network layers, they MUST pass the
  // same sequencer here so the merged report stays monotonic.
  const traceSequencer = opts.traceSequencer ?? makeEventSequencer()

  const ghostIps = opts.ghostIps ?? new Set(["10.255.255.254"])
  const transportBase = createLiveTransport({
    useExternalNetwork: true,
    participantLabels: labels,
    participantNetworkOverrides: networks,
    traceSequencer,
    ghostIps,
  })
  const target = { host: endpoints.extAdvertised.host, port: endpoints.extAdvertised.port }

  // Two distinct fabrics:
  //   - `SignalingNetwork.simulated` for the ext side. The proxy(ext)
  //     endpoint and every agent transport bind here. `transitDelayMs: 0`
  //     keeps the report timestamps tight — packets are still forked
  //     through `Effect.sleep("0 millis")` so fire-and-forget UDP
  //     semantics are preserved.
  //   - `SignalingNetworkCore.realTracing` for the core side. Only the
  //     proxy(core) endpoint binds here. `realTracing` (not `real`) so
  //     `drainTrace()` captures every send/recv for the merged report;
  //     production layers MUST use the non-tracing variants.
  //
  // Both fabrics share `traceSequencer` so `NetworkTraceEntry.seq`
  // values are monotonic across the merged ext+core stream and the
  // renderers can resolve same-ms ties.
  const extNetworkLayer =
    opts.extNetworkLayer ?? SignalingNetwork.simulated({ transitDelayMs: 0, traceSequencer })
  // In single-fabric mode the core endpoint reuses the ext fabric:
  // ProxyCore falls back to `SignalingNetwork` when `SignalingNetworkCore`
  // is absent from the runtime context (see ProxyCore.ts ~351).
  const coreNetworkLayer = singleFabric
    ? undefined
    : (opts.coreNetworkLayer ?? SignalingNetworkCore.realTracing({ traceSequencer }))
  const proxySutLayer = registrarFrontProxyHybridStackLayer({
    config: defaultHybridAppConfig(),
    extBind: endpoints.extBind,
    extAdvertised: endpoints.extAdvertised,
    coreBind: endpoints.coreBind,
    coreAdvertised: endpoints.coreAdvertised,
    coreDestination: endpoints.coreDestination,
    recordRoute: opts.recordRoute,
  })
  // `provideMerge`: the proxy reads `SignalingNetwork` (ext) and — when
  // present — `SignalingNetworkCore` (core). The outer effect re-yields
  // `SignalingNetwork` so the agent transport binds on the same ext
  // fabric instance. In single-fabric mode `coreNetworkLayer` is omitted
  // and the ProxyCore fallback at ~351 reuses ext for both endpoints.
  const stackLayer = coreNetworkLayer === undefined
    ? proxySutLayer.pipe(Layer.provideMerge(extNetworkLayer))
    : proxySutLayer.pipe(
        Layer.provideMerge(extNetworkLayer),
        Layer.provideMerge(coreNetworkLayer),
      )

  return (scenario: Scenario): Effect.Effect<void> => {
    const program = Effect.gen(function* () {
      const proxy = yield* ProxyCore
      yield* Effect.logInfo(
        `[hybrid-proxy] ext=${proxy.localAddress.ip}:${proxy.localAddress.port} ` +
          `core=${proxy.coreLocalAddress?.ip ?? "-"}:${proxy.coreLocalAddress?.port ?? "-"} ` +
          `→ core-dest=${endpoints.coreDestination.host}:${endpoints.coreDestination.port}`,
      )

      // Drain fabric trace buffers, merge by `sentMs`, then dedup +
      // filter by known labels. In single-fabric mode only the ext
      // fabric exists (ProxyCore reuses it for both endpoints) and the
      // core drain is skipped.
      const extNetwork = yield* SignalingNetwork
      const coreNetwork = singleFabric
        ? undefined
        : yield* SignalingNetworkCore
      const labelKeyOf = (ip: string, port: number) => `${ip}:${port}`
      const transport: TestTransport = {
        ...transportBase,
        kind: "hybrid" as const,
        drainNetworkTrace: () =>
          Effect.gen(function* () {
            const ext = yield* extNetwork.drainTrace()
            const core = coreNetwork === undefined
              ? ([] as ReadonlyArray<NetworkTraceEntry>)
              : yield* coreNetwork.drainTrace()
            const merged = [...ext, ...core].sort(
              (a, b) => a.sentMs - b.sentMs,
            )
            const seen = new Set<string>()
            return merged.filter((e) => {
              const k = e.raw.toString("binary")
              if (seen.has(k)) return false
              seen.add(k)
              const srcKnown = labels.has(labelKeyOf(e.src.ip, e.src.port))
              const dstKnown = labels.has(labelKeyOf(e.dst.ip, e.dst.port))
              return srcKnown || dstKnown
            }) as ReadonlyArray<NetworkTraceEntry>
          }),
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
   * IP address the proxy advertises on its `core` (real-UDP) endpoint.
   * Must be reachable from the consumer's SUT so in-bound b-leg traffic
   * can return. Default `127.0.0.1` (local-only test SUTs).
   */
  readonly advertisedIp?: string
  /** Proxy core UDP port on the host. */
  readonly corePort?: number
  /** Output directory for HTML / global.txt reports. */
  readonly outputDir?: string
  /**
   * Whether the proxy stamps Record-Route on dialog-creating requests.
   * `true` preserves the existing register-proxy mode; `false` selects
   * the non-record-routing mode (in-dialog traffic bypasses the proxy).
   */
  readonly recordRoute: boolean
  /**
   * When `true`, the proxy reuses the ext fabric for the core endpoint —
   * use this for all-real-UDP single-fabric topologies.
   */
  readonly singleFabric?: boolean
  /** Override ext endpoint bind (default: synthetic fake-fabric address). */
  readonly extBind?: SocketAddr
  /** Override ext endpoint advertised address. */
  readonly extAdvertised?: SocketAddr
  /** Override the ext-side fabric layer (default: `SignalingNetwork.simulated`). */
  readonly extNetworkLayer?: Layer.Layer<SignalingNetwork>
  /** Override the core-side fabric layer (default: `SignalingNetworkCore.realTracing`). */
  readonly coreNetworkLayer?: Layer.Layer<SignalingNetworkCore>
  /** Shared trace sequencer for merged-report monotonicity. */
  readonly traceSequencer?: NetworkTraceSequencer
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
    corePort: opts.corePort ?? 25081,
    kindHost: opts.coreDestination.host,
    kindPort: opts.coreDestination.port,
    outputDir: opts.outputDir ?? "test-results/registrar-test-proxy",
    recordRoute: opts.recordRoute,
    ...(opts.singleFabric !== undefined ? { singleFabric: opts.singleFabric } : {}),
    ...(opts.extBind !== undefined ? { extBind: opts.extBind } : {}),
    ...(opts.extAdvertised !== undefined ? { extAdvertised: opts.extAdvertised } : {}),
    ...(opts.extNetworkLayer !== undefined ? { extNetworkLayer: opts.extNetworkLayer } : {}),
    ...(opts.coreNetworkLayer !== undefined ? { coreNetworkLayer: opts.coreNetworkLayer } : {}),
    ...(opts.traceSequencer !== undefined ? { traceSequencer: opts.traceSequencer } : {}),
  })
}
