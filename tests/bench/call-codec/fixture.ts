/**
 * Representative `Call` fixture for the codec benchmark.
 *
 * Shape rationale (post N re-INVITEs on a 2-leg call):
 *   - aLeg + 1 bLeg (typical 1-target route)
 *   - 1 confirmed dialog per leg with a realistic routeSet (3 entries)
 *   - aLegInvite carries ~20 headers + ~1.5 KB SDP (the actual cost driver)
 *   - inboundPendingRequests has a couple of in-flight entries (re-INVITE churn)
 *   - cachedSdp present on the bLeg's dialog (fake-prack strategy)
 *   - small handfuls of cdrEvents / timers / tagMap / activeRules / ruleState
 *
 * `messageCount` lives on the Call (Schema.Int) but is a single number,
 * so the body still does NOT grow with N re-INVITEs. What changes per-
 * message is `inboundPendingRequests` add/remove on dialog.ext, CSeq
 * numbers, and the counter bump — they churn, they do not accumulate.
 */

import type { Call, Leg, Dialog, PendingRequest } from "../../../src/call/CallModel.js"

const SDP_BODY = `v=0
o=alice 53655765 2353687637 IN IP4 192.0.2.1
s=B2BUA call
c=IN IP4 192.0.2.1
t=0 0
m=audio 16384 RTP/AVP 0 8 96 97 98 99 100 101 102
a=rtpmap:0 PCMU/8000
a=rtpmap:8 PCMA/8000
a=rtpmap:96 opus/48000/2
a=fmtp:96 useinbandfec=1; usedtx=1; maxplaybackrate=48000
a=rtpmap:97 G722/8000
a=rtpmap:98 G729/8000
a=fmtp:98 annexb=no
a=rtpmap:99 telephone-event/8000
a=fmtp:99 0-16
a=rtpmap:100 telephone-event/16000
a=fmtp:100 0-16
a=rtpmap:101 telephone-event/48000
a=fmtp:101 0-16
a=rtpmap:102 CN/16000
a=sendrecv
a=ptime:20
a=maxptime:240
a=rtcp-mux
a=rtcp-rsize
a=ice-ufrag:F4Tr
a=ice-pwd:Xz9aV2W3kqXyzpQRsT0bAg
a=fingerprint:sha-256 12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0
a=setup:actpass
a=candidate:1 1 UDP 2130706431 192.0.2.1 16384 typ host
a=candidate:2 1 UDP 2130706431 198.51.100.42 16384 typ srflx raddr 192.0.2.1 rport 16384
`

const sdpBytes = new TextEncoder().encode(SDP_BODY)

const aLegHeaders = [
  { name: "Via", value: "SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bK-1234567890;rport" },
  { name: "Via", value: "SIP/2.0/UDP 10.0.0.5:5060;branch=z9hG4bK-fproxy-abc123;received=10.0.0.5;rport=5060" },
  { name: "Max-Forwards", value: "69" },
  { name: "From", value: "<sip:alice@example.com>;tag=alice-from-tag-001" },
  { name: "To", value: "<sip:bob@example.com>" },
  { name: "Call-ID", value: "call-id-deadbeef-abcdef0123456789@example.com" },
  { name: "CSeq", value: "1 INVITE" },
  { name: "Contact", value: "<sip:alice@192.0.2.10:5060;transport=udp>" },
  { name: "Allow", value: "INVITE, ACK, CANCEL, BYE, OPTIONS, INFO, UPDATE, REFER, NOTIFY, MESSAGE, PRACK" },
  { name: "Supported", value: "replaces, 100rel, timer, gruu, path, outbound" },
  { name: "User-Agent", value: "MySipClient/2.4.1 (linux)" },
  { name: "Subject", value: "Hello Bob" },
  { name: "Accept", value: "application/sdp, application/dtmf-relay" },
  { name: "Accept-Encoding", value: "identity" },
  { name: "Accept-Language", value: "en" },
  { name: "Date", value: "Thu, 22 May 2026 09:03:42 GMT" },
  { name: "Session-Expires", value: "1800;refresher=uac" },
  { name: "Min-SE", value: "90" },
  { name: "Resource-Priority", value: "esnet.0" },
  { name: "Record-Route", value: "<sip:fproxy.example.com;lr>" },
  { name: "Record-Route", value: "<sip:edge1.example.com;lr>" },
  { name: "Content-Type", value: "application/sdp" },
  { name: "Content-Length", value: String(sdpBytes.length) },
]

const inboundPendingRequest = (cseq: number, method: string): PendingRequest => ({
  method,
  outboundCSeq: cseq,
  inboundCSeq: cseq,
  sourceVias: [
    "SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bK-reinv-" + cseq + ";rport",
    "SIP/2.0/UDP 10.0.0.5:5060;branch=z9hG4bK-fproxy-reinv-" + cseq + ";received=10.0.0.5;rport=5060",
  ],
  sourceCallId: "call-id-deadbeef-abcdef0123456789@example.com",
  sourceFrom: "<sip:alice@example.com>;tag=alice-from-tag-001",
  sourceTo: "<sip:bob@example.com>;tag=b2bua-to-tag-aleg-9876",
  direction: "from-a",
})

const makeDialog = (
  callId: string,
  localTag: string,
  remoteTag: string,
  localUri: string,
  remoteUri: string,
  remoteTarget: string,
  cseq: number,
  withCachedSdp: boolean = false,
  pendingCount: number = 2,
): Dialog => ({
  sip: {
    callId,
    localTag,
    remoteTag,
    localUri,
    remoteUri,
    remoteTarget,
    localCSeq: cseq,
    routeSet: [
      "<sip:fproxy.example.com;lr>",
      "<sip:edge1.example.com;lr>",
      "<sip:bproxy.bob.example.com;lr>",
    ],
  },
  ext: {
    remoteCSeq: cseq + 1,
    inboundPendingRequests: Array.from({ length: pendingCount }, (_, i) =>
      inboundPendingRequest(cseq + 10 + i, "INVITE"),
    ),
    ackBranch: "z9hG4bK-ack-" + cseq.toString(16),
    cachedSdp: withCachedSdp ? sdpBytes : undefined,
  },
})

const aLeg: Leg = {
  legId: "a",
  callId: "call-id-deadbeef-abcdef0123456789@example.com",
  fromTag: "alice-from-tag-001",
  source: { address: "10.0.0.5", port: 5060 },
  state: "confirmed",
  disposition: "bridged",
  dialogs: [
    makeDialog(
      "call-id-deadbeef-abcdef0123456789@example.com",
      "b2bua-to-tag-aleg-9876",
      "alice-from-tag-001",
      "sip:bob@example.com",
      "sip:alice@example.com",
      "sip:alice@192.0.2.10:5060;transport=udp",
      8005,
      false,
      2,
    ),
  ],
  localUri: "sip:bob@example.com",
  remoteUri: "sip:alice@example.com",
}

const bLeg: Leg = {
  legId: "b-1",
  callId: "b-leg-call-id-fedcba9876543210@b2bua",
  fromTag: "b2bua-from-tag-bleg-5544",
  source: { address: "203.0.113.42", port: 5060 },
  state: "confirmed",
  disposition: "bridged",
  dialogs: [
    makeDialog(
      "b-leg-call-id-fedcba9876543210@b2bua",
      "b2bua-from-tag-bleg-5544",
      "bob-to-tag-007",
      "sip:alice@example.com",
      "sip:bob@example.com",
      "sip:bob@203.0.113.42:5060;transport=udp",
      4002,
      true,
      1,
    ),
  ],
  localUri: "sip:alice@example.com",
  remoteUri: "sip:bob@example.com",
  inviteRequestUri: "sip:bob@example.com",
}

export const representativeCall: Call = {
  callRef: "worker-0|call-id-deadbeef-abcdef0123456789@example.com|alice-from-tag-001",
  aLeg,
  bLegs: [bLeg],
  activePeer: { legA: "a", legB: "b-1" },
  callbackContext: "ctx-abc-123-def-456",
  billingContext: "subscriber=alice@example.com;plan=premium;cost-band=domestic",
  aLegInvite: {
    uri: "sip:bob@example.com",
    headers: aLegHeaders,
    body: sdpBytes,
  },
  limiterEntries: [
    { limiterId: "subscriber:alice@example.com", limit: 5, originWindow: 1779440000, incrementSucceeded: true },
    { limiterId: "trunk:edge1.example.com", limit: 1000, originWindow: 1779440000, incrementSucceeded: true },
  ],
  timers: [
    { id: "timer-no-answer-a", type: "no_answer", fireAt: 1779440045_000, legId: "a" },
    { id: "timer-global-duration", type: "global_duration", fireAt: 1779443642_000 },
    { id: "timer-limiter-refresh", type: "limiter_refresh", fireAt: 1779440072_000 },
  ],
  cdrEvents: [
    { type: "invite_received", timestamp: 1779440042_000, legId: "a" },
    { type: "invite_sent", timestamp: 1779440042_500, legId: "b-1" },
    { type: "provisional", timestamp: 1779440042_800, legId: "b-1", statusCode: 180 },
    { type: "answer", timestamp: 1779440043_200, legId: "b-1", statusCode: 200 },
  ],
  state: "active",
  createdAt: 1779440042_000,
  tagMap: [
    { aTag: "b2bua-to-tag-aleg-9876", bLegId: "b-1", bTag: "bob-to-tag-007" },
  ],
  traceId: "0123456789abcdef0123456789abcdef",
  rootSpanId: "fedcba9876543210",
  sampled: true,
  workerIndex: 0,
  _topology: { pri: "worker-0", bak: "worker-1", gen: 3 },
  emergency: true,
  activeRules: [
    { id: "limit-by-subscriber", params: { limiterId: "subscriber:alice@example.com", limit: 5 }, active: true },
    { id: "promote-pem-to-200", params: { strategy: "fake-prack" }, active: false },
    { id: "transfer-c-1xx-to-notify", active: true },
  ],
  ruleState: [
    { ruleId: "limit-by-subscriber", state: { admittedAt: 1779440042_000, window: 1779440000 } },
    { ruleId: "promote-pem-to-200", state: undefined },
  ],
}

/** Quick sanity print — `node ... fixture.js` outputs the encoded size. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const enc = JSON.stringify(representativeCall, (_k, v) => {
    if (v instanceof Uint8Array) return Buffer.from(v).toString("base64")
    return v
  })
  console.log(`fixture size (raw JSON w/ base64): ${enc.length} bytes`)
  console.log(`SDP size: ${sdpBytes.length} bytes`)
  console.log(`headers: ${aLegHeaders.length}`)
}
