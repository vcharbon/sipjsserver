/**
 * Recording-layer data shapes (Slice 1).
 *
 * The `Recorder` service is the single source of truth for what packets
 * crossed the test fabric (fake, live, or hybrid). Names live in a
 * separate `(ip,port) → names[]` registry; addresses are required on
 * every recorded entry so the renderer cannot fabricate labels.
 *
 * Naming convention vs. legacy types:
 *   - `Participant` (framework/types.ts) keys by name. Kept for now;
 *     replaced by `Lane` once Slice 4 lands the renderer rewrite.
 *   - `TraceEntry.fromAddr/toAddr` is `?optional` today. `RecordedSipEntry`
 *     makes addresses **required** — the typechecker becomes the first
 *     line of defense against "report invents names/IPs".
 */

import type { Effect } from "effect"
import type { SipMessage } from "../../../sip/types.js"
import type {
  Lane,
  LaneKey,
  NetworkTag,
  RecordedAnomaly,
  TraceStatus,
  TransportKind,
} from "../types.js"
import { laneKey } from "../types.js"

// Re-export so existing call sites that imported these from this module
// continue to compile after canonicalizing the types in
// `framework/types.ts`. The canonical home is framework/types.ts (no
// circular import with this module).
export type { Lane, LaneKey, RecordedAnomaly, TransportKind }
export { laneKey }

// ---------------------------------------------------------------------------
// SIP trace entries
// ---------------------------------------------------------------------------

/**
 * One SIP packet observation. Mirrors `TraceEntry` but with:
 *
 *   - `fromAddr` and `toAddr` **required** (no `?`).
 *   - No `from`/`to` name fields — names are looked up from the lane
 *     registry at render time. This is the structural defense against
 *     "the recorder wrote a name that disagrees with the address".
 *
 * `direction` reflects the recording-end perspective: `"send"` when the
 * Recorder was notified by a sender, `"receive"` when notified by a
 * receiver. The fake fabric records once per packet (network-level
 * delivery), so most fake entries are `"send"`. Live records both ends
 * via its dgram wrapper.
 */
export interface RecordedSipEntry {
  readonly timestamp: number
  readonly sentMs: number
  readonly receivedMs: number
  readonly fromAddr: { readonly ip: string; readonly port: number }
  readonly toAddr: { readonly ip: string; readonly port: number }
  readonly direction: "send" | "receive"
  readonly stepIndex: number
  readonly status: TraceStatus
  readonly message: SipMessage
  readonly durationMs?: number
  readonly network: NetworkTag
  /**
   * Monotonic capture-order tiebreaker from the shared `EventSequencer`,
   * stamped at the moment the Recorder buffered this observation. The
   * renderer uses `(timestamp, seq)` as the sort key so same-ms events
   * across recording layers stay in the order they were captured.
   */
  readonly seq: number
}

// ---------------------------------------------------------------------------
// Replication trace entries
// ---------------------------------------------------------------------------

/**
 * One replication frame the consumer worker received from the source
 * worker over the simulated `/replog` HTTP transport.
 *
 * Replication is pod-keyed by design (D6 in the grilling plan): pod
 * names like "worker-1" / "worker-2" stay as identifiers; the renderer
 * resolves them to lane positions via the lane registry's inverse map
 * at render time. Frames that name a pod without any SIP socket get a
 * synthetic pod-only column.
 */
export interface RecordedReplEntry {
  readonly timestamp: number
  readonly from: string
  readonly to: string
  readonly frame: unknown
  /** See `RecordedSipEntry.seq`. */
  readonly seq: number
}

// ---------------------------------------------------------------------------
// Scenario snapshot — what the renderer consumes
// ---------------------------------------------------------------------------

/**
 * The Recorder's drained state at scenario end. Shape consumed by the
 * Slice 4 renderer (and by Slice 5's anti-invention property test).
 *
 * `lanes` is intentionally NOT sorted here — lane ordering is the
 * renderer's responsibility (D10: by NetworkTag group, then first
 * appearance). The Recorder just emits the registered set.
 */
export interface RecordedScenario {
  readonly transportKind: TransportKind
  readonly lanes: ReadonlyArray<Lane>
  readonly sipTrace: ReadonlyArray<RecordedSipEntry>
  readonly replTrace: ReadonlyArray<RecordedReplEntry>
  readonly anomalies: ReadonlyArray<RecordedAnomaly>
}

// ---------------------------------------------------------------------------
// Typed per-Tag channels (ADR-0013 D2/D3)
// ---------------------------------------------------------------------------

/**
 * Stamps every recorded event carries on top of the layer-specific
 * payload. Allocated by the channel at `record` time so projectors can
 * cross-correlate events from different channels.
 */
export interface RecordedStamps {
  readonly seq: number
  readonly atMs: number
}

/**
 * Handle returned by `Recorder.forTag(tag)`. Helpers (`recordSync`,
 * `recordEffectCall`, `recordScopedAcquire`, `recordStreamLifecycle`)
 * call `record` with their layer-specific payload `E`; the channel
 * stamps `seq` + `atMs` and appends.
 *
 * `snapshot` returns the stamped events typed as `E & RecordedStamps`.
 * The type parameter `E` here is the *payload* shape — without stamps —
 * so wrappers can declare their event union without polluting it with
 * recorder bookkeeping.
 */
export interface TaggedChannel<E> {
  readonly record: (event: E) => Effect.Effect<void>
  readonly snapshot: Effect.Effect<ReadonlyArray<E & RecordedStamps>>
}

/**
 * Projector — turns a channel's stored events into a partial
 * `RecordedScenario`. Multiple projectors per tag are NOT supported
 * this slice; first-registration wins.
 */
export type Projector<E> = (
  events: ReadonlyArray<E & RecordedStamps>,
) => Partial<RecordedScenario>
