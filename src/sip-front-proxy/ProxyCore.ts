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
import { ProxyLogger, type ProxyLoggerApi } from "./observability/Logger.js"
import {
  ProxyMetrics,
  type ProxyMetricsApi,
  type RoutingDecisionKind,
} from "./observability/Metrics.js"
import { ProxyTracing, type ProxyTracingApi } from "./observability/Tracing.js"
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
  readonly endpoint: UdpEndpoint
  /** Final ip:port the proxy binds on (resolved from `ProxyBindConfig`). */
  readonly localAddress: { readonly ip: string; readonly port: number }
  /** ip:port advertised in our Via / Record-Route headers. */
  readonly advertisedAddress: { readonly ip: string; readonly port: number }
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

  const queueMax = cfg.queueMax ?? 1024
  const endpoint = yield* network
    .bindUdp({
      ip: cfg.bindHost,
      port: cfg.bindPort,
      queueMax,
      reusePort: cfg.reusePort ?? false,
    })
    .pipe(Effect.orDie)

  const localAddress = endpoint.localAddress
  const advertisedAddress = {
    ip: cfg.advertisedHost ?? localAddress.ip,
    port: cfg.advertisedPort ?? localAddress.port,
  }
  const counters = newCounters()

  yield* Effect.logInfo(
    `[sip-front-proxy/ProxyCore] strategy=${strategy.name} bound=${localAddress.ip}:${localAddress.port} advertised=${advertisedAddress.ip}:${advertisedAddress.port}`
  )

  const sendBuf = (buf: Buffer, dst: SocketAddr) =>
    endpoint.send(buf, dst.port, dst.host).pipe(
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

  const replyToSource = (
    buf: Buffer,
    src: { readonly address: string; readonly port: number }
  ) => sendBuf(buf, { host: src.address, port: src.port })

  // -------------------------------------------------------------------------
  // Per-packet handling — split by message type
  // -------------------------------------------------------------------------

  const handleRequest = (
    req: SipRequest,
    src: { readonly address: string; readonly port: number }
  ) =>
    handleRequestImpl({
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

  const handleResponse = (msg: SipMessage) =>
    handleResponseImpl({
      msg,
      advertisedAddress,
      counters,
      sendBuf,
      metrics,
    })

  // -------------------------------------------------------------------------
  // Ingress fiber — forked into the layer's scope (cancelled on shutdown)
  // -------------------------------------------------------------------------

  yield* Effect.forkScoped(
    Stream.runForEach(endpoint.messages, (packet) =>
      Effect.gen(function* () {
        const parsed = yield* parser.parse(packet.raw).pipe(
          Effect.catchTag("SipParseError", (err) =>
            Effect.sync(() => {
              counters.parseDropped++
            }).pipe(
              Effect.tap(() =>
                Effect.logWarning(
                  `[ProxyCore] dropped malformed packet from ${packet.rinfo.address}:${packet.rinfo.port}: ${err.reason}`
                )
              ),
              Effect.as(undefined as SipMessage | undefined)
            )
          )
        )
        if (parsed === undefined) return
        if (parsed.type === "request") {
          yield* handleRequest(parsed, packet.rinfo)
        } else {
          yield* handleResponse(parsed)
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(`[ProxyCore] unhandled error during packet handling`, cause)
        )
      )
    )
  )

  return {
    endpoint,
    localAddress,
    advertisedAddress,
  } satisfies ProxyCoreApi
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
      let nextHeaders: SipHeader[] = [...headers]
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
  readonly counters: ProxyCounters
  readonly sendBuf: (buf: Buffer, dst: SocketAddr) => Effect.Effect<void>
  readonly metrics: ProxyMetricsApi
}

const handleResponseImpl = (args: HandleResponseArgs): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { msg, advertisedAddress, counters, sendBuf, metrics } = args
    if (msg.type !== "response") return

    yield* metrics.recordMessage({
      direction: "inbound",
      methodOrStatus: String(msg.status),
      result: "forwarded",
    })

    // RFC 3261 §16.7.3: pop the topmost Via (must be one we own — i.e. the
    // sent-by host:port matches our advertised address). Forward to the
    // *next* Via's address.
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
    if (top.host !== advertisedAddress.ip || (top.port ?? 5060) !== advertisedAddress.port) {
      counters.responseDroppedNoVia++
      yield* Effect.logWarning(
        `[ProxyCore] response dropped — top Via ${top.host}:${top.port ?? 5060} is not us (${advertisedAddress.ip}:${advertisedAddress.port})`
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

    const headers = removeFirstHeader(msg.headers, "via")
    const outBuf = serialize({ ...msg, headers })
    counters.routedResponses++
    yield* sendBuf(outBuf, { host, port })
    yield* metrics.recordMessage({
      direction: "outbound",
      methodOrStatus: String(msg.status),
      result: "forwarded",
    })
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
