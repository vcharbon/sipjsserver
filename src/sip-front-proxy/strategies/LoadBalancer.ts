/**
 * LoadBalancerStrategy — D2/D13/D14 of the SIP Front Proxy plan, PR3b,
 * extended with D8 of the HA-resilience plan (cookie format v2 carrying
 * `w_pri` + `w_bak` ordinals so that a dead primary deterministically
 * routes to the named backup, never via fresh HRW).
 *
 *   selectForNewDialog : Call-ID → snapshot WorkerRegistry → filter alive
 *                        → rendezvousSelect(callId, candidates) → addr
 *                        (NoTargetAvailable when the alive set is empty).
 *
 *   encodeStickiness   : (target, msg) → look the target up in the
 *                        snapshot to recover its WorkerId (=`w_pri`), pick
 *                        the second-best HRW winner across the remaining
 *                        alive workers (=`w_bak`, empty when only one
 *                        worker is alive), sign
 *                        `v=2|w_pri=<id>|w_bak=<id>|c=<callId>` with
 *                        HmacKeyProvider, and return `{ w_pri, w_bak, v,
 *                        kid, sig }` URI params. The proxy core stamps
 *                        these on the Record-Route it inserts.
 *
 *   decodeStickiness   : ({ w_pri, w_bak, v, kid, sig }, msg) → recompute
 *                        the input from the message's Call-ID and verify
 *                        the MAC; on success resolve `w_pri` against the
 *                        live registry. Cookie version mismatch → reject
 *                        403. If primary is alive: forward(primary). If
 *                        primary is dead/post-grace AND `w_bak` resolves
 *                        to an alive entry: `forwardBackup(backup)`.
 *                        Otherwise: unknown (core falls back to
 *                        selectForNewDialog).
 *
 * Non-blocking invariant (D4). All three methods read snapshots out of a
 * `Ref` (synchronously) and call HMAC sign/verify (CPU-bound,
 * `Effect.sync`). No `Effect.sleep`, no I/O, no fiber join.
 *
 * RFC notes:
 *   - §16.5 — stickiness lives only in the Record-Route URI we insert; we
 *     do not push extra Route headers based on policy. The core honours
 *     this by treating `encodeStickiness` purely as a Record-Route param
 *     supplier.
 *   - §16.6.5 — Record-Route URI carries `;lr` (added by the core) plus
 *     our `;w=…;v=1;kid=…;sig=…` cookie.
 *
 * HMAC truncation. `HmacKeyProvider.sign` returns the full 32-byte
 * HMAC-SHA256 digest; we truncate to the first 16 bytes (128 bits) before
 * base64url-encoding into the cookie. Truncating to 128 bits is the
 * standard short-token tradeoff (RFC 4868 §2.6 / NIST SP 800-107) —
 * collision/forgery resistance remains comfortably above any plausible
 * attacker budget on a per-message HMAC, while shaving the cookie down
 * to ~22 base64url characters (vs ~44 for the full digest) keeps
 * Record-Route URIs short. Verify uses the provider's `verifyTruncated`
 * helper which recomputes the full digest under the named kid (current
 * OR previous, for the rotation overlap window) and compares the prefix
 * in constant time.
 */

import { Clock, Effect, Layer, Option, ServiceMap } from "effect"
import { getHeader } from "../../sip/MessageHelpers.js"
import type { SipMessage } from "../../sip/types.js"
import { ProxyMetrics } from "../observability/Metrics.js"
import {
  type RouteParams,
  RoutingStrategy,
  type SocketAddr,
} from "../RoutingStrategy.js"
import { DecodeResult, NoTargetAvailable } from "../RoutingStrategy.js"
import { HmacKeyProvider } from "../security/HmacKeyProvider.js"
import {
  type WorkerEntry,
  WorkerRegistry,
  WorkerId as makeWorkerId,
} from "../registry/WorkerRegistry.js"
import { rendezvousSelect } from "./RendezvousHash.js"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface LoadBalancerConfigData {
  /**
   * In-dialog grace window (ms) for in-flight requests when a worker enters
   * `draining`. Consumed in PR4; shipped here so the layer signature is
   * stable across PRs. Default: 5_000 ms (D5).
   */
  readonly drainGracePolicyMs?: number
}

export class LoadBalancerConfig extends ServiceMap.Service<
  LoadBalancerConfig,
  LoadBalancerConfigData
>()("@sipjsserver/sip-front-proxy/LoadBalancerConfig") {
  /** Build a layer providing a `LoadBalancerConfig` value. */
  static readonly layer = (
    cfg: LoadBalancerConfigData = {}
  ): Layer.Layer<LoadBalancerConfig> => Layer.succeed(LoadBalancerConfig, cfg)
}

const COOKIE_PRIMARY_NAME = "w_pri"
const COOKIE_BACKUP_NAME = "w_bak"
const DEFAULT_DRAIN_GRACE_MS = 5_000
const COOKIE_VERSION = "2"
/** First 16 bytes (128 bits) of HMAC-SHA256 — see header comment. */
const TRUNCATED_MAC_BYTES = 16

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/**
 * Build the byte input fed to HMAC:
 * `v=2|w_pri=<id>|w_bak=<id>|c=<callId>`.
 *
 * `backupId` is the empty string when only one worker is alive at encode
 * time. The HMAC binds the primary, backup, and call-id together, so a
 * UA that swaps `w_bak` to a different worker breaks the MAC.
 */
const stickinessInput = (
  primaryId: string,
  backupId: string,
  callId: string
): Uint8Array =>
  utf8(
    `v=${COOKIE_VERSION}|${COOKIE_PRIMARY_NAME}=${primaryId}|${COOKIE_BACKUP_NAME}=${backupId}|c=${callId}`
  )

/** Truncate a digest to the first `n` bytes. */
const truncate = (mac: Uint8Array, n: number): Uint8Array =>
  mac.byteLength <= n ? mac : mac.subarray(0, n)

/** Encode bytes as base64url (RFC 4648 §5). No padding. */
const base64urlEncode = (bytes: Uint8Array): string =>
  Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")

/** Decode base64url back to bytes. Returns `undefined` on malformed input. */
const base64urlDecode = (s: string): Uint8Array | undefined => {
  // Pad up to a multiple of 4 and translate the URL-safe alphabet back.
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4))
  const std = s.replace(/-/g, "+").replace(/_/g, "/") + pad
  try {
    return new Uint8Array(Buffer.from(std, "base64"))
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

/**
 * Pull the Call-ID off a parsed message. The parser guarantees it on every
 * well-formed packet (see `RequestParsedFields` / `ResponseParsedFields`),
 * so this is normally a single property read — we keep the raw-header
 * fallback for the defensive case where a caller hands us a synthesised
 * message that bypassed the parser.
 */
const callIdOf = (msg: SipMessage): string | undefined => {
  const id = msg.parsed.callId
  if (typeof id === "string" && id.length > 0) return id
  const raw = getHeader(msg.headers, "call-id")
  if (typeof raw !== "string" || raw.length === 0) return undefined
  return raw
}

const sameAddr = (a: SocketAddr, b: SocketAddr): boolean =>
  a.host === b.host && a.port === b.port

/** Find the worker entry whose address matches `target` in the snapshot. */
const findByAddress = (
  snapshot: ReadonlyArray<WorkerEntry>,
  target: SocketAddr
): WorkerEntry | undefined => snapshot.find((w) => sameAddr(w.address, target))

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const LoadBalancerStrategyLive: Layer.Layer<
  RoutingStrategy,
  never,
  WorkerRegistry | HmacKeyProvider | LoadBalancerConfig
> = Layer.effect(
  RoutingStrategy,
  Effect.gen(function* () {
    const registry = yield* WorkerRegistry
    const hmac = yield* HmacKeyProvider
    const cfg = yield* LoadBalancerConfig
    // Metrics is provided inline (its Default has no deps) so the public
    // layer signature stays exactly what PR3b shipped.
    const metrics = yield* (Effect.gen(function* () {
      return yield* ProxyMetrics
    }).pipe(Effect.provide(ProxyMetrics.Default)))

    const drainGraceMs = cfg.drainGracePolicyMs ?? DEFAULT_DRAIN_GRACE_MS

    // ---- selectForNewDialog -----------------------------------------------
    const selectForNewDialog = (
      msg: SipMessage
    ): Effect.Effect<SocketAddr, NoTargetAvailable> =>
      Effect.gen(function* () {
        const callId = callIdOf(msg) ?? ""
        const snapshot = yield* registry.snapshot
        // PR3b: filter on `alive` only. PR4 will exclude `draining` for new
        // dialogs by re-reading `health` on each select; the snapshot is
        // already authoritative.
        const candidates = snapshot.filter((w) => w.health === "alive")
        if (candidates.length === 0) {
          return yield* new NoTargetAvailable({
            reason:
              snapshot.length === 0
                ? "registry is empty"
                : `no alive workers among ${snapshot.length} entries`,
          })
        }
        const winner = rendezvousSelect(callId, candidates)
        if (winner === undefined) {
          // Defensive — `candidates.length > 0` guarantees a winner; the
          // branch keeps the type total without an unsafe cast.
          return yield* new NoTargetAvailable({
            reason: "rendezvous returned no winner",
          })
        }
        return winner.address
      })

    // ---- encodeStickiness -------------------------------------------------
    /**
     * The strategy interface returns `Option<RouteParams>` synchronously
     * (the proxy core stamps the params straight into the Record-Route URI
     * with no further effect). Our snapshot read is a single `Ref.get` and
     * `sign` is `Effect.sync`, both safe for `runSync`. We deliberately
     * stay inside the strategy interface rather than widening it to
     * `Effect`-returning, because the proxy core consumes the result
     * synchronously and an `Effect`-returning encoder would force a fiber
     * suspension on the routing path (D4 violation).
     */
    const encodeStickiness = (
      target: SocketAddr,
      msg: SipMessage
    ): Option.Option<RouteParams> => {
      const callId = callIdOf(msg)
      if (callId === undefined) return Option.none()
      // @effect-diagnostics-next-line runEffectInsideEffect:off
      const snapshot = Effect.runSync(registry.snapshot)
      const primary = findByAddress(snapshot, target)
      if (primary === undefined) return Option.none()
      // D8: pick `w_bak` as the second-best HRW winner among the alive
      // workers excluding the primary. Empty when the primary is the
      // only alive worker (single-pod deployment / cluster scale-out
      // edge case) — the cookie still verifies but recovery has no
      // alternative target, which is the documented small-cluster
      // limitation.
      const backupCandidates = snapshot.filter(
        (w) => w.health === "alive" && w.id !== primary.id
      )
      const backup = rendezvousSelect(callId, backupCandidates)
      const backupId = backup?.id ?? ""
      const input = stickinessInput(primary.id, backupId, callId)
      // @effect-diagnostics-next-line runEffectInsideEffect:off
      const signed = Effect.runSync(hmac.sign(input))
      const truncated = truncate(signed.mac, TRUNCATED_MAC_BYTES)
      return Option.some({
        [COOKIE_PRIMARY_NAME]: primary.id,
        [COOKIE_BACKUP_NAME]: backupId,
        v: COOKIE_VERSION,
        kid: signed.kid,
        sig: base64urlEncode(truncated),
      } satisfies RouteParams)
    }

    // ---- decodeStickiness -------------------------------------------------
    /**
     * Routing matrix:
     *
     *   - Primary `alive`: forward(primary).
     *   - Primary `draining`/`dead` AND method is ACK or CANCEL: forward
     *     to the original primary regardless. ACK on 2xx and CANCEL must
     *     reach the worker that owns the INVITE transaction (RFC 3261
     *     §13.2.2.4 / §9.1, §16.10) — only that worker can complete the
     *     handshake. Routing them to a fresh worker would fabricate a
     *     481 storm.
     *   - Primary `draining` within drain grace: forward(primary) so
     *     in-flight re-INVITE / UPDATE / INFO completes (D5).
     *   - Primary `draining` past grace OR `dead`: D8 — try the cookie's
     *     `w_bak`. If the backup resolves to an alive entry, return
     *     `forwardBackup(backup)`; the recovery worker reads its sidecar
     *     Redis (which has been receiving dual-write) and takes over.
     *     Otherwise return `unknown` so the core falls back to fresh
     *     `selectForNewDialog` — the picked worker hydrates from Redis
     *     and 481s on miss, the documented post-grace failure mode.
     *   - Primary missing from registry (scaled down): same backup path.
     */
    const isAckOrCancel = (msg: SipMessage): boolean => {
      if (msg.type !== "request") return false
      const m = msg.method
      return m === "ACK" || m === "CANCEL"
    }

    /**
     * Resolve `w_bak` to a `forwardBackup` decision when the named
     * backup is alive in the registry; otherwise yield `unknown` so the
     * core falls through to a fresh selection.
     */
    const tryBackup = (
      backupId: string
    ): Effect.Effect<DecodeResult> =>
      Effect.gen(function* () {
        if (backupId.length === 0) return DecodeResult.unknown()
        const opt = yield* registry.resolve(makeWorkerId(backupId))
        if (Option.isNone(opt)) return DecodeResult.unknown()
        const bak = opt.value
        if (bak.health !== "alive") return DecodeResult.unknown()
        return DecodeResult.forwardBackup(bak.address)
      })

    const decodeStickiness = (
      routeParam: RouteParams,
      msg: SipMessage
    ): Effect.Effect<DecodeResult> =>
      Effect.gen(function* () {
        // Pull every required field; absence of any → unknown (the proxy
        // core falls back to selectForNewDialog).
        const wPri = routeParam[COOKIE_PRIMARY_NAME]
        const wBakRaw = routeParam[COOKIE_BACKUP_NAME]
        const v = routeParam["v"]
        const kid = routeParam["kid"]
        const sig = routeParam["sig"]
        // `w_bak` may legitimately be present-but-empty (single-worker
        // cluster at encode time); `w_pri` must be non-empty.
        if (
          typeof wPri !== "string" ||
          typeof wBakRaw !== "string" ||
          typeof v !== "string" ||
          typeof kid !== "string" ||
          typeof sig !== "string" ||
          wPri.length === 0 ||
          kid.length === 0 ||
          sig.length === 0
        ) {
          yield* metrics.recordHmacFailure("missing")
          return DecodeResult.unknown()
        }
        if (v !== COOKIE_VERSION) {
          // Cookie minted by a different version is not forgeable into
          // the current grammar, so reject rather than fall back (which
          // could silently re-route a hostile cookie).
          yield* metrics.recordHmacFailure("decode")
          return DecodeResult.reject(
            403,
            `unsupported stickiness cookie version "${v}"`
          )
        }

        const callId = callIdOf(msg)
        if (callId === undefined) {
          yield* metrics.recordHmacFailure("decode")
          return DecodeResult.reject(403, "missing Call-ID for stickiness verify")
        }
        const decoded = base64urlDecode(sig)
        if (decoded === undefined || decoded.byteLength !== TRUNCATED_MAC_BYTES) {
          yield* metrics.recordHmacFailure("decode")
          return DecodeResult.reject(
            403,
            `malformed stickiness signature (length=${decoded?.byteLength ?? "?"})`
          )
        }

        const input = stickinessInput(wPri, wBakRaw, callId)
        const ok = yield* hmac.verifyTruncated(input, kid, decoded)
        if (!ok) {
          // Distinguish unknown_kid from mismatch: when the kid isn't
          // recognised, `verifyTruncated` returns false the same way it
          // does on a bad MAC. We don't have direct visibility here, so
          // we tag this as `mismatch` — the more common case. A future
          // PR can split the provider's return shape if operators need
          // to alert on rotation lag specifically.
          yield* metrics.recordHmacFailure("mismatch")
          return DecodeResult.reject(403, "stickiness signature mismatch")
        }

        // MAC verified — resolve the primary.
        const primaryOpt = yield* registry.resolve(makeWorkerId(wPri))
        if (Option.isNone(primaryOpt)) {
          // Primary scaled down / deleted: try the cookie's backup.
          return yield* tryBackup(wBakRaw)
        }
        const primary = primaryOpt.value

        // ── Routing matrix ──────────────────────────────────────────────
        if (primary.health === "alive") {
          return DecodeResult.forward(primary.address)
        }
        // ACK / CANCEL exemption: always reach the original primary.
        if (isAckOrCancel(msg)) {
          return DecodeResult.forward(primary.address)
        }
        if (primary.health === "draining") {
          const since = primary.drainingSince
          if (since !== undefined) {
            const nowMs = yield* Clock.currentTimeMillis
            if (nowMs - since <= drainGraceMs) {
              // Pre-grace: forward to the original primary so in-flight
              // re-INVITE / UPDATE / INFO completes.
              return DecodeResult.forward(primary.address)
            }
          }
          // Post-grace: fall through to the backup.
          return yield* tryBackup(wBakRaw)
        }
        // primary.health === "dead" or "unknown": fall through to the
        // backup.
        return yield* tryBackup(wBakRaw)
      })

    return {
      name: "LoadBalancer",
      selectForNewDialog,
      encodeStickiness,
      decodeStickiness,
    }
  })
)
