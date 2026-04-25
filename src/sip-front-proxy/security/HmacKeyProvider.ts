/**
 * HmacKeyProvider — D14 of the SIP Front Proxy plan.
 *
 * Owns the HMAC key material the `LoadBalancerStrategy` (PR3b) uses to
 * sign and verify the routing cookie it stamps onto Record-Route URIs.
 *
 * The interface is small on purpose:
 *
 *   - `sign(input)` MACs `input` with the **current** key and returns
 *     `{ kid, mac }` so the caller can stamp both onto the cookie.
 *   - `verify(input, kid, mac)` accepts EITHER the current key OR the
 *     optional **previous** key (NFR-8 1h overlap window for fleet-wide
 *     key rotation per D14).
 *
 * Implementation notes:
 *   - HMAC-SHA256 (32-byte output). Truncation, if any, is the
 *     strategy's choice; this provider returns the full digest.
 *   - Verify uses `crypto.timingSafeEqual` to avoid leaking bits via
 *     comparison timing. The kid lookup itself is plain string equality
 *     (the kid is non-secret — it's stamped on the wire — and so timing
 *     leaks on it would only let an attacker enumerate kids they could
 *     have observed anyway).
 *   - Only the `static` impl ships in this PR. The `kubernetesSecret`
 *     fs-watch impl (D14 / PR5) lives behind the same interface and
 *     will reuse the same `verify`/`sign` shape with current+previous
 *     reloads driven by `chokidar`-style notifications.
 *
 * TODO(PR5): add `kubernetesSecret({ currentPath, previousPath? })`
 * impl per D14 — fs-watch the mounted Secret files, hot-reload on
 * change, keep one rotation generation in `previous` for NFR-8.
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import { Data, Effect, Layer, ServiceMap } from "effect"

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface HmacKey {
  /**
   * Short opaque identifier carried in the cookie (kid). Distinct kids let
   * verify pick the right key during the rotation overlap window.
   */
  readonly id: string
  /**
   * Raw key material. HMAC-SHA256 has no formal minimum-length rule but
   * RFC 2104 §3 strongly recommends >=L bytes (here L=32 for SHA-256). We
   * enforce >=16 bytes at construction; anything weaker would betray an
   * operational mistake.
   */
  readonly bytes: Uint8Array
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Layer-build failure when key material is missing or too short. */
export class HmacKeyProviderConfigError extends Data.TaggedError(
  "HmacKeyProviderConfigError"
)<{
  readonly reason: string
}> {}

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export interface HmacSignResult {
  /** Identifier of the key used to produce `mac`. */
  readonly kid: string
  /** Full HMAC-SHA256 digest (32 bytes). */
  readonly mac: Uint8Array
}

export interface HmacKeyProviderApi {
  /** MAC `input` with the current key; returns kid + mac. */
  readonly sign: (input: Uint8Array) => Effect.Effect<HmacSignResult>
  /**
   * Verify `mac` against `input`. Accepts the current key or the optional
   * previous key, selected by `kid`. Returns `false` for unknown kid,
   * length mismatch, or constant-time digest mismatch.
   */
  readonly verify: (
    input: Uint8Array,
    kid: string,
    mac: Uint8Array
  ) => Effect.Effect<boolean>
}

export class HmacKeyProvider extends ServiceMap.Service<HmacKeyProvider, HmacKeyProviderApi>()(
  "@sipjsserver/sip-front-proxy/HmacKeyProvider"
) {}

// ---------------------------------------------------------------------------
// Static impl
// ---------------------------------------------------------------------------

const HMAC_ALGO = "sha256"
/** RFC 2104 §3: keys shorter than the hash output should be avoided. */
const MIN_KEY_BYTES = 16

const macFor = (key: HmacKey, input: Uint8Array): Uint8Array => {
  const h = createHmac(HMAC_ALGO, Buffer.from(key.bytes))
  h.update(input)
  return new Uint8Array(h.digest())
}

const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.byteLength !== b.byteLength) return false
  // node:crypto.timingSafeEqual requires Buffers of equal length; we just
  // checked the length so the call is safe.
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

const validateKey = (
  key: HmacKey,
  label: string
): HmacKeyProviderConfigError | undefined => {
  if (key.id.length === 0) {
    return new HmacKeyProviderConfigError({
      reason: `${label} key id must be non-empty`,
    })
  }
  if (key.bytes.byteLength < MIN_KEY_BYTES) {
    return new HmacKeyProviderConfigError({
      reason: `${label} key must be at least ${MIN_KEY_BYTES} bytes (got ${key.bytes.byteLength})`,
    })
  }
  return undefined
}

export interface StaticOpts {
  /** Active key — used by both `sign` and `verify`. */
  readonly current: HmacKey
  /**
   * Previous key — accepted by `verify` only, for the NFR-8 rotation
   * overlap window. Omit when no rotation is in progress.
   */
  readonly previous?: HmacKey
}

/**
 * Build a Layer providing `HmacKeyProvider` from raw key material at
 * Layer-build time. Validates non-empty kid + minimum key length; failures
 * are surfaced as `HmacKeyProviderConfigError` so wiring code (or tests)
 * can pattern-match.
 */
export const staticLayer = (
  opts: StaticOpts
): Layer.Layer<HmacKeyProvider, HmacKeyProviderConfigError> =>
  Layer.effect(
    HmacKeyProvider,
    Effect.suspend(() => {
      const currentErr = validateKey(opts.current, "current")
      if (currentErr !== undefined) return Effect.fail(currentErr)
      if (opts.previous !== undefined) {
        const prevErr = validateKey(opts.previous, "previous")
        if (prevErr !== undefined) return Effect.fail(prevErr)
        if (opts.previous.id === opts.current.id) {
          return Effect.fail(
            new HmacKeyProviderConfigError({
              reason: `previous key id must differ from current key id (both are "${opts.current.id}")`,
            })
          )
        }
      }

      const current = opts.current
      const previous = opts.previous

      const sign = (input: Uint8Array): Effect.Effect<HmacSignResult> =>
        Effect.sync(() => ({ kid: current.id, mac: macFor(current, input) }))

      const verify = (
        input: Uint8Array,
        kid: string,
        mac: Uint8Array
      ): Effect.Effect<boolean> =>
        Effect.sync(() => {
          const key =
            kid === current.id
              ? current
              : previous !== undefined && kid === previous.id
                ? previous
                : undefined
          if (key === undefined) return false
          const expected = macFor(key, input)
          return constantTimeEqual(expected, mac)
        })

      return Effect.succeed({ sign, verify } satisfies HmacKeyProviderApi)
    })
  )
