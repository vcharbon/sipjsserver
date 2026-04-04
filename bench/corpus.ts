/**
 * SIP message corpus generator for benchmarking.
 *
 * Generates realistic SIP messages as pre-built Buffers.
 * Each message has a unique Call-ID and Via branch to prevent
 * any caching or deduplication artifacts.
 * Content-Length is auto-calculated for correctness.
 */

function crlfize(s: string): string {
  return s.replace(/\r?\n/g, "\r\n")
}

/** Build a SIP message with correct Content-Length. */
function buildMessage(headers: string, body: string): Buffer {
  const crlfHeaders = crlfize(headers)
  const crlfBody = crlfize(body)
  const bodyBytes = Buffer.byteLength(crlfBody, "utf-8")
  // Replace the Content-Length placeholder
  const finalHeaders = crlfHeaders.replace(
    "Content-Length: __CL__",
    `Content-Length: ${bodyBytes}`
  )
  return Buffer.from(finalHeaders + "\r\n" + crlfBody, "utf-8")
}

const SDP_BODY = `v=0
o=alice 2890844526 2890844526 IN IP4 192.168.1.100
s=-
c=IN IP4 192.168.1.100
t=0 0
m=audio 49170 RTP/AVP 0 8 97
a=rtpmap:0 PCMU/8000
a=rtpmap:8 PCMA/8000
a=rtpmap:97 telephone-event/8000
a=fmtp:97 0-16
a=sendrecv
`

const SDP_BODY_B = `v=0
o=bob 1234567890 1234567890 IN IP4 192.168.1.200
s=-
c=IN IP4 192.168.1.200
t=0 0
m=audio 49172 RTP/AVP 0 8 97
a=rtpmap:0 PCMU/8000
a=rtpmap:8 PCMA/8000
a=rtpmap:97 telephone-event/8000
a=fmtp:97 0-16
a=sendrecv
`

/** Generate N unique INVITE messages with SDP. */
export function generateInvites(count: number): Buffer[] {
  const buffers: Buffer[] = []
  for (let i = 0; i < count; i++) {
    const callId = `bench-${i}-${Date.now()}@192.168.1.100`
    const branch = `z9hG4bK-bench-${i}`
    const headers =
`INVITE sip:bob@example.com SIP/2.0
Via: SIP/2.0/UDP 192.168.1.100:5060;branch=${branch};rport
Max-Forwards: 70
From: "Alice" <sip:alice@example.com>;tag=tag-${i}
To: <sip:bob@example.com>
Call-ID: ${callId}
CSeq: 1 INVITE
Contact: <sip:alice@192.168.1.100:5060>
Content-Type: application/sdp
Allow: INVITE,ACK,BYE,CANCEL,OPTIONS,PRACK,UPDATE,INFO
Supported: timer,100rel
User-Agent: BenchSIP/1.0
Content-Length: __CL__
`
    buffers.push(buildMessage(headers, SDP_BODY))
  }
  return buffers
}

/** Generate N unique 200 OK responses with SDP. */
export function generateOKs(count: number): Buffer[] {
  const buffers: Buffer[] = []
  for (let i = 0; i < count; i++) {
    const callId = `bench-${i}-${Date.now()}@192.168.1.100`
    const branch = `z9hG4bK-bench-${i}`
    const headers =
`SIP/2.0 200 OK
Via: SIP/2.0/UDP 192.168.1.100:5060;branch=${branch};rport;received=192.168.1.100
From: "Alice" <sip:alice@example.com>;tag=tag-${i}
To: <sip:bob@example.com>;tag=resp-${i}
Call-ID: ${callId}
CSeq: 1 INVITE
Contact: <sip:bob@192.168.1.200:5060>
Content-Type: application/sdp
Allow: INVITE,ACK,BYE,CANCEL,OPTIONS,PRACK,UPDATE
Supported: timer,100rel
Content-Length: __CL__
`
    buffers.push(buildMessage(headers, SDP_BODY_B))
  }
  return buffers
}

/** Generate N unique BYE messages (~300 bytes each). */
export function generateBYEs(count: number): Buffer[] {
  const buffers: Buffer[] = []
  for (let i = 0; i < count; i++) {
    const callId = `bench-${i}-${Date.now()}@192.168.1.100`
    const branch = `z9hG4bK-bye-${i}`
    const headers =
`BYE sip:bob@192.168.1.200:5060 SIP/2.0
Via: SIP/2.0/UDP 192.168.1.100:5060;branch=${branch};rport
Max-Forwards: 70
From: "Alice" <sip:alice@example.com>;tag=tag-${i}
To: <sip:bob@example.com>;tag=resp-${i}
Call-ID: ${callId}
CSeq: 2 BYE
Content-Length: __CL__
`
    buffers.push(buildMessage(headers, ""))
  }
  return buffers
}
