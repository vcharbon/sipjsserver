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
 *   - `static` and `kubernetesSecret` impls ship in PR5. The fs-watch
 *     `kubernetesSecret` impl (D14 / PR5) wraps the same `sign`/`verify`
 *     shape behind a `Ref<{ current, previous? }>` mutated by a
 *     `node:fs.watch` listener on the mounted Secret files. Reloads
 *     keep one rotation generation in `previous` for NFR-8.
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import * as fs from "node:fs"
import { Data, Effect, Layer, Ref, type Scope, ServiceMap } from "effect"

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
  /**
   * Truncated-MAC verify — recompute the full HMAC for `input` under the
   * named `kid` (current or previous), then compare its leading
   * `truncatedMac.byteLength` bytes against `truncatedMac` in
   * constant time. Used by `LoadBalancerStrategy` (PR3b) which carries a
   * 16-byte (128-bit) prefix of the SHA-256 MAC in the routing cookie.
   *
   * Truncating to 128 bits is a standard short-token tradeoff
   * (RFC 4868 §2.6 / NIST SP 800-107): collision/forgery resistance stays
   * comfortably above attacker budgets on a per-message HMAC, while
   * shaving the cookie down to ~22 base64url chars.
   *
   * Returns `false` for unknown kid, zero-length truncation, or mismatch.
   */
  readonly verifyTruncated: (
    input: Uint8Array,
    kid: string,
    truncatedMac: Uint8Array
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

      const lookupKey = (kid: string): HmacKey | undefined =>
        kid === current.id
          ? current
          : previous !== undefined && kid === previous.id
            ? previous
            : undefined

      const verify = (
        input: Uint8Array,
        kid: string,
        mac: Uint8Array
      ): Effect.Effect<boolean> =>
        Effect.sync(() => {
          const key = lookupKey(kid)
          if (key === undefined) return false
          const expected = macFor(key, input)
          return constantTimeEqual(expected, mac)
        })

      const verifyTruncated = (
        input: Uint8Array,
        kid: string,
        truncatedMac: Uint8Array
      ): Effect.Effect<boolean> =>
        Effect.sync(() => {
          const key = lookupKey(kid)
          if (key === undefined) return false
          if (truncatedMac.byteLength === 0) return false
          const full = macFor(key, input)
          if (truncatedMac.byteLength > full.byteLength) return false
          // node:crypto.timingSafeEqual requires equal-length buffers.
          const prefix = full.subarray(0, truncatedMac.byteLength)
          return timingSafeEqual(Buffer.from(prefix), Buffer.from(truncatedMac))
        })

      return Effect.succeed({
        sign,
        verify,
        verifyTruncated,
      } satisfies HmacKeyProviderApi)
    })
  )

// ---------------------------------------------------------------------------
// kubernetesSecret impl (D14 / PR5)
// ---------------------------------------------------------------------------

export interface KubernetesSecretOpts {
  /**
   * Filesystem path of the **current** key file. K8s typically mounts a
   * `Secret` as a directory of files; pass the path of the entry that
   * holds the key bytes (e.g. `/etc/sip-proxy/hmac/current`).
   */
  readonly keyPath: string
  /**
   * Optional path of the **previous** key file. When operators perform
   * an explicit two-file rotation (`current` and `previous` mounted from
   * separate Secret keys), this file is loaded and used by `verify`
   * during the NFR-8 1h overlap window.
   *
   * If omitted, the registry tracks an internal "previous" by
   * remembering the last key it loaded from `keyPath` — that satisfies
   * the rotation overlap automatically when the operator just bumps the
   * Secret in place.
   */
  readonly previousKeyPath?: string
  /**
   * Debounce window for `fs.watch` notifications (ms). Editors and
   * Kubelet's atomic-rename mechanism often emit several change events
   * for a single update; we coalesce them. Default: 200ms.
   */
  readonly watchDebounceMs?: number
}

const DEFAULT_WATCH_DEBOUNCE_MS = 200

/**
 * Read raw key bytes from disk and derive a `kid` from a SHA-1 prefix
 * of the bytes. Using a content-derived kid means rotations don't need
 * the operator to choose a new id — every distinct key gets a distinct
 * kid automatically, which is exactly what `verify` needs for the
 * overlap window.
 *
 * The kid is non-secret (it lands on the wire in every cookie). A
 * 16-hex-char prefix of SHA-1 is plenty to distinguish keys without
 * leaking material — even if an attacker learns the kid, they learn
 * nothing about the underlying bytes.
 */
const loadKeyFromFile = (path: string): HmacKey => {
  const raw = fs.readFileSync(path)
  if (raw.byteLength < MIN_KEY_BYTES) {
    throw new HmacKeyProviderConfigError({
      reason: `${path} key must be at least ${MIN_KEY_BYTES} bytes (got ${raw.byteLength})`,
    })
  }
  const hash = createHmac("sha1", "kid-derive")
  hash.update(raw)
  const kid = hash.digest("hex").slice(0, 16)
  return { id: kid, bytes: new Uint8Array(raw) }
}

/**
 * Build a Layer providing `HmacKeyProvider` from K8s Secret-mounted
 * files. Watches the file(s) via `node:fs.watch` and hot-reloads on
 * change — no pod restart required for rotation.
 *
 * On rotation:
 *   - With a single `keyPath`: when the file content changes, the new
 *     key becomes `current` and the previous `current` slides into
 *     `previous` for the NFR-8 overlap window.
 *   - With both `keyPath` + `previousKeyPath`: each file is watched
 *     independently. Operator-controlled rotation (Phase 2 GitOps).
 *
 * Reload failures (file removed, permissions, key too short) MUST log
 * + retain the prior key, never crash. D4 invariant: the watch fiber's
 * failures cannot reach the routing path.
 */
export const kubernetesSecretLayer = (
  opts: KubernetesSecretOpts
): Layer.Layer<HmacKeyProvider, HmacKeyProviderConfigError> =>
  Layer.effect(
    HmacKeyProvider,
    Effect.gen(function* () {
      const debounceMs = opts.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS

      // Initial load — surface failures here as a layer-build error so
      // a misconfigured deploy fails fast at startup.
      const initialCurrent = yield* Effect.try({
        try: () => loadKeyFromFile(opts.keyPath),
        catch: (err) =>
          err instanceof HmacKeyProviderConfigError
            ? err
            : new HmacKeyProviderConfigError({
                reason: `failed to read current key from ${opts.keyPath}: ${String(err)}`,
              }),
      })
      let initialPrevious: HmacKey | undefined
      if (opts.previousKeyPath !== undefined) {
        initialPrevious = yield* Effect.try({
          try: () => loadKeyFromFile(opts.previousKeyPath!),
          catch: (err) =>
            err instanceof HmacKeyProviderConfigError
              ? err
              : new HmacKeyProviderConfigError({
                  reason: `failed to read previous key from ${opts.previousKeyPath!}: ${String(err)}`,
                }),
        })
      }

      interface KeyState {
        readonly current: HmacKey
        readonly previous?: HmacKey
      }
      const stateRef = yield* Ref.make<KeyState>(
        initialPrevious === undefined
          ? { current: initialCurrent }
          : { current: initialCurrent, previous: initialPrevious }
      )

      const sign = (input: Uint8Array): Effect.Effect<HmacSignResult> =>
        Ref.get(stateRef).pipe(
          Effect.map((s) => ({ kid: s.current.id, mac: macFor(s.current, input) }))
        )

      const lookupKey = (s: KeyState, kid: string): HmacKey | undefined =>
        kid === s.current.id
          ? s.current
          : s.previous !== undefined && kid === s.previous.id
            ? s.previous
            : undefined

      const verify = (
        input: Uint8Array,
        kid: string,
        mac: Uint8Array
      ): Effect.Effect<boolean> =>
        Ref.get(stateRef).pipe(
          Effect.map((s) => {
            const key = lookupKey(s, kid)
            if (key === undefined) return false
            const expected = macFor(key, input)
            return constantTimeEqual(expected, mac)
          })
        )

      const verifyTruncated = (
        input: Uint8Array,
        kid: string,
        truncatedMac: Uint8Array
      ): Effect.Effect<boolean> =>
        Ref.get(stateRef).pipe(
          Effect.map((s) => {
            const key = lookupKey(s, kid)
            if (key === undefined) return false
            if (truncatedMac.byteLength === 0) return false
            const full = macFor(key, input)
            if (truncatedMac.byteLength > full.byteLength) return false
            const prefix = full.subarray(0, truncatedMac.byteLength)
            return timingSafeEqual(Buffer.from(prefix), Buffer.from(truncatedMac))
          })
        )

      // ── Reload helpers ──────────────────────────────────────────────
      // Use plain try/catch inside Effect.sync rather than Effect.try +
      // catchAll: simpler, no v3 vs v4 surface ambiguity, and we want
      // the failure path to log + return undefined (non-fatal) anyway.
      const tryLoad = (path: string, label: string): Effect.Effect<HmacKey | undefined> =>
        Effect.suspend(() => {
          try {
            return Effect.succeed(loadKeyFromFile(path))
          } catch (err) {
            return Effect.logWarning(
              `kubernetesSecret: failed to reload ${label} key from ${path}: ${String(err)}`
            ).pipe(Effect.as(undefined as HmacKey | undefined))
          }
        })

      const reloadCurrent: Effect.Effect<void> = Effect.gen(function* () {
        const next = yield* tryLoad(opts.keyPath, "current")
        if (next === undefined) return
        yield* Ref.update(stateRef, (s) => {
          if (next.id === s.current.id) return s
          // Single-path mode: previous current slides into previous slot.
          if (opts.previousKeyPath === undefined) {
            return { current: next, previous: s.current }
          }
          // Two-path mode: previous slot is owned by previousKeyPath; the
          // current slot just moves.
          return s.previous === undefined
            ? { current: next }
            : { current: next, previous: s.previous }
        })
        yield* Effect.logInfo(
          `kubernetesSecret: reloaded current key (kid=${next.id})`
        )
      })

      const reloadPrevious: Effect.Effect<void> = Effect.gen(function* () {
        if (opts.previousKeyPath === undefined) return
        const next = yield* tryLoad(opts.previousKeyPath, "previous")
        if (next === undefined) return
        yield* Ref.update(stateRef, (s) =>
          s.previous !== undefined && s.previous.id === next.id
            ? s
            : { current: s.current, previous: next }
        )
        yield* Effect.logInfo(
          `kubernetesSecret: reloaded previous key (kid=${next.id})`
        )
      })

      // ── fs.watch wiring ─────────────────────────────────────────────
      // We watch each file individually and debounce per-file. K8s
      // mounts Secret keys via a symlink to a `..data/` directory, so
      // updates manifest as a rename of the `..data` symlink — `watch`
      // on the leaf file path will fire even when only the symlink
      // target moves. On Linux this is `inotify` under the hood.
      //
      // We capture the parent layer's Effect services here so that
      // when fs.watch fires its callback (outside any Effect context)
      // we can `runForkWith(parentServices)(action)` and the reload
      // effect runs with the same logging/clock/etc the layer uses.
      const parentServices = yield* Effect.services<never>()

      // Install a single fs.watch and (best-effort) keep going even if
      // the install itself throws synchronously. Returns a tuple of
      // (timer-getter, watcher-or-undefined) so the finalizer can tear
      // down whatever was actually created.
      interface WatchHandle {
        readonly getTimer: () => NodeJS.Timeout | undefined
        readonly watcher: fs.FSWatcher | undefined
      }
      const tryInstall = (
        path: string,
        action: Effect.Effect<void>
      ): Effect.Effect<WatchHandle> =>
        Effect.suspend(() => {
          let timer: NodeJS.Timeout | undefined
          let watcher: fs.FSWatcher | undefined
          const onChange = () => {
            if (timer !== undefined) clearTimeout(timer)
            timer = setTimeout(() => {
              timer = undefined
              // Run on the parent runtime — we're in a node callback,
              // not an Effect context. Reload effects swallow their
              // own errors so this is safe to fire-and-forget.
              Effect.runForkWith(parentServices)(action)
            }, debounceMs)
          }
          // fs.watch can throw synchronously (ENOENT, EPERM). Log,
          // retain the loaded key, never crash. We surface the failure
          // through Effect.logWarning rather than the error channel so
          // the layer doesn't fail at start time on a transient mount
          // race.
          let installError: unknown = null
          try {
            watcher = fs.watch(path, { persistent: false }, onChange)
            watcher.on("error", (err) => {
              Effect.runForkWith(parentServices)(
                Effect.logWarning(
                  `kubernetesSecret: watcher on ${path} error: ${String(err)}`
                )
              )
            })
          } catch (err) {
            installError = err
            watcher = undefined
          }
          const handle: WatchHandle = { getTimer: () => timer, watcher }
          if (installError !== null) {
            return Effect.logWarning(
              `kubernetesSecret: failed to install watcher on ${path}: ${String(installError)}`
            ).pipe(Effect.as(handle))
          }
          return Effect.succeed(handle)
        })

      const installWatcher = (
        path: string,
        action: Effect.Effect<void>
      ): Effect.Effect<void, never, Scope.Scope> =>
        Effect.gen(function* () {
          const handle = yield* tryInstall(path, action)
          // Tear down on layer release.
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              const t = handle.getTimer()
              if (t !== undefined) clearTimeout(t)
              if (handle.watcher !== undefined) handle.watcher.close()
            })
          )
        })

      yield* installWatcher(opts.keyPath, reloadCurrent)
      if (opts.previousKeyPath !== undefined) {
        yield* installWatcher(opts.previousKeyPath, reloadPrevious)
      }

      return {
        sign,
        verify,
        verifyTruncated,
      } satisfies HmacKeyProviderApi
    })
  )
