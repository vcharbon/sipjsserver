/**
 * B2BUA OPTIONS / DrainingState integration test.
 *
 * Verifies the worker-side OPTIONS handler wired into `SipRouter`:
 *
 *   - `DrainingState = serving`  → 200 OK
 *   - `DrainingState = draining` → 503 Service Unavailable + Retry-After: 0
 *
 * RFC anchors:
 *   - §11 (OPTIONS): UAS responds with capabilities; minimal response
 *     is permitted.
 *   - §21.5.4 (503), §20.33 (Retry-After: 0): canonical "drained" signal
 *     proxies use to demote a worker to `draining`.
 *
 * Topology: a UAC endpoint bound on the simulated UDP fabric sends an
 * out-of-dialog OPTIONS at the B2BUA's bind port. The OPTIONS short-
 * circuit in `SipRouter.withCall` picks it up before call resolution
 * (no `CallStateCache` involvement).
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { handlers } from "../../src/b2bua/B2buaCore.js"
import { DrainingState } from "../../src/b2bua/DrainingState.js"
import { SipRouter } from "../../src/sip/SipRouter.js"
import { customParser } from "../../src/sip/parsers/custom/index.js"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import { fakeStackLayer } from "../support/fakeStack.js"
import { testAppConfigDefaults } from "../support/testAppConfigDefaults.js"

const SIP_PORT = 15060
const UAC = { ip: "127.0.0.1", port: 25060 }
const TRANSIT_MS = 5

const config = testAppConfigDefaults({ sipLocalPort: SIP_PORT })
const stack = fakeStackLayer({ config, transitDelayMs: TRANSIT_MS })

const buildOptions = (callId: string, branch: string): Buffer =>
  Buffer.from(
    [
      `OPTIONS sip:b2bua@127.0.0.1:${SIP_PORT} SIP/2.0`,
      `Via: SIP/2.0/UDP ${UAC.ip}:${UAC.port};branch=${branch};rport`,
      `Max-Forwards: 70`,
      `From: <sip:probe@${UAC.ip}>;tag=probe-${callId}`,
      `To: <sip:b2bua@127.0.0.1:${SIP_PORT}>`,
      `Call-ID: ${callId}`,
      `CSeq: 1 OPTIONS`,
      `Contact: <sip:probe@${UAC.ip}:${UAC.port}>`,
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

describe("b2bua/DrainingState — OPTIONS keepalive", () => {
  it.effect("serving → 200 OK; draining → 503 + Retry-After: 0", () =>
    Effect.gen(function* () {
      const router = yield* SipRouter
      const draining = yield* DrainingState

      // Start the router in the background. The effect blocks on the
      // TransactionEvent stream forever, so we forkChild and interrupt
      // at the end of the test.
      const routerFiber = yield* Effect.forkChild(router.start(handlers))

      // Bind a UAC endpoint on the simulated fabric.
      const network = yield* SignalingNetwork
      const uac = yield* network
        .bindUdp({ ip: UAC.ip, port: UAC.port, queueMax: 16 })
        .pipe(Effect.orDie)

      // ── 1. Serving → 200 OK ─────────────────────────────────────
      yield* uac.send(buildOptions("opts-serving@probe", "z9hG4bK-1"), SIP_PORT, "127.0.0.1")
      yield* pump(2) // OPTIONS in + 200 OK out

      const respServingPkt = yield* uac.poll()
      expect(respServingPkt).not.toBeNull()
      const respServing = parse(respServingPkt!.raw)
      expect(respServing.type).toBe("response")
      if (respServing.type !== "response") throw new Error("unreachable")
      expect(respServing.status).toBe(200)
      // Echoed Vias / From / Call-ID / CSeq per RFC 3261 §8.2.6.2.
      expect(respServing.parsed.callId).toBe("opts-serving@probe")
      expect(respServing.parsed.cseq.method).toBe("OPTIONS")
      // No Retry-After in the serving branch.
      expect(
        respServing.headers.find((h) => h.name.toLowerCase() === "retry-after")
      ).toBeUndefined()

      // ── 2. Flip to draining → 503 + Retry-After: 0 ──────────────
      yield* draining.markDraining

      yield* uac.send(buildOptions("opts-draining@probe", "z9hG4bK-2"), SIP_PORT, "127.0.0.1")
      yield* pump(2)

      const respDrainingPkt = yield* uac.poll()
      expect(respDrainingPkt).not.toBeNull()
      const respDraining = parse(respDrainingPkt!.raw)
      expect(respDraining.type).toBe("response")
      if (respDraining.type !== "response") throw new Error("unreachable")
      expect(respDraining.status).toBe(503)
      const retryAfter = respDraining.headers.find(
        (h) => h.name.toLowerCase() === "retry-after"
      )
      expect(retryAfter).toBeDefined()
      expect(retryAfter!.value.trim()).toBe("0")

      // ── 3. Flip back to serving → 200 OK again ──────────────────
      yield* draining.markServing

      yield* uac.send(buildOptions("opts-serving2@probe", "z9hG4bK-3"), SIP_PORT, "127.0.0.1")
      yield* pump(2)

      const respServing2Pkt = yield* uac.poll()
      expect(respServing2Pkt).not.toBeNull()
      const respServing2 = parse(respServing2Pkt!.raw)
      expect(respServing2.type).toBe("response")
      if (respServing2.type !== "response") throw new Error("unreachable")
      expect(respServing2.status).toBe(200)

      // Cleanup: interrupt the router fiber so the test scope can end.
      yield* Fiber.interrupt(routerFiber)
    }).pipe(Effect.provide(stack))
  )
})
