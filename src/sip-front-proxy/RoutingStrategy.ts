/**
 * RoutingStrategy — D2 of the SIP Front Proxy plan.
 *
 * The proxy *core* owns every SIP mechanic (classify, top-Route inspect/strip
 * via stack helpers, Via push/pop, CANCEL branch→target LRU, forward via
 * `SignalingNetwork`). The strategy never touches message bytes; the core
 * never makes a routing-policy decision.
 *
 * A concrete strategy plugs in three pure-ish hooks:
 *
 *   - `selectForNewDialog` — pick the downstream target for an out-of-dialog
 *     or non-sticky in-dialog request. Returns `NoTargetAvailable` when no
 *     destination can be chosen; the core synthesizes a 503 in that case
 *     (PR2 keeps it simple — the only built-in is `ForwardAll` which always
 *     succeeds, but the seam lets `LoadBalancer` (PR3b) signal "no live
 *     workers").
 *
 *   - `encodeStickiness` — given a chosen target, optionally produce route
 *     params that the core will append to the Record-Route URI it inserts
 *     for dialog-creating requests (RFC 3261 §16.6.5). Returning `None`
 *     means "this strategy has no per-dialog stickiness to remember".
 *
 *   - `decodeStickiness` — given a parsed top-Route URI's params (the one
 *     pointing at us, which the core just stripped per §16.4), recover the
 *     downstream target the strategy originally encoded. Four outcomes:
 *       - `forward { target }`: forward straight to that address;
 *       - `forwardBackup { target }`: primary worker is dead/draining-post-grace,
 *         strategy fell back to the cookie's backup ordinal which is alive.
 *         The core forwards exactly like `forward` but counts a distinct
 *         `decode_forward_backup` decision for HA observability (D8 of the
 *         HA-resilience plan).
 *       - `reject { status, reason }`: synthesize a response (e.g. 403 on
 *         HMAC tamper detection in `LoadBalancer`);
 *       - `unknown`: stickiness couldn't be parsed; core falls back to
 *         `selectForNewDialog`.
 *
 * The strategy is exposed as an Effect service (`ServiceMap.Service`) so
 * different layers — `ForwardAllStrategyLive`, `LoadBalancerStrategyLive`
 * (PR3b), `SippFanoutStrategyLive` (future) — can be swapped at the layer
 * boundary without changing core code.
 */

import { Data, Effect, Option, ServiceMap } from "effect"
import type { SipMessage } from "../sip/types.js"

// ---------------------------------------------------------------------------
// Public value types
// ---------------------------------------------------------------------------

/** Downstream UDP target — host:port pair the core will `endpoint.send` to. */
export interface SocketAddr {
  readonly host: string
  readonly port: number
}

/**
 * Stickiness payload encoded into / decoded out of a Record-Route URI by the
 * strategy. Plain `Record<string, string>` because URI params live as opaque
 * `;k=v` pairs on the wire. Values must already be safe for URI encoding —
 * the core appends them verbatim. `ForwardAll` uses `{ target: "host:port" }`;
 * `LoadBalancer` will use `{ w: "<workerId>", s: "<hmac>" }`.
 */
export type RouteParams = Record<string, string>

/**
 * Outcome of `decodeStickiness`. Tagged so the core can dispatch on it
 * without unsafe casts.
 */
export type DecodeResult =
  | { readonly _tag: "forward"; readonly target: SocketAddr }
  | { readonly _tag: "forwardBackup"; readonly target: SocketAddr }
  | { readonly _tag: "reject"; readonly status: number; readonly reason: string }
  | { readonly _tag: "unknown" }

export const DecodeResult = {
  forward: (target: SocketAddr): DecodeResult => ({ _tag: "forward", target }),
  forwardBackup: (target: SocketAddr): DecodeResult => ({ _tag: "forwardBackup", target }),
  reject: (status: number, reason: string): DecodeResult => ({ _tag: "reject", status, reason }),
  unknown: (): DecodeResult => ({ _tag: "unknown" }),
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * `selectForNewDialog` failure: the strategy has no live target to give.
 * Core handles it by synthesizing a 503 Service Unavailable back to the
 * source. PR2's `ForwardAll` never produces this; PR3b's `LoadBalancer`
 * raises it when the worker pool is empty.
 */
export class NoTargetAvailable extends Data.TaggedError("NoTargetAvailable")<{
  readonly reason: string
}> {}

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export interface RoutingStrategyApi {
  /** Human-readable name for logs / metrics. e.g. "ForwardAll", "LoadBalancer". */
  readonly name: string
  /**
   * Pick a downstream target for a request that has no usable stickiness
   * cookie (initial INVITE, or in-dialog request where decoding failed).
   */
  readonly selectForNewDialog: (
    msg: SipMessage
  ) => Effect.Effect<SocketAddr, NoTargetAvailable>
  /**
   * Recover the downstream target previously encoded into the topmost Route
   * URI's params (the proxy already verified the URI points at us and
   * stripped that Route header).
   */
  readonly decodeStickiness: (
    routeParam: RouteParams,
    msg: SipMessage
  ) => Effect.Effect<DecodeResult>
  /**
   * Build the URI params we want stamped into the Record-Route the core
   * inserts for dialog-creating requests. Strategies that don't need
   * stickiness (or fail to encode it) return `Option.none()`.
   */
  readonly encodeStickiness: (
    target: SocketAddr,
    msg: SipMessage
  ) => Option.Option<RouteParams>
}

export class RoutingStrategy extends ServiceMap.Service<RoutingStrategy, RoutingStrategyApi>()(
  "@sipjsserver/sip-front-proxy/RoutingStrategy"
) {}
