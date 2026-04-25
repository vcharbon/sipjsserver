/**
 * PR3b — `LoadBalancerStrategy` distribution test.
 *
 * Bind 8 simulated workers, push 1000 INVITEs whose Call-IDs come from a
 * fixed-seed PRNG, and assert each worker handled within ±25% of the
 * expected mean (1000/8 = 125). Generous tolerance because we only need
 * to catch gross mis-distribution; rendezvous hashing's actual variance
 * for 1000 keys / 8 buckets is on the order of √125 ≈ 11.
 *
 * Determinism: a small linear-congruential generator (Numerical Recipes
 * params) seeded once. Same seed → same Call-ID stream → same expected
 * counts → same pass/fail across machines.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { customParser } from "../../../src/sip/parsers/custom/index.js"
import {
  ProxyCore,
  WorkerId,
} from "../../../src/sip-front-proxy/index.js"
import { proxyFakeStack, pumpFor } from "../../support/proxy-fakeStack.js"
import { runProxyScenario } from "../_report/runner.js"

const PROXY = { host: "10.0.0.1", port: 5060 }
const ALICE = { host: "10.0.0.2", port: 5060 }
const TRANSIT_MS = 1
const N_WORKERS = 8
const N_INVITES = 1000
const TOLERANCE = 0.25 // ±25% of the expected per-worker mean.

const workerIds = Array.from({ length: N_WORKERS }, (_, i) => WorkerId(`w-${i}`))
const workerEntries = workerIds.map((id, i) => ({
  id,
  address: { host: `10.0.1.${i}`, port: 5060 },
  health: "alive" as const,
}))

/** Numerical Recipes LCG — repeatable across runs / OSes. */
const makeRng = (seed: number) => {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s
  }
}

const buildInvite = (callId: string, idx: number): Buffer =>
  Buffer.from(
    [
      `INVITE sip:user@example.com SIP/2.0`,
      `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-d-${idx};rport`,
      `Max-Forwards: 70`,
      `From: <sip:alice@${ALICE.host}>;tag=alice-${idx}`,
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

const parse = (raw: Buffer) => {
  const r = customParser.parse(raw)
  if (r._tag !== "Success") throw new Error(`parse failure: ${r.failure.reason}`)
  return r.success
}

const fx = proxyFakeStack({
  proxyAddr: PROXY,
  workers: workerEntries,
  transitDelayMs: TRANSIT_MS,
})

describe("sip-front-proxy/load-balancer — distribution", () => {
  it.effect(
    `${N_INVITES} INVITEs land within ±${TOLERANCE * 100}% of the per-worker mean`,
    () =>
      runProxyScenario(
        {
          name: "load-balancer.distribution-NO_ANALYSIS",
          description:
            `8 workers, ${N_INVITES} INVITEs with PRNG-derived Call-IDs;\n` +
            `asserts each worker handles within ±${TOLERANCE * 100}% of the per-worker\n` +
            "mean (rendezvous-hash distribution sanity).",
        },
        Effect.gen(function* () {
        const proxy = yield* ProxyCore
        const alice = yield* fx.bindRecordedUac("alice", ALICE, /* queueMax */ 8)
        // Bind a UAS endpoint at every worker's address. We don't reply to
        // the INVITEs — the proxy is fire-and-forget — but we drain the
        // queue per worker to count receipts.
        const uases = yield* Effect.all(
          workerIds.map((id) => fx.bindRecordedUasFor(id, id, /* queueMax */ N_INVITES))
        )

        const rng = makeRng(0xfeed_face)
        for (let i = 0; i < N_INVITES; i++) {
          const callId = `cid-${rng().toString(36)}-${i}@alice`
          yield* alice.send(buildInvite(callId, i), proxy.localAddress.port, proxy.localAddress.ip)
        }
        // One pump moves each packet through the in-memory transit. In
        // practice we need O(N) pumps because every INVITE is forked with
        // its own transit-delay sleep; the simulated fabric needs the
        // virtual clock to advance past each scheduled delivery. Pump
        // once per INVITE — cheap (few microseconds each).
        yield* pumpFor(TRANSIT_MS, N_INVITES)

        // Collect counts.
        const counts: number[] = new Array(N_WORKERS).fill(0)
        for (let w = 0; w < N_WORKERS; w++) {
          const ep = uases[w]!
          // Drain the queue.
          let total = 0
          for (let drain = 0; drain < N_INVITES; drain++) {
            const pkt = yield* ep.poll()
            if (pkt === null) break
            const m = parse(pkt.raw)
            if (m.type === "request" && m.method === "INVITE") total++
          }
          counts[w] = total
        }

        const totalDelivered = counts.reduce((a, b) => a + b, 0)
        // Every INVITE must reach exactly one worker — the proxy never drops.
        expect(totalDelivered).toBe(N_INVITES)

        const expected = N_INVITES / N_WORKERS
        const lo = Math.floor(expected * (1 - TOLERANCE))
        const hi = Math.ceil(expected * (1 + TOLERANCE))
        for (let w = 0; w < N_WORKERS; w++) {
          expect(counts[w]).toBeGreaterThanOrEqual(lo)
          expect(counts[w]).toBeLessThanOrEqual(hi)
        }
        })
      ).pipe(Effect.provide(fx.layer))
  )
})
