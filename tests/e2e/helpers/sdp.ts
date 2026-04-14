/**
 * Default SDP bodies for test scenarios with offer/answer correlation.
 *
 * Offer vs answer classification heuristic:
 *   - Offer:  3 codecs in m= line ("8 18 101") plus an `a=x-offer-id:<nonce>` tag.
 *   - Answer: 2 codecs ("8 101"); echoes the offer's nonce when built via
 *             `sdpAnswer(offer)`.
 *
 * The nonce + port pair lets the harness correlate every answer to the specific
 * offer it is replying to (RFC 3264 offer/answer). `sdpAnswer(offer)` derives
 * its port as `offer.port + 1` so both sides of the exchange are verifiable.
 *
 * Both builders return `Uint8Array` to stay drop-in compatible with the
 * `body:` field on `HeaderOverrides`. Call sites that need the nonce/port for
 * later correlation can recover them via `classifySdp(body)`.
 */
import { randomBytes } from "node:crypto"

const OFFER_PORT_MIN = 20000
const OFFER_PORT_MAX = 30000

function randomOfferPort(): number {
  const range = Math.floor((OFFER_PORT_MAX - OFFER_PORT_MIN) / 2)
  return OFFER_PORT_MIN + Math.floor(Math.random() * range) * 2
}

function randomNonce(): string {
  return randomBytes(4).toString("hex")
}

/**
 * Build an SDP offer with a random port and nonce.
 *
 * Backward-compat: `sdpOffer()`, `sdpOffer(ip)`, `sdpOffer(ip, port)` all work.
 * The caller can extract the nonce/port via `classifySdp(body)` if needed to
 * cross-correlate the answer built from this offer.
 */
export function sdpOffer(ip: string = "127.0.0.1", port?: number): Uint8Array {
  const finalPort = port ?? randomOfferPort()
  const nonce = randomNonce()
  const sdp = [
    "v=0",
    `o=test 1 1 IN IP4 ${ip}`,
    "s=-",
    `c=IN IP4 ${ip}`,
    "t=0 0",
    `m=audio ${finalPort} RTP/AVP 8 18 101`,
    "a=rtpmap:8 PCMA/8000",
    "a=rtpmap:18 G729/8000",
    "a=rtpmap:101 telephone-event/8000",
    "a=fmtp:101 0-16",
    `a=x-offer-id:${nonce}`,
    "a=sendrecv",
  ].join("\r\n") + "\r\n"
  return new TextEncoder().encode(sdp)
}

/**
 * Build an SDP answer.
 *
 * Pass the prior offer body for full correlation: the answer's port becomes
 * `offer.port + 1` and its `a=x-offer-id` echoes the offer's nonce.
 *
 * Calling without the offer arg produces a "blind" answer (no offer-id,
 * default port). Blind answers still pass "some pending offer exists" checks
 * but skip the strict nonce/port equality check — use only in negative tests
 * or when paired with `skipValidation: ["offerAnswer"]`.
 */
export function sdpAnswer(
  offer?: Uint8Array,
  ip?: string,
  port?: number
): Uint8Array {
  const finalIp = ip ?? "127.0.0.1"
  let derivedPort: number
  let derivedNonce = ""
  if (offer) {
    const parsed = classifySdp(offer)
    if (parsed.kind === "offer") {
      derivedPort = port ?? parsed.port + 1
      derivedNonce = parsed.nonce
    } else {
      derivedPort = port ?? 20001
    }
  } else {
    derivedPort = port ?? 20001
  }

  const lines = [
    "v=0",
    `o=test 2 2 IN IP4 ${finalIp}`,
    "s=-",
    `c=IN IP4 ${finalIp}`,
    "t=0 0",
    `m=audio ${derivedPort} RTP/AVP 8 101`,
    "a=rtpmap:8 PCMA/8000",
    "a=rtpmap:101 telephone-event/8000",
    "a=fmtp:101 0-16",
  ]
  if (derivedNonce) lines.push(`a=x-offer-id:${derivedNonce}`)
  lines.push("a=sendrecv")
  const sdp = lines.join("\r\n") + "\r\n"
  return new TextEncoder().encode(sdp)
}

/**
 * SDP classification + parsing for validators.
 *
 * Returns:
 *   - `{ kind: "offer", port, nonce }` when body has 3 codecs (8 18 101)
 *   - `{ kind: "answer", port, nonce }` when body has 2 codecs (8 101)
 *   - `{ kind: "unclassified" }` when body is not SDP or doesn't match the pattern
 *
 * Nonce may be empty when the body was built from the no-arg `sdpAnswer()` path.
 */
export type SdpClassification =
  | { readonly kind: "offer"; readonly port: number; readonly nonce: string }
  | { readonly kind: "answer"; readonly port: number; readonly nonce: string }
  | { readonly kind: "unclassified" }

export function classifySdp(body: Uint8Array): SdpClassification {
  if (body.byteLength === 0) return { kind: "unclassified" }
  const text = new TextDecoder().decode(body)
  if (!text.startsWith("v=0")) return { kind: "unclassified" }

  const mLine = text.split(/\r?\n/).find((l) => l.startsWith("m=audio "))
  if (!mLine) return { kind: "unclassified" }
  const parts = mLine.split(/\s+/)
  const port = parseInt(parts[1] ?? "0", 10)
  const codecs = parts.slice(3)

  const nonceMatch = /a=x-offer-id:([A-Za-z0-9]+)/.exec(text)
  const nonce = nonceMatch?.[1] ?? ""

  const sig = codecs.join(" ")
  if (sig === "8 18 101") return { kind: "offer", port, nonce }
  if (sig === "8 101") return { kind: "answer", port, nonce }
  return { kind: "unclassified" }
}
