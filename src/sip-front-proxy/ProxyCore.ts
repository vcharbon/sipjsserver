/**
 * ProxyCore — RFC 3261 §16 stateless front-proxy core.
 *
 * Owns all SIP mechanics that are independent of routing policy:
 *
 *   - Bind a UDP endpoint via `SignalingNetwork` (so the same code runs over
 *     the real `dgram` fabric in production and the in-memory fabric in
 *     fake-clock tests).
 *   - For each inbound packet, parse with `SipParser`, branch on
 *     request/response.
 *   - Request path (RFC 3261 §16.4 / §16.6 / §16.10):
 *       1. Decrement Max-Forwards. If it reaches 0, synthesize a 483 Too
 *          Many Hops back to the source via `generateResponse` and stop.
 *       2. If the topmost Route URI points at us, strip that Route header
 *          and (a) hand its uri-params to `RoutingStrategy.decodeStickiness`,
 *          (b) on `forward` use that target, (c) on `reject` synthesize
 *          the response, (d) on `unknown` fall through to selection.
 *       3. CANCEL: look the original INVITE's branch up in `CancelBranchLru`
 *          and forward to the same downstream.
 *       4. Otherwise call `RoutingStrategy.selectForNewDialog`. For
 *          dialog-creating requests (INVITE, SUBSCRIBE) insert a
 *          Record-Route header pointing at us, optionally carrying the
 *          stickiness params from `encodeStickiness`.
 *       5. Push our own Via on top with a unique branch (z9hG4bK…). For
 *          INVITEs remember `(branch -> chosenTarget)` in `CancelBranchLru`
 *          so a later CANCEL on the same branch finds the same downstream.
 *       6. Serialize and `endpoint.send` — fire-and-forget per D4.
 *   - Response path (RFC 3261 §16.7.3): pop our top Via (must be one we
 *     own — we recognize ourselves by ip:port match against the bind
 *     address). Forward to the next Via's `received`/`rport`/`sent-by`.
 *
 * Per D4 the routing path is non-blocking: parse failures, send errors,
 * strategy errors, registry lookup misses are all logged + counted; never
 * propagated to break the message loop. UA retransmissions cover loss.
 *
 * Stateless proxy: we do **not** retransmit; UDP reliability is end-to-end.
 */

import { Clock, Effect, Layer, Option, type Scope, ServiceMap, Stream } from "effect"
import {
  getHeader,
  newBranch,
  newTag,
  parseSipUri,
} from "../sip/MessageHelpers.js"
import { generateResponse } from "../sip/generators.js"
import { SipParser } from "../sip/Parser.js"
import { serialize } from "../sip/Serializer.js"
import { SignalingNetwork, type UdpEndpoint } from "../sip/SignalingNetwork.js"
import type { SipHeader, SipMessage, SipRequest } from "../sip/types.js"
import {
  CancelBranchLru,
  type CancelBranchLruApi,
  callIdCseqKey,
} from "./CancelBranchLru.js"
import {
  CoreToExtRoutingStrategy,
  type CoreToExtRoutingStrategyApi,
} from "./CoreToExtRoutingStrategy.js"
import { ProxyLogger, type ProxyLoggerApi } from "./observability/Logger.js"
import {
  ProxyMetrics,
  type ProxyMetricsApi,
  type RoutingDecisionKind,
} from "./observability/Metrics.js"
import { ProxyTracing, type ProxyTracingApi } from "./observability/Tracing.js"
import { RegisterStrategy } from "./RegisterStrategy.js"
import {
  RegistrarProxyConfig,
  type RegistrarProxyConfigData,
} from "./RegistrarProxyConfig.js"
import {
  type RouteParams,
  RoutingStrategy,
  type RoutingStrategyApi,
  type SocketAddr,
} from "./RoutingStrategy.js"
import {
  WorkerRegistry,
  type WorkerRegistryApi,
} from "./registry/WorkerRegistry.js"

/**
 * Network tag for the dual-endpoint registrar mode. `ext` is the
 * endpoint-facing fabric (Alice / Bob); `core` is the K8s-app-server-
 * facing fabric. Single-endpoint deployments only ever see `"ext"`.
 */
export type NetworkTag = "ext" | "core"

/** URI param name used to tag our own Via with the response-egress side. */
const NET_PARAM = "net"

// ---------------------------------------------------------------------------
// Bind config
// ---------------------------------------------------------------------------

export interface ProxyBindConfigData {
  /** Local IP to bind on. */
  readonly bindHost: string
  /** Local UDP port to bind on. */
  readonly bindPort: number
  /** Address advertised in our Via / Record-Route. Defaults to bindHost. */
  readonly advertisedHost?: string
  /** Port advertised in our Via / Record-Route. Defaults to bindPort. */
  readonly advertisedPort?: number
  /** Inbound queue depth — defaults to 1024. */
  readonly queueMax?: number
  /** Set SO_REUSEPORT on the underlying socket. Defaults to false. */
  readonly reusePort?: boolean
}

export class ProxyBindConfig extends ServiceMap.Service<
  ProxyBindConfig,
  ProxyBindConfigData
>()("@sipjsserver/sip-front-proxy/ProxyBindConfig") {
  /** Build a Layer providing a static `ProxyBindConfig`. */
  static readonly layer = (cfg: ProxyBindConfigData): Layer.Layer<ProxyBindConfig> =>
    Layer.succeed(ProxyBindConfig, cfg)
}

// ---------------------------------------------------------------------------
// Service surface — exposes the bound endpoint and the resolved bind tuple
// ---------------------------------------------------------------------------

export interface ProxyCoreApi {
  /** Primary (`ext`) endpoint — bound from `ProxyBindConfig`. Always present. */
  readonly endpoint: UdpEndpoint
  /** Final ip:port the proxy binds on (resolved from `ProxyBindConfig`). */
  readonly localAddress: { readonly ip: string; readonly port: number }
  /** ip:port advertised in our Via / Record-Route headers. */
  readonly advertisedAddress: { readonly ip: string; readonly port: number }
  /**
   * Optional `core` endpoint — present only when `RegistrarProxyConfig`
   * was provided, i.e. the proxy is running in registrar / dual-stack
   * mode. Absent for the legacy K8s-LB deployment.
   */
  readonly coreEndpoint?: UdpEndpoint
  /** ip:port the `core` endpoint binds on, or `undefined` in single-stack mode. */
  readonly coreLocalAddress?: { readonly ip: string; readonly port: number }
  /** ip:port advertised on the `core` side, or `undefined` in single-stack mode. */
  readonly coreAdvertisedAddress?: { readonly ip: string; readonly port: number }
}

export class ProxyCore extends ServiceMap.Service<ProxyCore, ProxyCoreApi>()(
  "@sipjsserver/sip-front-proxy/ProxyCore"
) {
  static readonly Default: Layer.Layer<
    ProxyCore,
    never,
    | SignalingNetwork
    | RoutingStrategy
    | CancelBranchLru
    | ProxyBindConfig
    | WorkerRegistry
    | RegisterStrategy
    | CoreToExtRoutingStrategy
  > = Layer.suspend(() =>
    Layer.effect(
      ProxyCore,
      makeProxyCore.pipe(
        // Observability layers have no own deps and can be instantiated
        // process-wide; bundling them with `SipParser.layer` keeps every
        // call site a 1-line update without forcing fixtures to re-wire.
        Effect.provide(
          Layer.mergeAll(
            SipParser.layer,
            ProxyMetrics.Default,
            ProxyTracing.Default,
            ProxyLogger.Default
          )
        )
      )
    )
  )
}

// ---------------------------------------------------------------------------
// Counters — observability stub for PR2 (PR6 wires Prometheus)
// ---------------------------------------------------------------------------

interface ProxyCounters {
  parseDropped: number
  maxForwardsRejected: number
  routedRequests: number
  routedResponses: number
  cancelMatched: number
  cancelUnmatched: number
  noTargetAvailable: number
  routeStripped: number
  recordRouteInserted: number
  responseDroppedNoVia: number
  sendErrors: number
  /** Worker-outbound (`;outbound`) request rejected because the R-URI is
   *  unparseable; the worker is the bug source — we 400 it back. */
  malformedRouteParam: number
}

const newCounters = (): ProxyCounters => ({
  parseDropped: 0,
  maxForwardsRejected: 0,
  routedRequests: 0,
  routedResponses: 0,
  cancelMatched: 0,
  cancelUnmatched: 0,
  noTargetAvailable: 0,
  routeStripped: 0,
  recordRouteInserted: 0,
  responseDroppedNoVia: 0,
  sendErrors: 0,
  malformedRouteParam: 0,
})

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const makeProxyCore: Effect.Effect<
  ProxyCoreApi,
  never,
  | SignalingNetwork
  | RoutingStrategy
  | CancelBranchLru
  | ProxyBindConfig
  | SipParser
  | ProxyMetrics
  | ProxyTracing
  | ProxyLogger
  | WorkerRegistry
  | RegisterStrategy
  | CoreToExtRoutingStrategy
  | Scope.Scope
> = Effect.gen(function* () {
  const network = yield* SignalingNetwork
  const strategy = yield* RoutingStrategy
  const cancelLru = yield* CancelBranchLru
  const cfg = yield* ProxyBindConfig
  const parser = yield* SipParser
  const metrics = yield* ProxyMetrics
  const tracing = yield* ProxyTracing
  const logger = yield* ProxyLogger
  const registry = yield* WorkerRegistry
  const registerStrategy = yield* RegisterStrategy
  const coreToExtStrategy = yield* CoreToExtRoutingStrategy
  // Optional: registrar deployments provide this; the K8s-LB binary
  // doesn't and the proxy stays single-endpoint.
  const registrarCfgOpt = yield* Effect.serviceOption(RegistrarProxyConfig)

  const queueMax = cfg.queueMax ?? 1024
  const extEndpoint = yield* network
    .bindUdp({
      ip: cfg.bindHost,
      port: cfg.bindPort,
      queueMax,
      reusePort: cfg.reusePort ?? false,
    })
    .pipe(Effect.orDie)

  const localAddress = extEndpoint.localAddress
  const advertisedAddress = {
    ip: cfg.advertisedHost ?? localAddress.ip,
    port: cfg.advertisedPort ?? localAddress.port,
  }
  const counters = newCounters()

  // Optional core endpoint — bound only when running in registrar mode.
  // `coreEndpoint === undefined` is the legacy K8s-LB single-endpoint
  // shape; downstream dispatch checks it before stamping `;net=` on
  // egress Vias / before consulting `coreToExtStrategy`.
  let coreEndpoint: UdpEndpoint | undefined
  let coreLocalAddress: { readonly ip: string; readonly port: number } | undefined
  let coreAdvertisedAddress:
    | { readonly ip: string; readonly port: number }
    | undefined
  let registrarCfg: RegistrarProxyConfigData | undefined
  if (Option.isSome(registrarCfgOpt)) {
    registrarCfg = registrarCfgOpt.value
    coreEndpoint = yield* network
      .bindUdp({
        ip: registrarCfg.coreBind.host,
        port: registrarCfg.coreBind.port,
        queueMax,
        reusePort: cfg.reusePort ?? false,
      })
      .pipe(Effect.orDie)
    coreLocalAddress = coreEndpoint.localAddress
    coreAdvertisedAddress = {
      ip: registrarCfg.coreAdvertisedHost ?? coreLocalAddress.ip,
      port: registrarCfg.coreAdvertisedPort ?? coreLocalAddress.port,
    }
  }

  yield* Effect.logInfo(
    `[sip-front-proxy/ProxyCore] strategy=${strategy.name} bound=${localAddress.ip}:${localAddress.port} advertised=${advertisedAddress.ip}:${advertisedAddress.port}` +
      (coreLocalAddress !== undefined && coreAdvertisedAddress !== undefined
        ? ` coreBound=${coreLocalAddress.ip}:${coreLocalAddress.port} coreAdvertised=${coreAdvertisedAddress.ip}:${coreAdvertisedAddress.port} registerStrategy=${registerStrategy.name} coreToExtStrategy=${coreToExtStrategy.name}`
        : "")
  )

  /**
   * Send a buffer on a specific endpoint. Catches `SendError`s into the
   * existing counter — outbound failures are observed but never propagate
   * (D4 of the proxy plan).
   */
  const sendOn = (ep: UdpEndpoint, buf: Buffer, dst: SocketAddr) =>
    ep.send(buf, dst.port, dst.host).pipe(
      Effect.catchTag("SendError", (err) =>
        Effect.sync(() => {
          counters.sendErrors++
        }).pipe(
          Effect.tap(() =>
            Effect.logWarning(
              `[ProxyCore] send to ${dst.host}:${dst.port} failed: ${err.message}`
            )
          )
        )
      )
    )

  // Default-egress-on-ext helpers — keep the legacy single-endpoint code
  // path byte-identical: every send goes out on `extEndpoint`.
  const sendBuf = (buf: Buffer, dst: SocketAddr) => sendOn(extEndpoint, buf, dst)
  const replyToSource = (
    buf: Buffer,
    src: { readonly address: string; readonly port: number }
  ) => sendOn(extEndpoint, buf, { host: src.address, port: src.port })

  /**
   * Network-aware reply: in dual-endpoint mode, replies (e.g. REGISTER 200
   * OK, registrar `404 Not Found`, `403 Forbidden` on REGISTER from core)
   * go out on the SAME endpoint the request arrived on. In single-endpoint
   * mode there's only `ext` and this collapses to `replyToSource`.
   */
  const replyOnNet = (
    net: NetworkTag,
    buf: Buffer,
    src: { readonly address: string; readonly port: number }
  ) =>
    sendOn(net === "core" && coreEndpoint !== undefined ? coreEndpoint : extEndpoint, buf, {
      host: src.address,
      port: src.port,
    })

  // -------------------------------------------------------------------------
  // Per-packet handling — split by message type
  // -------------------------------------------------------------------------

  const handleRequest = (
    req: SipRequest,
    src: { readonly address: string; readonly port: number },
    net: NetworkTag
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      // REGISTER always hands off to RegisterStrategy. In K8s-LB mode the
      // strategy is `noop` (501 Not Implemented). In registrar mode it is
      // `inMemoryRegistrar` (200 OK with bindings). Either way we reply
      // on the ingress endpoint.
      if (req.method.toUpperCase() === "REGISTER") {
        if (net === "ext") {
          const resp = yield* registerStrategy.handle(req)
          yield* replyOnNet("ext", serialize(resp), src)
          return
        }
        // REGISTER on core only happens in dual-endpoint mode and is
        // explicitly out of scope: the registrar lives on the ext side.
        const resp = generateResponse(req, 403, "Forbidden", { toTag: newTag() })
        yield* replyOnNet("core", serialize(resp), src)
        return
      }

      // In dual-endpoint registrar mode, request dispatch differs from
      // the K8s-LB shape: ext INVITEs always land at coreDestination,
      // core INVITEs go through `coreToExtStrategy`. CANCEL still
      // matches via the LRU. In-dialog requests follow Route headers.
      if (registrarCfg !== undefined && coreEndpoint !== undefined) {
        yield* handleRequestRegistrarMode({
          req,
          src,
          net,
          extEndpoint,
          coreEndpoint,
          extAdvertised: advertisedAddress,
          coreAdvertised: coreAdvertisedAddress!,
          registrarCfg,
          coreToExtStrategy,
          cancelLru,
          counters,
          sendOn,
        })
        return
      }

      // Single-endpoint (legacy K8s-LB) — unchanged. `net` is always "ext".
      yield* handleRequestImpl({
        req,
        src,
        advertisedAddress,
        strategy,
        cancelLru,
        counters,
        sendBuf,
        replyToSource,
        metrics,
        tracing,
        logger,
        registry,
      })
    })

  const handleResponse = (msg: SipMessage, net: NetworkTag): Effect.Effect<void> =>
    handleResponseImpl({
      msg,
      advertisedAddress,
      coreAdvertisedAddress,
      counters,
      sendOn,
      extEndpoint,
      coreEndpoint,
      defaultEgressNet: net,
      metrics,
    })

  // -------------------------------------------------------------------------
  // Ingress fiber(s) — forked into the layer's scope.
  // -------------------------------------------------------------------------

  /**
   * Process one packet from a tagged endpoint. Shared between ext and
   * core ingress — only the `net` tag differs. Errors during parse get
   * counted; defects get logged as unhandled.
   */
  const processPacket = (
    packet: { raw: Buffer; rinfo: { address: string; port: number } },
    net: NetworkTag
  ) =>
    Effect.gen(function* () {
      const parsed = yield* parser.parse(packet.raw).pipe(
        Effect.catchTag("SipParseError", (err) =>
          Effect.sync(() => {
            counters.parseDropped++
          }).pipe(
            Effect.tap(() =>
              Effect.logWarning(
                `[ProxyCore] dropped malformed packet from ${packet.rinfo.address}:${packet.rinfo.port} on ${net}: ${err.reason}`
              )
            ),
            Effect.as(undefined as SipMessage | undefined)
          )
        )
      )
      if (parsed === undefined) return
      if (parsed.type === "request") {
        yield* handleRequest(parsed, packet.rinfo, net)
      } else {
        yield* handleResponse(parsed, net)
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError(`[ProxyCore] unhandled error during packet handling`, cause)
      )
    )

  yield* Effect.forkScoped(
    Stream.runForEach(extEndpoint.messages, (packet) => processPacket(packet, "ext"))
  )
  if (coreEndpoint !== undefined) {
    yield* Effect.forkScoped(
      Stream.runForEach(coreEndpoint.messages, (packet) => processPacket(packet, "core"))
    )
  }

  const api: ProxyCoreApi =
    coreEndpoint !== undefined && coreLocalAddress !== undefined && coreAdvertisedAddress !== undefined
      ? {
          endpoint: extEndpoint,
          localAddress,
          advertisedAddress,
          coreEndpoint,
          coreLocalAddress,
          coreAdvertisedAddress,
        }
      : {
          endpoint: extEndpoint,
          localAddress,
          advertisedAddress,
        }
  return api
})

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

interface HandleRequestArgs {
  readonly req: SipRequest
  readonly src: { readonly address: string; readonly port: number }
  readonly advertisedAddress: { readonly ip: string; readonly port: number }
  readonly strategy: RoutingStrategyApi
  readonly cancelLru: CancelBranchLruApi
  readonly counters: ProxyCounters
  readonly sendBuf: (buf: Buffer, dst: SocketAddr) => Effect.Effect<void>
  readonly replyToSource: (
    buf: Buffer,
    src: { readonly address: string; readonly port: number }
  ) => Effect.Effect<void>
  readonly metrics: ProxyMetricsApi
  readonly tracing: ProxyTracingApi
  readonly logger: ProxyLoggerApi
  readonly registry: WorkerRegistryApi
}

const DIALOG_CREATING: ReadonlySet<string> = new Set(["INVITE", "SUBSCRIBE"])

const handleRequestImpl = (args: HandleRequestArgs): Effect.Effect<void> =>
  Effect.gen(function* () {
    const {
      req,
      src,
      advertisedAddress,
      strategy,
      cancelLru,
      counters,
      sendBuf,
      replyToSource,
      metrics,
      tracing,
      logger,
      registry,
    } = args

    const startMs = yield* Clock.currentTimeMillis
    const method = req.method.toUpperCase()
    const callId = req.parsed.callId
    yield* metrics.recordMessage({
      direction: "inbound",
      methodOrStatus: method,
      result: "forwarded", // pre-decision; final result tag below
    })

    // The body is wrapped in a route span so every routing path produces a
    // single inbound→decision tracing record. Decision is captured after
    // the fact via the closure variables below.
    let decisionKind: RoutingDecisionKind = "select_new"
    let decisionTarget: SocketAddr | undefined
    let result: "forwarded" | "rejected" | "dropped" = "forwarded"

    const observeAndLog = Effect.suspend(() =>
      Effect.gen(function* () {
        const endMs = yield* Clock.currentTimeMillis
        const durationSeconds = Math.max(0, (endMs - startMs) / 1000)
        yield* metrics.observeRoutingDuration({
          strategy: strategy.name,
          decision: decisionKind,
          durationSeconds,
        })
        yield* metrics.recordRoutingDecision({
          strategy: strategy.name,
          kind: decisionKind,
        })
        yield* logger.routingDecision({
          callId,
          method,
          decision: decisionKind,
          strategy: strategy.name,
          target:
            decisionTarget === undefined
              ? "n/a"
              : `${decisionTarget.host}:${decisionTarget.port}`,
          message: `routed ${method} ${callId} → ${
            decisionTarget === undefined
              ? "<no target>"
              : `${decisionTarget.host}:${decisionTarget.port}`
          } (decision=${decisionKind}, result=${result})`,
        })
      })
    )

    const body = Effect.gen(function* () {
      // ── §16.3 + Max-Forwards check ────────────────────────────────────────
      const mfRaw = getHeader(req.headers, "max-forwards")
      const mf = mfRaw === undefined ? 70 : Number.parseInt(mfRaw, 10)
      if (Number.isFinite(mf) && mf <= 0) {
        counters.maxForwardsRejected++
        const resp = generateResponse(req, 483, "Too Many Hops", { toTag: newTag() })
        yield* replyToSource(serialize(resp), src)
        decisionKind = "decode_reject"
        result = "rejected"
        yield* metrics.recordMessage({
          direction: "outbound",
          methodOrStatus: "483",
          result: "rejected",
        })
        return
      }
      const mfNext = (Number.isFinite(mf) ? mf : 70) - 1

      // ── §16.4 Route preprocessing ─────────────────────────────────────────
      // If topmost Route points at us, strip it and remember the params (used
      // below for stickiness decoding).
      //
      // Worker-outbound classification has two triggers:
      //
      //   1. `;outbound` URI param on the top-Route — the worker pre-loaded
      //      `Route: <sip:proxy:port;lr;outbound>` on a dialog-creating B-leg
      //      request (see src/b2bua/helpers.ts when `AppConfig.b2bOutboundProxy`
      //      is set). Initial INVITE/SUBSCRIBE.
      //
      //   2. The packet's source ip:port matches a registered worker. Covers
      //      in-dialog requests (ACK, BYE, re-INVITE) where the worker's
      //      B-leg dialog routeSet contains the proxy with a stickiness
      //      cookie — without source classification we'd decode that cookie
      //      and route the packet back to the same worker (loop).
      //
      // Both cases skip the cookie decode entirely; target is the R-URI.
      let headers: ReadonlyArray<SipHeader> = req.headers
      let strippedRouteParams: RouteParams | undefined
      let isWorkerOutbound = false
      const topRoute = getHeader(headers, "route")
      if (topRoute !== undefined) {
        const parsedRoute = parseSipUri(topRoute)
        if (
          parsedRoute !== undefined &&
          parsedRoute.host === advertisedAddress.ip &&
          parsedRoute.port === advertisedAddress.port
        ) {
          headers = removeFirstHeader(headers, "route")
          counters.routeStripped++
          if (parsedRoute.params["outbound"] !== undefined) {
            isWorkerOutbound = true
          } else {
            strippedRouteParams = parsedRoute.params
          }
        }
      }

      // Source-based outbound override: any packet from a registered worker
      // is treated as worker-outbound regardless of cookie params. This
      // breaks the in-dialog routing loop described above.
      if (!isWorkerOutbound) {
        const sourceWorker = yield* registry.lookupByAddress({
          host: src.address,
          port: src.port,
        })
        if (Option.isSome(sourceWorker)) {
          isWorkerOutbound = true
          strippedRouteParams = undefined
        }
      }

      // ── Pick the downstream target ────────────────────────────────────────
      let target: SocketAddr | undefined
      let synthesizedReply: { status: number; reason: string } | undefined
      // RFC 3261 §9.1: a CANCEL must carry the same top-Via branch as the
      // INVITE it cancels so the downstream's transaction layer matches
      // them. When this proxy forwards an INVITE it stamps a fresh branch;
      // we cache that branch in the LRU and reuse it on the CANCEL below.
      let reuseBranch: string | undefined

      if (method === "CANCEL") {
        // §16.10: forward CANCEL to the same downstream as the matching
        // INVITE. RFC 3261 §9.1 — a CANCEL shares the INVITE's Call-ID and
        // CSeq number (only the CSeq method differs, INVITE→CANCEL). We key
        // the LRU on `(Call-ID, CSeq number)` so the lookup works at any
        // hop regardless of what the upstream UAC chose for the top-Via
        // branch on the CANCEL — and crucially without re-sharding to a
        // different worker under `LoadBalancer`.
        const key = callIdCseqKey(req.parsed.callId, req.parsed.cseq.seq)
        const found = yield* cancelLru.lookup(key)
        if (Option.isSome(found)) {
          target = found.value.target
          reuseBranch = found.value.branch
          counters.cancelMatched++
          decisionKind = "cancel_lookup_hit"
          yield* metrics.recordCancelLookup("hit")
        } else {
          counters.cancelUnmatched++
          decisionKind = "cancel_lookup_miss"
          yield* metrics.recordCancelLookup("miss")
          // Fall back to selectForNewDialog so a CANCEL we never saw the INVITE
          // for still gets forwarded somewhere reasonable. Stateless proxies
          // can't conjure a "we don't know" — we'd otherwise drop.
          target = yield* tryStrategySelect(strategy, req, counters)
        }
      } else if (isWorkerOutbound) {
        // Worker→external (B-leg egress through us). The packet's source
        // IP:port identifies the originating worker; forward to whatever
        // the R-URI says (controller-supplied Bob address). Cookie
        // encoding for the inserted Record-Route happens below — the
        // `target` here is the wire destination only.
        const parsedRuri = parseSipUri(req.uri)
        if (parsedRuri === undefined) {
          counters.malformedRouteParam++
          const resp = generateResponse(req, 400, "Bad Request", { toTag: newTag() })
          yield* replyToSource(serialize(resp), src)
          result = "rejected"
          yield* metrics.recordMessage({
            direction: "outbound",
            methodOrStatus: "400",
            result: "rejected",
          })
          return
        }
        target = { host: parsedRuri.host, port: parsedRuri.port ?? 5060 }
        decisionKind = "worker_outbound"
      } else if (strippedRouteParams !== undefined) {
        const decoded = yield* strategy.decodeStickiness(strippedRouteParams, req)
        switch (decoded._tag) {
          case "forward":
            target = decoded.target
            decisionKind = "decode_forward"
            break
          case "forwardBackup":
            // D8 of the HA-resilience plan: cookie's primary worker is
            // dead/draining-post-grace, strategy resolved the named
            // `w_bak` to an alive entry. Forward exactly like a normal
            // hit but emit a distinct decision class for HA dashboards.
            target = decoded.target
            decisionKind = "decode_forward_backup"
            break
          case "reject":
            synthesizedReply = { status: decoded.status, reason: decoded.reason }
            decisionKind = "decode_reject"
            break
          case "unknown":
            target = yield* tryStrategySelect(strategy, req, counters)
            decisionKind = "decode_unknown"
            break
        }
      } else {
        target = yield* tryStrategySelect(strategy, req, counters)
        decisionKind = "select_new"
      }

      if (synthesizedReply !== undefined) {
        const resp = generateResponse(req, synthesizedReply.status, synthesizedReply.reason, {
          toTag: newTag(),
        })
        yield* replyToSource(serialize(resp), src)
        result = "rejected"
        yield* metrics.recordMessage({
          direction: "outbound",
          methodOrStatus: String(synthesizedReply.status),
          result: "rejected",
        })
        return
      }

      if (target === undefined) {
        // selectForNewDialog raised NoTargetAvailable → emit 503 to source.
        const resp = generateResponse(req, 503, "Service Unavailable", {
          toTag: newTag(),
          extraHeaders: [{ name: "Retry-After", value: "5" }],
        })
        yield* replyToSource(serialize(resp), src)
        result = "dropped"
        yield* metrics.recordMessage({
          direction: "outbound",
          methodOrStatus: "503",
          result: "dropped",
        })
        return
      }

      decisionTarget = target

      // ── §16.6 / §16.6.5 Record-Route ──────────────────────────────────────
      // First populate `received=` / `rport=` on the topmost incoming
      // Via per RFC 3261 §18.2.1 + RFC 3581 §4 so the response-routing
      // path can deliver replies through NAT / non-routable upstream
      // addresses.
      let nextHeaders: SipHeader[] = populateReceivedRportOnTopVia(
        headers,
        src.address,
        src.port,
      )
      // Update Max-Forwards in place (or append).
      nextHeaders = upsertHeader(nextHeaders, "Max-Forwards", String(mfNext))

      if (DIALOG_CREATING.has(method)) {
        // Encode stickiness for the destination Bob's UAS will see in
        // its received Record-Route. For a normal A-leg ingress that's
        // the LB-selected target (`target`). For worker-outbound that's
        // the *source* worker — Bob's in-dialog requests must come back
        // to the worker that originated the call, not to whichever
        // worker the proxy would HRW-pick fresh.
        const cookieAddr = isWorkerOutbound
          ? { host: src.address, port: src.port }
          : target
        const stickiness = strategy.encodeStickiness(cookieAddr, req)
        const rrValue = buildRecordRouteValue(advertisedAddress, stickiness)
        // Insert Record-Route at the top of the header set so it sits ahead of
        // any existing Record-Route (RFC 3261 §16.6.4 — proxies prepend).
        nextHeaders = prependHeader(nextHeaders, "Record-Route", rrValue)
        counters.recordRouteInserted++
      }

      // ── §16.6.4 push our Via on top ───────────────────────────────────────
      // For CANCEL we MUST reuse the branch we stamped on the matching
      // INVITE so the downstream's transaction layer correlates them
      // (RFC 3261 §9.1). For everything else, fresh `newBranch()`.
      const ourBranch = reuseBranch ?? newBranch()
      const viaValue = `SIP/2.0/UDP ${advertisedAddress.ip}:${advertisedAddress.port};branch=${ourBranch};rport`
      nextHeaders = prependHeader(nextHeaders, "Via", viaValue)

      // ── Remember (Call-ID, CSeq number)→{target, branch} for CANCEL ──────
      // Per RFC 3261 §9.1 the CANCEL we may later receive will carry the
      // same Call-ID and CSeq number; that pair is the canonical correlator
      // independent of what branch the upstream UAC stamps on the CANCEL.
      // We also cache `branch` so the CANCEL we forward downstream carries
      // the same top-Via branch as the INVITE we forwarded — required for
      // the downstream's transaction matching (§9.1, §17).
      if (method === "INVITE") {
        const key = callIdCseqKey(req.parsed.callId, req.parsed.cseq.seq)
        yield* cancelLru.remember(key, { target, branch: ourBranch })
        // Update active-dialog estimate from LRU size (best-effort, see
        // Metrics.ts header comment).
        yield* metrics.setActiveDialogsEstimate(cancelLru.size())
      }

      // ── Serialize + fire-and-forget send ──────────────────────────────────
      const outBuf = serialize({ ...req, headers: nextHeaders })
      counters.routedRequests++
      yield* sendBuf(outBuf, target)
      result = "forwarded"
      yield* metrics.recordMessage({
        direction: "outbound",
        methodOrStatus: method,
        result: "forwarded",
      })
    })

    yield* tracing
      .withRouteSpan(
        {
          method,
          callId,
          strategy: strategy.name,
          decision: decisionKind,
          workerTarget:
            decisionTarget === undefined
              ? "n/a"
              : `${decisionTarget.host}:${decisionTarget.port}`,
        },
        body
      )
      .pipe(Effect.ensuring(observeAndLog))
  })

const tryStrategySelect = (
  strategy: RoutingStrategyApi,
  req: SipRequest,
  counters: ProxyCounters
): Effect.Effect<SocketAddr | undefined> =>
  strategy.selectForNewDialog(req).pipe(
    Effect.catchTag("NoTargetAvailable", (err) =>
      Effect.sync(() => {
        counters.noTargetAvailable++
      }).pipe(
        Effect.tap(() =>
          Effect.logWarning(`[ProxyCore] strategy ${strategy.name} no target: ${err.reason}`)
        ),
        Effect.as(undefined as SocketAddr | undefined)
      )
    ),
    Effect.map((t) => t as SocketAddr | undefined)
  )

// ---------------------------------------------------------------------------
// Response handling — §16.7.3
// ---------------------------------------------------------------------------

interface HandleResponseArgs {
  readonly msg: SipMessage // narrowed below
  readonly advertisedAddress: { readonly ip: string; readonly port: number }
  /** Present in dual-endpoint mode; the response may be ours via Via match here. */
  readonly coreAdvertisedAddress?: { readonly ip: string; readonly port: number } | undefined
  readonly counters: ProxyCounters
  readonly sendOn: (ep: UdpEndpoint, buf: Buffer, dst: SocketAddr) => Effect.Effect<void>
  readonly extEndpoint: UdpEndpoint
  readonly coreEndpoint?: UdpEndpoint | undefined
  /** Ingress network — fallback when our top Via has no `;net=` tag. */
  readonly defaultEgressNet: NetworkTag
  readonly metrics: ProxyMetricsApi
}

const handleResponseImpl = (args: HandleResponseArgs): Effect.Effect<void> =>
  Effect.gen(function* () {
    const {
      msg,
      advertisedAddress,
      coreAdvertisedAddress,
      counters,
      sendOn,
      extEndpoint,
      coreEndpoint,
      defaultEgressNet,
      metrics,
    } = args
    if (msg.type !== "response") return

    yield* metrics.recordMessage({
      direction: "inbound",
      methodOrStatus: String(msg.status),
      result: "forwarded",
    })

    // RFC 3261 §16.7.3: pop the topmost Via (must be one we own — i.e. the
    // sent-by host:port matches our advertised address on EITHER fabric).
    // Forward to the *next* Via's address on the egress endpoint indicated
    // by the popped Via's `;net=` tag (or fall back to the ingress fabric).
    const vias = msg.parsed.vias
    if (vias.length < 2) {
      counters.responseDroppedNoVia++
      yield* Effect.logWarning(
        `[ProxyCore] response dropped — only ${vias.length} Via header(s); cannot relay upstream`
      )
      yield* metrics.recordMessage({
        direction: "outbound",
        methodOrStatus: String(msg.status),
        result: "dropped",
      })
      return
    }
    const top = vias[0]!
    const topPort = top.port ?? 5060
    const matchesExt =
      top.host === advertisedAddress.ip && topPort === advertisedAddress.port
    const matchesCore =
      coreAdvertisedAddress !== undefined &&
      top.host === coreAdvertisedAddress.ip &&
      topPort === coreAdvertisedAddress.port
    if (!matchesExt && !matchesCore) {
      counters.responseDroppedNoVia++
      yield* Effect.logWarning(
        `[ProxyCore] response dropped — top Via ${top.host}:${topPort} is not us (ext=${advertisedAddress.ip}:${advertisedAddress.port}` +
          (coreAdvertisedAddress !== undefined
            ? ` core=${coreAdvertisedAddress.ip}:${coreAdvertisedAddress.port}`
            : "") +
          ")"
      )
      yield* metrics.recordMessage({
        direction: "outbound",
        methodOrStatus: String(msg.status),
        result: "dropped",
      })
      return
    }

    const next = vias[1]!
    // received / rport take precedence over sent-by per §18.2.2 / §16.7.3.
    const receivedRaw = next.params["received"]
    const rportRaw = next.params["rport"]
    const host = typeof receivedRaw === "string" && receivedRaw.length > 0 ? receivedRaw : next.host
    const port =
      typeof rportRaw === "string" && rportRaw.length > 0
        ? Number.parseInt(rportRaw, 10)
        : (next.port ?? 5060)

    // Egress endpoint — read the `;net=` tag we stamped on the way out.
    // Single-endpoint deployments never set the param; egress defaults
    // to ext (the only endpoint). Dual-endpoint deployments use the
    // tag explicitly so a response forwarded ext→core finds its way
    // back across the fabric boundary.
    const netParamRaw = top.params[NET_PARAM]
    const egressNet: NetworkTag =
      netParamRaw === "ext" || netParamRaw === "core"
        ? netParamRaw
        : defaultEgressNet
    const egressEp =
      egressNet === "core" && coreEndpoint !== undefined ? coreEndpoint : extEndpoint

    const headers = removeFirstHeader(msg.headers, "via")
    const outBuf = serialize({ ...msg, headers })
    counters.routedResponses++
    yield* sendOn(egressEp, outBuf, { host, port })
    yield* metrics.recordMessage({
      direction: "outbound",
      methodOrStatus: String(msg.status),
      result: "forwarded",
    })
  })

// ---------------------------------------------------------------------------
// Registrar-mode request dispatch (dual-endpoint)
// ---------------------------------------------------------------------------

interface HandleRegistrarRequestArgs {
  readonly req: SipRequest
  readonly src: { readonly address: string; readonly port: number }
  readonly net: NetworkTag
  readonly extEndpoint: UdpEndpoint
  readonly coreEndpoint: UdpEndpoint
  readonly extAdvertised: { readonly ip: string; readonly port: number }
  readonly coreAdvertised: { readonly ip: string; readonly port: number }
  readonly registrarCfg: RegistrarProxyConfigData
  readonly coreToExtStrategy: CoreToExtRoutingStrategyApi
  readonly cancelLru: CancelBranchLruApi
  readonly counters: ProxyCounters
  readonly sendOn: (ep: UdpEndpoint, buf: Buffer, dst: SocketAddr) => Effect.Effect<void>
}

const handleRequestRegistrarMode = (
  args: HandleRegistrarRequestArgs
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const {
      req,
      src,
      net,
      extEndpoint,
      coreEndpoint,
      extAdvertised,
      coreAdvertised,
      registrarCfg,
      coreToExtStrategy,
      cancelLru,
      counters,
      sendOn,
    } = args
    const method = req.method.toUpperCase()

    // ── Max-Forwards check (RFC 3261 §16.3) ──────────────────────────────
    const mfRaw = getHeader(req.headers, "max-forwards")
    const mf = mfRaw === undefined ? 70 : Number.parseInt(mfRaw, 10)
    if (Number.isFinite(mf) && mf <= 0) {
      counters.maxForwardsRejected++
      const resp = generateResponse(req, 483, "Too Many Hops", { toTag: newTag() })
      yield* sendOn(net === "core" ? coreEndpoint : extEndpoint, serialize(resp), {
        host: src.address,
        port: src.port,
      })
      return
    }
    const mfNext = (Number.isFinite(mf) ? mf : 70) - 1

    // ── §16.4 strip topmost Route if it points at us (either side) ───────
    let headers: ReadonlyArray<SipHeader> = req.headers
    const topRoute = getHeader(headers, "route")
    if (topRoute !== undefined) {
      const parsedRoute = parseSipUri(topRoute)
      if (
        parsedRoute !== undefined &&
        ((parsedRoute.host === extAdvertised.ip &&
          parsedRoute.port === extAdvertised.port) ||
          (parsedRoute.host === coreAdvertised.ip &&
            parsedRoute.port === coreAdvertised.port))
      ) {
        headers = removeFirstHeader(headers, "route")
        counters.routeStripped++
      }
    }

    // ── Pick egress endpoint + destination ───────────────────────────────
    // Dispatch table:
    //   REGISTER       — handled before this function runs.
    //   CANCEL         — match the original INVITE in the LRU; reuse
    //                    target + branch; egress = OPPOSITE of ingress.
    //   INVITE on ext  — forward to coreDestination on core endpoint.
    //   INVITE on core — coreToExtStrategy.resolve → forward via ext, OR reject.
    //   In-dialog any  — follow Route header (already stripped above) or
    //                    fall back to RURI; egress = OPPOSITE of ingress.
    //
    // The "egress = opposite of ingress" default is a deliberate v1
    // simplification: every dialog goes ext↔core through the proxy with
    // no ext↔ext or core↔core direct paths.
    const egressNet: NetworkTag = net === "ext" ? "core" : "ext"
    const egressEp = egressNet === "ext" ? extEndpoint : coreEndpoint
    const egressAdvertised = egressNet === "ext" ? extAdvertised : coreAdvertised

    let target: SocketAddr | undefined
    let synthesizedReply: { status: number; reason: string } | undefined
    let reuseBranch: string | undefined
    let ruriOverride: string | undefined

    if (method === "CANCEL") {
      const key = callIdCseqKey(req.parsed.callId, req.parsed.cseq.seq)
      const found = yield* cancelLru.lookup(key)
      if (Option.isSome(found)) {
        target = found.value.target
        reuseBranch = found.value.branch
        counters.cancelMatched++
      } else {
        counters.cancelUnmatched++
        // Without a recorded INVITE we can't re-derive the right hop —
        // 481 is the spec-correct response (RFC 3261 §9.2).
        synthesizedReply = { status: 481, reason: "Call/Transaction Does Not Exist" }
      }
    } else if (method === "INVITE" && net === "ext") {
      target = registrarCfg.coreDestination
    } else if (method === "INVITE" && net === "core") {
      const outcome = yield* coreToExtStrategy.resolve(req)
      if (outcome._tag === "reject") {
        synthesizedReply = { status: outcome.status, reason: outcome.reason }
      } else {
        target = outcome.destination
        ruriOverride = outcome.ruriOverride
      }
    } else {
      // In-dialog (BYE, ACK, re-INVITE, OPTIONS, …): the (now stripped)
      // top Route or the Request-URI tells us where to go. v1 trusts the
      // R-URI — agents in our test fabric set it from the dialog's
      // remote-target Contact, which in registrar mode is always either
      // a registered ext contact or the core destination.
      const parsedRuri = parseSipUri(req.uri)
      if (parsedRuri === undefined) {
        synthesizedReply = { status: 400, reason: "Bad Request" }
      } else {
        target = { host: parsedRuri.host, port: parsedRuri.port }
      }
    }

    if (synthesizedReply !== undefined) {
      const resp = generateResponse(req, synthesizedReply.status, synthesizedReply.reason, {
        toTag: newTag(),
      })
      yield* sendOn(net === "core" ? coreEndpoint : extEndpoint, serialize(resp), {
        host: src.address,
        port: src.port,
      })
      return
    }
    if (target === undefined) {
      // Defensive: dispatch fell through without a target and without a
      // synthesized reply. 500 because that's a proxy-side bug, not the
      // caller's.
      counters.noTargetAvailable++
      const resp = generateResponse(req, 500, "Server Internal Error", { toTag: newTag() })
      yield* sendOn(net === "core" ? coreEndpoint : extEndpoint, serialize(resp), {
        host: src.address,
        port: src.port,
      })
      return
    }

    // ── Build outbound headers ───────────────────────────────────────────
    let nextHeaders: SipHeader[] = [...headers]
    nextHeaders = upsertHeader(nextHeaders, "Max-Forwards", String(mfNext))

    if (DIALOG_CREATING.has(method)) {
      // Stamp Record-Route on the egress side so the far party's
      // in-dialog requests come back through us. The URI advertises the
      // egress fabric's address — that's the side the far party can
      // reach. v1 inserts a single RR (no double-RR for transport
      // bridging — out of scope).
      const rrUri = `<sip:${egressAdvertised.ip}:${egressAdvertised.port};lr>`
      nextHeaders = prependHeader(nextHeaders, "Record-Route", rrUri)
      counters.recordRouteInserted++
    }

    // RFC 3261 §18.2.1 + RFC 3581 §4 — populate `received=` / `rport=`
    // on the topmost incoming Via before pushing our own.
    nextHeaders = populateReceivedRportOnTopVia(nextHeaders, src.address, src.port)

    // ── Push our Via on top with `;net=<ingress>` tag ─────────────────────
    // The tag tells `handleResponseImpl` which endpoint to send the
    // response on when this Via gets popped: the response goes back to
    // the ingress side of THIS request.
    const ourBranch = reuseBranch ?? newBranch()
    const viaValue = `SIP/2.0/UDP ${egressAdvertised.ip}:${egressAdvertised.port};branch=${ourBranch};rport;${NET_PARAM}=${net}`
    nextHeaders = prependHeader(nextHeaders, "Via", viaValue)

    if (method === "INVITE") {
      const key = callIdCseqKey(req.parsed.callId, req.parsed.cseq.seq)
      yield* cancelLru.remember(key, { target, branch: ourBranch })
    }

    // ── Serialize + fire-and-forget send on egress endpoint ──────────────
    const finalReq = ruriOverride !== undefined
      ? ({ ...req, uri: ruriOverride, headers: nextHeaders } as SipRequest)
      : ({ ...req, headers: nextHeaders } as SipRequest)
    const outBuf = serialize(finalReq)
    counters.routedRequests++
    yield* sendOn(egressEp, outBuf, target)
  })

// ---------------------------------------------------------------------------
// Header helpers (proxy-local — kept here so PR2 doesn't touch src/sip/)
// ---------------------------------------------------------------------------

/** Remove only the first header matching `name` (case-insensitive). */
const removeFirstHeader = (
  headers: ReadonlyArray<SipHeader>,
  name: string
): SipHeader[] => {
  const lower = name.toLowerCase()
  const out: SipHeader[] = []
  let removed = false
  for (const h of headers) {
    if (!removed && h.name.toLowerCase() === lower) {
      removed = true
      continue
    }
    out.push(h)
  }
  return out
}

/** Prepend a header to the list (used for Via and Record-Route). */
const prependHeader = (
  headers: ReadonlyArray<SipHeader>,
  name: string,
  value: string
): SipHeader[] => [{ name, value }, ...headers]

/**
 * RFC 3261 §18.2.1 + RFC 3581 §4: when a stateful proxy / UAS receives a
 * request, it MUST add `received=<src-ip>` to the topmost Via if the Via
 * sent-by host differs from the actual packet source address, and SHOULD
 * populate `rport=<src-port>` if the Via had an `rport` flag without a
 * value. The mutated Via is then carried in the forwarded request and
 * later used by the response-routing path (`handleResponseImpl`) to
 * deliver responses through NAT or non-routable upstream addresses.
 */
const populateReceivedRportOnTopVia = (
  headers: ReadonlyArray<SipHeader>,
  srcIp: string,
  srcPort: number,
): SipHeader[] => {
  const out: SipHeader[] = []
  let updated = false
  for (const h of headers) {
    if (!updated && h.name.toLowerCase() === "via") {
      // Parse just enough of `SIP/2.0/UDP host:port;param=val;...` to
      // (a) compare sent-by host to srcIp and (b) splice `received=` /
      // populate `rport=` without disturbing the rest.
      let value = h.value
      const semi = value.indexOf(";")
      const head = semi === -1 ? value : value.slice(0, semi)
      const params = semi === -1 ? "" : value.slice(semi)
      // head = "SIP/2.0/UDP host:port" — extract host:port.
      const hp = head.split(" ").pop() ?? ""
      const colon = hp.lastIndexOf(":")
      const sentByHost = colon === -1 ? hp : hp.slice(0, colon)
      const needReceived = sentByHost !== srcIp
      // Already has received=? then RFC §18.2.1 says "MUST add" — but if
      // upstream stamped one, leave it. Reasonable.
      const hasReceived = /;received=/i.test(params)
      // rport flag (no value) → populate. If already populated or absent
      // from the original Via, leave alone.
      const rportFlag = /(^|;)rport(?=;|$)/i.test(params)
      let nextParams = params
      if (needReceived && !hasReceived) {
        nextParams += `;received=${srcIp}`
      }
      if (rportFlag) {
        nextParams = nextParams.replace(/;rport(?=;|$)/i, `;rport=${srcPort}`)
      }
      value = head + nextParams
      out.push({ name: h.name, value })
      updated = true
    } else {
      out.push(h)
    }
  }
  return out
}

/** Replace first occurrence of `name`, or append if absent. */
const upsertHeader = (
  headers: ReadonlyArray<SipHeader>,
  name: string,
  value: string
): SipHeader[] => {
  const lower = name.toLowerCase()
  const out: SipHeader[] = []
  let replaced = false
  for (const h of headers) {
    if (!replaced && h.name.toLowerCase() === lower) {
      out.push({ name, value })
      replaced = true
    } else {
      out.push(h)
    }
  }
  if (!replaced) out.push({ name, value })
  return out
}

/**
 * Build a Record-Route URI. Loose-routing per RFC 3261 §16.6.5 (`;lr`).
 * Strategy-supplied stickiness params (e.g. `target=host:port`, `w=worker-3`)
 * are stamped before `;lr` so they live on the URI itself, not on the header.
 */
const buildRecordRouteValue = (
  addr: { readonly ip: string; readonly port: number },
  stickiness: Option.Option<RouteParams>
): string => {
  let uri = `sip:${addr.ip}:${addr.port}`
  if (Option.isSome(stickiness)) {
    for (const [k, v] of Object.entries(stickiness.value)) {
      uri += `;${k}=${v}`
    }
  }
  uri += ";lr"
  return `<${uri}>`
}
