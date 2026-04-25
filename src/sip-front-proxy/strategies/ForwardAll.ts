/**
 * ForwardAllStrategy — D11 of the SIP Front Proxy plan.
 *
 * Trivial routing strategy: every new dialog goes to one statically
 * configured backend. Stickiness is encoded as a plain `target=host:port`
 * URI param on the Record-Route the proxy core inserts (no HMAC — this
 * is dev/test scaffolding and the transit-only test suite). On in-dialog
 * requests the strategy reads that param back, parses it, and returns
 * `forward { target }`. If parsing fails the strategy returns `unknown`
 * and the core falls back to `selectForNewDialog` (which still points at
 * the configured backend).
 *
 * Dependencies: `ForwardAllConfig` only — a layer-supplied static target.
 * The intended dev-mode wiring in `bin/proxy.ts` reads `PROXY_FORWARD_TARGET`
 * out of the environment and provides this layer.
 */

import { Effect, Layer, Option, ServiceMap } from "effect"
import {
  type RouteParams,
  RoutingStrategy,
  type SocketAddr,
} from "../RoutingStrategy.js"
import { DecodeResult } from "../RoutingStrategy.js"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ForwardAllConfigData {
  readonly target: SocketAddr
}

export class ForwardAllConfig extends ServiceMap.Service<ForwardAllConfig, ForwardAllConfigData>()(
  "@sipjsserver/sip-front-proxy/ForwardAllConfig"
) {
  /** Build a Layer providing a static `ForwardAllConfig` from a target. */
  static readonly layer = (target: SocketAddr): Layer.Layer<ForwardAllConfig> =>
    Layer.succeed(ForwardAllConfig, { target })
}

// ---------------------------------------------------------------------------
// Stickiness encoding (dev-only — no signature)
// ---------------------------------------------------------------------------

const TARGET_PARAM = "target"

const encodeTarget = (target: SocketAddr): string => `${target.host}:${target.port}`

/**
 * Parse a `host:port` value back into a SocketAddr. Returns `undefined` on
 * any malformed input. We accept a missing port and default to 5060
 * (RFC 3261 default SIP port) — keeps tests from blowing up on degenerate
 * inputs without inviting silent misroutes (host alone is ambiguous, but
 * the only producer of this string is `encodeTarget` above, which always
 * stamps `host:port`).
 */
const parseTarget = (value: string): SocketAddr | undefined => {
  const colon = value.lastIndexOf(":")
  if (colon === -1) return undefined
  const host = value.slice(0, colon)
  const portStr = value.slice(colon + 1)
  if (host.length === 0 || portStr.length === 0) return undefined
  const port = Number.parseInt(portStr, 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return undefined
  return { host, port }
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const ForwardAllStrategyLive = Layer.effect(
  RoutingStrategy,
  Effect.gen(function* () {
    const cfg = yield* ForwardAllConfig
    return {
      name: "ForwardAll",
      selectForNewDialog: (_msg) => Effect.succeed(cfg.target),
      encodeStickiness: (target, _msg) =>
        Option.some<RouteParams>({ [TARGET_PARAM]: encodeTarget(target) }),
      decodeStickiness: (routeParam, _msg) =>
        Effect.sync(() => {
          const raw = routeParam[TARGET_PARAM]
          if (raw === undefined) return DecodeResult.unknown()
          const target = parseTarget(raw)
          if (target === undefined) return DecodeResult.unknown()
          return DecodeResult.forward(target)
        }),
    }
  })
)
