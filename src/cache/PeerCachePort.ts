/**
 * PeerCachePort — abstract contract for cross-pod cache I/O.
 *
 * Slice 3 of the HA-resilience plan. The B2BUA's dual-write path
 * (Slice 4) writes locally to its own `PartitionedRelayStorage`
 * (`pri:self:` partition) and remotely to the cookie-named backup
 * peer's relay through THIS port (writing into the peer's `bak:self:`
 * partition). The port keeps the dual-write logic agnostic of whether
 * the peer is reached via real HTTP (production: `PeerCacheClient`)
 * or via the in-process simulated fabric (tests: `PeerFabric` —
 * Slice 5).
 *
 * Every method names the destination peer by `WorkerOrdinal` (the
 * cookie's `w_pri` / `w_bak` value — a branded string compatible with
 * the proxy's `WorkerId`). The port resolves `WorkerOrdinal` to a
 * concrete URL via `PeerEndpointResolver`.
 *
 * The (`role`, `owner`, `callRef`) triple identifies a partition entry
 * on the receiving peer per D10:
 *   - `role` = where this entry lives on the RECEIVER ("pri" if the
 *     receiver is the natural primary; "bak" if the receiver is the
 *     backup taking the dual-write).
 *   - `owner` = the cookie's `w_pri` ordinal — the natural primary.
 *
 * Errors are tagged so the dual-write path can implement the "throw
 * away on failure" semantics (D3): a failed remote write must NOT
 * block the local write or fail the call event; it logs metrics and
 * moves on.
 */

import { Data, type Effect, ServiceMap, type Stream } from "effect"
import type { PartitionRole, ScanEntry } from "./PartitionedRelayStorage.js"

// ---------------------------------------------------------------------------
// Identity types
// ---------------------------------------------------------------------------

/**
 * Branded string identifying a worker pod in the cluster. Matches the
 * proxy's `WorkerId` value space — the cookie carries this verbatim.
 * Using a separate brand here keeps the cache layer free of any
 * dependency on `src/sip-front-proxy`.
 */
export type WorkerOrdinal = string & {
  readonly _brand: "@sipjsserver/cache/WorkerOrdinal"
}

export const WorkerOrdinal = (raw: string): WorkerOrdinal => raw as WorkerOrdinal

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type PeerWriteFailureReason =
  | "timeout"
  | "connection_refused"
  | "http_error"
  | "fabric_partitioned"
  | "dns_failed"

export class PeerWriteError extends Data.TaggedError("PeerWriteError")<{
  readonly peer: WorkerOrdinal
  readonly reason: PeerWriteFailureReason
  readonly detail?: string
}> {}

export type PeerScanFailureReason =
  | "timeout"
  | "connection_refused"
  | "stream_aborted"
  | "fabric_partitioned"
  | "dns_failed"

export class PeerScanError extends Data.TaggedError("PeerScanError")<{
  readonly peer: WorkerOrdinal
  readonly reason: PeerScanFailureReason
  readonly detail?: string
}> {}

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export interface PeerCachePortApi {
  /**
   * Full create/overwrite. Sends `{ state, indexes, ttlSec }` to the
   * peer; receiver writes the call + every named index entry under
   * the partitioned key prefix `{role}:{owner}:`. `state` is the
   * msgpack-encoded body bytes (HTTP transport base64-encodes them
   * over the JSON envelope).
   */
  readonly putCall: (args: {
    readonly peer: WorkerOrdinal
    readonly role: PartitionRole
    readonly owner: WorkerOrdinal
    readonly callRef: string
    readonly state: Buffer
    readonly indexes: ReadonlyArray<string>
    readonly ttlSec: number
    /**
     * Per-call content version forwarded into the body's :gen sidecar.
     * Optional — recovery / scan paths default to 0 (dead-weight in
     * commit 2; commit 4 wires the read side).
     */
    readonly callGen?: number
  }) => Effect.Effect<void, PeerWriteError>

  /**
   * Keepalive — refresh TTL on the call key + every named index entry.
   * No state body. Maps to `expireCall` + `expireIndex × N` on the
   * peer side.
   */
  readonly refreshCall: (args: {
    readonly peer: WorkerOrdinal
    readonly role: PartitionRole
    readonly owner: WorkerOrdinal
    readonly callRef: string
    readonly indexes: ReadonlyArray<string>
    readonly ttlSec: number
  }) => Effect.Effect<void, PeerWriteError>

  /** Termination — delete the call + every named index entry. */
  readonly deleteCall: (args: {
    readonly peer: WorkerOrdinal
    readonly role: PartitionRole
    readonly owner: WorkerOrdinal
    readonly callRef: string
    readonly indexes: ReadonlyArray<string>
  }) => Effect.Effect<void, PeerWriteError>

  /**
   * Stream every entry currently in the (role, owner) partition on
   * the peer. Used by Slice 6's ReclaimRunner. Receiver walks the
   * partition with batched yielding so its sidecar Redis is not
   * starved.
   */
  readonly scan: (args: {
    readonly peer: WorkerOrdinal
    readonly role: PartitionRole
    readonly owner: WorkerOrdinal
  }) => Stream.Stream<ScanEntry, PeerScanError>
}

export class PeerCachePort extends ServiceMap.Service<PeerCachePort, PeerCachePortApi>()(
  "@sipjsserver/cache/PeerCachePort"
) {}

export type { PartitionRole, ScanEntry } from "./PartitionedRelayStorage.js"
