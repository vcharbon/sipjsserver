/**
 * PR3b — Adding a worker may re-shard new INVITEs but must NOT break
 * stickiness on already-established dialogs.
 *
 * Properties under test:
 *   1. INVITE for Call-ID X goes to worker A under the initial 2-worker
 *      set (rendezvous(X, {A,B}) === A).
 *   2. After establishing the dialog (200 OK echoes RR back through the
 *      proxy → Alice), an in-dialog request from Alice (BYE) routes via
 *      the Record-Route cookie back to A — even after we add worker C.
 *      Stickiness wins over re-sharding.
 *   3. A *new* INVITE on a *different* Call-ID — picked so its
 *      rendezvous winner shifts after C joins — lands on the post-add
 *      winner. (Sanity: the strategy actually consults the live registry
 *      for `selectForNewDialog`; it isn't caching a snapshot somewhere.)
 *
 * RFC notes: §16.4 Route preprocessing strips the proxy's RR off the
 * BYE; §16.6.5 RR insertion happens for dialog-creating requests only.
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
const W_C = WorkerId("worker-c")
const ADDR_A = { host: "10.0.1.10", port: 5060 }
const ADDR_B = { host: "10.0.1.11", port: 5060 }
const ADDR_C = { host: "10.0.1.12", port: 5060 }
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
  const cands = [{ id: W_A as string }, { id: W_B as string }]
  for (let i = 0; i < 1000; i++) {
    const cid = `cid-${i}@alice`
    const w = rendezvousSelect(cid, cands)
    if (w !== undefined && w.id === target) return cid
  }
  throw new Error(`no Call-ID maps to ${target}`)
}

/**
 * Find a Call-ID whose rendezvous winner under {A,B} is `from` and whose
 * winner under {A,B,C} is `to`. Used to demonstrate the re-shard case.
 */
const findReshardCallId = (from: WorkerId, to: WorkerId): string => {
  const before = [{ id: W_A as string }, { id: W_B as string }]
  const after = [
    { id: W_A as string },
    { id: W_B as string },
    { id: W_C as string },
  ]
  for (let i = 0; i < 5000; i++) {
    const cid = `re-${i}@alice`
    const wb = rendezvousSelect(cid, before)
    const wa = rendezvousSelect(cid, after)
    if (wb?.id === from && wa?.id === to) return cid
  }
  throw new Error(`no Call-ID re-shards from ${from} to ${to}`)
}

describe("sip-front-proxy/load-balancer — add/remove resharding", () => {
  it.effect(
    "stickiness on existing dialog wins; new dialogs see the new winner",
    () =>
      Effect.gen(function* () {
        const proxy = yield* ProxyCore
        const alice = yield* fx.bindUac(ALICE)
        const aEp = yield* fx.bindUasFor(W_A)
        const bEp = yield* fx.bindUasFor(W_B)

        // ── 1. INVITE for cid1 → A ────────────────────────────────────
        const cid1 = findCallIdMappingTo(W_A)
        const invite1 = Buffer.from(
          [
            `INVITE sip:user@example.com SIP/2.0`,
            `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-a1;rport`,
            `Max-Forwards: 70`,
            `From: <sip:alice@${ALICE.host}>;tag=t-a1`,
            `To: <sip:user@example.com>`,
            `Call-ID: ${cid1}`,
            `CSeq: 1 INVITE`,
            `Contact: <sip:alice@${ALICE.host}:${ALICE.port}>`,
            `Content-Length: 0`,
            ``,
            ``,
          ].join("\r\n"),
          "utf-8"
        )
        yield* alice.send(invite1, proxy.localAddress.port, proxy.localAddress.ip)
        yield* pumpFor(TRANSIT_MS)
        const inv1AtA = yield* aEp.poll()
        expect(inv1AtA).not.toBeNull()
        const inv1Parsed = parse(inv1AtA!.raw)
        if (inv1Parsed.type !== "request") throw new Error("expected request")
        const rr = inv1Parsed.headers.find(
          (h) => h.name.toLowerCase() === "record-route"
        )!
        expect(rr).toBeDefined()

        // 200 OK echoes RR back through proxy → Alice
        const ok = Buffer.from(
          [
            `SIP/2.0 200 OK`,
            ...inv1Parsed.headers
              .filter((h) => h.name.toLowerCase() === "via")
              .map((h) => `Via: ${h.value}`),
            `Record-Route: ${rr.value}`,
            `From: <sip:alice@${ALICE.host}>;tag=t-a1`,
            `To: <sip:user@example.com>;tag=t-b1`,
            `Call-ID: ${cid1}`,
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

        // ── 2. Add C ──────────────────────────────────────────────────
        yield* fx.addSimulatedWorker(W_C, ADDR_C)
        const cEp = yield* fx.bindUasFor(W_C)

        // ── 3. In-dialog BYE on cid1 — must still hit A (stickiness) ──
        const rrInner = rr.value.replace(/^</, "").replace(/>$/, "")
        const bye = Buffer.from(
          [
            `BYE sip:user@${ADDR_A.host}:${ADDR_A.port} SIP/2.0`,
            `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-bye1;rport`,
            `Route: <${rrInner}>`,
            `Max-Forwards: 70`,
            `From: <sip:alice@${ALICE.host}>;tag=t-a1`,
            `To: <sip:user@example.com>;tag=t-b1`,
            `Call-ID: ${cid1}`,
            `CSeq: 2 BYE`,
            `Content-Length: 0`,
            ``,
            ``,
          ].join("\r\n"),
          "utf-8"
        )
        yield* alice.send(bye, proxy.localAddress.port, proxy.localAddress.ip)
        yield* pumpFor(TRANSIT_MS)
        const byeAtA = yield* aEp.poll()
        const byeAtB = yield* bEp.poll()
        const byeAtC = yield* cEp.poll()
        expect(byeAtA).not.toBeNull()
        expect(byeAtB).toBeNull()
        expect(byeAtC).toBeNull()

        // ── 4. Fresh INVITE on a Call-ID that re-shards to C ──────────
        // Pick a Call-ID whose rendezvous winner shifts B→C after add.
        let cid2: string
        try {
          cid2 = findReshardCallId(W_B, W_C)
        } catch {
          // If no key in our search budget shifts B→C we'll accept A→C.
          cid2 = findReshardCallId(W_A, W_C)
        }
        const invite2 = Buffer.from(
          [
            `INVITE sip:other@example.com SIP/2.0`,
            `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-a2;rport`,
            `Max-Forwards: 70`,
            `From: <sip:alice@${ALICE.host}>;tag=t-a2`,
            `To: <sip:other@example.com>`,
            `Call-ID: ${cid2}`,
            `CSeq: 1 INVITE`,
            `Contact: <sip:alice@${ALICE.host}:${ALICE.port}>`,
            `Content-Length: 0`,
            ``,
            ``,
          ].join("\r\n"),
          "utf-8"
        )
        yield* alice.send(invite2, proxy.localAddress.port, proxy.localAddress.ip)
        yield* pumpFor(TRANSIT_MS)
        const inv2AtC = yield* cEp.poll()
        expect(inv2AtC).not.toBeNull()
        // Sanity: didn't double-deliver
        const inv2AtA = yield* aEp.poll()
        const inv2AtB = yield* bEp.poll()
        expect(inv2AtA).toBeNull()
        expect(inv2AtB).toBeNull()
      }).pipe(Effect.provide(fx.layer))
  )
})
