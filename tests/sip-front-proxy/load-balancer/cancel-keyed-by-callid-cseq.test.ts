/**
 * PR3b — CANCEL must hit the same downstream as the matching INVITE, even
 * with a multi-worker `LoadBalancer` whose `selectForNewDialog` fallback
 * would otherwise re-shard.
 *
 * Bug fixed: PR2 keyed `CancelBranchLru` on the proxy's *outbound* branch.
 * At CANCEL time the proxy receives the upstream UAC's branch on top of
 * the CANCEL's Via stack (RFC 3261 §9.1 — UAC reuses the INVITE's top-Via
 * branch), so the LRU lookup missed and the proxy fell back to
 * `selectForNewDialog`. Under `ForwardAll` this papered over the miss
 * (single static target). Under `LoadBalancer` with N≥2 workers the same
 * Call-ID can rendezvous-hash to a different worker after the registry
 * shifts → CANCEL goes to the wrong worker.
 *
 * Fix: re-key the LRU on `(Call-ID, CSeq number)` per RFC 3261 §9.1.
 *
 * This test pins the new key in place. Two workers (A, B). We pick a
 * Call-ID whose rendezvous winner is A, send INVITE → A, then send a
 * CANCEL with the SAME Call-ID and CSeq number. Even though the upstream
 * Via branch on the CANCEL doesn't match the proxy's outbound INVITE
 * branch, the CANCEL must still reach A.
 *
 * To make the test deterministic we don't pick a Call-ID by trial — we
 * compute the rendezvous winner up front via `rendezvousSelect` and use
 * the first Call-ID it picks A for. (We could just hard-code one if the
 * hash were stable across versions, but rendezvous winners depend on
 * SHA-1 of `${callId}:${id}` so we'd be hard-coding a magic constant.)
 *
 * Cancel-after-rebalance: the spec calls this out as folded into the
 * cancel-keyed test; we extend by adding a third worker C *after* the
 * INVITE has been remembered and before the CANCEL is sent. Because the
 * LRU is keyed on (Call-ID, CSeq), the CANCEL still reaches A even though
 * `selectForNewDialog` for the same Call-ID would now likely pick C.
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
const W_C = WorkerId("worker-c")
const ADDR_A = { host: "10.0.1.10", port: 5060 }
const ADDR_B = { host: "10.0.1.11", port: 5060 }
const ADDR_C = { host: "10.0.1.12", port: 5060 }
const TRANSIT_MS = 1

/** Find the first integer-suffixed Call-ID whose rendezvous winner is `target`. */
const findCallIdMappingTo = (target: WorkerId): string => {
  const candidates = [
    { id: W_A as string },
    { id: W_B as string },
  ]
  for (let i = 0; i < 1000; i++) {
    const cid = `pin-${i}@alice`
    const w = rendezvousSelect(cid, candidates)
    if (w !== undefined && w.id === target) return cid
  }
  throw new Error(`no Call-ID found mapping to ${target} within 1000 tries`)
}

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

describe("sip-front-proxy/load-balancer — CANCEL keyed by (Call-ID, CSeq)", () => {
  it.effect("CANCEL reaches the original worker even after registry change", () =>
    runProxyScenario(
      {
        name: "load-balancer.cancel-keyed-by-callid-cseq",
        description:
          "Two workers (A, B) initially. INVITE to A; add worker C; CANCEL with the\n" +
          "same (Call-ID, CSeq) and the upstream branch reaches A — not B, not C —\n" +
          "proving the LRU is keyed on (Call-ID, CSeq) per RFC 3261 §9.1.",
      },
      Effect.gen(function* () {
      const proxy = yield* ProxyCore

      // Pick a Call-ID that hashes to A under the initial 2-worker set.
      const callId = findCallIdMappingTo(W_A)

      const alice = yield* fx.bindRecordedUac("alice", ALICE)
      const aEp = yield* fx.bindRecordedUasFor("worker-a", W_A)
      const bEp = yield* fx.bindRecordedUasFor("worker-b", W_B)

      // ── 1. INVITE → must reach A ─────────────────────────────────────
      const inviteBranch = "z9hG4bK-alice-inv"
      const invite = Buffer.from(
        [
          `INVITE sip:user@example.com SIP/2.0`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=${inviteBranch};rport`,
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
      const inviteAtBNone = yield* bEp.poll()
      expect(inviteAtBNone).toBeNull()
      const m = parse(inviteAtA!.raw)
      expect(m.type).toBe("request")

      // ── 2. Add worker C — would shift rendezvous winner for some keys ─
      yield* fx.addSimulatedWorker(W_C, ADDR_C)
      const cEp = yield* fx.bindRecordedUasFor("worker-c", W_C)

      // ── 3. CANCEL with the same Call-ID + CSeq, upstream branch ──────
      // RFC 3261 §9.1 — UAC reuses the INVITE's top-Via branch on CANCEL.
      const cancel = Buffer.from(
        [
          `CANCEL sip:user@example.com SIP/2.0`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=${inviteBranch};rport`,
          `Max-Forwards: 70`,
          `From: <sip:alice@${ALICE.host}>;tag=t-alice`,
          `To: <sip:user@example.com>`,
          `Call-ID: ${callId}`,
          `CSeq: 1 CANCEL`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* alice.send(cancel, proxy.localAddress.port, proxy.localAddress.ip)
      yield* pumpFor(TRANSIT_MS)

      // CANCEL must hit A (per the LRU), not B and not the rebalance
      // candidate C.
      const cancelAtA = yield* aEp.poll()
      const cancelAtB = yield* bEp.poll()
      const cancelAtC = yield* cEp.poll()
      expect(cancelAtA).not.toBeNull()
      expect(cancelAtB).toBeNull()
      expect(cancelAtC).toBeNull()
      const cm = parse(cancelAtA!.raw)
      if (cm.type !== "request") throw new Error("expected CANCEL request")
      expect(cm.method).toBe("CANCEL")
      })
    ).pipe(Effect.provide(fx.layer))
  )
})
