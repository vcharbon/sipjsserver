/**
 * PR3b — HMAC tampering on the stickiness cookie must produce a 403.
 *
 * Flow:
 *   1. INVITE Alice → Proxy(LoadBalancer) → Worker A. The proxy stamps a
 *      Record-Route with `;w_pri=<id>;w_bak=<id>;v=2;kid=<kid>;sig=<base64url>`.
 *   2. We extract the Record-Route from the INVITE that arrived at A,
 *      mint a 200 OK with that RR mirrored back, and route it through
 *      the proxy → Alice (so Alice "knows" the route set).
 *   3. Alice sends a BYE with `Route: <…proxy uri…>` BUT with a single
 *      bit flipped in the `sig` param.
 *   4. The proxy sees the Route on top, recognises itself, strips it,
 *      hands the params to `decodeStickiness` → reject 403. The proxy
 *      emits a 403 back to Alice.
 *
 * Verifies RFC 3261 §16.4 routing pre-processing + the strategy-side
 * `DecodeResult.reject` path.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { customParser } from "../../../src/sip/parsers/custom/index.js"
import { ProxyCore, WorkerId } from "../../../src/sip-front-proxy/index.js"
import { proxyFakeStack, pumpFor } from "../../support/proxy-fakeStack.js"
import { runProxyScenario } from "../_report/runner.js"

const PROXY = { host: "10.0.0.1", port: 5060 }
const ALICE = { host: "10.0.0.2", port: 5060 }
const W_A = WorkerId("worker-a")
const ADDR_A = { host: "10.0.1.10", port: 5060 }
const TRANSIT_MS = 1

const fx = proxyFakeStack({
  proxyAddr: PROXY,
  workers: [{ id: W_A, address: ADDR_A, health: "alive" }],
  transitDelayMs: TRANSIT_MS,
})

const parse = (raw: Buffer) => {
  const r = customParser.parse(raw)
  if (r._tag !== "Success") throw new Error(`parse failure: ${r.failure.reason}`)
  return r.success
}

/** Flip one base64url char inside the `sig=…` param of a Route URI string. */
const tamperSig = (rr: string): string => {
  const m = /sig=([A-Za-z0-9_-]+)/.exec(rr)
  if (m === null) throw new Error(`no sig in ${rr}`)
  const orig = m[1]!
  // Replace the first char with a different valid base64url char so the
  // length stays the same (preserves the 16-byte truncated MAC budget).
  const flipped = (orig[0] === "A" ? "B" : "A") + orig.slice(1)
  return rr.replace(`sig=${orig}`, `sig=${flipped}`)
}

describe("sip-front-proxy/load-balancer — HMAC tampering rejected", () => {
  it.effect("BYE with flipped sig is rejected with 403", () =>
    runProxyScenario(
      {
        name: "load-balancer.hmac-tampering-rejected",
        description:
          "INVITE through proxy stamps RR with HMAC stickiness cookie; round-trip 200\n" +
          "OK to Alice; Alice sends BYE with one bit of `sig=` flipped. Proxy must\n" +
          "reject with 403 — BYE never reaches the worker (RFC 3261 §16.4 +\n" +
          "decodeStickiness reject path).",
      },
      Effect.gen(function* () {
      const proxy = yield* ProxyCore
      const alice = yield* fx.bindNamedUac("alice", ALICE)
      const aEp = yield* fx.bindNamedUasFor("worker-a", W_A)

      const callId = "tamper-call@alice"

      // ── 1. INVITE → A ────────────────────────────────────────────────
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
      const inviteAtAParsed = parse(inviteAtA!.raw)
      if (inviteAtAParsed.type !== "request") throw new Error("expected request")
      const rrHeader = inviteAtAParsed.headers.find(
        (h) => h.name.toLowerCase() === "record-route"
      )
      expect(rrHeader).toBeDefined()
      // sanity: RR carries the v3 cookie (slice 7 of overload rework
      // added the `e=<0|1>` emergency flag and bumped to v=3).
      expect(rrHeader!.value).toMatch(/sig=/)
      expect(rrHeader!.value).toMatch(/kid=/)
      expect(rrHeader!.value).toMatch(/;w_pri=/)
      expect(rrHeader!.value).toMatch(/;w_bak=/)
      expect(rrHeader!.value).toMatch(/;e=0/)
      expect(rrHeader!.value).toMatch(/v=3/)

      // ── 2. 200 OK back through the proxy → Alice ─────────────────────
      const ok = Buffer.from(
        [
          `SIP/2.0 200 OK`,
          ...inviteAtAParsed.headers
            .filter((h) => h.name.toLowerCase() === "via")
            .map((h) => `Via: ${h.value}`),
          `Record-Route: ${rrHeader!.value}`,
          `From: <sip:alice@${ALICE.host}>;tag=t-alice`,
          `To: <sip:user@example.com>;tag=t-bob`,
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

      // ── 3. BYE with TAMPERED sig ─────────────────────────────────────
      // The Route value mirrors the proxy's RR URI but with a single byte
      // of `sig=` replaced. Strip the angle brackets to keep just the URI
      // pattern then reapply for the final header.
      const rrInner = rrHeader!.value.replace(/^</, "").replace(/>$/, "")
      const tamperedRouteValue = `<${tamperSig(rrInner)}>`

      const bye = Buffer.from(
        [
          `BYE sip:user@${ADDR_A.host}:${ADDR_A.port} SIP/2.0`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-alice-bye;rport`,
          `Route: ${tamperedRouteValue}`,
          `Max-Forwards: 70`,
          `From: <sip:alice@${ALICE.host}>;tag=t-alice`,
          `To: <sip:user@example.com>;tag=t-bob`,
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

      // ── 4. Proxy must respond 403 — BYE must NOT reach A ─────────────
      const reply = yield* alice.poll()
      expect(reply).not.toBeNull()
      const replyParsed = parse(reply!.raw)
      if (replyParsed.type !== "response") throw new Error("expected response")
      expect(replyParsed.status).toBe(403)
      const byeAtA = yield* aEp.poll()
      expect(byeAtA).toBeNull()
      })
    ).pipe(Effect.provide(fx.layer))
  )
})
