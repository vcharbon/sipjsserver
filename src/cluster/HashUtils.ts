/**
 * HashUtils — Call-ID extraction from raw SIP buffers and deterministic
 * hashing for worker dispatch.
 *
 * The dispatcher uses these to route UDP packets to the correct worker
 * process without a full SIP parse.
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
// Worker index from Call-ID
// ---------------------------------------------------------------------------

/** Deterministic worker index for a given Call-ID string. */
export function workerIndexForCallId(callId: string, totalWorkers: number): number {
  return fnv1a(callId) % totalWorkers
}

// ---------------------------------------------------------------------------
// Call-ID extraction from raw SIP buffer
// ---------------------------------------------------------------------------

// Pre-computed search patterns (case-insensitive scan for Call-ID or compact form "i:")
const CALL_ID_FULL = Buffer.from("\r\nCall-ID:", "ascii")
const CALL_ID_FULL_LC = Buffer.from("\r\ncall-id:", "ascii")
const CALL_ID_COMPACT = Buffer.from("\r\ni:", "ascii")

/**
 * Extract the Call-ID value from a raw SIP UDP packet buffer.
 *
 * Scans for `\r\nCall-ID:` (case-insensitive) or compact form `\r\ni:`.
 * Returns undefined if the header cannot be found.
 */
export function extractCallIdFromBuffer(buf: Buffer): string | undefined {
  let pos = -1
  let skipLen = 0

  // Try full form (most common) — both standard and lowercase
  pos = buf.indexOf(CALL_ID_FULL)
  if (pos !== -1) {
    skipLen = CALL_ID_FULL.length
  } else {
    pos = buf.indexOf(CALL_ID_FULL_LC)
    if (pos !== -1) {
      skipLen = CALL_ID_FULL_LC.length
    } else {
      // Try compact form "i:"
      pos = buf.indexOf(CALL_ID_COMPACT)
      if (pos !== -1) {
        skipLen = CALL_ID_COMPACT.length
      }
    }
  }

  if (pos === -1) return undefined

  // Find end of header value (next \r\n)
  const valueStart = pos + skipLen
  const endPos = buf.indexOf("\r\n", valueStart)
  if (endPos === -1) return undefined

  return buf.subarray(valueStart, endPos).toString("utf8").trim()
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
