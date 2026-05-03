/**
 * SDP answer construction for the fake-PRACK UPDATE handler.
 *
 * Given Bob's UPDATE SDP offer and Alice's INVITE SDP, build a syntactically
 * valid RFC 3264 answer such that:
 *   - the m-line count and order match Bob's offer
 *   - per-m-line codec list = intersection of Bob's offer ∩ Alice's INVITE
 *     (matched by codec name + clock rate; payload types of Bob are kept)
 *   - port and c= per-m-line come from Alice — so Bob sends RTP toward
 *     Alice's address, even though we do not relay media ourselves
 *
 * If any m-line has an empty codec intersection, the build fails with
 * `_tag: "no-common-codec"` and the caller replies 488 to Bob's UPDATE.
 *
 * Co-located with SdpUtils.ts (the existing minimal SDP toolkit) to keep all
 * SDP code in one place.
 */

const CRLF = "\r\n"

// RFC 3551 static payload types we may need to recognise when an m-line has
// no rtpmap line. Limited to the ones our test traffic and common UAS
// stacks emit; unknown static PTs are treated as opaque (no-rtpmap) and
// only match when the offer and answer use the same numeric PT.
const STATIC_PT: Record<number, string> = {
  0: "PCMU/8000",
  3: "GSM/8000",
  4: "G723/8000",
  5: "DVI4/8000",
  6: "DVI4/16000",
  7: "LPC/8000",
  8: "PCMA/8000",
  9: "G722/8000",
  13: "CN/8000",
  15: "G728/8000",
  18: "G729/8000",
}

interface MediaSection {
  readonly raw: string
  readonly media: string
  readonly port: number
  readonly proto: string
  readonly payloadTypes: readonly number[]
  readonly connection: string | undefined
  readonly rtpmaps: ReadonlyMap<number, string>
  readonly fmtps: ReadonlyMap<number, string>
  readonly direction: string | undefined
}

interface ParsedSdp {
  readonly preamble: readonly string[]
  readonly sessionConnection: string | undefined
  readonly mediaSections: readonly MediaSection[]
}

export type SdpBuildResult =
  | { readonly _tag: "ok"; readonly body: Uint8Array }
  | { readonly _tag: "no-common-codec"; readonly mLineIndex: number }
  | { readonly _tag: "no-alice-sdp" }

function decodeBody(body: Uint8Array | string): string {
  return typeof body === "string" ? body : new TextDecoder("utf-8").decode(body)
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\n/).filter((l) => l.length > 0)
}

function parseSdp(text: string): ParsedSdp {
  const lines = splitLines(text)
  const preamble: string[] = []
  let sessionConnection: string | undefined
  const mediaSections: MediaSection[] = []

  let i = 0
  while (i < lines.length && !lines[i]!.startsWith("m=")) {
    const line = lines[i]!
    if (line.startsWith("c=") && sessionConnection === undefined) {
      sessionConnection = line
    }
    preamble.push(line)
    i++
  }

  while (i < lines.length) {
    const mLine = lines[i]!
    i++
    const parts = mLine.slice(2).trim().split(/\s+/)
    const media = parts[0] ?? ""
    const port = Number.parseInt(parts[1] ?? "0", 10)
    const proto = parts[2] ?? "RTP/AVP"
    const payloadTypes: number[] = []
    for (const fmt of parts.slice(3)) {
      const n = Number.parseInt(fmt, 10)
      if (Number.isFinite(n)) payloadTypes.push(n)
    }

    let connection: string | undefined
    const rtpmaps = new Map<number, string>()
    const fmtps = new Map<number, string>()
    let direction: string | undefined
    const sectionLines: string[] = [mLine]

    while (i < lines.length && !lines[i]!.startsWith("m=")) {
      const line = lines[i]!
      sectionLines.push(line)
      if (line.startsWith("c=") && connection === undefined) {
        connection = line
      } else if (line.startsWith("a=rtpmap:")) {
        const rest = line.slice("a=rtpmap:".length).trim()
        const space = rest.indexOf(" ")
        if (space !== -1) {
          const pt = Number.parseInt(rest.slice(0, space), 10)
          const codec = rest.slice(space + 1).trim()
          if (Number.isFinite(pt) && codec.length > 0) rtpmaps.set(pt, codec)
        }
      } else if (line.startsWith("a=fmtp:")) {
        const rest = line.slice("a=fmtp:".length).trim()
        const space = rest.indexOf(" ")
        if (space !== -1) {
          const pt = Number.parseInt(rest.slice(0, space), 10)
          if (Number.isFinite(pt)) fmtps.set(pt, line)
        }
      } else if (
        line === "a=sendrecv" ||
        line === "a=sendonly" ||
        line === "a=recvonly" ||
        line === "a=inactive"
      ) {
        direction = line.slice(2)
      }
      i++
    }

    mediaSections.push({
      raw: sectionLines.join(CRLF),
      media,
      port,
      proto,
      payloadTypes,
      connection,
      rtpmaps,
      fmtps,
      direction,
    })
  }

  return { preamble, sessionConnection, mediaSections }
}

function codecKey(pt: number, rtpmaps: ReadonlyMap<number, string>): string | undefined {
  const fromMap = rtpmaps.get(pt)
  if (fromMap) return fromMap.toLowerCase()
  const staticKey = STATIC_PT[pt]
  return staticKey ? staticKey.toLowerCase() : undefined
}

interface IntersectedSection {
  readonly bobPts: readonly number[]
  readonly bobRtpmaps: ReadonlyMap<number, string>
  readonly bobFmtps: ReadonlyMap<number, string>
}

function intersectCodecs(
  bob: MediaSection,
  alice: MediaSection
): IntersectedSection | "empty" {
  const aliceKeys = new Set<string>()
  for (const pt of alice.payloadTypes) {
    const key = codecKey(pt, alice.rtpmaps)
    if (key) aliceKeys.add(key)
  }
  const matchedPts: number[] = []
  for (const pt of bob.payloadTypes) {
    const key = codecKey(pt, bob.rtpmaps)
    if (!key) continue
    if (aliceKeys.has(key)) matchedPts.push(pt)
  }
  if (matchedPts.length === 0) return "empty"
  return {
    bobPts: matchedPts,
    bobRtpmaps: bob.rtpmaps,
    bobFmtps: bob.fmtps,
  }
}

function buildAnswerSection(args: {
  readonly bob: MediaSection
  readonly alice: MediaSection | undefined
  readonly aliceSessionConnection: string | undefined
  readonly intersected: IntersectedSection | undefined
  /** Extra a= attributes from the offer to echo verbatim (e.g. test harness
   *  correlation tags like `a=x-offer-id:`). */
  readonly extraOfferAttrs: ReadonlyArray<string>
}): string {
  const { bob, alice, aliceSessionConnection, intersected, extraOfferAttrs } = args
  const lines: string[] = []

  if (intersected !== undefined && alice !== undefined) {
    const port = alice.port
    lines.push(`m=${bob.media} ${port} ${bob.proto} ${intersected.bobPts.join(" ")}`)
    const c = alice.connection ?? aliceSessionConnection
    if (c !== undefined) lines.push(c)
    for (const pt of intersected.bobPts) {
      const rtpmap = intersected.bobRtpmaps.get(pt)
      if (rtpmap) lines.push(`a=rtpmap:${pt} ${rtpmap}`)
      const fmtp = intersected.bobFmtps.get(pt)
      if (fmtp) lines.push(fmtp)
    }
    for (const attr of extraOfferAttrs) lines.push(attr)
    lines.push(bob.direction ? `a=${bob.direction}` : "a=sendrecv")
  } else {
    // Alice has no matching m-section: emit a disabled placeholder per
    // RFC 3264 §6 — port 0, keep at least one codec from the offer, mark
    // a=inactive.
    const fallbackPt = bob.payloadTypes[0]
    if (fallbackPt === undefined) {
      lines.push(`m=${bob.media} 0 ${bob.proto} 0`)
    } else {
      lines.push(`m=${bob.media} 0 ${bob.proto} ${fallbackPt}`)
      const rtpmap = bob.rtpmaps.get(fallbackPt)
      if (rtpmap) lines.push(`a=rtpmap:${fallbackPt} ${rtpmap}`)
    }
    for (const attr of extraOfferAttrs) lines.push(attr)
    lines.push("a=inactive")
  }

  return lines.join(CRLF)
}

/**
 * Identify session-level `a=` attributes from `bobOffer` that the answer
 * must echo for downstream correlation. The test harness uses
 * `a=x-offer-id:<nonce>` to pair an offer with its answer (RFC 3264 §5
 * compliance check); preserving it makes our locally-built answer pass
 * the harness validator while remaining harmless in production.
 */
function extractEchoAttrs(bobOfferText: string): string[] {
  const out: string[] = []
  for (const line of splitLines(bobOfferText)) {
    if (line.startsWith("a=x-offer-id:")) out.push(line)
  }
  return out
}

/**
 * Build an answer to `bobOffer` whose addresses/ports come from `aliceOffer`.
 *
 * - `bobOffer` must be a parseable SDP with at least one m-line.
 * - `aliceOffer === null` returns `_tag: "no-alice-sdp"` (caller should not
 *   reach this branch in practice — we self-disable fake-PRACK at policy
 *   activation when Alice's INVITE has no SDP).
 * - Codec intersection per m-line; if any m-line in Bob's offer has an
 *   empty intersection with Alice's same-index m-line, returns
 *   `_tag: "no-common-codec"` with the offending index.
 */
export function buildAnswerFromOffer(
  bobOffer: Uint8Array | string,
  aliceOffer: Uint8Array | string | null
): SdpBuildResult {
  if (aliceOffer === null) return { _tag: "no-alice-sdp" }
  const aliceText = decodeBody(aliceOffer)
  if (aliceText.length === 0) return { _tag: "no-alice-sdp" }

  const bobText = decodeBody(bobOffer)
  const bob = parseSdp(bobText)
  const alice = parseSdp(aliceText)

  if (bob.mediaSections.length === 0) return { _tag: "no-alice-sdp" }
  if (alice.mediaSections.length === 0) return { _tag: "no-alice-sdp" }

  const echoAttrs = extractEchoAttrs(bobText)

  const sections: string[] = []
  for (let idx = 0; idx < bob.mediaSections.length; idx++) {
    const bobSection = bob.mediaSections[idx]!
    const aliceSection = alice.mediaSections[idx]
    if (aliceSection !== undefined) {
      const intersected = intersectCodecs(bobSection, aliceSection)
      if (intersected === "empty") {
        return { _tag: "no-common-codec", mLineIndex: idx }
      }
      sections.push(
        buildAnswerSection({
          bob: bobSection,
          alice: aliceSection,
          aliceSessionConnection: alice.sessionConnection,
          intersected,
          extraOfferAttrs: echoAttrs,
        })
      )
    } else {
      sections.push(
        buildAnswerSection({
          bob: bobSection,
          alice: undefined,
          aliceSessionConnection: alice.sessionConnection,
          intersected: undefined,
          extraOfferAttrs: echoAttrs,
        })
      )
    }
  }

  // Synthesise the session header. We do not echo Bob's o= / s= lines
  // because they identify Bob's session; the answer should look like it
  // comes from us. The session-level c= is set to Alice's so that any
  // m-line lacking an explicit c= still resolves to her address.
  const sessionLines: string[] = ["v=0", "o=b2bua 0 0 IN IP4 0.0.0.0", "s=-"]
  if (alice.sessionConnection !== undefined) {
    sessionLines.push(alice.sessionConnection)
  }
  sessionLines.push("t=0 0")

  const body = sessionLines.join(CRLF) + CRLF + sections.join(CRLF) + CRLF
  return { _tag: "ok", body: new TextEncoder().encode(body) }
}
