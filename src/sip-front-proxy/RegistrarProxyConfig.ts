/**
 * RegistrarProxyConfig — opt-in second-endpoint config for the front
 * proxy's registrar mode.
 *
 * Slice 2 of `docs/plan/register-and-double-stack-bright-panda.md`.
 *
 * `ProxyBindConfig` is the existing single-endpoint bind (the `ext`
 * fabric in registrar mode). When `RegistrarProxyConfig` is *also*
 * provided, `ProxyCore` binds a second `UdpEndpoint` at `coreBind` and
 * runs the dual-endpoint dispatch:
 *
 *   - REGISTER on `ext`            → `RegisterStrategy.handle`
 *   - INVITE on `ext`              → forward to `coreDestination` via
 *                                    `core` endpoint
 *   - INVITE on `core`             → `CoreToExtRoutingStrategy.resolve`
 *                                    → forward via `ext` endpoint
 *   - In-dialog (ACK/BYE/CANCEL/…) → existing Route/Via stack logic;
 *                                    egress endpoint follows the
 *                                    `;net=ext|core` tag we stamp on
 *                                    record-routed Vias.
 *
 * Read by `ProxyCore` via `Effect.serviceOption(RegistrarProxyConfig)`,
 * so the K8s-LB binary that doesn't need a second endpoint never has to
 * provide it. Absence ⇔ single-endpoint mode (= today's behaviour).
 */

import { Layer, ServiceMap } from "effect"
import type { SocketAddr } from "./RoutingStrategy.js"

export interface RegistrarProxyConfigData {
  /**
   * Bind address for the proxy's `core`-facing UDP endpoint. The proxy
   * listens here for traffic originated by the K8s app server (e.g. an
   * INVITE the core sends back to a registered AOR).
   */
  readonly coreBind: SocketAddr
  /**
   * Address advertised in the `core`-facing Via / Record-Route. Defaults
   * to `coreBind`. Distinct from `coreBind` when the proxy bind is on a
   * private interface but external-visible traffic uses a different
   * (NAT'd) address — same shape as `ProxyBindConfig.advertisedHost`.
   */
  readonly coreAdvertisedHost?: string
  readonly coreAdvertisedPort?: number
  /**
   * Wire-level destination on the `core` network for INVITEs forwarded
   * from `ext`. v1 supports a single fixed destination (the K8s app
   * server's SIP ingress); future variants of `ExtToCoreRoutingStrategy`
   * (out of v1 scope) could replace this with a strategy.
   */
  readonly coreDestination: SocketAddr
  /**
   * When `true` (existing register-proxy mode) the proxy inserts a
   * Record-Route on every dialog-creating request so in-dialog traffic
   * loops back through the proxy. When `false` (non-record-routing mode)
   * the proxy stays out of the in-dialog path: ACK/BYE/re-INVITE travel
   * peer-to-peer via each side's Contact and the proxy never sees them
   * after the initial INVITE/200/ACK setup.
   *
   * No default — every consumer must state intent explicitly.
   */
  readonly recordRoute: boolean
}

export class RegistrarProxyConfig extends ServiceMap.Service<
  RegistrarProxyConfig,
  RegistrarProxyConfigData
>()("@sipjsserver/sip-front-proxy/RegistrarProxyConfig") {
  /** Build a Layer providing a static `RegistrarProxyConfig`. */
  static readonly layer = (
    cfg: RegistrarProxyConfigData,
  ): Layer.Layer<RegistrarProxyConfig> => Layer.succeed(RegistrarProxyConfig, cfg)
}
