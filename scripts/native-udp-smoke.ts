/**
 * Smoke-test the NativeSignalingNetwork layer end-to-end:
 *   bindUdp → external dgram send → messages stream → packet.parsed is set
 */

import { Effect, Stream } from "effect"
import * as dgram from "node:dgram"
import { SignalingNetwork, type UdpPacket } from "../src/sip/SignalingNetwork.js"
import { NativeSignalingNetwork } from "../src/sip/NativeSignalingNetwork.js"

const program = Effect.gen(function* () {
  const network = yield* SignalingNetwork
  const endpoint = yield* network.bindUdp({
    ip: "127.0.0.1",
    port: 0,
    queueMax: 100,
  })

  console.log("native bind:", endpoint.localAddress)

  const client = dgram.createSocket("udp4")
  const msg = [
    "INVITE sip:bob@example.com SIP/2.0",
    "Via: SIP/2.0/UDP pc.example.com;branch=z9hG4bK776asdhds",
    "From: Alice <sip:alice@example.com>;tag=1928301774",
    "To: Bob <sip:bob@example.com>",
    "Call-ID: smoke-test-call-id@example.com",
    "CSeq: 1 INVITE",
    "Max-Forwards: 70",
    "Contact: <sip:alice@pc.example.com>",
    "Content-Length: 0",
    "",
    "",
  ].join("\r\n")
  client.send(Buffer.from(msg), endpoint.localAddress.port, "127.0.0.1")

  const headOpt = yield* Stream.take(endpoint.messages, 1).pipe(
    Stream.runHead,
    Effect.timeout("3 seconds"),
  )

  if (headOpt._tag !== "Some") {
    console.log("FAIL: no packet received")
    client.close()
    return
  }
  const p: UdpPacket = headOpt.value
  console.log("packet.raw bytes:", p.raw.length)
  console.log("packet.rinfo:", p.rinfo)
  console.log("packet.parsed defined?", p.parsed !== undefined)
  if (p.parsed !== undefined && p.parsed.type === "request") {
    console.log("  method:", p.parsed.method)
    console.log("  uri:", p.parsed.uri)
    console.log("  from.tag:", p.parsed.getHeader("from").tag)
    console.log("  to.uri:", p.parsed.getHeader("to").uri)
    console.log("  via[0].branch:", p.parsed.getHeader("via")[0].branch)
  }
  console.log("endpoint.counters:", endpoint.counters)

  client.close()
  console.log("PASS — native stack delivered pre-parsed SipMessage")
})

Effect.runPromise(
  Effect.scoped(program).pipe(Effect.provide(NativeSignalingNetwork.layer)),
).then(() => process.exit(0)).catch((err) => {
  console.error("FAIL:", err)
  process.exit(1)
})
