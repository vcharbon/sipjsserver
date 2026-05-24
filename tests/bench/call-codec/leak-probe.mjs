// Leak detection: 1M pack/unpack cycles, GC every 10k, print RSS over
// time. Production safety check before adopting msgpackr.
//
// Run: node --expose-gc tests/bench/call-codec/leak-probe.mjs
//
// Pass: RSS plateaus (small variance after warm-up).
// Fail: RSS climbs linearly with iteration count.

import { pack, unpack } from "msgpackr"

// Same shape as the fixture: a-leg + 1 b-leg, ~20 headers, ~900-byte SDP
const sdpBody = new TextEncoder().encode("v=0\no=alice 53655765 2353687637 IN IP4 192.0.2.1\ns=B2BUA\nc=IN IP4 192.0.2.1\nt=0 0\nm=audio 16384 RTP/AVP 0 8 96\na=rtpmap:0 PCMU/8000\na=rtpmap:8 PCMA/8000\na=rtpmap:96 opus/48000/2\na=fmtp:96 useinbandfec=1\na=sendrecv\na=rtcp-mux\na=ice-ufrag:F4Tr\na=ice-pwd:Xz9aV2W3kqXyzpQRsT0bAg\na=fingerprint:sha-256 12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0\na=setup:actpass\na=candidate:1 1 UDP 2130706431 192.0.2.1 16384 typ host\n".repeat(2))

const headers = Array.from({ length: 20 }, (_, i) => ({
  name: `Header-${i}`,
  value: `value-${i}-some-realistic-length-string-here-blah-blah-${i}`,
}))

const call = {
  callRef: "worker-0|call-id-deadbeef-abcdef0123456789@example.com|alice-from-tag-001",
  aLeg: {
    legId: "a", callId: "x", fromTag: "t",
    source: { address: "10.0.0.5", port: 5060 },
    state: "confirmed", disposition: "bridged",
    dialogs: [{
      sip: { callId: "x", localTag: "lt", remoteTag: "rt", localUri: "sip:u@e", remoteUri: "sip:v@e", remoteTarget: "sip:t@e", localCSeq: 8005, routeSet: ["<sip:r1;lr>", "<sip:r2;lr>", "<sip:r3;lr>"] },
      ext: { remoteCSeq: 8006, inboundPendingRequests: [], ackBranch: "z9hG4bK-1234" },
    }],
  },
  bLegs: [{
    legId: "b-1", callId: "y", fromTag: "u",
    source: { address: "203.0.113.42", port: 5060 },
    state: "confirmed", disposition: "bridged",
    dialogs: [{
      sip: { callId: "y", localTag: "lt2", remoteTag: "rt2", localUri: "sip:u@e", remoteUri: "sip:v@e", remoteTarget: "sip:t@e", localCSeq: 4002, routeSet: ["<sip:r1;lr>"] },
      ext: { remoteCSeq: 4003, inboundPendingRequests: [], cachedSdp: sdpBody },
    }],
  }],
  activePeer: { legA: "a", legB: "b-1" },
  aLegInvite: { uri: "sip:bob@example.com", headers, body: sdpBody },
  limiterEntries: [{ limiterId: "x", limit: 5, originWindow: 1779440000, incrementSucceeded: true }],
  timers: [{ id: "t1", type: "no_answer", fireAt: 1779440045_000, legId: "a" }],
  cdrEvents: [{ type: "invite_received", timestamp: 1779440042_000, legId: "a" }],
  state: "active", createdAt: 1779440042_000,
  tagMap: [{ aTag: "a1", bLegId: "b-1", bTag: "b1" }],
  _topology: { pri: "worker-0", bak: "worker-1", gen: 3 },
}

const TOTAL = 1_000_000
const CHECKPOINT = 50_000
const mb = (n) => (n / 1_048_576).toFixed(1)

console.log("== msgpackr 1M pack+unpack leak probe ==")
console.log(`iterations=${TOTAL}  checkpoint every ${CHECKPOINT}`)
console.log(`payload size (single pack): ${pack(call).length} bytes`)
console.log()
console.log("iter             rss      heap   external   arrayBuf   elapsed_s")
console.log("─".repeat(72))

const start = Date.now()
let prevRss = 0
const samples = []

global.gc(); global.gc()
const baseline = process.memoryUsage()
samples.push({ iter: 0, rss: baseline.rss, heap: baseline.heapUsed, external: baseline.external, ab: baseline.arrayBuffers })

for (let i = 1; i <= TOTAL; i++) {
  const buf = pack(call)
  const _ = unpack(buf)
  if (i % CHECKPOINT === 0) {
    global.gc()
    const m = process.memoryUsage()
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    const delta = prevRss === 0 ? 0 : (m.rss - prevRss) / 1_048_576
    console.log(
      `${String(i).padStart(8)}  ${mb(m.rss).padStart(8)}  ${mb(m.heapUsed).padStart(8)}  ${mb(m.external).padStart(9)}  ${mb(m.arrayBuffers).padStart(9)}  ${elapsed.padStart(10)}  (${delta >= 0 ? "+" : ""}${delta.toFixed(1)} MB)`
    )
    samples.push({ iter: i, rss: m.rss, heap: m.heapUsed, external: m.external, ab: m.arrayBuffers })
    prevRss = m.rss
  }
}

console.log()
console.log("== Analysis ==")
const first = samples[1]
const last = samples[samples.length - 1]
const halfway = samples[Math.floor(samples.length / 2)]

const growthFirstHalf = (halfway.rss - first.rss) / 1_048_576
const growthSecondHalf = (last.rss - halfway.rss) / 1_048_576

console.log(`first checkpoint  (${first.iter}): rss=${mb(first.rss)} MB`)
console.log(`half             (${halfway.iter}): rss=${mb(halfway.rss)} MB  (Δ first-half: ${growthFirstHalf >= 0 ? "+" : ""}${growthFirstHalf.toFixed(1)} MB)`)
console.log(`last             (${last.iter}): rss=${mb(last.rss)} MB  (Δ second-half: ${growthSecondHalf >= 0 ? "+" : ""}${growthSecondHalf.toFixed(1)} MB)`)
console.log()

const VERDICT_THRESHOLD_MB = 10
if (Math.abs(growthSecondHalf) < VERDICT_THRESHOLD_MB) {
  console.log(`VERDICT: PLATEAU — RSS stable in second half (|Δ| < ${VERDICT_THRESHOLD_MB} MB). No leak.`)
} else if (growthSecondHalf > VERDICT_THRESHOLD_MB) {
  console.log(`VERDICT: GROWING — RSS climbed ${growthSecondHalf.toFixed(1)} MB in second half. INVESTIGATE.`)
} else {
  console.log(`VERDICT: SHRINKING — RSS dropped ${growthSecondHalf.toFixed(1)} MB. Unusual but not a leak.`)
}
