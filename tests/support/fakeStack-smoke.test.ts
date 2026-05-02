import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { CallState } from "../../src/call/CallState.js"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import { SipRouter } from "../../src/sip/SipRouter.js"
import { UdpTransport } from "../../src/sip/UdpTransport.js"
import { fakeStackLayer } from "./fakeStack.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"

describe("fakeStackLayer", () => {
  it.effect("exposes router + shared SignalingNetwork", () =>
    Effect.gen(function* () {
      const network = yield* SignalingNetwork
      const router = yield* SipRouter
      const callState = yield* CallState
      const udp = yield* UdpTransport

      expect(typeof network.bindUdp).toBe("function")
      expect(typeof router.start).toBe("function")
      expect(typeof callState.stats).toBe("function")
      expect(udp.metrics.queueMax).toBeGreaterThan(0)

      // Verify agent binding + B2BUA binding share the same fabric.
      const ep = yield* network.bindUdp({ ip: "127.0.0.1", port: 15661, queueMax: 16 })
      yield* ep.send(Buffer.from("PING"), 15060, "127.0.0.1")
      // UdpTransport is bound at sipLocalIp:sipLocalPort — if both sides see
      // the same fabric, drainUndeliverable should be empty.
      const undelivered = yield* network.drainUndeliverable()
      expect(undelivered.length).toBe(0)
    }).pipe(
      Effect.provide(
        fakeStackLayer({
          config: testAppConfigDefaults({
            sipLocalIp: "127.0.0.1",
            sipLocalPort: 15060,
          }),
        })
      )
    )
  )
})
