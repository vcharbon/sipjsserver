/**
 * Slice E1 of the decode-forward-respawn-bye-481 fix — proxy honours
 * per-worker readiness on `decode_forward`.
 *
 * Topology:
 *   - Workers A and B, both initially alive.
 *   - INVITE → A (Call-ID is chosen so HRW pins to A; second-best is B).
 *   - 200 OK round-trips so Alice owns the v2 RR cookie carrying
 *     {w_pri=A, w_bak=B}.
 *
 * The matrix this exercises:
 *   - Control: A.health = "alive" → BYE arrives at A (decode_forward).
 *   - Failure mode being fixed: A.health = "not-ready" (the OPTIONS-503
 *     reply with Reason "not-ready (boot drain)" — see HealthProbe).
 *     The proxy MUST promote `decode_forward → decode_forward_backup`
 *     and deliver the BYE to B, which holds the bak: copy.
 *
 * Both branches live in one file so the matrix is obvious. K8s pre-fix
 * behaviour (Endpoints+OPTIONS gates work, but decode_forward bypasses
 * them) is what made the proxy-drain test fail ~40% of the time; this
 * test reproduces that bypass deterministically without standing up
 * kind.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { customParser } from "../../../src/sip/parsers/custom/index.js"
import {
  ProxyCore,
  rendezvousSelect,
  WorkerId,
} from "../../../src/sip-front-proxy/index.js"
import { proxyFakeStack, pumpFor } from "../../support/proxy-fakeStack.js"

const PROXY = { host: "10.0.0.1", port: 5060 }
const ALICE = { host: "10.0.0.2", port: 5060 }
const W_A = WorkerId("worker-a")
const W_B = WorkerId("worker-b")
const ADDR_A = { host: "10.0.1.10", port: 5060 }
const ADDR_B = { host: "10.0.1.11", port: 5060 }
const TRANSIT_MS = 1

const parse = (raw: Buffer) => {
  const r = customParser.parse(raw)
  if (r._tag !== "Success") throw new Error(`parse failure: ${r.failure.reason}`)
  return r.success
}

/** Find a Call-ID whose HRW winner is A (so backup is deterministically B). */
const findCallIdMappingTo = (target: WorkerId): string => {
  const candidates = [{ id: W_A as string }, { id: W_B as string }]
  for (let i = 0; i < 1000; i++) {
    const cid = `pin-${i}@alice`
    const w = rendezvousSelect(cid, candidates)
    if (w !== undefined && w.id === target) return cid
  }
  throw new Error(`no Call-ID found mapping to ${target}`)
}

describe("sip-front-proxy/load-balancer — decode_forward honours not-ready (Slice E1)", () => {
  // Each it.effect builds its own fx so the BYE in case 2 can't see state
  // leaked from case 1.

  it.effect(
    "control: primary alive → BYE forwarded to A (decode_forward)",
    () => {
      const fx = proxyFakeStack({
        proxyAddr: PROXY,
        workers: [
          { id: W_A, address: ADDR_A, health: "alive" },
          { id: W_B, address: ADDR_B, health: "alive" },
        ],
        transitDelayMs: TRANSIT_MS,
      })
      return Effect.gen(function* () {
        const proxy = yield* ProxyCore
        const callId = findCallIdMappingTo(W_A)

        const alice = yield* fx.bindUac(ALICE)
        const aEp = yield* fx.bindUasFor(W_A)
        const bEp = yield* fx.bindUasFor(W_B)

        // INVITE → A
        const invite = buildInvite(callId)
        yield* alice.send(invite, proxy.localAddress.port, proxy.localAddress.ip)
        yield* pumpFor(TRANSIT_MS)
        const inviteAtA = yield* aEp.poll()
        expect(inviteAtA).not.toBeNull()
        const inviteParsed = parse(inviteAtA!.raw)
        if (inviteParsed.type !== "request") throw new Error("expected request")
        const rr = inviteParsed.headers.find(
          (h) => h.name.toLowerCase() === "record-route"
        )!
        expect(rr.value).toMatch(/;w_pri=worker-a/)
        expect(rr.value).toMatch(/;w_bak=worker-b/)

        // 200 OK back through the proxy
        const ok = build200Ok(callId, inviteParsed.headers, rr.value)
        yield* aEp.send(ok, proxy.localAddress.port, proxy.localAddress.ip)
        yield* pumpFor(TRANSIT_MS)
        yield* alice.poll() // drain

        // BYE — primary still alive → MUST land on A.
        const rrInner = rr.value.replace(/^</, "").replace(/>$/, "")
        const bye = buildBye(callId, rrInner)
        yield* alice.send(bye, proxy.localAddress.port, proxy.localAddress.ip)
        yield* pumpFor(TRANSIT_MS)

        const byeAtA = yield* aEp.poll()
        const byeAtB = yield* bEp.poll()
        expect(byeAtA).not.toBeNull()
        expect(byeAtB).toBeNull()
        const byeParsed = parse(byeAtA!.raw)
        if (byeParsed.type !== "request") throw new Error("expected request")
        expect(byeParsed.method).toBe("BYE")
      }).pipe(Effect.provide(fx.layer))
    }
  )

  it.effect(
    "primary not-ready (mid-ReadyGate) → BYE promoted to backup (decode_forward_backup → B)",
    () => {
      const fx = proxyFakeStack({
        proxyAddr: PROXY,
        workers: [
          { id: W_A, address: ADDR_A, health: "alive" },
          { id: W_B, address: ADDR_B, health: "alive" },
        ],
        transitDelayMs: TRANSIT_MS,
      })
      return Effect.gen(function* () {
        const proxy = yield* ProxyCore
        const callId = findCallIdMappingTo(W_A)

        const alice = yield* fx.bindUac(ALICE)
        const aEp = yield* fx.bindUasFor(W_A)
        const bEp = yield* fx.bindUasFor(W_B)

        // Establish call on A (cookie {w_pri=A, w_bak=B}).
        const invite = buildInvite(callId)
        yield* alice.send(invite, proxy.localAddress.port, proxy.localAddress.ip)
        yield* pumpFor(TRANSIT_MS)
        const inviteAtA = yield* aEp.poll()
        const inviteParsed = parse(inviteAtA!.raw)
        if (inviteParsed.type !== "request") throw new Error("expected request")
        const rr = inviteParsed.headers.find(
          (h) => h.name.toLowerCase() === "record-route"
        )!

        const ok = build200Ok(callId, inviteParsed.headers, rr.value)
        yield* aEp.send(ok, proxy.localAddress.port, proxy.localAddress.ip)
        yield* pumpFor(TRANSIT_MS)
        yield* alice.poll() // drain

        // Simulate respawn-mid-ReadyGate: A is NOT-READY. Equivalent to
        // OPTIONS keepalive returning 503 + Reason "not-ready (boot drain)".
        yield* fx.setWorkerHealth(W_A, "not-ready")

        // BYE traverses the proxy.
        const rrInner = rr.value.replace(/^</, "").replace(/>$/, "")
        const bye = buildBye(callId, rrInner)
        yield* alice.send(bye, proxy.localAddress.port, proxy.localAddress.ip)
        yield* pumpFor(TRANSIT_MS)

        // No 503/403 to Alice — the promotion is silent on the wire.
        const aliceReply = yield* alice.poll()
        expect(aliceReply).toBeNull()

        // BYE landed on B (cookie's w_bak), NOT on the not-ready primary A.
        const byeAtA = yield* aEp.poll()
        const byeAtB = yield* bEp.poll()
        expect(byeAtA).toBeNull()
        expect(byeAtB).not.toBeNull()
        const byeParsed = parse(byeAtB!.raw)
        if (byeParsed.type !== "request") throw new Error("expected request")
        expect(byeParsed.method).toBe("BYE")
      }).pipe(Effect.provide(fx.layer))
    }
  )

  it.effect(
    "ACK on a not-ready primary follows w_bak fallback (slice 4 fix)",
    () => {
      // Slice 4 bug fix: when the primary is `not-ready` (e.g. a respawn
      // mid-ReadyGate), ACK no longer pins to that primary — the worker
      // can't complete a transaction it never received the INVITE for, so
      // routing the ACK to it would 481-storm. Instead we fall through to
      // `w_bak` along with every other in-dialog method.
      const fx = proxyFakeStack({
        proxyAddr: PROXY,
        workers: [
          { id: W_A, address: ADDR_A, health: "alive" },
          { id: W_B, address: ADDR_B, health: "alive" },
        ],
        transitDelayMs: TRANSIT_MS,
      })
      return Effect.gen(function* () {
        const proxy = yield* ProxyCore
        const callId = findCallIdMappingTo(W_A)

        const alice = yield* fx.bindUac(ALICE)
        const aEp = yield* fx.bindUasFor(W_A)
        const bEp = yield* fx.bindUasFor(W_B)

        const invite = buildInvite(callId)
        yield* alice.send(invite, proxy.localAddress.port, proxy.localAddress.ip)
        yield* pumpFor(TRANSIT_MS)
        const inviteAtA = yield* aEp.poll()
        const inviteParsed = parse(inviteAtA!.raw)
        if (inviteParsed.type !== "request") throw new Error("expected request")
        const rr = inviteParsed.headers.find(
          (h) => h.name.toLowerCase() === "record-route"
        )!

        const ok = build200Ok(callId, inviteParsed.headers, rr.value)
        yield* aEp.send(ok, proxy.localAddress.port, proxy.localAddress.ip)
        yield* pumpFor(TRANSIT_MS)
        yield* alice.poll()

        yield* fx.setWorkerHealth(W_A, "not-ready")

        const rrInner = rr.value.replace(/^</, "").replace(/>$/, "")
        const ack = buildAck(callId, rrInner)
        yield* alice.send(ack, proxy.localAddress.port, proxy.localAddress.ip)
        yield* pumpFor(TRANSIT_MS)

        // ACK lands on alive backup B, NOT on the not-ready primary.
        const ackAtA = yield* aEp.poll()
        const ackAtB = yield* bEp.poll()
        expect(ackAtA).toBeNull()
        expect(ackAtB).not.toBeNull()
        const ackParsed = parse(ackAtB!.raw)
        if (ackParsed.type !== "request") throw new Error("expected request")
        expect(ackParsed.method).toBe("ACK")
      }).pipe(Effect.provide(fx.layer))
    }
  )
})

// ---------------------------------------------------------------------------
// Local message builders — kept inline so the test file is self-contained.
// ---------------------------------------------------------------------------

const buildInvite = (callId: string): Buffer =>
  Buffer.from(
    [
      `INVITE sip:user@example.com SIP/2.0`,
      `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-alice-inv;rport`,
      `Max-Forwards: 70`,
      `From: <sip:alice@${ALICE.host}>;tag=t-alice`,
      `To: <sip:user@example.com>`,
      `Call-ID: ${callId}`,
      `CSeq: 1 INVITE`,
      `Contact: <sip:alice@${ALICE.host}:${ALICE.port}>`,
      `Content-Length: 0`,
      ``,
      ``,
    ].join("\r\n"),
    "utf-8"
  )

const build200Ok = (
  callId: string,
  inviteHeaders: ReadonlyArray<{ name: string; value: string }>,
  rrValue: string
): Buffer =>
  Buffer.from(
    [
      `SIP/2.0 200 OK`,
      ...inviteHeaders
        .filter((h) => h.name.toLowerCase() === "via")
        .map((h) => `Via: ${h.value}`),
      `Record-Route: ${rrValue}`,
      `From: <sip:alice@${ALICE.host}>;tag=t-alice`,
      `To: <sip:user@example.com>;tag=t-b`,
      `Call-ID: ${callId}`,
      `CSeq: 1 INVITE`,
      `Contact: <sip:user@${ADDR_A.host}:${ADDR_A.port}>`,
      `Content-Length: 0`,
      ``,
      ``,
    ].join("\r\n"),
    "utf-8"
  )

const buildBye = (callId: string, rrInner: string): Buffer =>
  Buffer.from(
    [
      `BYE sip:user@${ADDR_A.host}:${ADDR_A.port} SIP/2.0`,
      `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-alice-bye;rport`,
      `Route: <${rrInner}>`,
      `Max-Forwards: 70`,
      `From: <sip:alice@${ALICE.host}>;tag=t-alice`,
      `To: <sip:user@example.com>;tag=t-b`,
      `Call-ID: ${callId}`,
      `CSeq: 2 BYE`,
      `Content-Length: 0`,
      ``,
      ``,
    ].join("\r\n"),
    "utf-8"
  )

const buildAck = (callId: string, rrInner: string): Buffer =>
  Buffer.from(
    [
      `ACK sip:user@${ADDR_A.host}:${ADDR_A.port} SIP/2.0`,
      `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-alice-ack;rport`,
      `Route: <${rrInner}>`,
      `Max-Forwards: 70`,
      `From: <sip:alice@${ALICE.host}>;tag=t-alice`,
      `To: <sip:user@example.com>;tag=t-b`,
      `Call-ID: ${callId}`,
      `CSeq: 1 ACK`,
      `Content-Length: 0`,
      ``,
      ``,
    ].join("\r\n"),
    "utf-8"
  )
