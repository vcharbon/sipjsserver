/**
 * B2BUA OPTIONS / DrainingState integration test.
 *
 * Verifies the worker-side OPTIONS handler wired into `SipRouter` walks
 * the two-tier graceful-drain protocol (ADR-0008):
 *
 *   - `DrainingState = serving`        → 200 OK + normal `X-Overload`
 *   - `DrainingState = draining-new`   → 200 OK + `X-Overload: elu=1.000;
 *                                         reason=draining; ...`
 *   - `DrainingState = draining-quiet` → no reply at all
 *
 * RFC anchors:
 *   - §11 (OPTIONS): UAS responds with capabilities; minimal response
 *     is permitted.
 *   - §21.5.4 (503), §20.33 (Retry-After: 0): canonical "boot drain"
 *     signal — kept for the not-ready branch only.
 *
 * Topology: a UAC endpoint bound on the simulated UDP fabric sends an
 * out-of-dialog OPTIONS at the B2BUA's bind port. The OPTIONS short-
 * circuit in `SipRouter.withCall` picks it up before call resolution
 * (no call-resolution path involvement).
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
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"

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

describe("b2bua/DrainingState — two-tier OPTIONS keepalive (ADR-0008)", () => {
  it.effect(
    "serving → 200; draining-new → 200 with elu=1.000+reason=draining; draining-quiet → silence; back to serving → 200",
    () =>
      Effect.gen(function* () {
        const router = yield* SipRouter
        const draining = yield* DrainingState

        const routerFiber = yield* Effect.forkChild(router.start(handlers))

        const network = yield* SignalingNetwork
        const uac = yield* network
          .bindUdp({ ip: UAC.ip, port: UAC.port, queueMax: 16 })
          .pipe(Effect.orDie)

        // ── 1. Serving → 200 OK ───────────────────────────────────
        yield* uac.send(buildOptions("opts-serving@probe", "z9hG4bK-1"), SIP_PORT, "127.0.0.1")
        yield* pump(2)

        const respServingPkt = yield* uac.poll()
        expect(respServingPkt).not.toBeNull()
        const respServing = parse(respServingPkt!.raw)
        expect(respServing.type).toBe("response")
        if (respServing.type !== "response") throw new Error("unreachable")
        expect(respServing.status).toBe(200)
        expect(respServing.getHeader("call-id")).toBe("opts-serving@probe")
        expect(respServing.getHeader("cseq").method).toBe("OPTIONS")
        // Serving X-Overload must NOT advertise drain.
        const servingOverload = respServing.headers.find(
          (h) => h.name.toLowerCase() === "x-overload"
        )
        expect(servingOverload).toBeDefined()
        expect(servingOverload!.value).not.toContain("reason=draining")
        expect(respServing.headers.find((h) => h.name.toLowerCase() === "retry-after")).toBeUndefined()

        // ── 2. Flip to draining-new → 200 OK but elu=1.000 + reason=draining ──
        yield* draining.markDrainingNew

        yield* uac.send(buildOptions("opts-draining-new@probe", "z9hG4bK-2"), SIP_PORT, "127.0.0.1")
        yield* pump(2)

        const respTier1Pkt = yield* uac.poll()
        expect(respTier1Pkt).not.toBeNull()
        const respTier1 = parse(respTier1Pkt!.raw)
        expect(respTier1.type).toBe("response")
        if (respTier1.type !== "response") throw new Error("unreachable")
        expect(respTier1.status).toBe(200)
        const drainOverload = respTier1.headers.find(
          (h) => h.name.toLowerCase() === "x-overload"
        )
        expect(drainOverload).toBeDefined()
        expect(drainOverload!.value).toMatch(/elu=1\.000/)
        expect(drainOverload!.value).toMatch(/reason=draining/)
        expect(respTier1.headers.find((h) => h.name.toLowerCase() === "retry-after")).toBeUndefined()

        // ── 3. Flip to draining-quiet → no reply ───────────────────
        yield* draining.markDrainingQuiet

        yield* uac.send(buildOptions("opts-draining-quiet@probe", "z9hG4bK-3"), SIP_PORT, "127.0.0.1")
        yield* pump(3)

        const silentPkt = yield* uac.poll()
        expect(silentPkt).toBeNull()

        // ── 4. Flip back to serving → 200 OK ───────────────────────
        yield* draining.markServing

        yield* uac.send(buildOptions("opts-serving2@probe", "z9hG4bK-4"), SIP_PORT, "127.0.0.1")
        yield* pump(2)

        const respServing2Pkt = yield* uac.poll()
        expect(respServing2Pkt).not.toBeNull()
        const respServing2 = parse(respServing2Pkt!.raw)
        expect(respServing2.type).toBe("response")
        if (respServing2.type !== "response") throw new Error("unreachable")
        expect(respServing2.status).toBe(200)

        yield* Fiber.interrupt(routerFiber)
      }).pipe(Effect.provide(stack))
  )
})
