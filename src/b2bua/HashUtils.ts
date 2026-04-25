/**
 * HashUtils — b-leg Call-ID generation.
 *
 * Originally lived under `src/cluster/` because the dispatcher used the
 * same FNV-1a hash to route a-leg + b-leg packets to the same worker.
 * PR6 retires `src/cluster/`; the b-leg Call-ID derivation moves here so
 * `src/b2bua/helpers.ts` keeps working without cross-package imports.
 *
 * The dispatcher-side use of these utilities is gone with the cluster
 * module — the front proxy uses rendezvous hashing on the upstream
 * Call-ID instead, and a-leg/b-leg co-location is no longer guaranteed
 * (workers hydrate from Redis when a b-leg lands on a different pod).
 */

// ---------------------------------------------------------------------------
// FNV-1a hash (32-bit)
// ---------------------------------------------------------------------------

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/** FNV-1a 32-bit hash of a string. Fast, good distribution for short keys. */
export function fnv1a(input: string): number {
  let hash = FNV_OFFSET
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash >>> 0
}

// ---------------------------------------------------------------------------
// B-leg Call-ID generation with hash constraint
// ---------------------------------------------------------------------------

let blegCounter = 0

/**
 * Generate a b-leg Call-ID that hashes to the same worker as the a-leg.
 *
 * Strategy: try `{legNumber}-{counter}-{localHost}` candidates until
 * `fnv1a(candidate) % totalWorkers === targetWorkerIndex`.
 * With N=4-8, average ~2-4 attempts.
 *
 * Behavior preserved from `src/cluster/HashUtils.ts` so existing
 * b-leg Call-ID strings remain identical across the cluster→proxy
 * migration.
 */
export function generateBLegCallId(
  legNumber: number,
  targetWorkerIndex: number,
  totalWorkers: number,
  localHost: string
): string {
  for (;;) {
    const candidate = `${legNumber}-${++blegCounter}-${localHost}`
    if (fnv1a(candidate) % totalWorkers === targetWorkerIndex) {
      return candidate
    }
  }
}
