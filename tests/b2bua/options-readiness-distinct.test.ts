/**
 * Slice E1 of the decode-forward-respawn-bye-481 fix — worker-side OPTIONS
 * keepalive distinguishes `draining` from `not-ready (boot drain)` via an
 * RFC 3326 `Reason` header so the proxy's HealthProbe can classify the
 * worker accurately.
 *
 * Matrix (from `src/sip/SipRouter.ts` OPTIONS short-circuit):
 *
 *   serving + ready         → 200 OK
 *   serving + !ready        → 503 + Retry-After: 0
 *                             + `Reason: SIP;cause=503;text="not-ready (boot drain)"`
 *   draining + (any)        → 503 + Retry-After: 0
 *                             + `Reason: SIP;cause=503;text="draining"`
 *
 * The test drives `WorkerReadiness` and `DrainingState` directly and
 * asserts the response headers. No proxy is involved — this is a pure
 * UAS-side unit test that complements the existing
 * `b2bua/draining-options.test.ts` for the `draining` branch.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { handlers } from "../../src/b2bua/B2buaCore.js"
import { DrainingState } from "../../src/b2bua/DrainingState.js"
import { WorkerReadiness } from "../../src/cache/WorkerReadiness.js"
import { SipRouter } from "../../src/sip/SipRouter.js"
import { customParser } from "../../src/sip/parsers/custom/index.js"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import { fakeStackLayer } from "../support/fakeStack.js"
import { testAppConfigDefaults } from "../support/testAppConfigDefaults.js"

const SIP_PORT = 16060
const UAC = { ip: "127.0.0.1", port: 26060 }
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

describe("b2bua/SipRouter — OPTIONS Reason discriminates draining vs not-ready", () => {
  it.effect(
    "serving + !ready → 503 + Reason: not-ready; draining → 503 + Reason: draining",
    () =>
      Effect.gen(function* () {
        const router = yield* SipRouter
        const draining = yield* DrainingState
        const readiness = yield* WorkerReadiness

        const routerFiber = yield* Effect.forkChild(router.start(handlers))

        const network = yield* SignalingNetwork
        const uac = yield* network
          .bindUdp({ ip: UAC.ip, port: UAC.port, queueMax: 16 })
          .pipe(Effect.orDie)

        // ── 1. Serving + ready (default in fakeStack) → 200 OK ─────
        yield* uac.send(buildOptions("opts-ready@probe", "z9hG4bK-r1"), SIP_PORT, "127.0.0.1")
        yield* pump(2)
        const respReadyPkt = yield* uac.poll()
        expect(respReadyPkt).not.toBeNull()
        const respReady = parse(respReadyPkt!.raw)
        if (respReady.type !== "response") throw new Error("expected response")
        expect(respReady.status).toBe(200)
        // No Reason header on the happy path.
        expect(
          respReady.headers.find((h) => h.name.toLowerCase() === "reason")
        ).toBeUndefined()

        // ── 2. Serving + NOT ready → 503 + Reason: not-ready ────────
        yield* readiness.markReady(false)
        yield* uac.send(buildOptions("opts-not-ready@probe", "z9hG4bK-r2"), SIP_PORT, "127.0.0.1")
        yield* pump(2)
        const respNotReadyPkt = yield* uac.poll()
        expect(respNotReadyPkt).not.toBeNull()
        const respNotReady = parse(respNotReadyPkt!.raw)
        if (respNotReady.type !== "response") throw new Error("expected response")
        expect(respNotReady.status).toBe(503)
        const retryAfterNR = respNotReady.headers.find(
          (h) => h.name.toLowerCase() === "retry-after"
        )
        expect(retryAfterNR?.value.trim()).toBe("0")
        const reasonNR = respNotReady.headers.find(
          (h) => h.name.toLowerCase() === "reason"
        )
        expect(reasonNR).toBeDefined()
        expect(reasonNR!.value).toMatch(/cause=503/)
        expect(reasonNR!.value.toLowerCase()).toContain("not-ready")

        // ── 3. Flip back to ready, then mark draining → 503 + Reason: draining ─
        yield* readiness.markReady(true)
        yield* draining.markDraining
        yield* uac.send(buildOptions("opts-draining@probe", "z9hG4bK-r3"), SIP_PORT, "127.0.0.1")
        yield* pump(2)
        const respDrainPkt = yield* uac.poll()
        expect(respDrainPkt).not.toBeNull()
        const respDrain = parse(respDrainPkt!.raw)
        if (respDrain.type !== "response") throw new Error("expected response")
        expect(respDrain.status).toBe(503)
        const reasonDrain = respDrain.headers.find(
          (h) => h.name.toLowerCase() === "reason"
        )
        expect(reasonDrain).toBeDefined()
        expect(reasonDrain!.value).toMatch(/cause=503/)
        expect(reasonDrain!.value.toLowerCase()).toContain("draining")
        // The text MUST NOT include "not-ready" — the proxy's classifier
        // distinguishes on substring.
        expect(reasonDrain!.value.toLowerCase()).not.toContain("not-ready")

        yield* Fiber.interrupt(routerFiber)
      }).pipe(Effect.provide(stack))
  )
})
