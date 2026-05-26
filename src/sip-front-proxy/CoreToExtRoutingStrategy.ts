/**
 * CoreToExtRoutingStrategy — pluggable resolver for inbound requests on
 * the front proxy's `core` network in registrar mode.
 *
 * Slice 2 of `docs/plan/register-and-double-stack-bright-panda.md`.
 *
 * Whenever the K8s app server initiates a fresh dialog toward a
 * registered AOR (e.g. inbound bridge call to `bob@…`), the INVITE lands
 * on our `core`-side endpoint with the AOR userpart in the Request-URI.
 * The proxy must turn the AOR into a wire-level destination on the `ext`
 * fabric (the registered Contact for that AOR).
 *
 * Two variants ship in v1:
 *
 *   - `noopLayer` — every request rejects with `404 Not Found`. Used in
 *     deployments that bind a `core` endpoint but haven't wired the
 *     registrar lookup yet (e.g. integration tests for the strategy plumb-
 *     ing without touching the binding store).
 *   - `registrarLookupLayer` — pulls the AOR userpart out of the Request-
 *     URI, looks it up in `Registrar`, and returns either the resolved
 *     Contact (forward) or 404 (no binding).
 *
 * Future variants (`databaseLayer`, `mixLayer`) plug into the same
 * service surface without touching ProxyCore — that's why the strategy
 * is kept *orthogonal* from `RegisterStrategy`.
 */

import { Effect, Layer, Option, ServiceMap } from "effect"
import { extractContactUri, parseSipUri } from "../sip/MessageHelpers.js"
import type { SipRequest } from "../sip/types.js"
import { Registrar } from "./Registrar.js"
import type { SocketAddr } from "./RoutingStrategy.js"

// ---------------------------------------------------------------------------
// Outcome ADT
// ---------------------------------------------------------------------------

/**
 * Result of `resolve`. ProxyCore dispatches on the tag:
 *   - `forward { destination }` → forward the INVITE to `destination` on the
 *      `ext` endpoint with the original Request-URI untouched. The registrar
 *      lookup uses the AOR userpart to find the binding; only the wire-level
 *      destination (host/port) comes from the registered Contact.
 *   - `reject { status, reason }` → synthesize a response and reply on
 *      the `core` endpoint.
 */
export type RouteOutcome =
  | {
      readonly _tag: "forward"
      readonly destination: SocketAddr
    }
  | {
      readonly _tag: "reject"
      readonly status: number
      readonly reason: string
    }

export const RouteOutcome = {
  forward: (destination: SocketAddr): RouteOutcome => ({
    _tag: "forward",
    destination,
  }),
  reject: (status: number, reason: string): RouteOutcome => ({
    _tag: "reject",
    status,
    reason,
  }),
}

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export interface CoreToExtRoutingStrategyApi {
  /** Human-readable name for logs / metrics. */
  readonly name: string
  /**
   * Resolve a wire-level destination (and the new Request-URI to stamp)
   * for a request that arrived on the core endpoint. Always succeeds —
   * "no destination" surfaces as `RouteOutcome.reject(404, ...)` so the
   * proxy's request loop has one decision point.
   */
  readonly resolve: (req: SipRequest) => Effect.Effect<RouteOutcome>
}

export class CoreToExtRoutingStrategy extends ServiceMap.Service<
  CoreToExtRoutingStrategy,
  CoreToExtRoutingStrategyApi
>()("@sipjsserver/sip-front-proxy/CoreToExtRoutingStrategy") {
  // -------------------------------------------------------------------------
  // No-op (always 404)
  // -------------------------------------------------------------------------

  static readonly noopLayer: Layer.Layer<CoreToExtRoutingStrategy> =
    Layer.succeed(CoreToExtRoutingStrategy, {
      name: "noop",
      resolve: (_req) => Effect.succeed(RouteOutcome.reject(404, "Not Found")),
    })

  // -------------------------------------------------------------------------
  // Registrar lookup
  // -------------------------------------------------------------------------

  /**
   * Resolve via the `Registrar` service. Steps per RFC 3261 §16.5:
   *
   *   1. Extract the AOR key from the Request-URI userpart (lowercase,
   *      v1 uses userpart only — see `Registrar` doc).
   *   2. Look up the live binding. Missing or expired → `404`.
   *   3. Parse the bound Contact URI to get host/port. If unparseable,
   *      `500 Server Internal Error` (we wrote it; if we can't read it
   *      back, that's our bug, not the caller's).
   *   4. Return `forward { destination }`. The original Request-URI is
   *      preserved on the outbound INVITE — only the wire-level destination
   *      (host/port) comes from the registered Contact.
   */
  static readonly registrarLookupLayer: Layer.Layer<
    CoreToExtRoutingStrategy,
    never,
    Registrar
  > = Layer.effect(
    CoreToExtRoutingStrategy,
    Effect.gen(function* () {
      const registrar = yield* Registrar
      const resolve = (req: SipRequest): Effect.Effect<RouteOutcome> =>
        Effect.gen(function* () {
          const aor = extractRuriUserpart(req)
          if (aor === undefined) return RouteOutcome.reject(400, "Bad Request")
          const found = yield* registrar.lookup(aor)
          if (Option.isNone(found)) return RouteOutcome.reject(404, "Not Found")
          // Strip angle brackets / display-name from the stored value
          // before parsing — defensive, even though Registrar is supposed
          // to store the bare URI.
          const bareContact = extractContactUri(found.value.contactUri)
          const parsed = parseSipUri(bareContact)
          if (parsed === undefined) {
            return RouteOutcome.reject(500, "Server Internal Error")
          }
          const destination: SocketAddr = {
            host: parsed.host,
            port: parsed.port,
          }
          return RouteOutcome.forward(destination)
        })
      return { name: "registrarLookup", resolve }
    }),
  )
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the AOR key from a request's Request-URI userpart. Returns
 * `undefined` when the URI lacks a userpart — slice 2 only resolves
 * `sip:<user>@<host>` shapes. Lowercased to match `Registrar`'s
 * case-insensitive key.
 */
function extractRuriUserpart(req: SipRequest): string | undefined {
  const ruri = req.uri
  if (ruri.length === 0) return undefined
  const parsed = parseSipUri(ruri)
  if (parsed?.user === undefined || parsed.user.length === 0) return undefined
  return parsed.user.toLowerCase()
}
