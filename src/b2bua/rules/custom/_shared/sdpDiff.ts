/**
 * Negotiated-media SDP comparison.
 *
 * Returns true iff two SDP bodies describe the same media session for the
 * purpose of deciding whether the B2BUA must re-INVITE alice. The comparison
 * focuses on what actually steers media flow (m= line tuples and their
 * attached `c=` / `a=` lines) and ignores fields that legitimately drift
 * between offer/answer revisions without changing the negotiated stream:
 *
 *   - `o=` session-version (RFC 4566 §5.2): bumps on every refresh, even
 *     when media is unchanged.
 *   - `s=`, `i=`, `e=`, `p=`, `u=`, `t=`, `r=`, `z=`, `k=` session-level
 *     metadata: not part of media negotiation.
 *   - blank lines and CRLF/LF line-endings.
 *
 * Within each m= block the order of `c=` / `b=` / `a=` lines is preserved
 * but the comparison set-equates them so an SDP that lists the same
 * attributes in a different order still compares equal.
 *
 * Pure — no Effect, no I/O. Suitable for hot-path use in a rule handler.
 */

const MEDIA_LINE_PREFIX = "m="

/** Split an SDP body into normalized lines (CRLF/LF tolerant, blanks dropped). */
function splitLines(body: Uint8Array): ReadonlyArray<string> {
  const text = new TextDecoder("utf-8").decode(body)
  return text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
}

interface MediaBlock {
  /** Verbatim m= line (e.g. "m=audio 49170 RTP/AVP 0 8") */
  readonly mLine: string
  /** Sorted set of c=/b=/a= lines under this m= block. */
  readonly attributes: ReadonlyArray<string>
}

/**
 * Parse SDP into media blocks. Session-level lines are dropped — only the
 * media descriptors are compared. Each block sorts its attributes so two
 * SDPs with the same media but reordered attribute lines compare equal.
 */
function parseMediaBlocks(body: Uint8Array): ReadonlyArray<MediaBlock> {
  const lines = splitLines(body)
  const blocks: MediaBlock[] = []
  let current: { mLine: string; attributes: string[] } | undefined

  for (const line of lines) {
    if (line.startsWith(MEDIA_LINE_PREFIX)) {
      if (current !== undefined) {
        blocks.push({ mLine: current.mLine, attributes: [...current.attributes].sort() })
      }
      current = { mLine: line, attributes: [] }
    } else if (current !== undefined) {
      // Inside a media block — capture connection / bandwidth / attribute lines.
      // Other media-level lines (i=, k=) are rare in B2BUA flows but are
      // captured too so an unexpected change still triggers re-INVITE.
      const ch = line[0]
      if (ch === "c" || ch === "b" || ch === "a" || ch === "i" || ch === "k") {
        current.attributes.push(line)
      }
    }
    // Session-level lines before any m= are ignored.
  }
  if (current !== undefined) {
    blocks.push({ mLine: current.mLine, attributes: [...current.attributes].sort() })
  }
  return blocks
}

/**
 * Returns true iff `a` and `b` represent the same negotiated media session.
 * Empty/missing bodies are equal only when both are empty — a body-less SDP
 * compared against a real one always differs.
 */
export function sdpMediaEquivalent(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength === 0 && b.byteLength === 0) return true
  if (a.byteLength === 0 || b.byteLength === 0) return false

  const ba = parseMediaBlocks(a)
  const bb = parseMediaBlocks(b)
  if (ba.length !== bb.length) return false
  for (let i = 0; i < ba.length; i++) {
    if (ba[i]!.mLine !== bb[i]!.mLine) return false
    const aa = ba[i]!.attributes
    const ab = bb[i]!.attributes
    if (aa.length !== ab.length) return false
    for (let j = 0; j < aa.length; j++) {
      if (aa[j] !== ab[j]) return false
    }
  }
  return true
}
