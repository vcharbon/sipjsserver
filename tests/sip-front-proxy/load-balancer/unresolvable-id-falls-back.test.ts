/**
 * PR3b — In-dialog request whose stickiness cookie names a worker that's
 * no longer in the registry must fall back via `selectForNewDialog` to
 * any live worker. No 403 (signature was valid), no drop.
 *
 * Models the D5 Redis-hydration fallback: an in-dialog re-INVITE / BYE
 * arrives long after the original worker scaled down. Cookie verifies,
 * but `WorkerRegistry.resolve` returns `Option.none`. Strategy returns
 * `unknown`, proxy core falls back to `selectForNewDialog`, which picks
 * a live worker; the new worker would then hydrate state from Redis (PR
 * 5 wires the actual hydration; PR3b just proves the fallback path).
 *
 * Topology:
 *   - Workers A and B initially.
 *   - INVITE → A (we pick a Call-ID that hashes to A).
 *   - 200 OK echoes RR back via the proxy → Alice.
 *   - Remove A from the registry.
 *   - BYE with intact stickiness cookie → proxy decodes, resolve(A)
 *     returns none → selectForNewDialog → picks B (the only live
 *     worker now). Assert BYE arrives at B, not 403.
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

const findCallIdMappingTo = (target: WorkerId): string => {
  const candidates = [{ id: W_A as string }, { id: W_B as string }]
  for (let i = 0; i < 1000; i++) {
    const cid = `pin-${i}@alice`
    const w = rendezvousSelect(cid, candidates)
    if (w !== undefined && w.id === target) return cid
  }
  throw new Error(`no Call-ID found mapping to ${target}`)
}

describe("sip-front-proxy/load-balancer — unresolvable id falls back", () => {
  it.effect(
    "in-dialog BYE after target worker removal lands on the surviving live worker",
    () =>
      runProxyScenario(
        {
          name: "load-balancer.unresolvable-id-falls-back",
          description:
            "INVITE pinned to A round-trips so Alice has the RR cookie; A is then\n" +
            "removed from the registry; in-dialog BYE with intact cookie verifies but\n" +
            "resolve(A) returns none, so the proxy falls back via selectForNewDialog\n" +
            "to B (the only surviving live worker) — no 403, no drop.",
        },
        Effect.gen(function* () {
        const proxy = yield* ProxyCore
        const callId = findCallIdMappingTo(W_A)

        const alice = yield* fx.bindRecordedUac("alice", ALICE)
        const aEp = yield* fx.bindRecordedUasFor("worker-a", W_A)
        const bEp = yield* fx.bindRecordedUasFor("worker-b", W_B)

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

        // ── 2. 200 OK back through the proxy (just to round-trip RR) ─
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

        // ── 3. Remove worker A from the registry ─────────────────────
        yield* fx.removeSimulatedWorker(W_A)

        // ── 4. BYE with intact RR-cookie → fallback to B ─────────────
        // The cookie still names A; verify succeeds; resolve(A) → none;
        // strategy returns unknown; proxy falls back to selectForNewDialog
        // which must pick B (the only live worker).
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

        // No 403 to Alice.
        const aliceReply = yield* alice.poll()
        expect(aliceReply).toBeNull()

        // BYE should land on B (the only surviving live worker).
        const byeAtB = yield* bEp.poll()
        expect(byeAtB).not.toBeNull()
        const byeAtA = yield* aEp.poll()
        // A's endpoint is still bound (we didn't release it) but the proxy
        // routes nowhere near it now.
        expect(byeAtA).toBeNull()
        const byeParsed = parse(byeAtB!.raw)
        if (byeParsed.type !== "request") throw new Error("expected request")
        expect(byeParsed.method).toBe("BYE")
        })
      ).pipe(Effect.provide(fx.layer))
  )
})
