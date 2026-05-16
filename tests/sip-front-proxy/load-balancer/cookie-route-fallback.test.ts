/**
 * D8 of the HA-resilience plan — when the cookie's `w_pri` is dead, the
 * proxy MUST route the in-dialog request to the cookie's `w_bak` (the
 * backup ordinal stamped at INVITE time as second-best HRW), not via a
 * fresh HRW pick that could land on a worker with neither primary nor
 * backup state.
 *
 * Topology:
 *   - Workers A and B, both initially alive.
 *   - INVITE → A (Call-ID is chosen so HRW pins to A; second-best is B).
 *   - 200 OK round-trips so Alice has the Record-Route cookie.
 *   - A is flipped to `dead`.
 *   - BYE with the cookie's RR as a Route → proxy decodes, sees `w_pri=A`
 *     dead, sees `w_bak=B` alive → `forwardBackup(B)`. BYE arrives at B,
 *     never at A.
 *
 * Distinct from `unresolvable-id-falls-back.test.ts`, which exercises the
 * "primary removed entirely" path. Here the primary is still in the
 * registry (with state stamped on it) but reports `dead`, which is the
 * realistic K8s-pod-watch outcome on node failure.
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
import { runProxyScenario } from "../_report/runner.js"

const PROXY = { host: "10.0.0.1", port: 5060 }
const ALICE = { host: "10.0.0.2", port: 5060 }
const W_A = WorkerId("worker-a")
const W_B = WorkerId("worker-b")
const ADDR_A = { host: "10.0.1.10", port: 5060 }
const ADDR_B = { host: "10.0.1.11", port: 5060 }
const TRANSIT_MS = 1

const fx = proxyFakeStack({
  proxyAddr: PROXY,
  workers: [
    { id: W_A, address: ADDR_A, health: "alive" },
    { id: W_B, address: ADDR_B, health: "alive" },
  ],
  transitDelayMs: TRANSIT_MS,
})

const parse = (raw: Buffer) => {
  const r = customParser.parse(raw)
  if (r._tag !== "Success") throw new Error(`parse failure: ${r.failure.reason}`)
  return r.success
}

/** Find a Call-ID whose HRW winner is A (so backup will deterministically be B). */
const findCallIdMappingTo = (target: WorkerId): string => {
  const candidates = [{ id: W_A as string }, { id: W_B as string }]
  for (let i = 0; i < 1000; i++) {
    const cid = `pin-${i}@alice`
    const w = rendezvousSelect(cid, candidates)
    if (w !== undefined && w.id === target) return cid
  }
  throw new Error(`no Call-ID found mapping to ${target}`)
}

describe("sip-front-proxy/load-balancer — cookie route fallback to w_bak", () => {
  it.effect(
    "in-dialog BYE after primary is marked dead routes to cookie's w_bak (forwardBackup)",
    () =>
      runProxyScenario(
        {
          name: "load-balancer.cookie-route-fallback",
          description:
            "INVITE pinned to A round-trips so Alice owns the v2 RR cookie carrying\n" +
            "{w_pri=A, w_bak=B}. A is then flipped to `dead`. In-dialog BYE arrives\n" +
            "at B (cookie's named backup) — proves D8: dead primary deterministically\n" +
            "routes to w_bak, not via fresh HRW.",
        },
        Effect.gen(function* () {
          const proxy = yield* ProxyCore
          const callId = findCallIdMappingTo(W_A)

          const alice = yield* fx.bindNamedUac("alice", ALICE)
          const aEp = yield* fx.bindNamedUasFor("worker-a", W_A)
          const bEp = yield* fx.bindNamedUasFor("worker-b", W_B)

          // ── 1. INVITE → A ────────────────────────────────────────────
          const invite = Buffer.from(
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
          yield* alice.send(invite, proxy.localAddress.port, proxy.localAddress.ip)
          yield* pumpFor(TRANSIT_MS)

          const inviteAtA = yield* aEp.poll()
          expect(inviteAtA).not.toBeNull()
          const inviteParsed = parse(inviteAtA!.raw)
          if (inviteParsed.type !== "request") throw new Error("expected request")
          const rr = inviteParsed.headers.find(
            (h) => h.name.toLowerCase() === "record-route"
          )!
          expect(rr).toBeDefined()
          // Sanity: the v3 cookie carries both ordinals + emergency flag.
          expect(rr.value).toMatch(/;w_pri=worker-a/)
          expect(rr.value).toMatch(/;w_bak=worker-b/)
          expect(rr.value).toMatch(/;e=0/)
          expect(rr.value).toMatch(/v=3/)

          // ── 2. 200 OK back through the proxy → Alice ─────────────────
          const ok = Buffer.from(
            [
              `SIP/2.0 200 OK`,
              ...inviteParsed.headers
                .filter((h) => h.name.toLowerCase() === "via")
                .map((h) => `Via: ${h.value}`),
              `Record-Route: ${rr.value}`,
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
          yield* aEp.send(ok, proxy.localAddress.port, proxy.localAddress.ip)
          yield* pumpFor(TRANSIT_MS)
          const okAtAlice = yield* alice.poll()
          expect(okAtAlice).not.toBeNull()

          // ── 3. Mark A dead (registry entry preserved, only health flips) ─
          yield* fx.setWorkerHealth(W_A, "dead")

          // ── 4. BYE with intact RR cookie → must land on B ────────────
          const rrInner = rr.value.replace(/^</, "").replace(/>$/, "")
          const bye = Buffer.from(
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
          yield* alice.send(bye, proxy.localAddress.port, proxy.localAddress.ip)
          yield* pumpFor(TRANSIT_MS)

          // No 403 / 503 to Alice.
          const aliceReply = yield* alice.poll()
          expect(aliceReply).toBeNull()

          // BYE arrived at B (the named backup), NOT at A (dead primary).
          const byeAtB = yield* bEp.poll()
          expect(byeAtB).not.toBeNull()
          const byeAtA = yield* aEp.poll()
          expect(byeAtA).toBeNull()
          const byeParsed = parse(byeAtB!.raw)
          if (byeParsed.type !== "request") throw new Error("expected request")
          expect(byeParsed.method).toBe("BYE")
        })
      ).pipe(Effect.provide(fx.layer))
  )

  it.effect(
    "ACK on a dead primary follows the same w_bak fallback as other in-dialog requests",
    () =>
      runProxyScenario(
        {
          name: "load-balancer.cookie-ack-fallback-on-death",
          description:
            "Slice 4 bug fix: when the cookie's primary is dead, ACK must route to\n" +
            "the cookie's `w_bak` along with every other in-dialog method. After\n" +
            "failover the backup served the most recent (re-)INVITE so it owns the\n" +
            "transaction the ACK is acknowledging. The earlier behaviour (ACK pinned\n" +
            "to the dead primary) caused 5s ACK timeouts in re-INVITE-after-failover\n" +
            "scenarios because the ACK never reached the backup that 200'd the\n" +
            "re-INVITE.",
        },
        Effect.gen(function* () {
          const proxy = yield* ProxyCore
          const callId = findCallIdMappingTo(W_A)

          const alice = yield* fx.bindNamedUac("alice", ALICE)
          const aEp = yield* fx.bindNamedUasFor("worker-a", W_A)
          const bEp = yield* fx.bindNamedUasFor("worker-b", W_B)

          // INVITE → A → 200 OK round-trip (same setup as above).
          const invite = Buffer.from(
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
          yield* alice.send(invite, proxy.localAddress.port, proxy.localAddress.ip)
          yield* pumpFor(TRANSIT_MS)
          const inviteAtA = yield* aEp.poll()
          const inviteParsed = parse(inviteAtA!.raw)
          if (inviteParsed.type !== "request") throw new Error("expected request")
          const rr = inviteParsed.headers.find(
            (h) => h.name.toLowerCase() === "record-route"
          )!

          const ok = Buffer.from(
            [
              `SIP/2.0 200 OK`,
              ...inviteParsed.headers
                .filter((h) => h.name.toLowerCase() === "via")
                .map((h) => `Via: ${h.value}`),
              `Record-Route: ${rr.value}`,
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
          yield* aEp.send(ok, proxy.localAddress.port, proxy.localAddress.ip)
          yield* pumpFor(TRANSIT_MS)
          yield* alice.poll()

          // Flip A to dead, then ACK.
          yield* fx.setWorkerHealth(W_A, "dead")

          const rrInner = rr.value.replace(/^</, "").replace(/>$/, "")
          const ack = Buffer.from(
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
          yield* alice.send(ack, proxy.localAddress.port, proxy.localAddress.ip)
          yield* pumpFor(TRANSIT_MS)

          // ACK lands on the alive backup, NOT on the dead primary.
          const ackAtA = yield* aEp.poll()
          const ackAtB = yield* bEp.poll()
          expect(ackAtA).toBeNull()
          expect(ackAtB).not.toBeNull()
          const ackParsed = parse(ackAtB!.raw)
          if (ackParsed.type !== "request") throw new Error("expected request")
          expect(ackParsed.method).toBe("ACK")
        })
      ).pipe(Effect.provide(fx.layer))
  )
})
