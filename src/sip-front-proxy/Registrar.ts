/**
 * Registrar — in-memory AOR → Contact binding store for the front proxy
 * when it operates in registrar + recursive-proxy mode (the second
 * deployment shape introduced by the REGISTER + double-stack work).
 *
 * v1 scope (slice 2 of `docs/plan/register-and-double-stack-bright-panda.md`):
 *
 *   - **single binding per AOR** — each REGISTER for a userpart replaces
 *     whatever was there before. Forking / multiple-contacts is v2.
 *   - **userpart-only AOR key** — extracted from the To-URI (REGISTER) or
 *     Request-URI userpart (incoming INVITE on the core network), lower-
 *     cased. The host part is intentionally ignored — single-tenant scope
 *     for v1; documented in the plan.
 *   - **lazy TTL on Effect `Clock`** — every `lookup`/`register` checks
 *     `Clock.currentTimeMillis` against the stored expiry and silently
 *     drops expired entries. Determinism under `TestClock` is the whole
 *     point: no background sweeper.
 *   - **Contact stored verbatim** — RFC 3261 §10.3 says the registrar
 *     stores what the UA puts in Contact. No NAT rewriting (no NAT
 *     support in v1).
 *
 * Two layers:
 *
 *   - `Registrar.noopLayer` — `lookup` always returns `Option.none`,
 *     `register` no-ops, `remove` no-ops. The "registrar disabled" mode
 *     used by the existing K8s-LB binary so its dependency surface
 *     stays the same after slice 2 lands.
 *   - `Registrar.inMemoryLayer` — the real binding store. Used when
 *     `RegisterStrategy.inMemoryRegistrar` and
 *     `CoreToExtRoutingStrategy.registrarLookup` are wired together at
 *     startup to form the registrar deployment.
 *
 * Pattern mirrors `CallStateCache.memoryLayer`
 * ([src/call/CallStateCache.ts:140](src/call/CallStateCache.ts#L140)) so a
 * future `Registrar.redisLayer` slot in cleanly when persistence becomes a
 * v2 requirement.
 */

import { Clock, Effect, Layer, MutableHashMap, Option, ServiceMap } from "effect"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A live AOR binding. */
export interface Binding {
  /** Lowercased userpart from the To-URI. */
  readonly aor: string
  /**
   * Contact URI as supplied by the REGISTER. Carries scheme, user, host,
   * port and any params verbatim. `extractContactUri` is what the
   * registrar uses to peel angle brackets / display name; what's stored
   * here is the bare URI string (e.g. `sip:alice@10.20.0.5:5061`).
   */
  readonly contactUri: string
  /** Absolute virtual-clock millis when this binding expires. */
  readonly expiresAtMs: number
}

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export interface RegistrarApi {
  /**
   * Store / refresh the binding `aor → contactUri` with a `ttlSec`-long
   * lifetime (in seconds, like the Expires header). Existing binding for
   * the same `aor` is replaced (v1 = single-binding, last-write-wins).
   */
  readonly register: (
    aor: string,
    contactUri: string,
    ttlSec: number,
  ) => Effect.Effect<Binding>

  /**
   * Look up the live binding for `aor`. Returns `Option.none()` when the
   * AOR has no binding OR the binding has expired (lazy sweep).
   */
  readonly lookup: (aor: string) => Effect.Effect<Option.Option<Binding>>

  /** Remove the binding for `aor` immediately. Idempotent. */
  readonly remove: (aor: string) => Effect.Effect<void>
}

export class Registrar extends ServiceMap.Service<Registrar, RegistrarApi>()(
  "@sipjsserver/sip-front-proxy/Registrar",
) {
  // -------------------------------------------------------------------------
  // No-op (registrar disabled)
  // -------------------------------------------------------------------------

  /**
   * Disabled-registrar layer. Every `lookup` returns `none`; `register`
   * accepts the call and discards the binding (so callers can pretend the
   * registrar acknowledged without keeping any state).
   *
   * Used by the legacy K8s-LB binary so the proxy's dependency surface
   * after slice 2 still resolves without operators wiring registrar
   * machinery they don't run.
   */
  static readonly noopLayer: Layer.Layer<Registrar> = Layer.succeed(Registrar, {
    register: (aor, contactUri, ttlSec) =>
      Effect.succeed({
        aor: aor.toLowerCase(),
        contactUri,
        expiresAtMs: ttlSec > 0 ? Number.MAX_SAFE_INTEGER : 0,
      }),
    lookup: (_aor) => Effect.succeed(Option.none<Binding>()),
    remove: (_aor) => Effect.void,
  })

  // -------------------------------------------------------------------------
  // In-memory implementation
  // -------------------------------------------------------------------------

  /**
   * In-memory binding store. AOR keys are lowercased (case-insensitive
   * match per RFC 3261 §19.1.4 for user/host parts). Lazy expiry on every
   * `lookup` / `register`: an entry whose `expiresAtMs <= now` is removed
   * before the call returns its result.
   *
   * Reads `Clock.currentTimeMillis`, so `TestClock.adjust` deterministically
   * expires entries — the slice 3 TTL test relies on this.
   */
  static readonly inMemoryLayer: Layer.Layer<Registrar> = Layer.effect(
    Registrar,
    Effect.gen(function* () {
      // userpart (lowercased) → Binding. MutableHashMap matches the
      // CallStateCache.memoryLayer pattern: hot-path map, no Ref overhead.
      const bindings = MutableHashMap.empty<string, Binding>()

      /**
       * Sweep one key against `nowMs`. Removes the entry if expired and
       * returns `none`; otherwise returns the live binding.
       */
      const sweep = (key: string, nowMs: number): Option.Option<Binding> => {
        const opt = MutableHashMap.get(bindings, key)
        if (Option.isNone(opt)) return Option.none()
        if (opt.value.expiresAtMs <= nowMs) {
          MutableHashMap.remove(bindings, key)
          return Option.none()
        }
        return opt
      }

      const register: RegistrarApi["register"] = (aor, contactUri, ttlSec) =>
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis
          const key = aor.toLowerCase()
          const binding: Binding = {
            aor: key,
            contactUri,
            expiresAtMs: nowMs + Math.max(0, ttlSec) * 1000,
          }
          MutableHashMap.set(bindings, key, binding)
          return binding
        })

      const lookup: RegistrarApi["lookup"] = (aor) =>
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis
          return sweep(aor.toLowerCase(), nowMs)
        })

      const remove: RegistrarApi["remove"] = (aor) =>
        Effect.sync(() => {
          MutableHashMap.remove(bindings, aor.toLowerCase())
        })

      return { register, lookup, remove }
    }),
  )
}
