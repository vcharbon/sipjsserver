/**
 * Direct `it.effect` test for non-record-routing registrar mode under
 * fake clock + simulated fabric. Not routed through the SUT harness
 * (`runOn(...)`): wires `registrarFrontProxyFakeStackLayer({
 * recordRoute: false })` and drives the full alice ↔ bob lifecycle
 * with hand-built SIP messages, then asserts the proxy is structurally
 * absent from the in-dialog ACK and BYE.
 *
 * Topology (mirrors `core-call-to-registered-ext`):
 *   - bobExt   on 10.30.0.x (ext subnet) — REGISTERs with the proxy
 *   - aliceCore on 10.40.0.x (core subnet) — stand-in K8s app server
 *
 * Proxy(core) receives aliceCore's INVITE for `sip:bob@<CORE_INGRESS>`,
 * looks up bob in the in-memory registrar, forwards to bobExt without
 * inserting Record-Route. Both Contacts (bob's, alice's) are then
 * routable on the same simulated fabric so ACK and BYE flow
 * peer-to-peer.
 *
 * Invariant under test: `Record-Route` is NOT inserted on the INVITE
 * the proxy hands to bob, and the in-dialog ACK + BYE arrive at bob
 * with a source address that matches alice (not the proxy's ext
 * ingress).
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import {
  CORE_INGRESS,
  EXT_INGRESS,
  coreIp,
  extIp,
  registrarFrontProxyFakeStackLayer,
} from "../support/registrarFrontProxyFakeStack.js"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import { ProxyCore } from "../../src/sip-front-proxy/index.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"

const BOB_IP = extIp(2)
const BOB_PORT = 16062
const ALICE_IP = coreIp(1)
const ALICE_PORT = 16040

const CRLF = "\r\n"
const join = (lines: ReadonlyArray<string>): Buffer =>
  Buffer.from(lines.join(CRLF) + CRLF + CRLF, "ascii")

const buildRegister = (cseq: number): Buffer =>
  join([
    `REGISTER sip:${EXT_INGRESS.host}:${EXT_INGRESS.port} SIP/2.0`,
    `Via: SIP/2.0/UDP ${BOB_IP}:${BOB_PORT};branch=z9hG4bK-bob-reg-${cseq};rport`,
    `Max-Forwards: 70`,
    `From: <sip:bob@example.test>;tag=bob-reg-tag`,
    `To: <sip:bob@example.test>`,
    `Call-ID: bob-register@example.test`,
    `CSeq: ${cseq} REGISTER`,
    `Contact: <sip:bob@${BOB_IP}:${BOB_PORT}>`,
    `Expires: 3600`,
    `Content-Length: 0`,
  ])

const CALL_ID = "norr-call-1@alice.k8s.test"
const ALICE_TAG = "alice-tag-1"
const FROM_HDR = `<sip:alice@k8s.example.test>;tag=${ALICE_TAG}`
const TO_HDR = `<sip:bob@${CORE_INGRESS.host}:${CORE_INGRESS.port}>`
const RURI = `sip:bob@${CORE_INGRESS.host}:${CORE_INGRESS.port}`

const buildInvite = (): Buffer =>
  join([
    `INVITE ${RURI} SIP/2.0`,
    `Via: SIP/2.0/UDP ${ALICE_IP}:${ALICE_PORT};branch=z9hG4bK-invite-1;rport`,
    `Max-Forwards: 70`,
    `From: ${FROM_HDR}`,
    `To: ${TO_HDR}`,
    `Call-ID: ${CALL_ID}`,
    `CSeq: 1 INVITE`,
    `Contact: <sip:alice@${ALICE_IP}:${ALICE_PORT}>`,
    `Content-Length: 0`,
  ])

const parseHeader = (msg: string, name: string): string | undefined => {
  const re = new RegExp(`^${name}\\s*:\\s*(.+)$`, "im")
  const m = msg.match(re)
  return m === null ? undefined : m[1]!.trim()
}

const extractToTag = (msg: string): string => {
  const to = parseHeader(msg, "To") ?? ""
  const m = to.match(/;tag=([^;\s>]+)/)
  return m === null ? "" : m[1]!
}

const buildResponse = (
  status: number,
  reason: string,
  receivedRequest: string,
  bobToTag: string,
): Buffer => {
  // Echo Via stack and core dialog headers from the request; add
  // bob's Contact + To-tag so the route set and remote target propagate
  // through to alice.
  const viaLines: string[] = []
  for (const line of receivedRequest.split(/\r?\n/)) {
    if (/^Via\s*:/i.test(line)) viaLines.push(line)
  }
  const from = parseHeader(receivedRequest, "From") ?? FROM_HDR
  const toRaw = parseHeader(receivedRequest, "To") ?? TO_HDR
  const callId = parseHeader(receivedRequest, "Call-ID") ?? CALL_ID
  const cseq = parseHeader(receivedRequest, "CSeq") ?? "1 INVITE"
  const toWithTag = /;tag=/.test(toRaw)
    ? toRaw
    : `${toRaw};tag=${bobToTag}`
  return join([
    `SIP/2.0 ${status} ${reason}`,
    ...viaLines,
    `From: ${from}`,
    `To: ${toWithTag}`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq}`,
    `Contact: <sip:bob@${BOB_IP}:${BOB_PORT}>`,
    `Content-Length: 0`,
  ])
}

const buildAck = (bobToTag: string): Buffer =>
  join([
    // No Record-Route on the INVITE => no Route header on ACK; goes
    // directly to bob's Contact.
    `ACK sip:bob@${BOB_IP}:${BOB_PORT} SIP/2.0`,
    `Via: SIP/2.0/UDP ${ALICE_IP}:${ALICE_PORT};branch=z9hG4bK-ack-1;rport`,
    `Max-Forwards: 70`,
    `From: ${FROM_HDR}`,
    `To: <sip:bob@${CORE_INGRESS.host}:${CORE_INGRESS.port}>;tag=${bobToTag}`,
    `Call-ID: ${CALL_ID}`,
    `CSeq: 1 ACK`,
    `Content-Length: 0`,
  ])

const buildBye = (bobToTag: string): Buffer =>
  join([
    `BYE sip:bob@${BOB_IP}:${BOB_PORT} SIP/2.0`,
    `Via: SIP/2.0/UDP ${ALICE_IP}:${ALICE_PORT};branch=z9hG4bK-bye-1;rport`,
    `Max-Forwards: 70`,
    `From: ${FROM_HDR}`,
    `To: <sip:bob@${CORE_INGRESS.host}:${CORE_INGRESS.port}>;tag=${bobToTag}`,
    `Call-ID: ${CALL_ID}`,
    `CSeq: 2 BYE`,
    `Content-Length: 0`,
  ])

interface RecvSpy {
  readonly raw: Buffer
  readonly srcIp: string
  readonly srcPort: number
}

const drainInto = <E>(
  ep: { readonly poll: () => Effect.Effect<{ raw: Buffer; rinfo: { address: string; port: number } } | null, E> },
  into: RecvSpy[],
) =>
  Effect.gen(function* () {
    for (;;) {
      const p = yield* ep.poll()
      if (p === null) return
      into.push({ raw: p.raw, srcIp: p.rinfo.address, srcPort: p.rinfo.port })
    }
  })

const pumpAndDrain = (
  endpoints: ReadonlyArray<{
    readonly ep: { readonly poll: () => Effect.Effect<{ raw: Buffer; rinfo: { address: string; port: number } } | null, never> }
    readonly into: RecvSpy[]
  }>,
  steps = 12,
) =>
  Effect.gen(function* () {
    for (let i = 0; i < steps; i++) {
      yield* TestClock.adjust("20 millis")
      yield* Effect.yieldNow
      for (const { ep, into } of endpoints) yield* drainInto(ep, into)
    }
  })

describe("registrar mode: recordRoute=false (non-record-routing)", () => {
  it.effect("INVITE arrives at bob without Record-Route; ACK + BYE bypass the proxy", () =>
    Effect.gen(function* () {
      const network = yield* SignalingNetwork
      yield* ProxyCore

      const alice = yield* network.bindUdp({ ip: ALICE_IP, port: ALICE_PORT, queueMax: 64 })
      const bob = yield* network.bindUdp({ ip: BOB_IP, port: BOB_PORT, queueMax: 64 })

      const aliceInbox: RecvSpy[] = []
      const bobInbox: RecvSpy[] = []
      const endpoints = [
        { ep: alice, into: aliceInbox },
        { ep: bob, into: bobInbox },
      ] as const

      // 1. Bob REGISTERs against the proxy's ext ingress.
      yield* bob.send(buildRegister(1), EXT_INGRESS.port, EXT_INGRESS.host)
      yield* pumpAndDrain(endpoints)
      const reg200 = bobInbox.find((p) => /^SIP\/2\.0 200 /.test(p.raw.toString("ascii")))
      expect(reg200, "bob should receive 200 OK to REGISTER").toBeDefined()
      bobInbox.length = 0

      // 2. Alice (core-side) INVITEs sip:bob@CORE_INGRESS. Proxy's
      //    core→ext lookup resolves "bob" and forwards to bob's Contact.
      yield* alice.send(buildInvite(), CORE_INGRESS.port, CORE_INGRESS.host)
      yield* pumpAndDrain(endpoints)

      const inviteAtBob = bobInbox.find((p) => /^INVITE /.test(p.raw.toString("ascii")))
      expect(inviteAtBob, "bob should receive the forwarded INVITE").toBeDefined()
      const inviteText = inviteAtBob!.raw.toString("ascii")

      // Invariant 1: no Record-Route header was inserted by the proxy.
      expect(
        /^Record-Route\s*:/im.test(inviteText),
        "INVITE forwarded to bob must NOT carry a Record-Route header (recordRoute=false)",
      ).toBe(false)

      // Sanity: the INVITE's R-URI preserves the original from alice
      // (no ruriOverride rewrite).
      expect(inviteText.startsWith(`INVITE ${RURI} SIP/2.0`)).toBe(true)

      // 3. Bob replies 180 and 200 — proxy forwards back via Via stack.
      const bobToTag = "bob-tag-1"
      yield* bob.send(
        buildResponse(180, "Ringing", inviteText, bobToTag),
        inviteAtBob!.srcPort,
        inviteAtBob!.srcIp,
      )
      yield* bob.send(
        buildResponse(200, "OK", inviteText, bobToTag),
        inviteAtBob!.srcPort,
        inviteAtBob!.srcIp,
      )
      yield* pumpAndDrain(endpoints)

      const ok = aliceInbox.find((p) => /^SIP\/2\.0 200 /.test(p.raw.toString("ascii")))
      expect(ok, "alice should receive 200 OK").toBeDefined()
      const okText = ok!.raw.toString("ascii")
      // Confirm: 200 OK contains no Record-Route either.
      expect(/^Record-Route\s*:/im.test(okText)).toBe(false)
      const echoedBobTag = extractToTag(okText)
      expect(echoedBobTag).toBe(bobToTag)
      bobInbox.length = 0

      // 4. Alice ACK. With no Record-Route the in-dialog request must
      //    bypass the proxy entirely — bob receives ACK with src = alice.
      yield* alice.send(buildAck(bobToTag), BOB_PORT, BOB_IP)
      yield* pumpAndDrain(endpoints)
      const ack = bobInbox.find((p) => /^ACK /.test(p.raw.toString("ascii")))
      expect(ack, "bob should receive ACK").toBeDefined()
      expect(
        { srcIp: ack!.srcIp, srcPort: ack!.srcPort },
        "ACK must arrive at bob directly from alice (no proxy hop)",
      ).toEqual({ srcIp: ALICE_IP, srcPort: ALICE_PORT })
      bobInbox.length = 0

      // 5. Alice BYE — same invariant.
      yield* alice.send(buildBye(bobToTag), BOB_PORT, BOB_IP)
      yield* pumpAndDrain(endpoints)
      const bye = bobInbox.find((p) => /^BYE /.test(p.raw.toString("ascii")))
      expect(bye, "bob should receive BYE").toBeDefined()
      expect(
        { srcIp: bye!.srcIp, srcPort: bye!.srcPort },
        "BYE must arrive at bob directly from alice (no proxy hop)",
      ).toEqual({ srcIp: ALICE_IP, srcPort: ALICE_PORT })

      // 6. Bob replies 200 to BYE — direct to alice's Contact.
      yield* bob.send(buildResponse(200, "OK", bye!.raw.toString("ascii"), bobToTag), ALICE_PORT, ALICE_IP)
      yield* pumpAndDrain(endpoints)
      const bye200 = aliceInbox.find((p) => {
        const t = p.raw.toString("ascii")
        return /^SIP\/2\.0 200 /.test(t) && /CSeq:\s*2 BYE/i.test(t)
      })
      expect(bye200, "alice should receive 200 OK to BYE").toBeDefined()
      expect(
        { srcIp: bye200!.srcIp, srcPort: bye200!.srcPort },
        "BYE/200 must arrive at alice directly from bob",
      ).toEqual({ srcIp: BOB_IP, srcPort: BOB_PORT })
    }).pipe(
      Effect.provide(
        registrarFrontProxyFakeStackLayer({
          config: testAppConfigDefaults({
            sipLocalIp: EXT_INGRESS.host,
            sipLocalPort: EXT_INGRESS.port,
          }),
          recordRoute: false,
        }),
      ),
    ),
  )
})
