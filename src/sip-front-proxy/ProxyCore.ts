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

import { Effect, Layer, Option, type Scope, ServiceMap, Stream } from "effect"
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
} from "./CancelBranchLru.js"
import {
  type RouteParams,
  RoutingStrategy,
  type RoutingStrategyApi,
  type SocketAddr,
} from "./RoutingStrategy.js"

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
  > = Layer.suspend(() =>
    Layer.effect(ProxyCore, makeProxyCore.pipe(Effect.provide(SipParser.layer)))
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
  | Scope.Scope
> = Effect.gen(function* () {
  const network = yield* SignalingNetwork
  const strategy = yield* RoutingStrategy
  const cancelLru = yield* CancelBranchLru
  const cfg = yield* ProxyBindConfig
  const parser = yield* SipParser

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
    })

  const handleResponse = (msg: SipMessage) =>
    handleResponseImpl({
      msg,
      advertisedAddress,
      counters,
      sendBuf,
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
}

const DIALOG_CREATING: ReadonlySet<string> = new Set(["INVITE", "SUBSCRIBE"])

const handleRequestImpl = (args: HandleRequestArgs): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { req, src, advertisedAddress, strategy, cancelLru, counters, sendBuf, replyToSource } = args

    // ── §16.3 + Max-Forwards check ────────────────────────────────────────
    const mfRaw = getHeader(req.headers, "max-forwards")
    const mf = mfRaw === undefined ? 70 : Number.parseInt(mfRaw, 10)
    if (Number.isFinite(mf) && mf <= 0) {
      counters.maxForwardsRejected++
      const resp = generateResponse(req, 483, "Too Many Hops", { toTag: newTag() })
      yield* replyToSource(serialize(resp), src)
      return
    }
    const mfNext = (Number.isFinite(mf) ? mf : 70) - 1

    // ── §16.4 Route preprocessing ─────────────────────────────────────────
    // If topmost Route points at us, strip it and remember the params (used
    // below for stickiness decoding).
    let headers: ReadonlyArray<SipHeader> = req.headers
    let strippedRouteParams: RouteParams | undefined
    const topRoute = getHeader(headers, "route")
    if (topRoute !== undefined) {
      const parsedRoute = parseSipUri(topRoute)
      if (
        parsedRoute !== undefined &&
        parsedRoute.host === advertisedAddress.ip &&
        parsedRoute.port === advertisedAddress.port
      ) {
        headers = removeFirstHeader(headers, "route")
        strippedRouteParams = parsedRoute.params
        counters.routeStripped++
      }
    }

    // ── Pick the downstream target ────────────────────────────────────────
    const method = req.method.toUpperCase()
    let target: SocketAddr | undefined
    let synthesizedReply: { status: number; reason: string } | undefined

    if (method === "CANCEL") {
      // §16.10: forward CANCEL to the same downstream as the matching INVITE.
      // Match by the topmost Via branch — for stateless proxies, this is the
      // branch the upstream UAC put on the INVITE that we mirrored on the
      // CANCEL we are now seeing.
      const branch = req.parsed.via.branch
      if (branch !== undefined) {
        const found = yield* cancelLru.lookup(branch)
        if (Option.isSome(found)) {
          target = found.value
          counters.cancelMatched++
        }
      }
      if (target === undefined) {
        counters.cancelUnmatched++
        // Fall back to selectForNewDialog so a CANCEL we never saw the INVITE
        // for still gets forwarded somewhere reasonable. Stateless proxies
        // can't conjure a "we don't know" — we'd otherwise drop.
        target = yield* tryStrategySelect(strategy, req, counters)
      }
    } else if (strippedRouteParams !== undefined) {
      const decoded = yield* strategy.decodeStickiness(strippedRouteParams, req)
      switch (decoded._tag) {
        case "forward":
          target = decoded.target
          break
        case "reject":
          synthesizedReply = { status: decoded.status, reason: decoded.reason }
          break
        case "unknown":
          target = yield* tryStrategySelect(strategy, req, counters)
          break
      }
    } else {
      target = yield* tryStrategySelect(strategy, req, counters)
    }

    if (synthesizedReply !== undefined) {
      const resp = generateResponse(req, synthesizedReply.status, synthesizedReply.reason, {
        toTag: newTag(),
      })
      yield* replyToSource(serialize(resp), src)
      return
    }

    if (target === undefined) {
      // selectForNewDialog raised NoTargetAvailable → emit 503 to source.
      const resp = generateResponse(req, 503, "Service Unavailable", {
        toTag: newTag(),
        extraHeaders: [{ name: "Retry-After", value: "5" }],
      })
      yield* replyToSource(serialize(resp), src)
      return
    }

    // ── §16.6 / §16.6.5 Record-Route ──────────────────────────────────────
    let nextHeaders: SipHeader[] = [...headers]
    // Update Max-Forwards in place (or append).
    nextHeaders = upsertHeader(nextHeaders, "Max-Forwards", String(mfNext))

    if (DIALOG_CREATING.has(method)) {
      const stickiness = strategy.encodeStickiness(target, req)
      const rrValue = buildRecordRouteValue(advertisedAddress, stickiness)
      // Insert Record-Route at the top of the header set so it sits ahead of
      // any existing Record-Route (RFC 3261 §16.6.4 — proxies prepend).
      nextHeaders = prependHeader(nextHeaders, "Record-Route", rrValue)
      counters.recordRouteInserted++
    }

    // ── §16.6.4 push our Via on top with a unique branch ──────────────────
    const ourBranch = newBranch()
    const viaValue = `SIP/2.0/UDP ${advertisedAddress.ip}:${advertisedAddress.port};branch=${ourBranch};rport`
    nextHeaders = prependHeader(nextHeaders, "Via", viaValue)

    // ── Remember branch→target for CANCEL correlation ─────────────────────
    if (method === "INVITE") {
      yield* cancelLru.remember(ourBranch, target)
    }

    // ── Serialize + fire-and-forget send ──────────────────────────────────
    const outBuf = serialize({ ...req, headers: nextHeaders })
    counters.routedRequests++
    yield* sendBuf(outBuf, target)
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
}

const handleResponseImpl = (args: HandleResponseArgs): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { msg, advertisedAddress, counters, sendBuf } = args
    if (msg.type !== "response") return

    // RFC 3261 §16.7.3: pop the topmost Via (must be one we own — i.e. the
    // sent-by host:port matches our advertised address). Forward to the
    // *next* Via's address.
    const vias = msg.parsed.vias
    if (vias.length < 2) {
      counters.responseDroppedNoVia++
      yield* Effect.logWarning(
        `[ProxyCore] response dropped — only ${vias.length} Via header(s); cannot relay upstream`
      )
      return
    }
    const top = vias[0]!
    if (top.host !== advertisedAddress.ip || (top.port ?? 5060) !== advertisedAddress.port) {
      counters.responseDroppedNoVia++
      yield* Effect.logWarning(
        `[ProxyCore] response dropped — top Via ${top.host}:${top.port ?? 5060} is not us (${advertisedAddress.ip}:${advertisedAddress.port})`
      )
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
