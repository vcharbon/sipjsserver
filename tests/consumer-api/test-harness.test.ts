/**
 * Consumer-API gate for `@vcharbon/sipjs/test-harness`.
 *
 * Pulls the load-bearing public symbols (DSL, runner factory, types) and
 * builds a minimal `Scenario` to verify the surface compiles and shapes
 * cleanly. Does NOT actually run the proxy / send UDP — that requires a
 * live SUT and is gated under `TEST_MODE=live`. This file's job
 * is to fail when a Slice 2+ refactor accidentally drops a symbol from
 * the published surface.
 */

import { describe, expect, it } from "vitest"

import {
  scenario,
  createRegistrarTestProxyRunner,
  flushHybridIndexReport,
  TransportError,
  DEFAULT_NETWORK,
} from "@vcharbon/sipjs/test-harness"
import type {
  Scenario,
  AgentConfig,
  ScenarioResult,
  RegistrarTestProxyRunnerOptions,
} from "@vcharbon/sipjs/test-harness"

describe("@vcharbon/sipjs/test-harness public surface", () => {
  it("scenario() builds a runnable scenario with two registered agents", () => {
    const aliceConfig: AgentConfig = {
      uri: "sip:alice@example.test",
      ip: "127.0.0.1",
      port: 0,
    }
    const bobConfig: AgentConfig = {
      uri: "sip:bob@example.test",
      ip: "127.0.0.1",
      port: 0,
    }
    const built = scenario("alice and bob register", (s) => {
      const alice = s.agent("alice", aliceConfig)
      const bob = s.agent("bob", bobConfig)
      alice.register()
      bob.register()
    })

    const asScenario: Scenario = built.toScenario()
    expect(asScenario.name).toBe("alice and bob register")
    expect(Object.keys(asScenario.agents)).toEqual(["alice", "bob"])
    expect(asScenario.steps.length).toBeGreaterThan(0)
  })

  it("createRegistrarTestProxyRunner accepts the documented options shape", () => {
    const opts: RegistrarTestProxyRunnerOptions = {
      coreDestination: { host: "10.0.0.1", port: 5060 },
      advertisedIp: "127.0.0.1",
      corePort: 35081,
      outputDir: "test-results/consumer-api-smoke",
      recordRoute: true,
    }
    const runner = createRegistrarTestProxyRunner(opts)
    expect(typeof runner).toBe("function")
  })

  it("re-exports auxiliary symbols", () => {
    expect(typeof flushHybridIndexReport).toBe("function")
    expect(DEFAULT_NETWORK).toBe("ext")
    const err = new TransportError({ message: "bind failed" })
    expect(err._tag).toBe("TransportError")
  })

  it("ScenarioResult shape is reachable as a type", () => {
    const _resultType: ScenarioResult | undefined = undefined
    expect(_resultType).toBeUndefined()
  })
})
