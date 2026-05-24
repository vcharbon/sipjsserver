// Probe: does msgpackr actually retain memory, or is the bench's RSS Δ
// just a high-water artifact of running 20k pack/unpack with no GC between?
//
// Run with `node --expose-gc /tmp/rss-probe.mjs`.

import { pack, unpack } from "msgpackr"

const fixture = JSON.parse(JSON.stringify({
  callRef: "call-1",
  aLeg: { legId: "a", callId: "x", fromTag: "t", source: { address: "1.2.3.4", port: 5060 }, state: "confirmed", disposition: "bridged", dialogs: [] },
  bLegs: [{ legId: "b-1", callId: "y", fromTag: "u", source: { address: "5.6.7.8", port: 5060 }, state: "confirmed", disposition: "bridged", dialogs: [] }],
  body: Buffer.alloc(1024).toString("base64").repeat(8), // ~10 KB filler to make it realistic
  cdrEvents: Array.from({length: 5}, (_, i) => ({ type: "answer", timestamp: i, legId: "a" })),
}))

const mb = (n) => (n / 1_048_576).toFixed(1)
const sample = (label) => {
  global.gc(); global.gc(); global.gc()
  const m = process.memoryUsage()
  console.log(`${label.padEnd(28)} rss=${mb(m.rss)} MB  heap=${mb(m.heapUsed)} MB  external=${mb(m.external)} MB  arrayBuffers=${mb(m.arrayBuffers)} MB`)
}

sample("baseline")

// One pack, hold the buffer
const onePacked = pack(fixture)
sample("after 1 pack (buf kept)")
console.log(`  one pack size: ${onePacked.length} bytes\n`)

// 20k packs, throw away each buffer
for (let i = 0; i < 20_000; i++) {
  pack(fixture)
}
sample("after 20k packs (discarded)")

// 20k packs, keep all buffers
const bufs = []
for (let i = 0; i < 20_000; i++) bufs.push(pack(fixture))
sample("after 20k packs (kept)")
console.log(`  total bytes held: ${mb(bufs.reduce((a, b) => a + b.length, 0))} MB`)

// Free them
bufs.length = 0
sample("after release + GC")

// 20k unpack
const buf = pack(fixture)
for (let i = 0; i < 20_000; i++) unpack(buf)
sample("after 20k unpacks (discarded)")

// 20k unpack, keep refs
const objs = []
for (let i = 0; i < 20_000; i++) objs.push(unpack(buf))
sample("after 20k unpacks (kept)")

objs.length = 0
sample("final after release + GC")
