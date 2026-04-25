/**
 * Rendezvous (Highest-Random-Weight, HRW) hashing — D13 of the SIP Front
 * Proxy plan.
 *
 * Pure function. Given a routing key (typically the SIP Call-ID) and a list
 * of candidate workers, return the candidate that maximises the score
 * `weight * H(key + ":" + candidate.id)`. With consistent weights, this
 * yields:
 *
 *   - O(N) lookup, no virtual-node bookkeeping.
 *   - 1/N expected key churn on membership changes (only keys whose previous
 *     winner left the set, plus a 1/N share of newcomer placements, move).
 *   - Deterministic — same `(key, candidates)` pair always returns the same
 *     winner regardless of candidate insertion order.
 *
 * Implementation notes:
 *   - We use SHA-1 from `node:crypto`. SHA-1 is *not* used here as a
 *     cryptographic primitive — only as a fast, well-distributed hash. The
 *     output is interpreted as 64 bits (top 8 bytes) of a uint64.
 *   - The 64-bit value is converted to a `bigint` before multiplying by the
 *     candidate's `weight` (default 1). Using `bigint` avoids the precision
 *     loss `Number.MAX_SAFE_INTEGER` (2^53) imposes; weights up to 2^64-1
 *     therefore behave as the operator wrote them.
 *   - Returns `undefined` (not `null` / not throwing) if `candidates` is
 *     empty — the caller (`LoadBalancerStrategy`) lifts that into
 *     `NoTargetAvailable` so the proxy core synthesises a 503.
 */

import { createHash } from "node:crypto"

export interface RendezvousCandidate {
  readonly id: string
  /** Optional weight; defaults to 1. Higher → proportionally more keys land here. */
  readonly weight?: number
}

/** Compute the top 64 bits of `SHA1(key + ":" + id)` as a bigint. */
const score64 = (key: string, id: string): bigint => {
  const h = createHash("sha1").update(`${key}:${id}`).digest()
  // First 8 bytes, big-endian, as a 64-bit unsigned integer.
  let acc = 0n
  for (let i = 0; i < 8; i++) {
    acc = (acc << 8n) | BigInt(h[i]!)
  }
  return acc
}

/**
 * Pick the candidate with the highest weighted score for `key`. Stable on
 * ties via candidate-array order (the strict `>` keeps the first winner —
 * SHA-1 collisions on 64 bits are vanishingly rare, but if two scores ever
 * tie we keep the earlier candidate to make the result deterministic across
 * snapshots that happen to put workers in the same order).
 */
export function rendezvousSelect<T extends RendezvousCandidate>(
  key: string,
  candidates: ReadonlyArray<T>
): T | undefined {
  if (candidates.length === 0) return undefined
  let best: T | undefined
  let bestScore = -1n
  for (const c of candidates) {
    const w = BigInt(Math.max(1, Math.floor(c.weight ?? 1)))
    const s = score64(key, c.id) * w
    if (best === undefined || s > bestScore) {
      best = c
      bestScore = s
    }
  }
  return best
}
