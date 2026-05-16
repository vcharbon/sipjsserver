/**
 * Transparency: HealthProbe late-reply recovery.
 *
 * Regression for the k8s endurance run on 2026-05-05 (seed
 * `1777960808113`). Under sustained UDP traffic the front proxy probe
 * could mark every worker `dead` on its probe-side health and never
 * recover — the only re-marking path (`inboundDrain` matching
 * `pendingByCallId[callId]`) was being short-circuited because every
 * late-but-valid 200 OK arrived AFTER `reapTimeouts` had already
 * cleared the matching pending entry. Late replies were therefore
 * silently discarded, and once a worker crossed `threshold` it
 * stayed `dead` for the rest of the run.
 *
 * The race is reproduced deterministically here by setting
 * `TRANSIT_MS > TIMEOUT_MS` so the OPTIONS request itself does not
 * even reach the worker before `reapTimeouts` has fired. Every reply
 * is therefore late and the post-reap fallback path in `inboundDrain`
 * is the only thing that can keep the worker alive.
 *
 * See `docs/plan/health-probe-recovery-race-fix.md`.
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
  WorkerLoadObserver,
  WorkerRegistry,
  WorkerRegistrySimulatedControl,
  workerRegistrySimulatedLayer,
  type WorkerHealth,
} from "../../../src/sip-front-proxy/index.js"
import { customParser } from "../../../src/sip/parsers/custom/index.js"
import { SignalingNetwork } from "../../../src/sip/SignalingNetwork.js"
import {
  generateOutOfDialogRequest,
  generateResponse,
} from "../../../src/sip/generators.js"
import { serialize } from "../../../src/sip/Serializer.js"
import type { SipRequest } from "../../../src/sip/types.js"

const PROBE_BIND = { ip: "10.0.0.1", port: 5060 }
const WORKER_ADDR = { host: "10.0.1.0", port: 5060 }
const W = WorkerId("w-probe")

// Force the race: every reply lands AFTER `reapTimeouts` has fired
// because OPTIONS itself takes longer than `timeoutMs` to even reach
// the worker.
const TRANSIT_MS = 300
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
  const ControlOnRegistry = Control.pipe(Layer.provideMerge(Registry))
  return Probe.pipe(
    Layer.provide(WorkerLoadObserver.layer()),
    Layer.provideMerge(ControlOnRegistry),
    Layer.provideMerge(Network)
  )
}

const okFor = (req: SipRequest): Buffer => {
  const resp = generateResponse(req, 200, "OK", { toTag: "probe-uas" })
  return serialize(resp)
}

const health = (
  registry: WorkerRegistry["Service"]
): Effect.Effect<WorkerHealth | undefined> =>
  registry
    .resolve(W)
    .pipe(Effect.map((opt) => (Option.isNone(opt) ? undefined : opt.value.health)))

/**
 * Build a synthetic 200 OK carrying the given Call-ID. Used by the
 * spoofing test to inject a packet directly at the probe without
 * going through the real fanOut → reap cycle.
 */
const synthetic200 = (callId: string): Buffer => {
  const fakeOptions = generateOutOfDialogRequest("OPTIONS", {
    requestUri: `sip:${WORKER_ADDR.host}:${WORKER_ADDR.port}`,
    callId,
    fromUri: `sip:probe@${PROBE_BIND.ip}`,
    fromTag: "spoof-from",
    toUri: `sip:probe@${WORKER_ADDR.host}:${WORKER_ADDR.port}`,
    cseq: 1,
    via: {
      localIp: PROBE_BIND.ip,
      localPort: PROBE_BIND.port,
      transport: "UDP",
      branch: "z9hG4bK-spoof",
    },
    contact: {
      user: "probe",
      host: PROBE_BIND.ip,
      port: PROBE_BIND.port,
    },
  })
  const resp = generateResponse(fakeOptions, 200, "OK", { toTag: "spoof-uas" })
  return serialize(resp)
}

const settle = Effect.gen(function* () {
  // Multiple yieldNows give the simulated transit fibers time to
  // run deliver() and the probe's inboundDrain time to consume.
  for (let i = 0; i < 8; i++) yield* Effect.yieldNow
})

describe("transparency: HealthProbe late-reply recovery", () => {
  it.effect(
    "late replies past the reap window keep the worker alive (regression: k8s endurance 2026-05-05)",
    () =>
      Effect.gen(function* () {
        const probe = yield* HealthProbe
        const registry = yield* WorkerRegistry
        // Hold the control in scope so the layer keeps providing it.
        void (yield* WorkerRegistryControl)

        const network = yield* SignalingNetwork
        const worker = yield* network
          .bindUdp({ ip: WORKER_ADDR.host, port: WORKER_ADDR.port, queueMax: 64 })
          .pipe(Effect.orDie)

        const respond = (replyFor: (req: SipRequest) => Buffer | null) =>
          Effect.gen(function* () {
            for (let i = 0; i < 16; i++) {
              const pkt = yield* worker.poll()
              if (pkt === null) break
              const msg = parse(pkt.raw)
              if (msg.type !== "request" || msg.method !== "OPTIONS") continue
              const reply = replyFor(msg)
              if (reply === null) continue
              yield* worker
                .send(reply, pkt.rinfo.port, pkt.rinfo.address)
                .pipe(Effect.catchCause(() => Effect.void))
            }
          })

        yield* probe.start

        // ── Initial alignment ───────────────────────────────────────────
        // Advance past the FIRST fanOut + FIRST reap.
        //   t=INTERVAL_MS                — fanOut0 fires, OPTIONS0 in flight
        //   t=INTERVAL_MS + TIMEOUT_MS   — reap0 fires (consecutiveMisses=1)
        // OPTIONS0 still has TRANSIT_MS - TIMEOUT_MS ms to go before the
        // worker queue can see it.
        yield* settle
        yield* TestClock.adjust(Duration.millis(INTERVAL_MS))
        yield* settle
        yield* TestClock.adjust(Duration.millis(TIMEOUT_MS))
        yield* settle

        // ── Per-cycle pacing ─────────────────────────────────────────────
        // Each `cycle` handles the previous cycle's late reply, then
        // advances exactly `INTERVAL_MS + TIMEOUT_MS` so the loop ends
        // just past the next reap (invariant: clock is one step past the
        // most recent reap, sleep(intervalMs) just started).
        //
        //   Phase A: TRANSIT_MS - TIMEOUT_MS + 1   — OPTIONS arrives at worker
        //   Phase B: drain + reply                  — worker sends reply
        //   Phase C: TRANSIT_MS + 1                 — reply lands at probe
        //                                             (LATE — no pending entry)
        //   Phase D: remainder                      — next fanOut + reap fire
        const PHASE_A_C_MS = (TRANSIT_MS - TIMEOUT_MS + 1) + (TRANSIT_MS + 1)
        const PHASE_D_MS = INTERVAL_MS + TIMEOUT_MS - PHASE_A_C_MS

        const cycle = (replyFor: (req: SipRequest) => Buffer | null) =>
          Effect.gen(function* () {
            yield* settle
            yield* TestClock.adjust(
              Duration.millis(TRANSIT_MS - TIMEOUT_MS + 1)
            )
            yield* settle
            yield* respond(replyFor)
            yield* settle
            yield* TestClock.adjust(Duration.millis(TRANSIT_MS + 1))
            yield* settle
            yield* TestClock.adjust(Duration.millis(PHASE_D_MS))
            yield* settle
          })

        // The worker answers EVERY OPTIONS, but the reply always lands
        // after the matching reap. Without the fallback fix, miss counter
        // walks to threshold and the worker is marked `dead`. With the
        // fix, the late-reply fallback resets the miss counter and
        // re-marks `alive` on every cycle.
        const TICKS = THRESHOLD + 2
        for (let i = 0; i < TICKS; i++) {
          yield* cycle(okFor)
        }

        const finalHealth = yield* health(registry)
        expect(finalHealth).toBe("alive")
      }).pipe(Effect.provide(buildLayer()))
  )

  it.effect(
    "stable alive across 10 cycles of sustained late replies",
    () =>
      Effect.gen(function* () {
        const probe = yield* HealthProbe
        const registry = yield* WorkerRegistry
        void (yield* WorkerRegistryControl)

        const network = yield* SignalingNetwork
        const worker = yield* network
          .bindUdp({ ip: WORKER_ADDR.host, port: WORKER_ADDR.port, queueMax: 64 })
          .pipe(Effect.orDie)

        const respond = (replyFor: (req: SipRequest) => Buffer | null) =>
          Effect.gen(function* () {
            for (let i = 0; i < 16; i++) {
              const pkt = yield* worker.poll()
              if (pkt === null) break
              const msg = parse(pkt.raw)
              if (msg.type !== "request" || msg.method !== "OPTIONS") continue
              const reply = replyFor(msg)
              if (reply === null) continue
              yield* worker
                .send(reply, pkt.rinfo.port, pkt.rinfo.address)
                .pipe(Effect.catchCause(() => Effect.void))
            }
          })

        yield* probe.start

        yield* settle
        yield* TestClock.adjust(Duration.millis(INTERVAL_MS))
        yield* settle
        yield* TestClock.adjust(Duration.millis(TIMEOUT_MS))
        yield* settle

        const PHASE_A_C_MS = (TRANSIT_MS - TIMEOUT_MS + 1) + (TRANSIT_MS + 1)
        const PHASE_D_MS = INTERVAL_MS + TIMEOUT_MS - PHASE_A_C_MS

        const cycle = (replyFor: (req: SipRequest) => Buffer | null) =>
          Effect.gen(function* () {
            yield* settle
            yield* TestClock.adjust(
              Duration.millis(TRANSIT_MS - TIMEOUT_MS + 1)
            )
            yield* settle
            yield* respond(replyFor)
            yield* settle
            yield* TestClock.adjust(Duration.millis(TRANSIT_MS + 1))
            yield* settle
            yield* TestClock.adjust(Duration.millis(PHASE_D_MS))
            yield* settle
          })

        for (let i = 0; i < 10; i++) {
          yield* cycle(okFor)
          const h = yield* health(registry)
          expect(h).toBe("alive")
        }
      }).pipe(Effect.provide(buildLayer()))
  )

  it.effect(
    "spoofed Call-ID cannot revive a dead worker; properly-prefixed packet does",
    () =>
      Effect.gen(function* () {
        const probe = yield* HealthProbe
        const registry = yield* WorkerRegistry
        const simControl = yield* WorkerRegistrySimulatedControl
        void (yield* WorkerRegistryControl)

        const network = yield* SignalingNetwork
        const worker = yield* network
          .bindUdp({ ip: WORKER_ADDR.host, port: WORKER_ADDR.port, queueMax: 64 })
          .pipe(Effect.orDie)

        yield* probe.start

        // Force worker `dead` directly so we exercise ONLY the fallback
        // identification path in `inboundDrain` (no real OPTIONS in
        // flight, no pending entry).
        yield* simControl.setHealth(W, "dead")
        const dead0 = yield* health(registry)
        expect(dead0).toBe("dead")

        // Send a synthetic 200 OK from worker → probe and let it transit
        // through the simulated fabric + the probe's inboundDrain.
        const inject = (raw: Buffer) =>
          Effect.gen(function* () {
            yield* worker
              .send(raw, PROBE_BIND.port, PROBE_BIND.ip)
              .pipe(Effect.catchCause(() => Effect.void))
            yield* settle
            yield* TestClock.adjust(Duration.millis(TRANSIT_MS + 1))
            yield* settle
          })

        // 1. Spoof: Call-ID does NOT match `probe-` prefix → ignored.
        yield* inject(synthetic200("evil-totally-not-a-probe-callid@attacker"))
        const afterSpoof = yield* health(registry)
        expect(afterSpoof).toBe("dead")

        // 2. Properly-prefixed but unknown WorkerId → ignored (registry
        //    resolves to None).
        yield* inject(
          synthetic200(`probe-w-unknown-1234-deadbeef@${PROBE_BIND.ip}`)
        )
        const afterUnknown = yield* health(registry)
        expect(afterUnknown).toBe("dead")

        // 3. Properly-prefixed, registered WorkerId → recovers to alive.
        yield* inject(
          synthetic200(`probe-${W}-9999-cafebabe@${PROBE_BIND.ip}`)
        )
        const afterValid = yield* health(registry)
        expect(afterValid).toBe("alive")
      }).pipe(Effect.provide(buildLayer()))
  )
})
