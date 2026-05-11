/**
 * Transit-only PR2 — CANCEL during ringing.
 *
 * Topology: Alice ─► Proxy(ForwardAll → Bob) ─► Bob
 *
 * Flow exercised:
 *   1. Alice INVITE → Bob (proxy stamps Via, mints branch B_p, remembers
 *      `(B_p → Bob)` in CancelBranchLru).
 *   2. Bob 180 Ringing → Alice (Via stripping per §16.7.3).
 *   3. Alice CANCEL → Proxy. The CANCEL carries the *upstream-side*
 *      branch (Alice's `z9hG4bK-alice-1`) on its top Via, but at the proxy
 *      we look the branch up under the proxy's own perspective: when the
 *      CANCEL arrives, its top Via is Alice's, and after we push our own
 *      Via we mint a fresh branch. We correlate via the existing
 *      `CancelBranchLru` keyed on the branch the proxy chose for the
 *      INVITE so we hit the same Bob.
 *
 * Verifies RFC 3261 §16.10 — CANCEL forwards to the same downstream the
 * matching INVITE went to.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { customParser } from "../../../src/sip/parsers/custom/index.js"
import { CancelBranchLru, ProxyCore } from "../../../src/sip-front-proxy/index.js"
import { proxyOnlyFakeStackLayer } from "../../support/proxy-only-fakeStack.js"
import { bindNamedEndpoint, runProxyScenario } from "../_report/runner.js"

const PROXY = { host: "10.0.0.1", port: 5060 }
const ALICE = { host: "10.0.0.2", port: 5060 }
const BOB = { host: "10.0.0.3", port: 5060 }
const TRANSIT_MS = 5

const layer = proxyOnlyFakeStackLayer({
  proxyAddr: PROXY,
  forwardTarget: BOB,
  transitDelayMs: TRANSIT_MS,
})

const pump = (cycles = 1) =>
  Effect.gen(function* () {
    for (let i = 0; i < cycles; i++) {
      yield* Effect.yieldNow
      yield* TestClock.adjust(`${TRANSIT_MS + 1} millis`)
      yield* Effect.yieldNow
      yield* TestClock.adjust(`${TRANSIT_MS + 1} millis`)
      yield* Effect.yieldNow
    }
  })

const parse = (raw: Buffer) => {
  const r = customParser.parse(raw)
  if (r._tag !== "Success") throw new Error(`parse failure: ${r.failure.reason}`)
  return r.success
}

describe("sip-front-proxy/transit-only — CANCEL during ringing", () => {
  it.effect("CANCEL traverses to the same downstream as the INVITE", () =>
    runProxyScenario(
      {
        name: "transit-only.cancel-during-ringing",
        description:
          "Alice → Proxy(ForwardAll) → Bob. INVITE/180/CANCEL/487/ACK round-trip;\n" +
          "asserts CANCEL keyed by (Call-ID, CSeq) reaches the same downstream as the\n" +
          "matching INVITE (RFC 3261 §16.10 / §9.1).",
      },
      Effect.gen(function* () {
      const proxy = yield* ProxyCore
      const lru = yield* CancelBranchLru
      const alice = yield* bindNamedEndpoint("alice", ALICE)
      const bob = yield* bindNamedEndpoint("bob", BOB)

      const aliceBranch = "z9hG4bK-alice-INV"

      // ── 1. Alice → Proxy: INVITE ────────────────────────────────────
      const invite = Buffer.from(
        [
          `INVITE sip:bob@${BOB.host}:${BOB.port} SIP/2.0`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=${aliceBranch};rport`,
          `Max-Forwards: 70`,
          `From: <sip:alice@${ALICE.host}>;tag=alice-tag`,
          `To: <sip:bob@${BOB.host}>`,
          `Call-ID: cancel-call@alice`,
          `CSeq: 1 INVITE`,
          `Contact: <sip:alice@${ALICE.host}:${ALICE.port}>`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* alice.send(invite, proxy.localAddress.port, proxy.localAddress.ip)
      yield* pump()

      const inviteAtBob = yield* bob.poll()
      expect(inviteAtBob).not.toBeNull()
      const inviteParsed = parse(inviteAtBob!.raw)
      if (inviteParsed.type !== "request") throw new Error("expected request")
      const proxyBranchInv = inviteParsed.getHeader("via")[0]!.branch!
      expect(proxyBranchInv).toMatch(/^z9hG4bK/)

      // The proxy must have remembered branch → Bob in CancelBranchLru.
      expect(lru.size()).toBeGreaterThanOrEqual(1)

      // ── 2. Bob → Proxy → Alice: 180 Ringing ─────────────────────────
      const ringing = Buffer.from(
        [
          `SIP/2.0 180 Ringing`,
          ...inviteParsed.headers
            .filter((h) => h.name.toLowerCase() === "via")
            .map((h) => `Via: ${h.value}`),
          `From: <sip:alice@${ALICE.host}>;tag=alice-tag`,
          `To: <sip:bob@${BOB.host}>;tag=bob-tag`,
          `Call-ID: cancel-call@alice`,
          `CSeq: 1 INVITE`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* bob.send(ringing, proxy.localAddress.port, proxy.localAddress.ip)
      yield* pump()
      const ringAtAlice = yield* alice.poll()
      expect(ringAtAlice).not.toBeNull()
      const ringParsed = parse(ringAtAlice!.raw)
      if (ringParsed.type !== "response") throw new Error("expected response")
      expect(ringParsed.status).toBe(180)

      // ── 3. Alice → Proxy: CANCEL (mirrors the INVITE's top Via per
      //      RFC 3261 §9.1 — i.e. Alice's own branch). ───────────────
      // Per PR3b the CancelBranchLru is now keyed on `(Call-ID, CSeq
      // number)` (RFC 3261 §9.1: the CANCEL shares both with the
      // matching INVITE), so the lookup hits regardless of what branch
      // Alice put on the CANCEL or what branch the proxy stamped on the
      // INVITE. End-to-end the CANCEL reaches Bob — same behavior as
      // before, but now via the canonical correlator instead of the
      // ForwardAll fallback path.
      const cancel = Buffer.from(
        [
          `CANCEL sip:bob@${BOB.host}:${BOB.port} SIP/2.0`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=${aliceBranch};rport`,
          `Max-Forwards: 70`,
          `From: <sip:alice@${ALICE.host}>;tag=alice-tag`,
          `To: <sip:bob@${BOB.host}>`,
          `Call-ID: cancel-call@alice`,
          `CSeq: 1 CANCEL`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* alice.send(cancel, proxy.localAddress.port, proxy.localAddress.ip)
      yield* pump()

      const cancelAtBob = yield* bob.poll()
      expect(cancelAtBob).not.toBeNull()
      const cancelParsed = parse(cancelAtBob!.raw)
      if (cancelParsed.type !== "request") throw new Error("expected request")
      expect(cancelParsed.method).toBe("CANCEL")
      // Proxy stamped its own Via on top.
      expect(cancelParsed.getHeader("via")[0]!.host).toBe(PROXY.host)
      // Alice's Via preserved underneath.
      expect(cancelParsed.getHeader("via")[1]!.branch).toBe(aliceBranch)

      // ── 4. Bob → Proxy → Alice: 487 Request Terminated ─────────────
      const r487 = Buffer.from(
        [
          `SIP/2.0 487 Request Terminated`,
          ...inviteParsed.headers
            .filter((h) => h.name.toLowerCase() === "via")
            .map((h) => `Via: ${h.value}`),
          `From: <sip:alice@${ALICE.host}>;tag=alice-tag`,
          `To: <sip:bob@${BOB.host}>;tag=bob-tag`,
          `Call-ID: cancel-call@alice`,
          `CSeq: 1 INVITE`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* bob.send(r487, proxy.localAddress.port, proxy.localAddress.ip)
      yield* pump()
      const r487AtAlice = yield* alice.poll()
      expect(r487AtAlice).not.toBeNull()
      const r487Parsed = parse(r487AtAlice!.raw)
      if (r487Parsed.type !== "response") throw new Error("expected response")
      expect(r487Parsed.status).toBe(487)

      // ── 5. ACK for non-2xx (Alice → Proxy → Bob) ───────────────────
      const ack = Buffer.from(
        [
          `ACK sip:bob@${BOB.host}:${BOB.port} SIP/2.0`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=${aliceBranch};rport`,
          `Max-Forwards: 70`,
          `From: <sip:alice@${ALICE.host}>;tag=alice-tag`,
          `To: <sip:bob@${BOB.host}>;tag=bob-tag`,
          `Call-ID: cancel-call@alice`,
          `CSeq: 1 ACK`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* alice.send(ack, proxy.localAddress.port, proxy.localAddress.ip)
      yield* pump()
      const ackAtBob = yield* bob.poll()
      expect(ackAtBob).not.toBeNull()
      const ackParsed = parse(ackAtBob!.raw)
      if (ackParsed.type !== "request") throw new Error("expected request")
      expect(ackParsed.method).toBe("ACK")
      })
    ).pipe(Effect.provide(layer))
  )
})
