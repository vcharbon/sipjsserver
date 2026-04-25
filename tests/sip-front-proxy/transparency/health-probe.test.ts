/**
 * Transparency: HealthProbe optionsKeepalive — registry annotations.
 *
 * Bind a single fake "worker" UDP endpoint and a `HealthProbe.optionsKeepalive`.
 * Then drive three modes by responding (or not) to the probe's OPTIONS:
 *
 *   1. Reply 200 → registry stays `alive`.
 *   2. Reply 503 + Retry-After: 0 → registry flips to `draining`.
 *   3. Drop OPTIONS for `threshold` × `intervalMs` → registry flips to `dead`.
 *
 * The probe sends OPTIONS at a fixed interval; we drive virtual time
 * with TestClock and use the worker's UDP endpoint to inspect the probe
 * traffic + craft the canned reply.
 */

import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import {
  HealthProbe,
  optionsKeepaliveLayer,
} from "../../../src/sip-front-proxy/health/HealthProbe.js"
import {
  simulatedAdapterLayer,
  WorkerRegistryControl,
} from "../../../src/sip-front-proxy/health/WorkerRegistryControl.js"
import {
  WorkerId,
  WorkerRegistry,
  WorkerRegistrySimulatedControl,
  workerRegistrySimulatedLayer,
  type WorkerHealth,
} from "../../../src/sip-front-proxy/index.js"
import { customParser } from "../../../src/sip/parsers/custom/index.js"
import { SignalingNetwork } from "../../../src/sip/SignalingNetwork.js"
import { generateResponse } from "../../../src/sip/generators.js"
import { serialize } from "../../../src/sip/Serializer.js"
import type { SipRequest } from "../../../src/sip/types.js"

const PROBE_BIND = { ip: "10.0.0.1", port: 5060 }
const WORKER_ADDR = { host: "10.0.1.0", port: 5060 }
const W = WorkerId("w-probe")
const TRANSIT_MS = 1
const INTERVAL_MS = 1_000
const TIMEOUT_MS = 200
const THRESHOLD = 3

const parse = (raw: Buffer) => {
  const r = customParser.parse(raw)
  if (r._tag !== "Success") throw new Error(`parse failure: ${r.failure.reason}`)
  return r.success
}

const buildLayer = () => {
  const Network = SignalingNetwork.simulated({ transitDelayMs: TRANSIT_MS })
  const Registry = workerRegistrySimulatedLayer({
    initial: [{ id: W, address: WORKER_ADDR, health: "alive" }],
  })
  const Control = simulatedAdapterLayer
  const Probe = optionsKeepaliveLayer({
    bindHost: PROBE_BIND.ip,
    bindPort: PROBE_BIND.port,
    intervalMs: INTERVAL_MS,
    timeoutMs: TIMEOUT_MS,
    threshold: THRESHOLD,
  })
  // Compose so the test body sees Network + Registry + Control + Probe.
  // `provideMerge` republishes the inner layer outward; the simulated
  // Registry layer provides BOTH `WorkerRegistry` and
  // `WorkerRegistrySimulatedControl`, which the Control adapter needs
  // and which the test body also pulls.
  const ControlOnRegistry = Control.pipe(Layer.provideMerge(Registry))
  return Probe.pipe(
    Layer.provideMerge(ControlOnRegistry),
    Layer.provideMerge(Network)
  )
}

/**
 * Drain the worker endpoint, respond with `replyFor(req)`. Returns the
 * number of OPTIONS observed in this drain.
 */
const drainAndReply = (
  worker: { poll: () => Effect.Effect<{ raw: Buffer; src: { address: string; port: number } } | null>; send: (buf: Buffer, port: number, host: string) => Effect.Effect<void, unknown> },
  replyFor: (req: SipRequest) => Buffer | null
) =>
  Effect.gen(function* () {
    let observed = 0
    for (let i = 0; i < 16; i++) {
      const pkt = yield* worker.poll()
      if (pkt === null) break
      observed++
      const msg = parse(pkt.raw)
      if (msg.type !== "request" || msg.method !== "OPTIONS") continue
      const reply = replyFor(msg)
      if (reply === null) continue
      yield* worker
        .send(reply, pkt.src.port, pkt.src.address)
        .pipe(Effect.catchCause(() => Effect.void))
    }
    return observed
  })

const okFor = (req: SipRequest): Buffer => {
  const resp = generateResponse(req, 200, "OK", { toTag: "probe-uas" })
  return serialize(resp)
}

const draining503For = (req: SipRequest): Buffer => {
  const resp = generateResponse(req, 503, "Service Unavailable", {
    toTag: "probe-uas",
    extraHeaders: [{ name: "Retry-After", value: "0" }],
  })
  return serialize(resp)
}

const pump = (cycles: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < cycles; i++) {
      yield* Effect.yieldNow
      yield* TestClock.adjust(`${TRANSIT_MS + 1} millis`)
      yield* Effect.yieldNow
    }
  })

const health = (
  registry: WorkerRegistry["Service"]
): Effect.Effect<WorkerHealth | undefined> =>
  registry
    .resolve(W)
    .pipe(Effect.map((opt) => (Option.isNone(opt) ? undefined : opt.value.health)))

describe("transparency: HealthProbe optionsKeepalive", () => {
  it.effect(
    "200 keeps alive; 503 flips draining; threshold timeouts flip dead",
    () =>
      Effect.gen(function* () {
        const probe = yield* HealthProbe
        const registry = yield* WorkerRegistry
        const control = yield* WorkerRegistryControl
        void control // kept in scope so layer holds ref

        const network = yield* SignalingNetwork
        const worker = yield* network
          .bindUdp({ ip: WORKER_ADDR.host, port: WORKER_ADDR.port, queueMax: 32 })
          .pipe(Effect.orDie)

        // Forward worker.messages into a manual queue we can drain at
        // will via worker.poll. The endpoint already supports `poll()`,
        // but we want a side-channel reply path. Use the endpoint
        // directly — it's both poll-able and send-able.
        const respond = (
          replyFor: (req: SipRequest) => Buffer | null
        ): Effect.Effect<number> =>
          drainAndReply(
            {
              poll: () =>
                worker.poll().pipe(
                  Effect.map((pkt) =>
                    pkt === null
                      ? null
                      : {
                          raw: pkt.raw,
                          src: {
                            address: pkt.rinfo.address,
                            port: pkt.rinfo.port,
                          },
                        }
                  )
                ),
              send: (buf, port, host) =>
                worker.send(buf, port, host).pipe(Effect.orDie),
            },
            replyFor
          )

        // Note: do NOT also drain `worker.messages` — `poll()` reads
        // from the same underlying queue, and a side-channel drain
        // would race the test for packets.

        // Probe loop: sleep(intervalMs) → if(enabled) fanOut + sleep(
        // timeoutMs) + reap. Each `oneTick` advances exactly one cycle.
        // Flip the gate first so the very first tick is enabled.
        yield* probe.start

        const oneTick = (replyFor: (req: SipRequest) => Buffer | null) =>
          Effect.gen(function* () {
            // Step 1 — fire the idle sleep. Now probe is mid-tick:
            // OPTIONS in flight, sleeping `timeoutMs`.
            yield* TestClock.adjust(Duration.millis(INTERVAL_MS + 1))
            yield* pump(3)
            // Step 2 — drain OPTIONS at worker, reply.
            yield* respond(replyFor)
            // Step 3 — let reply transit + probe's inbound drain run.
            yield* pump(5)
            // Step 4 — cross `timeoutMs` so the reaper runs.
            yield* TestClock.adjust(Duration.millis(TIMEOUT_MS + 1))
            yield* pump(3)
          })

        // ── 1. Two ticks of 200 OK → alive ──────────────────────────
        yield* oneTick(okFor)
        yield* oneTick(okFor)
        const aliveAfter = yield* health(registry)
        expect(aliveAfter).toBe("alive")

        // ── 2. One tick of 503 → draining ───────────────────────────
        yield* oneTick(draining503For)
        const drainingAfter = yield* health(registry)
        expect(drainingAfter).toBe("draining")

        // ── 3. Threshold ticks with no reply → dead ─────────────────
        // Reset to alive in the registry first; the probe will demote.
        yield* (yield* WorkerRegistrySimulatedControl).setHealth(W, "alive")
        for (let tick = 0; tick < THRESHOLD; tick++) {
          yield* oneTick(() => null)
        }
        const deadAfter = yield* health(registry)
        expect(deadAfter).toBe("dead")
      }).pipe(Effect.provide(buildLayer()))
  )
})
