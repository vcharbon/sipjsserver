/**
 * Tier 1 overload-brake coverage for the `UdpTransport` facade.
 *
 * Flavor: direct, end-to-end-through-the-fabric. Instead of driving the full
 * B2BUA router, we stand up one `UdpTransport` (bound on the simulated
 * `SignalingNetwork`) and one raw flooder endpoint, and we simply never
 * drain the B2BUA's ingress stream — so the bounded queue fills past the
 * Tier 1 threshold and later INVITEs must be stateless-503'd.
 *
 * This exercises the code that moved from a one-off pre-parse path in
 * the old `UdpTransport` into the new `preIngress` hook wiring (see
 * `src/sip/UdpTransport.ts`): INVITE classification, emergency bypass,
 * 503 template, `dropsTier1Brake` / `tier1RejectSent` counters.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AppConfig, type AppConfigData } from "../../src/config/AppConfig.js"
import { MetricsRegistry } from "../../src/observability/MetricsRegistry.js"
import { SignalingNetwork, type UdpEndpoint } from "../../src/sip/SignalingNetwork.js"
import { UdpTransport } from "../../src/sip/UdpTransport.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"

const TRANSIT_MS = 15
const QUEUE_MAX = 5
// Tier 1 threshold = floor(QUEUE_MAX * TIER1_PCT / 100) = floor(5 * 40 / 100) = 2
const TIER1_PCT = 40
const B2BUA_IP = "127.0.0.1"
const B2BUA_PORT = 5060
const FLOODER_IP = "10.0.0.1"
const FLOODER_PORT = 5555

function testConfig(overrides?: Partial<AppConfigData>): AppConfigData {
  return testAppConfigDefaults({
    sipLocalIp: B2BUA_IP,
    sipLocalPort: B2BUA_PORT,
    redisKeyPrefix: "test",
    cdrFilePath: "/tmp/cdr.jsonl",
    httpStatusPort: 3002,
    callControlUrl: "http://localhost:3002",
    udpQueueMax: QUEUE_MAX,
    udpQueueTier1ThresholdPct: TIER1_PCT,
    retryAfterJitterSec: 0,
    ...overrides,
  })
}

/**
 * Build a minimal valid INVITE buffer. If `opts.emergency` is true, we
 * add a Resource-Priority header with `esnet.0` — the canonical marker
 * that `bufferHasEmergencyMarker` looks for.
 */
function buildInviteBuffer(i: number, opts?: { emergency?: boolean }): Buffer {
  const lines: string[] = [
    `INVITE sip:bob@${B2BUA_IP}:${B2BUA_PORT} SIP/2.0`,
    `Via: SIP/2.0/UDP ${FLOODER_IP}:${FLOODER_PORT};branch=z9hG4bK-brake-${i}`,
    `From: <sip:alice@flooder.test>;tag=alice-tag-${i}`,
    `To: <sip:bob@b2bua.test>`,
    `Call-ID: brake-test-${i}@${FLOODER_IP}`,
    `CSeq: 1 INVITE`,
    `Contact: <sip:alice@${FLOODER_IP}:${FLOODER_PORT}>`,
    `Max-Forwards: 70`,
  ]
  if (opts?.emergency) {
    lines.push(`Resource-Priority: esnet.0`)
  }
  lines.push(`Content-Length: 0`, "", "")
  return Buffer.from(lines.join("\r\n"), "ascii")
}

function buildOptionsBuffer(i: number): Buffer {
  const lines = [
    `OPTIONS sip:bob@${B2BUA_IP}:${B2BUA_PORT} SIP/2.0`,
    `Via: SIP/2.0/UDP ${FLOODER_IP}:${FLOODER_PORT};branch=z9hG4bK-opts-${i}`,
    `From: <sip:alice@flooder.test>;tag=opt-${i}`,
    `To: <sip:bob@b2bua.test>`,
    `Call-ID: opts-${i}@${FLOODER_IP}`,
    `CSeq: 1 OPTIONS`,
    `Max-Forwards: 70`,
    `Content-Length: 0`,
    "",
    "",
  ]
  return Buffer.from(lines.join("\r\n"), "ascii")
}

/** Extract status line (first line) from a buffer as a string. */
function statusLine(raw: Buffer): string {
  const end = raw.indexOf("\r\n")
  return raw.subarray(0, end === -1 ? raw.length : end).toString("ascii")
}

/**
 * Bind a flooder endpoint on the same simulated fabric as the B2BUA's
 * UdpTransport. The SignalingNetwork service is shared via the test layer.
 */
const bindFlooder = Effect.gen(function* () {
  const network = yield* SignalingNetwork
  return yield* network.bindUdp({
    ip: FLOODER_IP,
    port: FLOODER_PORT,
    queueMax: 64,
  })
})

/** Collect exactly `n` packets from an endpoint's stream as an array. */
const collectN = (ep: UdpEndpoint, n: number) =>
  ep.messages.pipe(Stream.take(n), Stream.runCollect)

/**
 * Compose the full dependency stack for a brake test: shared simulated
 * fabric + AppConfig + MetricsRegistry + UdpTransport bound on the fabric.
 * Provided once at the test level so every binding (UdpTransport and the
 * flooder endpoint below) sees the same routing table.
 */
const brakeLayers = (configOverrides?: Partial<AppConfigData>) => {
  const NetworkLayer = SignalingNetwork.simulated({ transitDelayMs: TRANSIT_MS })
  const AppConfigLayer = Layer.succeed(AppConfig, testConfig(configOverrides))
  const UdpLayer = UdpTransport.layer.pipe(
    Layer.provide(AppConfigLayer),
    Layer.provide(MetricsRegistry.layer),
    Layer.provide(NetworkLayer)
  )
  // Re-export both UdpTransport (from UdpLayer) and the underlying
  // SignalingNetwork (from NetworkLayer) at the top of the merge, so the
  // flooder endpoint can yield the same network instance UdpTransport bound on.
  return Layer.mergeAll(UdpLayer, NetworkLayer, AppConfigLayer)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UdpTransport — Tier 1 overload brake", () => {
  it.effect(
    "non-emergency INVITEs past the threshold receive a stateless 503",
    () =>
      Effect.gen(function* () {
        const udp = yield* UdpTransport
        const flooder = yield* bindFlooder

        // Flood 10 INVITEs. Each send forks a TRANSIT_MS-delayed delivery
        // into the fabric; nothing drains the B2BUA ingress stream, so
        // once queue depth crosses the threshold (2), every subsequent
        // INVITE takes the reply path.
        const floodCount = 10
        for (let i = 0; i < floodCount; i++) {
          yield* flooder.send(buildInviteBuffer(i), B2BUA_PORT, B2BUA_IP)
        }

        // One hop of transit: all 10 arrival forks fire simultaneously.
        // Second hop: the 503 reply deliveries back to flooder land.
        yield* TestClock.adjust(`${TRANSIT_MS} millis`)
        yield* TestClock.adjust(`${TRANSIT_MS} millis`)

        // preIngress saw depth=0,1 for the first two packets (accepted)
        // and depth=2 for every packet after (≥ threshold → reply 503).
        const expectedRejects = floodCount - 2
        expect(udp.metrics.dropsTier1Brake).toBe(expectedRejects)
        expect(udp.metrics.tier1RejectSent).toBe(expectedRejects)
        expect(udp.metrics.queueDepth).toBe(2)

        // Flooder should have received exactly `expectedRejects` 503s back.
        const replies = yield* collectN(flooder, expectedRejects)
        expect(replies.length).toBe(expectedRejects)
        for (const pkt of replies) {
          const line = statusLine(pkt.raw)
          expect(line.startsWith("SIP/2.0 503")).toBe(true)
          expect(pkt.rinfo).toEqual({ address: B2BUA_IP, port: B2BUA_PORT })
        }
      }).pipe(Effect.provide(brakeLayers()))
  )

  it.effect(
    "emergency INVITEs bypass the brake even when above the threshold",
    () =>
      Effect.gen(function* () {
        const udp = yield* UdpTransport
        const flooder = yield* bindFlooder

        // First send 2 non-emergency INVITEs (accepted, fill up to threshold),
        // then send one emergency INVITE that would otherwise trip the brake.
        yield* flooder.send(buildInviteBuffer(0), B2BUA_PORT, B2BUA_IP)
        yield* flooder.send(buildInviteBuffer(1), B2BUA_PORT, B2BUA_IP)
        yield* flooder.send(
          buildInviteBuffer(2, { emergency: true }),
          B2BUA_PORT,
          B2BUA_IP
        )
        yield* TestClock.adjust(`${TRANSIT_MS} millis`)

        // All three should have been enqueued. No reject sent.
        expect(udp.metrics.dropsTier1Brake).toBe(0)
        expect(udp.metrics.tier1RejectSent).toBe(0)
        expect(udp.metrics.queueDepth).toBe(3)
      }).pipe(Effect.provide(brakeLayers()))
  )

  it.effect("non-INVITE requests are not 503'd by the brake", () =>
    Effect.gen(function* () {
      const udp = yield* UdpTransport
      const flooder = yield* bindFlooder

      // Saturate with INVITEs so the queue is at / above threshold,
      // then fire an OPTIONS — should accept (brake only targets new INVITEs).
      for (let i = 0; i < 5; i++) {
        yield* flooder.send(buildInviteBuffer(i), B2BUA_PORT, B2BUA_IP)
      }
      yield* flooder.send(buildOptionsBuffer(0), B2BUA_PORT, B2BUA_IP)
      yield* TestClock.adjust(`${TRANSIT_MS} millis`)
      yield* TestClock.adjust(`${TRANSIT_MS} millis`)

      // Brake rejected 3 of the 5 INVITEs (depth >= 2 for indexes 2..4).
      expect(udp.metrics.tier1RejectSent).toBe(3)

      // Flooder receives 3 x 503 (for the rejected INVITEs). The OPTIONS
      // should have been enqueued at the B2BUA — so no extra reply was sent.
      const replies = yield* collectN(flooder, 3)
      expect(replies.length).toBe(3)
      for (const pkt of replies) {
        expect(statusLine(pkt.raw).startsWith("SIP/2.0 503")).toBe(true)
      }
    }).pipe(Effect.provide(brakeLayers()))
  )
})
