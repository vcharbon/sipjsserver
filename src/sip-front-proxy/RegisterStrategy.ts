/**
 * RegisterStrategy — pluggable handler for inbound REGISTER requests on
 * the front proxy's external network.
 *
 * Slice 2 of `docs/plan/register-and-double-stack-bright-panda.md`. Two
 * variants:
 *
 *   - `noopLayer` — replies `501 Not Implemented`. Wired by the K8s-LB
 *     binary so REGISTER never produces a real binding (the K8s mode
 *     doesn't run a registrar).
 *   - `inMemoryRegistrarLayer` — delegates to the `Registrar` service:
 *     parses To-URI userpart, resolves effective Expires (header > Contact
 *     `;expires` param > default 3600), `Expires=0` removes the binding,
 *     otherwise stores it. Builds a 200 OK echoing the Contact and the
 *     effective Expires so the UA knows what the registrar granted.
 *
 * Out of scope for v1 (must NOT be assumed to work — flagged in plan):
 *   - 423 Interval Too Brief / Min-Expires
 *   - Wildcard `Contact: *`
 *   - Multiple bindings per AOR (forking)
 *   - RFC 3327 Path
 *   - Authentication
 *
 * The strategy is a *pure* (req → response) hook; it never touches the
 * UDP fabric directly. ProxyCore owns the "send the response on the
 * right endpoint" responsibility.
 */

import { Effect, Layer, ServiceMap } from "effect"
import {
  extractContactUri,
  getHeader,
  newTag,
  parseSipUri,
} from "../sip/MessageHelpers.js"
import { generateResponse } from "../sip/generators.js"
import { parseSipUriString } from "../sip/parsers/custom/structured-headers.js"
import type { SipHeader, SipRequest, SipResponse } from "../sip/types.js"
import { Registrar } from "./Registrar.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Default Expires when the REGISTER carries neither an `Expires` header
 * nor a `;expires=N` param on the Contact URI. RFC 3261 §10.2.1 lets the
 * registrar pick its own default; 3600s is the canonical choice and the
 * value the plan locked in for v1.
 */
export const DEFAULT_EXPIRES_SEC = 3600

export interface RegisterStrategyApi {
  /** Human-readable name for logs / metrics. */
  readonly name: string
  /**
   * Process an inbound REGISTER and return the response the proxy should
   * send back on the request's ingress endpoint. Always succeeds — any
   * "I refuse" outcome surfaces as a 4xx/5xx response, never as an error
   * channel. Keeps the proxy's request loop branch-free.
   */
  readonly handle: (req: SipRequest) => Effect.Effect<SipResponse>
}

export class RegisterStrategy extends ServiceMap.Service<
  RegisterStrategy,
  RegisterStrategyApi
>()("@sipjsserver/sip-front-proxy/RegisterStrategy") {
  // -------------------------------------------------------------------------
  // No-op (REGISTER not supported on this deployment)
  // -------------------------------------------------------------------------

  /**
   * Returns `501 Not Implemented` regardless of the request. Wire this in
   * K8s-LB deployments so any stray REGISTER (operator typo, scanner, …)
   * gets a clean spec-compliant rejection rather than a silent drop.
   */
  static readonly noopLayer: Layer.Layer<RegisterStrategy> = Layer.succeed(
    RegisterStrategy,
    {
      name: "noop",
      handle: (req) =>
        Effect.succeed(
          generateResponse(req, 501, "Not Implemented", { toTag: newTag() }),
        ),
    },
  )

  // -------------------------------------------------------------------------
  // Real registrar (delegates to Registrar service)
  // -------------------------------------------------------------------------

  /**
   * The registrar deployment's REGISTER handler. Pulls a `Registrar`
   * service out of the layer it was provided with — when the consumer
   * provides `Registrar.inMemoryLayer`, REGISTER traffic actually persists
   * bindings; provide `Registrar.noopLayer` instead and the strategy still
   * builds 200 OKs but every lookup returns nothing (useful as a stress
   * smoke for slice 3).
   */
  static readonly inMemoryRegistrarLayer: Layer.Layer<RegisterStrategy, never, Registrar> =
    Layer.effect(
      RegisterStrategy,
      Effect.gen(function* () {
        const registrar = yield* Registrar
        const handle = (req: SipRequest): Effect.Effect<SipResponse> =>
          Effect.gen(function* () {
            const aor = extractAorUserpart(req)
            const contactRaw = getHeader(req.headers, "contact")
            if (aor === undefined || contactRaw === undefined) {
              // RFC 3261 §10.3 requires the To URI for the AOR and at
              // least one Contact (or `Contact: *` for wildcard, which we
              // reject — out of v1 scope per the plan). Either-missing
              // means malformed input; 400 is the correct response.
              return generateResponse(req, 400, "Bad Request", {
                toTag: newTag(),
              })
            }
            const contactUri = extractContactUri(contactRaw)
            const expiresSec = computeEffectiveExpires(req, contactRaw)

            if (expiresSec <= 0) {
              // Single-Contact de-registration shape (the only one v1
              // supports — wildcard `Contact: *` is explicitly out of
              // scope and arrives in `contactRaw` as `*`, which fails
              // `extractContactUri` parsing → bad request above).
              yield* registrar.remove(aor)
            } else {
              yield* registrar.register(aor, contactUri, expiresSec)
            }

            // 200 OK echoes the granted Contact + Expires so the UA knows
            // what the registrar actually applied. Per RFC 3261 §10.3
            // step 8 the registrar MUST return all current bindings —
            // with v1's single-binding-per-AOR rule that's just this one.
            const echoContact = `${contactRaw};expires=${expiresSec}`
            const extraHeaders: SipHeader[] = [
              { name: "Contact", value: echoContact },
              { name: "Expires", value: String(expiresSec) },
            ]
            return generateResponse(req, 200, "OK", {
              toTag: newTag(),
              extraHeaders,
            })
          })
        return { name: "inMemoryRegistrar", handle }
      }),
    )
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Pull the AOR userpart from the To header. RFC 3261 §10.2 keys
 * registrations by the To URI; v1 uses userpart only (host ignored).
 * Returns `undefined` when the To URI is absent or unparseable, which
 * the caller surfaces as 400 Bad Request.
 */
function extractAorUserpart(req: SipRequest): string | undefined {
  const toUri = req.parsed.to.uri
  if (toUri === undefined || toUri.length === 0) return undefined
  const parsed = parseSipUri(toUri)
  if (parsed?.user === undefined || parsed.user.length === 0) return undefined
  return parsed.user.toLowerCase()
}

/**
 * Compute the effective Expires for a REGISTER per the precedence:
 *
 *   1. `Expires` header value (RFC 3261 §10.2.1.1).
 *   2. `;expires=N` param on the Contact URI (RFC 3261 §10.2.1.1).
 *   3. Registrar default (`DEFAULT_EXPIRES_SEC` = 3600).
 *
 * Negative or non-finite inputs collapse to the default; `0` is preserved
 * (it means de-registration in v1).
 */
function computeEffectiveExpires(
  req: SipRequest,
  contactValue: string,
): number {
  const headerVal = getHeader(req.headers, "expires")
  if (headerVal !== undefined) {
    const n = Number.parseInt(headerVal, 10)
    if (Number.isFinite(n) && n >= 0) return n
  }
  // Contact `;expires=N` lives on the URI's parameter list (after the `;`
  // following the user@host). `parseSipUriString` accepts angle-bracketed
  // OR bare URIs but the Contact header value carries display-name fluff
  // — strip it down to the bare URI before parsing.
  const ltIdx = contactValue.indexOf("<")
  const gtIdx = contactValue.indexOf(">")
  const bareUri =
    ltIdx >= 0 && gtIdx > ltIdx
      ? contactValue.slice(ltIdx + 1, gtIdx)
      : contactValue
  // Header-level params (after `>` for name-addr, after the URI for
  // addr-spec) ALSO carry `expires=N`. RFC 3261 §20.10 / §10.2.1.1 places
  // the `expires` param at the header level, not the URI level — peek at
  // both for robustness.
  const hdrTail = ltIdx >= 0 && gtIdx > ltIdx ? contactValue.slice(gtIdx + 1) : ""
  const hdrExpires = parseHeaderParam(hdrTail, "expires")
  if (hdrExpires !== undefined) {
    const n = Number.parseInt(hdrExpires, 10)
    if (Number.isFinite(n) && n >= 0) return n
  }
  const parsed = parseSipUriString(bareUri)
  const uriExpires = parsed?.params["expires"]
  if (typeof uriExpires === "string") {
    const n = Number.parseInt(uriExpires, 10)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return DEFAULT_EXPIRES_SEC
}

/**
 * Lift `;name=value` out of a Contact header tail (everything after the
 * closing `>` for a name-addr Contact). Tolerant of leading whitespace.
 * Returns the bare value with no quoting handling — REGISTER `;expires=`
 * is always a digit string in practice.
 */
function parseHeaderParam(tail: string, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const seg of tail.split(";")) {
    const trimmed = seg.trim()
    if (trimmed.length === 0) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    if (trimmed.slice(0, eq).toLowerCase() !== lower) continue
    return trimmed.slice(eq + 1)
  }
  return undefined
}
