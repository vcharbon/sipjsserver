/**
 * Five shape kinds spanning the call lifecycle, used by the bench's mix
 * iterator (`fixtureMix.ts`) so the codec is exercised on the actual
 * production distribution instead of a single representative point.
 *
 * Each builder takes a deterministic `idx` so the same seed always
 * produces the same fixture bytes — bench output stays stable across
 * runs even though every iteration pulls a different shape.
 *
 * Calibration note: the default weights in `fixtureMix.ts` are starter
 * values inferred from `/debug/memory` histograms on a healthy worker
 * (mid-soak, 45 cps legit + 1 cap × 3 abuse archetypes). Recalibrate
 * from a fresh production scrape before locking budgets — see the
 * benchmark README.
 */

import type { Call, Dialog, Leg, PendingRequest } from "../../../src/call/CallModel.js"

export type FixtureKind =
  | "EARLY"
  | "CONFIRMED_STEADY"
  | "REINVITE_STORM"
  | "TERMINATING"
  | "ABUSE_MALFORMED"

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

const baseHeaders = (idx: number) => [
  { name: "Via", value: `SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bK-${idx};rport` },
  { name: "Via", value: `SIP/2.0/UDP 10.0.0.5:5060;branch=z9hG4bK-fproxy-${idx};received=10.0.0.5;rport=5060` },
  { name: "Max-Forwards", value: "69" },
  { name: "From", value: `<sip:alice-${idx}@example.com>;tag=alice-from-tag-${idx}` },
  { name: "To", value: "<sip:bob@example.com>" },
  { name: "Call-ID", value: `call-id-${idx.toString(16).padStart(16, "0")}@example.com` },
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

const pendingRequest = (cseq: number, method: string, idx: number): PendingRequest => ({
  method,
  outboundCSeq: cseq,
  inboundCSeq: cseq,
  sourceVias: [
    `SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bK-reinv-${cseq}-${idx};rport`,
    `SIP/2.0/UDP 10.0.0.5:5060;branch=z9hG4bK-fproxy-reinv-${cseq}-${idx};received=10.0.0.5;rport=5060`,
  ],
  sourceCallId: `call-id-${idx.toString(16).padStart(16, "0")}@example.com`,
  sourceFrom: `<sip:alice-${idx}@example.com>;tag=alice-from-tag-${idx}`,
  sourceTo: "<sip:bob@example.com>;tag=b2bua-to-tag-aleg-9876",
  direction: "from-a",
})

const dialog = (
  callId: string,
  localTag: string,
  remoteTag: string,
  cseq: number,
  pending: number,
  withCachedSdp: boolean,
  idx: number,
): Dialog => ({
  sip: {
    callId,
    localTag,
    remoteTag,
    localUri: "sip:bob@example.com",
    remoteUri: `sip:alice-${idx}@example.com`,
    remoteTarget: "sip:alice@192.0.2.10:5060;transport=udp",
    localCSeq: cseq,
    routeSet: [
      "<sip:fproxy.example.com;lr>",
      "<sip:edge1.example.com;lr>",
      "<sip:bproxy.bob.example.com;lr>",
    ],
  },
  ext: {
    remoteCSeq: cseq + 1,
    inboundPendingRequests: Array.from({ length: pending }, (_, i) =>
      pendingRequest(cseq + 10 + i, "INVITE", idx),
    ),
    ackBranch: `z9hG4bK-ack-${cseq.toString(16)}-${idx}`,
    cachedSdp: withCachedSdp ? sdpBytes : undefined,
  },
})

const callRefFor = (idx: number, kind: FixtureKind) =>
  `worker-0|call-id-${idx.toString(16).padStart(16, "0")}@example.com|alice-from-tag-${idx}|${kind}`

// ── EARLY ──────────────────────────────────────────────────────────────────
// Pre-200 a-leg with no confirmed dialog and no bLegs yet. Smallest body
// shape on the wire — single pending request, single cdrEvent.
const earlyCall = (idx: number): Call => {
  const callId = `call-id-${idx.toString(16).padStart(16, "0")}@example.com`
  return {
    callRef: callRefFor(idx, "EARLY"),
    aLeg: {
      legId: "a",
      callId,
      fromTag: `alice-from-tag-${idx}`,
      source: { address: "10.0.0.5", port: 5060 },
      state: "trying",
      disposition: "pending",
      dialogs: [],
    },
    bLegs: [],
    activePeer: null,
    aLegInvite: {
      uri: "sip:bob@example.com",
      headers: baseHeaders(idx),
      body: sdpBytes,
    },
    limiterEntries: [
      { limiterId: `subscriber:alice-${idx}@example.com`, limit: 5, originWindow: 1779440000, incrementSucceeded: true },
    ],
    timers: [
      { id: "timer-no-answer-a", type: "no_answer", fireAt: 1779440045_000, legId: "a" },
    ],
    cdrEvents: [
      { type: "invite_received", timestamp: 1779440042_000, legId: "a" },
    ],
    state: "active",
    createdAt: 1779440042_000,
    tagMap: [],
    workerIndex: 0,
    _topology: { pri: "worker-0", bak: "worker-1", gen: 1 },
  }
}

// ── CONFIRMED_STEADY ───────────────────────────────────────────────────────
// Mid-call steady state — 1 a-leg + 1 b-leg, both confirmed, modest
// pending churn, cachedSdp on b-leg only (fake-prack strategy).
const confirmedSteadyCall = (idx: number): Call => {
  const callId = `call-id-${idx.toString(16).padStart(16, "0")}@example.com`
  const bCallId = `b-leg-${idx.toString(16).padStart(16, "0")}@b2bua`
  const aLeg: Leg = {
    legId: "a",
    callId,
    fromTag: `alice-from-tag-${idx}`,
    source: { address: "10.0.0.5", port: 5060 },
    state: "confirmed",
    disposition: "bridged",
    dialogs: [dialog(callId, "b2bua-to-tag-aleg-9876", `alice-from-tag-${idx}`, 8005, 2, false, idx)],
    localUri: "sip:bob@example.com",
    remoteUri: `sip:alice-${idx}@example.com`,
  }
  const bLeg: Leg = {
    legId: "b-1",
    callId: bCallId,
    fromTag: "b2bua-from-tag-bleg-5544",
    source: { address: "203.0.113.42", port: 5060 },
    state: "confirmed",
    disposition: "bridged",
    dialogs: [dialog(bCallId, "b2bua-from-tag-bleg-5544", "bob-to-tag-007", 4002, 1, true, idx)],
    localUri: `sip:alice-${idx}@example.com`,
    remoteUri: "sip:bob@example.com",
    inviteRequestUri: "sip:bob@example.com",
  }
  return {
    callRef: callRefFor(idx, "CONFIRMED_STEADY"),
    aLeg,
    bLegs: [bLeg],
    activePeer: { legA: "a", legB: "b-1" },
    callbackContext: "ctx-abc-123-def-456",
    billingContext: `subscriber=alice-${idx}@example.com;plan=premium`,
    aLegInvite: {
      uri: "sip:bob@example.com",
      headers: baseHeaders(idx),
      body: sdpBytes,
    },
    limiterEntries: [
      { limiterId: `subscriber:alice-${idx}@example.com`, limit: 5, originWindow: 1779440000, incrementSucceeded: true },
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
    tagMap: [{ aTag: "b2bua-to-tag-aleg-9876", bLegId: "b-1", bTag: "bob-to-tag-007" }],
    traceId: "0123456789abcdef0123456789abcdef",
    rootSpanId: "fedcba9876543210",
    sampled: true,
    workerIndex: 0,
    _topology: { pri: "worker-0", bak: "worker-1", gen: 3 },
    emergency: true,
    activeRules: [
      { id: "limit-by-subscriber", active: true },
      { id: "promote-pem-to-200", active: false },
      { id: "transfer-c-1xx-to-notify", active: true },
    ],
  }
}

// ── REINVITE_STORM ─────────────────────────────────────────────────────────
// Mid-storm: 5–10 inbound pending requests per dialog, cachedSdp on both
// legs, longer cdrEvents tail.
const reinviteStormCall = (idx: number): Call => {
  const callId = `call-id-${idx.toString(16).padStart(16, "0")}@example.com`
  const bCallId = `b-leg-${idx.toString(16).padStart(16, "0")}@b2bua`
  const pendingCount = 5 + (idx % 6)
  const aLeg: Leg = {
    legId: "a",
    callId,
    fromTag: `alice-from-tag-${idx}`,
    source: { address: "10.0.0.5", port: 5060 },
    state: "confirmed",
    disposition: "bridged",
    dialogs: [dialog(callId, "b2bua-to-tag-aleg-9876", `alice-from-tag-${idx}`, 8005, pendingCount, true, idx)],
    localUri: "sip:bob@example.com",
    remoteUri: `sip:alice-${idx}@example.com`,
  }
  const bLeg: Leg = {
    legId: "b-1",
    callId: bCallId,
    fromTag: "b2bua-from-tag-bleg-5544",
    source: { address: "203.0.113.42", port: 5060 },
    state: "confirmed",
    disposition: "bridged",
    dialogs: [dialog(bCallId, "b2bua-from-tag-bleg-5544", "bob-to-tag-007", 4002, pendingCount, true, idx)],
    localUri: `sip:alice-${idx}@example.com`,
    remoteUri: "sip:bob@example.com",
    inviteRequestUri: "sip:bob@example.com",
  }
  const cdrEvents = Array.from({ length: 18 }, (_, i) => {
    const t: "invite_received" | "invite_sent" | "answer" =
      i % 3 === 0 ? "invite_received" : i % 3 === 1 ? "invite_sent" : "answer"
    return {
      type: t,
      timestamp: 1779440042_000 + i * 25,
      legId: i % 2 === 0 ? "a" : "b-1",
      ...(i % 3 === 2 ? { statusCode: 200 } : {}),
    }
  })
  return {
    callRef: callRefFor(idx, "REINVITE_STORM"),
    aLeg,
    bLegs: [bLeg],
    activePeer: { legA: "a", legB: "b-1" },
    callbackContext: "ctx-storm",
    billingContext: `subscriber=alice-${idx}@example.com;plan=premium`,
    aLegInvite: {
      uri: "sip:bob@example.com",
      headers: baseHeaders(idx),
      body: sdpBytes,
    },
    limiterEntries: [
      { limiterId: `subscriber:alice-${idx}@example.com`, limit: 5, originWindow: 1779440000, incrementSucceeded: true },
    ],
    timers: [
      { id: "timer-global-duration", type: "global_duration", fireAt: 1779443642_000 },
    ],
    cdrEvents,
    state: "active",
    createdAt: 1779440042_000,
    tagMap: [{ aTag: "b2bua-to-tag-aleg-9876", bLegId: "b-1", bTag: "bob-to-tag-007" }],
    workerIndex: 0,
    _topology: { pri: "worker-0", bak: "worker-1", gen: 12 },
    messageCount: 50 + (idx % 30),
  }
}

// ── TERMINATING ────────────────────────────────────────────────────────────
// Partial teardown: state="terminating", no aLegInvite.body, dialogs
// shrunk, slightly larger tagMap (b-leg trail).
const terminatingCall = (idx: number): Call => {
  const callId = `call-id-${idx.toString(16).padStart(16, "0")}@example.com`
  const bCallId = `b-leg-${idx.toString(16).padStart(16, "0")}@b2bua`
  const aLeg: Leg = {
    legId: "a",
    callId,
    fromTag: `alice-from-tag-${idx}`,
    source: { address: "10.0.0.5", port: 5060 },
    state: "terminated",
    disposition: "bridged",
    dialogs: [dialog(callId, "b2bua-to-tag-aleg-9876", `alice-from-tag-${idx}`, 8200, 0, false, idx)],
    byeDisposition: "bye_sent",
  }
  const bLeg: Leg = {
    legId: "b-1",
    callId: bCallId,
    fromTag: "b2bua-from-tag-bleg-5544",
    source: { address: "203.0.113.42", port: 5060 },
    state: "terminated",
    disposition: "bridged",
    dialogs: [dialog(bCallId, "b2bua-from-tag-bleg-5544", "bob-to-tag-007", 4200, 0, false, idx)],
    byeDisposition: "bye_received",
  }
  return {
    callRef: callRefFor(idx, "TERMINATING"),
    aLeg,
    bLegs: [bLeg],
    activePeer: null,
    aLegInvite: {
      uri: "sip:bob@example.com",
      headers: baseHeaders(idx).slice(0, 12),
      body: new Uint8Array(),
    },
    limiterEntries: [],
    timers: [],
    cdrEvents: [
      { type: "invite_received", timestamp: 1779440042_000, legId: "a" },
      { type: "answer", timestamp: 1779440043_200, legId: "b-1", statusCode: 200 },
      { type: "bye", timestamp: 1779440080_000, legId: "a" },
      { type: "bye", timestamp: 1779440080_200, legId: "b-1" },
      { type: "bye", timestamp: 1779440080_500, legId: "a", statusCode: 200 },
    ],
    state: "terminating",
    createdAt: 1779440042_000,
    tagMap: [
      { aTag: "b2bua-to-tag-aleg-9876", bLegId: "b-1", bTag: "bob-to-tag-007" },
      { aTag: "b2bua-to-tag-aleg-9876-old", bLegId: "b-1", bTag: "bob-to-tag-prev" },
      { aTag: "b2bua-to-tag-aleg-9876-init", bLegId: "b-1", bTag: "bob-to-tag-180" },
    ],
    workerIndex: 0,
    _topology: { pri: "worker-0", bak: "worker-1", gen: 5 },
  }
}

// ── ABUSE_MALFORMED ────────────────────────────────────────────────────────
// Reflects an under-attack call: oversized headers, runaway pending
// requests, massive cdrEvents tail. The codec must still hold up.
const abuseMalformedCall = (idx: number): Call => {
  const callId = `call-id-${idx.toString(16).padStart(16, "0")}@example.com`
  const bCallId = `b-leg-${idx.toString(16).padStart(16, "0")}@b2bua`
  const fatHeaders = [
    ...baseHeaders(idx),
    ...Array.from({ length: 35 }, (_, i) => ({
      name: `X-Abuse-Header-${i}`,
      value: `A-very-long-attacker-controlled-header-value-${"x".repeat(200)}-${i}`,
    })),
  ]
  const aLeg: Leg = {
    legId: "a",
    callId,
    fromTag: `alice-from-tag-${idx}`,
    source: { address: "10.0.0.5", port: 5060 },
    state: "early",
    disposition: "pending",
    dialogs: [dialog(callId, "b2bua-to-tag-aleg-9876", `alice-from-tag-${idx}`, 8005, 20, false, idx)],
  }
  const bLeg: Leg = {
    legId: "b-1",
    callId: bCallId,
    fromTag: "b2bua-from-tag-bleg-5544",
    source: { address: "203.0.113.42", port: 5060 },
    state: "early",
    disposition: "pending",
    dialogs: [dialog(bCallId, "b2bua-from-tag-bleg-5544", "bob-to-tag-007", 4002, 20, true, idx)],
  }
  const cdrEvents = Array.from({ length: 60 }, (_, i) => {
    const t: "invite_received" | "reject" = i % 2 === 0 ? "invite_received" : "reject"
    return {
      type: t,
      timestamp: 1779440042_000 + i * 5,
      legId: i % 2 === 0 ? "a" : "b-1",
      statusCode: i % 2 === 0 ? 200 : 503,
      reason: "abuse-rule-tripped",
    }
  })
  return {
    callRef: callRefFor(idx, "ABUSE_MALFORMED"),
    aLeg,
    bLegs: [bLeg],
    activePeer: { legA: "a", legB: "b-1" },
    aLegInvite: {
      uri: "sip:bob@example.com",
      headers: fatHeaders,
      body: sdpBytes,
    },
    limiterEntries: [
      { limiterId: `subscriber:alice-${idx}@example.com`, limit: 5, originWindow: 1779440000, incrementSucceeded: false },
    ],
    timers: [],
    cdrEvents,
    state: "active",
    createdAt: 1779440042_000,
    tagMap: [{ aTag: "b2bua-to-tag-aleg-9876", bLegId: "b-1", bTag: "bob-to-tag-007" }],
    workerIndex: 0,
    _topology: { pri: "worker-0", bak: "worker-1", gen: 7 },
    messageCount: 250 + (idx % 50),
  }
}

const KIND_BUILDERS: Record<FixtureKind, (idx: number) => Call> = {
  EARLY: earlyCall,
  CONFIRMED_STEADY: confirmedSteadyCall,
  REINVITE_STORM: reinviteStormCall,
  TERMINATING: terminatingCall,
  ABUSE_MALFORMED: abuseMalformedCall,
}

export const buildFixture = (kind: FixtureKind, idx: number): Call => KIND_BUILDERS[kind](idx)
