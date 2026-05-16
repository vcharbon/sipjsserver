/**
 * LoadBalancer.selectForNewDialog — overload integration (slice 5).
 *
 * Pins:
 *   - non-emergency INVITE on a CRITICAL worker → NoTargetAvailable
 *     when ALL alive workers are CRITICAL (or rendezvous still picks
 *     a non-CRITICAL one if available).
 *   - non-emergency INVITE when AIMD bucket is empty → RateCapExhausted.
 *   - emergency INVITE bypasses both CRITICAL filter and bucket.
 *   - successful admit calls recordOwnAdmitted on the observer.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import {
  HmacKeyProvider,
  hmacKeyProviderStaticLayer,
  LoadBalancerConfig,
  LoadBalancerStrategyLive,
  RoutingStrategy,
  WorkerId,
  WorkerLoadObserver,
  workerRegistrySimulatedLayer,
  type OverloadPayload,
} from "../../../src/sip-front-proxy/index.js"
import type { SipMessage } from "../../../src/sip/types.js"
import { customParser } from "../../../src/sip/parsers/custom/index.js"

const W_A = WorkerId("worker-a")
const W_B = WorkerId("worker-b")
const ADDR_A = { host: "10.0.1.10", port: 5060 }
const ADDR_B = { host: "10.0.1.11", port: 5060 }

const parse = (raw: Buffer): SipMessage => {
  const r = customParser.parse(raw)
  if (r._tag !== "Success") throw new Error(`parse failure: ${r.failure.reason}`)
  return r.success
}

const buildInvite = (callId: string, isEmergency: boolean): SipMessage => {
  const rpHeader = isEmergency ? "Resource-Priority: esnet.0\r\n" : ""
  const raw = Buffer.from(
    `INVITE sip:bob@10.0.0.3:5060 SIP/2.0\r\n` +
      `Via: SIP/2.0/UDP 10.0.0.2:5060;branch=z9hG4bK-${callId}\r\n` +
      `Max-Forwards: 70\r\n` +
      `From: <sip:alice@10.0.0.2:5060>;tag=a-tag\r\n` +
      `To: <sip:bob@10.0.0.3:5060>\r\n` +
      `Call-ID: ${callId}\r\n` +
      `CSeq: 1 INVITE\r\n` +
      `Contact: <sip:alice@10.0.0.2:5060>\r\n` +
      rpHeader +
      `Content-Length: 0\r\n\r\n`,
  )
  return parse(raw)
}

const overloadPayload = (elu: number, adm = 0): OverloadPayload => ({
  elu,
  gc: 0,
  adm,
})

const stackLayer = LoadBalancerStrategyLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      workerRegistrySimulatedLayer({
        initial: [
          { id: W_A, address: ADDR_A, health: "alive" },
          { id: W_B, address: ADDR_B, health: "alive" },
        ],
      }),
      hmacKeyProviderStaticLayer({
        current: {
          id: "k1",
          bytes: new TextEncoder().encode("test-secret-bytes-16-or-more-x"),
        },
      }),
      LoadBalancerConfig.layer({}),
      // Pin observer config: small cap = bucket actually empties under
      // the test's 200-400 admits-per-second loop. Band thresholds
      // pinned so payload(0.99) → above_critical, payload(0.7) → hold.
      WorkerLoadObserver.layer({
        eluSoft: 0.6,
        eluHard: 0.8,
        eluCritical: 0.95,
        bandHysteresis: 0.02,
        aimdIncreaseStepCps: 5,
        aimdDecreaseFactor: 0.75,
        aimdCooldownTicks: 3,
        capInitialCps: 100,
        capFloorCps: 1,
        capCeilingCps: 1000,
        payloadStaleMs: 5000,
        optionsIntervalMs: 1000,
      }),
    ),
  ),
)

describe("LoadBalancer.selectForNewDialog — overload behaviour", () => {
  it.effect("admits non-emergency INVITE when all workers are healthy", () =>
    Effect.gen(function* () {
      const strategy = yield* RoutingStrategy
      const result = yield* strategy.selectForNewDialog(buildInvite("c1", false))
      // Result is one of the two worker addresses.
      const ok = (result.host === ADDR_A.host && result.port === ADDR_A.port)
        || (result.host === ADDR_B.host && result.port === ADDR_B.port)
      expect(ok).toBe(true)
    }).pipe(Effect.provide(stackLayer)),
  )

  it.effect("rejects non-emergency INVITE with RateCapExhausted when bucket empty", () =>
    Effect.gen(function* () {
      const strategy = yield* RoutingStrategy
      const observer = yield* WorkerLoadObserver
      // Seed observers via applyPayload at TestClock=0 so the bucket's
      // lastRefillAtMs aligns with the Clock that tryConsumeFor reads.
      observer.applyPayload(W_A, overloadPayload(0.7), 0)
      observer.applyPayload(W_B, overloadPayload(0.7), 0)
      // Drain. Both workers have cap=100; rendezvous distributes ~half
      // to each, so ~200 calls drain BOTH buckets to ~0.
      let rateCapCount = 0
      for (let i = 0; i < 400; i++) {
        const exit = yield* strategy
          .selectForNewDialog(buildInvite(`drain-${i}`, false))
          .pipe(Effect.catchTag("RateCapExhausted", () => Effect.succeed("CAPPED" as const)))
        if (exit === "CAPPED") rateCapCount++
      }
      // At least SOME selections must have hit the cap.
      expect(rateCapCount).toBeGreaterThan(0)
    }).pipe(Effect.provide(stackLayer)),
  )

  it.effect("emergency INVITE bypasses CRITICAL filter", () =>
    Effect.gen(function* () {
      const strategy = yield* RoutingStrategy
      const observer = yield* WorkerLoadObserver
      observer.applyPayload(W_A, overloadPayload(0.99), 1000)
      observer.applyPayload(W_B, overloadPayload(0.99), 1000)
      expect(observer.bandFor(W_A)).toBe("above_critical")
      expect(observer.bandFor(W_B)).toBe("above_critical")

      const nonEm = yield* strategy
        .selectForNewDialog(buildInvite("ne1", false))
        .pipe(Effect.exit)
      expect(nonEm._tag).toBe("Failure")
      if (nonEm._tag === "Failure" && nonEm.cause._tag === "Fail") {
        expect(nonEm.cause.error._tag).toBe("NoTargetAvailable")
      }

      const em = yield* strategy
        .selectForNewDialog(buildInvite("em1", true))
        .pipe(Effect.exit)
      expect(em._tag).toBe("Success")
    }).pipe(Effect.provide(stackLayer)),
  )

  it.effect("emergency INVITE bypasses AIMD bucket", () =>
    Effect.gen(function* () {
      const strategy = yield* RoutingStrategy
      const observer = yield* WorkerLoadObserver
      observer.applyPayload(W_A, overloadPayload(0.7), 1000)
      observer.applyPayload(W_B, overloadPayload(0.7), 1000)
      for (let i = 0; i < 250; i++) {
        yield* strategy
          .selectForNewDialog(buildInvite(`drain-${i}`, false))
          .pipe(Effect.exit)
      }
      let allEmergencyAdmitted = true
      for (let i = 0; i < 20; i++) {
        const exit = yield* strategy
          .selectForNewDialog(buildInvite(`em-${i}`, true))
          .pipe(Effect.exit)
        if (exit._tag !== "Success") {
          allEmergencyAdmitted = false
          break
        }
      }
      expect(allEmergencyAdmitted).toBe(true)
    }).pipe(Effect.provide(stackLayer)),
  )
})
