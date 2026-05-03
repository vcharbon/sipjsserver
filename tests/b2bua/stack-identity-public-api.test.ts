/**
 * StackIdentity public-API unit test (Issue 8 of the upstream-consumer
 * plan). Verifies the read-side seam consumers use to populate their
 * own templating layer ($(ip.AS) / $(port.AS) substitution) reads back
 * the configured advertised host/port.
 *
 * The actual SIP message stamping is exercised by the e2e fake-clock
 * suite; this test only pins the public API contract.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { AppConfig, type AppConfigData } from "../../src/config/AppConfig.js"
import { StackIdentity } from "../../src/b2bua/stack-identity.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"

describe("StackIdentity public read-API", () => {
  it.effect(
    "advertisedHost / advertisedPort match the configured AppConfig values",
    () =>
      Effect.gen(function* () {
        const cfg: AppConfigData = testAppConfigDefaults({
          sipLocalIp: "10.20.30.40",
          sipLocalPort: 35060,
        })
        const program = Effect.gen(function* () {
          const identity = yield* StackIdentity
          const host = yield* identity.advertisedHost
          const port = yield* identity.advertisedPort
          return { host, port }
        })
        const result = yield* program.pipe(
          Effect.provide(
            StackIdentity.Default.pipe(Layer.provide(Layer.succeed(AppConfig, cfg))),
          ),
        )
        expect(result).toEqual({ host: "10.20.30.40", port: 35060 })
      }),
  )

  it.effect(
    "default (testAppConfigDefaults) is reachable end-to-end",
    () =>
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          const identity = yield* StackIdentity
          return {
            host: yield* identity.advertisedHost,
            port: yield* identity.advertisedPort,
          }
        })
        const result = yield* program.pipe(
          Effect.provide(
            StackIdentity.Default.pipe(
              Layer.provide(Layer.succeed(AppConfig, testAppConfigDefaults())),
            ),
          ),
        )
        expect(typeof result.host).toBe("string")
        expect(typeof result.port).toBe("number")
      }),
  )
})
