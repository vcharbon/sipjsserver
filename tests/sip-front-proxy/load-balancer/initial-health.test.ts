/**
 * MS-1 — workers admit as `unknown`, not `alive`. Verifies:
 *
 *   1. A worker registered with `health: "unknown"` is NOT selectable
 *      by `selectForNewDialog`. The proxy responds 503 Service Unavailable
 *      to inbound INVITEs.
 *   2. `WorkerRegistrySimulatedControl.setHealth(id, "alive")` flips the
 *      worker into the routable set (proxy now forwards INVITEs to it).
 *      In production this transition is driven by HealthProbe on the
 *      first 200 OK to OPTIONS; the simulated control surface stands in
 *      for that here.
 *   3. `unknown` and `dead` are kept as distinct values in the type
 *      (compile-time guard) so future hysteresis on `dead → alive` can
 *      apply without penalising cold-start workers.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { customParser } from "../../../src/sip/parsers/custom/index.js"
import {
  ProxyCore,
  type WorkerHealth,
  WorkerId,
} from "../../../src/sip-front-proxy/index.js"
import { proxyFakeStack, pumpFor } from "../../support/proxy-fakeStack.js"

const PROXY = { host: "10.0.0.1", port: 5060 }
const ALICE = { host: "10.0.0.2", port: 5060 }
const W_1 = WorkerId("w-1")
const ADDR_W1 = { host: "10.0.1.10", port: 5060 }
const TRANSIT_MS = 1

const buildInvite = (callId: string): Buffer =>
  Buffer.from(
    [
      `INVITE sip:user@example.com SIP/2.0`,
      `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-init-${callId};rport`,
      `Max-Forwards: 70`,
      `From: <sip:alice@${ALICE.host}>;tag=alice-${callId}`,
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

describe("sip-front-proxy/load-balancer — workers admitted as unknown", () => {
  const fx = proxyFakeStack({
    proxyAddr: PROXY,
    workers: [{ id: W_1, address: ADDR_W1, health: "unknown" }],
    transitDelayMs: TRANSIT_MS,
  })

  it.effect(
    "INVITE while sole worker is `unknown` → 503; setHealth(alive) → next INVITE forwarded",
    () =>
      Effect.gen(function* () {
        yield* ProxyCore // force materialisation of the proxy stack
        const alice = yield* fx.bindUac(ALICE, /* queueMax */ 8)
        const w1 = yield* fx.bindUasFor(W_1, /* queueMax */ 8)

        // ── 1. Worker is `unknown`. INVITE routes nowhere → 503. ─────────
        yield* alice.send(buildInvite("call-while-unknown@alice"), PROXY.port, PROXY.host)
        yield* pumpFor(TRANSIT_MS, /* cycles */ 2)

        const respPkt = yield* alice.poll()
        if (respPkt === null) {
          throw new Error("alice did not receive a response to INVITE")
        }
        const respMsg = parse(respPkt.raw)
        expect(respMsg.type).toBe("response")
        if (respMsg.type === "response") {
          expect(respMsg.status).toBe(503)
        }

        // The unknown worker must NOT have received the INVITE.
        const w1Pkt = yield* w1.poll()
        expect(w1Pkt).toBeNull()

        // ── 2. Flip to `alive`. Next INVITE must reach the worker. ───────
        yield* fx.setWorkerHealth(W_1, "alive")
        yield* alice.send(buildInvite("call-after-alive@alice"), PROXY.port, PROXY.host)
        yield* pumpFor(TRANSIT_MS, /* cycles */ 2)

        // Drain alice's queue (any 100 Trying / 503 retransmits) — what we
        // care about is the worker now seeing the INVITE.
        for (let i = 0; i < 4; i++) {
          const drained = yield* alice.poll()
          if (drained === null) break
        }

        const w1Pkt2 = yield* w1.poll()
        if (w1Pkt2 === null) {
          throw new Error(
            "worker w-1 did not receive the post-setHealth(alive) INVITE"
          )
        }
        const w1Msg = parse(w1Pkt2.raw)
        expect(w1Msg.type).toBe("request")
        if (w1Msg.type === "request") {
          expect(w1Msg.method).toBe("INVITE")
        }
      }).pipe(Effect.provide(fx.layer))
  )

  it("`unknown` and `dead` are distinct values in the WorkerHealth type", () => {
    // Compile-time guard. If a future refactor collapses unknown/dead into
    // a single value, this assignment fails to typecheck (the literal types
    // would no longer be assignable to two different cases). Runtime is
    // trivially true.
    const u: WorkerHealth = "unknown"
    const d: WorkerHealth = "dead"
    expect(u).not.toBe(d)
  })
})
