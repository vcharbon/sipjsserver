/**
 * LoadBalancerStrategy — D2/D13/D14 of the SIP Front Proxy plan, PR3b.
 *
 * Routes new dialogs to a B2BUA worker pool by consistent (rendezvous /
 * HRW) hashing on Call-ID, and recovers stickiness on in-dialog requests
 * from an HMAC-signed cookie stamped into the Record-Route URI.
 *
 *   selectForNewDialog : Call-ID → snapshot WorkerRegistry → filter alive
 *                        → rendezvousSelect(callId, candidates) → addr
 *                        (NoTargetAvailable when the alive set is empty).
 *
 *   encodeStickiness   : (target, msg) → look the target up in the
 *                        snapshot to recover its WorkerId, sign
 *                        `v=1|w=<id>|c=<callId>` with HmacKeyProvider, and
 *                        return `{ w, v, kid, sig }` URI params. The proxy
 *                        core stamps these on the Record-Route it inserts.
 *
 *   decodeStickiness   : ({ w, v, kid, sig }, msg) → recompute the input
 *                        from the message's Call-ID and verify the MAC; on
 *                        success resolve `w` against the live registry.
 *                        Mismatch → reject 403; unknown id → unknown (the
 *                        core falls back to selectForNewDialog and the new
 *                        worker hydrates from Redis on its own).
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
import {
  type RouteParams,
  RoutingStrategy,
  type SocketAddr,
} from "../RoutingStrategy.js"
import { DecodeResult, NoTargetAvailable } from "../RoutingStrategy.js"
import { HmacKeyProvider } from "../security/HmacKeyProvider.js"
import {
  type WorkerEntry,
  type WorkerId,
  WorkerRegistry,
  WorkerId as makeWorkerId,
} from "../registry/WorkerRegistry.js"
import { rendezvousSelect } from "./RendezvousHash.js"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface LoadBalancerConfigData {
  /**
   * URI-param name for the worker id cookie. Defaults to `"w"` per the plan.
   * Configurable so an operator can rename it without code change.
   */
  readonly cookieName?: string
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

const DEFAULT_COOKIE_NAME = "w"
const DEFAULT_DRAIN_GRACE_MS = 5_000
const COOKIE_VERSION = "1"
/** First 16 bytes (128 bits) of HMAC-SHA256 — see header comment. */
const TRUNCATED_MAC_BYTES = 16

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/** Build the byte input fed to HMAC: `v=1|w=<id>|c=<callId>`. */
const stickinessInput = (workerId: string, callId: string): Uint8Array =>
  utf8(`v=${COOKIE_VERSION}|w=${workerId}|c=${callId}`)

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

    const cookieName = cfg.cookieName ?? DEFAULT_COOKIE_NAME
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
      const entry = findByAddress(snapshot, target)
      if (entry === undefined) return Option.none()
      const input = stickinessInput(entry.id, callId)
      // @effect-diagnostics-next-line runEffectInsideEffect:off
      const signed = Effect.runSync(hmac.sign(input))
      const truncated = truncate(signed.mac, TRUNCATED_MAC_BYTES)
      return Option.some({
        [cookieName]: entry.id,
        v: COOKIE_VERSION,
        kid: signed.kid,
        sig: base64urlEncode(truncated),
      } satisfies RouteParams)
    }

    // ---- decodeStickiness -------------------------------------------------
    /**
     * D5 (Draining model) wiring:
     *
     *   - When the resolved worker is `alive`: forward.
     *   - When `draining` AND the request method is **NOT** ACK or CANCEL:
     *     check `drainingSince` — if `(now - drainingSince) <= drainGraceMs`
     *     forward to the original worker, otherwise return `unknown` so
     *     the proxy core falls back via `selectForNewDialog` (a new live
     *     worker hydrates from Redis on its own).
     *   - When `dead`: same logic as draining-post-grace — return
     *     `unknown` so the core picks a live worker. ACK/CANCEL still
     *     hit the dead worker because we have nothing better to try and
     *     the UAC's transaction will time out either way.
     *   - When `draining`/`dead` AND method is ACK or CANCEL: forward
     *     to the resolved worker regardless of grace. ACK on 2xx and
     *     CANCEL must reach the worker that owns the INVITE
     *     transaction (RFC 3261 §13.2.2.4 / §9.1, §16.10) — only that
     *     worker can complete the handshake. Routing them to a fresh
     *     worker would fabricate a 481 storm.
     */
    const isAckOrCancel = (msg: SipMessage): boolean => {
      if (msg.type !== "request") return false
      const m = msg.method
      return m === "ACK" || m === "CANCEL"
    }

    const decodeStickiness = (
      routeParam: RouteParams,
      msg: SipMessage
    ): Effect.Effect<DecodeResult> =>
      Effect.gen(function* () {
        // Pull every required field; absence of any → unknown (the proxy
        // core falls back to selectForNewDialog).
        const w = routeParam[cookieName]
        const v = routeParam["v"]
        const kid = routeParam["kid"]
        const sig = routeParam["sig"]
        if (
          typeof w !== "string" ||
          typeof v !== "string" ||
          typeof kid !== "string" ||
          typeof sig !== "string" ||
          w.length === 0 ||
          kid.length === 0 ||
          sig.length === 0
        ) {
          return DecodeResult.unknown()
        }
        if (v !== COOKIE_VERSION) {
          // Future-proofing: a cookie minted by a different version is not
          // forgeable into the current grammar, so reject rather than fall
          // back (which could silently re-route a hostile cookie).
          return DecodeResult.reject(
            403,
            `unsupported stickiness cookie version "${v}"`
          )
        }

        const callId = callIdOf(msg)
        if (callId === undefined) {
          return DecodeResult.reject(403, "missing Call-ID for stickiness verify")
        }
        const decoded = base64urlDecode(sig)
        if (decoded === undefined || decoded.byteLength !== TRUNCATED_MAC_BYTES) {
          return DecodeResult.reject(
            403,
            `malformed stickiness signature (length=${decoded?.byteLength ?? "?"})`
          )
        }

        const input = stickinessInput(w, callId)
        const ok = yield* hmac.verifyTruncated(input, kid, decoded)
        if (!ok) {
          return DecodeResult.reject(403, "stickiness signature mismatch")
        }

        // MAC verified — resolve the worker.
        const id: WorkerId = makeWorkerId(w)
        const opt = yield* registry.resolve(id)
        if (Option.isNone(opt)) {
          // Worker disappeared (scaled down, deleted). Caller falls back to
          // selectForNewDialog → new worker hydrates from Redis (D5).
          return DecodeResult.unknown()
        }
        const entry = opt.value

        // ── D5 (draining) routing matrix ────────────────────────────────
        if (entry.health === "alive") {
          return DecodeResult.forward(entry.address)
        }
        // ACK / CANCEL exemption: always reach the original worker.
        if (isAckOrCancel(msg)) {
          return DecodeResult.forward(entry.address)
        }
        if (entry.health === "draining") {
          const since = entry.drainingSince
          if (since !== undefined) {
            const nowMs = yield* Clock.currentTimeMillis
            if (nowMs - since <= drainGraceMs) {
              // Pre-grace: still forward to the original worker so
              // in-flight re-INVITE / UPDATE / INFO completes.
              return DecodeResult.forward(entry.address)
            }
          }
          // Post-grace (or no `drainingSince` stamped) → fall back to
          // a fresh selection via the core. The new worker hydrates
          // from Redis; on hydration miss it 481s, which is the
          // documented post-grace failure mode (D-RES).
          return DecodeResult.unknown()
        }
        // entry.health === "dead": same as post-grace.
        return DecodeResult.unknown()
      })

    return {
      name: "LoadBalancer",
      selectForNewDialog,
      encodeStickiness,
      decodeStickiness,
    }
  })
)
