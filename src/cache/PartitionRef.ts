/**
 * PartitionRef — explicit bundle of the immutable (wPri, wBak) cookie
 * ordinals plus the local worker's ordinal. From these three values
 * every storage path (`pri:{owner}:call:{ref}` vs `bak:{primary}:call:{ref}`),
 * the role this worker holds for the call, and the propagate target
 * peer are pure derivations — no scan, no mutation, no external state.
 *
 * Single-owner invariant (docs/replication/call-cache-backup.md §0):
 * `wPri` is fixed at INVITE time and never changes for the call's
 * lifetime. The proxy MAC-signs (wPri, wBak) into the stickiness cookie,
 * so every in-dialog SIP message that reaches a worker carries the same
 * ordinals. A worker derives its role at message-handling time:
 *
 *   role === "primary"  iff  self === wPri
 *   role === "backup"   iff  self !== wPri (and typically self === wBak)
 *
 * The ownerPartition is the (role, primaryOrdinal) pair this worker
 * reads/writes its in-memory image from on the local sidecar. The
 * replicaPeer is who this worker propagates writes to:
 *
 *   primary  → propagate to wBak (forward direction)
 *   backup   → propagate to wPri (reverse direction — the original
 *              primary will drain this on its eventual reboot and
 *              merge the updates into its own pri:{self}: partition)
 *
 * Slice 2 of the k8s-reliability rework uses this type as the canonical
 * partition descriptor; the in-tree `parseCallRef`-based derivation in
 * CallState is functionally equivalent (callRef encodes `wPri` in its
 * first segment per slice-4 Option C) and remains the production path
 * until slice 3 of this rework wires explicit cookie extraction at the
 * SipRouter ingress.
 */

import type { PartitionRole } from "./PartitionedRelayStorage.js"

export interface PartitionRef {
  /** Cookie ordinal of the call's primary worker (immutable per call). */
  readonly wPri: string
  /** Cookie ordinal of the LB-assigned backup, or undefined for single-copy calls. */
  readonly wBak: string | undefined
  /** Local worker's ordinal — used to compare against `wPri`/`wBak`. */
  readonly self: string
}

/**
 * Forward when the local worker is the call's primary (we own
 * `pri:{self}:` and propagate to wBak); reverse when the local worker
 * is acting as backup (we own `bak:{wPri}:` and propagate back to wPri
 * so the original primary's ReadyGate drain rebuilds `pri:{wPri}:` on
 * reboot).
 */
export type PropagateDirection = "forward" | "reverse"

/** Role this worker holds for the call. */
export const roleOf = (ref: PartitionRef): PartitionRole =>
  ref.wPri === ref.self ? "pri" : "bak"

/**
 * Owner of the (role, primary) pair this worker reads its in-memory
 * image from. For role==="pri" the owner is `self`; for role==="bak"
 * the owner is the original primary (`wPri`) — we hold the call's
 * authoritative state for the primary while it is unreachable.
 */
export const ownerOf = (ref: PartitionRef): string =>
  ref.wPri === ref.self ? ref.self : ref.wPri

/**
 * Peer ordinal this worker propagates writes to, given its role.
 *
 * - role==="pri": forward direction → wBak (skip if undefined / equal to self).
 * - role==="bak": reverse direction → wPri (the original primary, who
 *   is by construction !== self in the backup case).
 *
 * Returns undefined for the no-replica case (degenerate cookie / single-copy
 * call), in which case the AtomicWriter takes the no-peer path and no
 * propagate side effect occurs.
 */
export const replicaPeerOf = (ref: PartitionRef): string | undefined => {
  if (ref.wPri === ref.self) {
    if (ref.wBak === undefined || ref.wBak.length === 0 || ref.wBak === ref.self) {
      return undefined
    }
    return ref.wBak
  }
  return ref.wPri.length > 0 ? ref.wPri : undefined
}

/**
 * Propagate direction given role. Forward when local worker is primary;
 * reverse when local worker is acting as backup. The receiver
 * (ReplPuller on the peer) reads this off the wire and chooses where to
 * apply: forward → `bak:{caller}:`, reverse → `pri:{self}:`.
 */
export const directionOf = (ref: PartitionRef): PropagateDirection =>
  ref.wPri === ref.self ? "forward" : "reverse"
