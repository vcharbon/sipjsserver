/**
 * PR1 smoke test: prove the `reusePort` option added to `BindUdpOpts`
 * is accepted (and ignored) by `SignalingNetwork.simulated`, and that
 * standard packet flow still works.
 *
 * The real-socket path is exercised manually via `npm run proxy:dev` and
 * will get full coverage in PR4 (live transparency suite).
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { SignalingNetwork } from "../../../src/sip/SignalingNetwork.js"

const TRANSIT = 10
const layer = SignalingNetwork.simulated({ transitDelayMs: TRANSIT })

describe("sip-front-proxy PR1 — BindUdpOpts.reusePort on simulated fabric", () => {
  it.effect("simulated bindUdp accepts reusePort=true and still delivers", () =>
    Effect.gen(function* () {
      const net = yield* SignalingNetwork
      const a = yield* net.bindUdp({
        ip: "10.0.0.1",
        port: 5070,
        queueMax: 16,
        reusePort: true,
      })
      const b = yield* net.bindUdp({
        ip: "10.0.0.2",
        port: 5070,
        queueMax: 16,
        reusePort: true,
      })

      yield* a.send(Buffer.from("hello-proxy"), 5070, "10.0.0.2")
      yield* TestClock.adjust(`${TRANSIT} millis`)

      const received = yield* b.poll()
      expect(received).not.toBeNull()
      expect(received!.raw.toString()).toBe("hello-proxy")
      expect(received!.rinfo).toEqual({ address: "10.0.0.1", port: 5070 })
      expect(b.counters.enqueued).toBe(1)
    }).pipe(Effect.provide(layer))
  )

  it.effect("omitting reusePort keeps existing behavior (default false, no-op on simulated)", () =>
    Effect.gen(function* () {
      const net = yield* SignalingNetwork
      const a = yield* net.bindUdp({ ip: "10.0.0.3", port: 5070, queueMax: 16 })
      const b = yield* net.bindUdp({ ip: "10.0.0.4", port: 5070, queueMax: 16 })

      yield* a.send(Buffer.from("default"), 5070, "10.0.0.4")
      yield* TestClock.adjust(`${TRANSIT} millis`)

      const received = yield* b.poll()
      expect(received).not.toBeNull()
      expect(received!.raw.toString()).toBe("default")
    }).pipe(Effect.provide(layer))
  )
})
