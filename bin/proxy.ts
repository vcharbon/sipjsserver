/**
 * SIP Front Proxy entry point.
 *
 * PR2 wires the real `ProxyCore` + `ForwardAllStrategy` over
 * `SignalingNetwork.real` and forwards every received SIP message to a
 * single configured backend. The PR1 echo behavior is gone — for a raw
 * UDP echo loop, drop back to `git show 25de99f^:bin/proxy.ts`.
 *
 * Configuration (env-driven, no `AppConfig` dep — see `docs/todos/SIP-Front-Proxy.md` D9):
 *   - PROXY_BIND_HOST           default "0.0.0.0"
 *   - PROXY_BIND_PORT           default 5070
 *   - PROXY_ADVERTISED_HOST     default = bind host (override behind NAT / Service VIP)
 *   - PROXY_ADVERTISED_PORT     default = bind port
 *   - PROXY_FORWARD_TARGET      required: "host:port" — the single backend
 *                               every dialog gets forwarded to. Without it
 *                               the proxy refuses to start.
 *
 * Manual smoke (two terminals):
 *   PROXY_FORWARD_TARGET=127.0.0.1:5061 npm run proxy:dev
 *   sipp -sn uas -p 5061 127.0.0.1
 *   sipp -sn uac -s alice 127.0.0.1:5070
 */

import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { SignalingNetwork } from "../src/sip/SignalingNetwork.js"
import {
  CancelBranchLru,
  ForwardAllConfig,
  ForwardAllStrategyLive,
  ProxyBindConfig,
  ProxyCore,
  PROXY_VERSION,
  type SocketAddr,
} from "../src/sip-front-proxy/index.js"

const DEFAULT_BIND_HOST = "0.0.0.0"
const DEFAULT_BIND_PORT = 5070

const parsePort = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.length === 0) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 && n <= 65535 ? n : fallback
}

const parseTarget = (raw: string | undefined): SocketAddr => {
  if (raw === undefined || raw.length === 0) {
    throw new Error("PROXY_FORWARD_TARGET is required (format: host:port)")
  }
  const colon = raw.lastIndexOf(":")
  if (colon === -1) {
    throw new Error(`PROXY_FORWARD_TARGET malformed: ${raw} (expected host:port)`)
  }
  const host = raw.slice(0, colon)
  const port = Number.parseInt(raw.slice(colon + 1), 10)
  if (host.length === 0 || !Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`PROXY_FORWARD_TARGET malformed: ${raw}`)
  }
  return { host, port }
}

const bindHost = process.env["PROXY_BIND_HOST"] ?? DEFAULT_BIND_HOST
const bindPort = parsePort(process.env["PROXY_BIND_PORT"], DEFAULT_BIND_PORT)
const advertisedHost = process.env["PROXY_ADVERTISED_HOST"] ?? bindHost
const advertisedPort = parsePort(process.env["PROXY_ADVERTISED_PORT"], bindPort)
const target = parseTarget(process.env["PROXY_FORWARD_TARGET"])

const program = Effect.gen(function* () {
  const proxy = yield* ProxyCore
  yield* Effect.logInfo(
    `sip-front-proxy ${PROXY_VERSION} bound=${proxy.localAddress.ip}:${proxy.localAddress.port} ` +
      `advertised=${proxy.advertisedAddress.ip}:${proxy.advertisedAddress.port} ` +
      `→ ${target.host}:${target.port}`
  )
  // ProxyCore's ingress fiber is forked into the layer scope; we just keep
  // the runtime alive until SIGINT/SIGTERM.
  return yield* Effect.never
})

const ProxyLayer = ProxyCore.Default.pipe(
  Layer.provide(
    Layer.mergeAll(
      SignalingNetwork.real,
      ProxyBindConfig.layer({
        bindHost,
        bindPort,
        advertisedHost,
        advertisedPort,
        reusePort: true,
      }),
      ForwardAllStrategyLive.pipe(
        Layer.provide(ForwardAllConfig.layer(target))
      ),
      CancelBranchLru.Default
    )
  )
)

NodeRuntime.runMain(Effect.scoped(program).pipe(Effect.provide(ProxyLayer)))
