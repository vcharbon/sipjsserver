/**
 * @vcharbon/sipjs/test-harness — public surface.
 *
 * Curated re-exports for the SIP test harness with auto-started
 * registrar front-proxy. Consumers write scenarios with `alice.register()`
 * / `bob.register()` and run them via [createRegistrarTestProxyRunner],
 * which forwards INVITEs to the consumer's real third-party SIP system
 * on the proxy's core side.
 *
 * Quick-start example:
 *
 * ```ts
 * import { describe, it } from "@effect/vitest"
 * import {
 *   createRegistrarTestProxyRunner,
 *   flushHybridIndexReport,
 *   scenario,
 * } from "@vcharbon/sipjs/test-harness"
 * import { afterAll } from "vitest"
 *
 * const OUTPUT_DIR = "test-results/my-sbc"
 *
 * const runner = createRegistrarTestProxyRunner({
 *   coreDestination: { host: "10.0.1.5", port: 5060 },
 *   advertisedIp: "10.0.1.10",
 *   outputDir: OUTPUT_DIR,
 * })
 *
 * const aliceCallsBob = scenario("alice calls bob", (s) => {
 *   const alice = s.agent("alice", { uri: "sip:alice@example.test", ip: "10.0.1.10", port: 0 })
 *   const bob   = s.agent("bob",   { uri: "sip:bob@example.test",   ip: "10.0.1.10", port: 0 })
 *   alice.register()
 *   bob.register()
 *   const { dialog, transaction } = alice.invite("sip:bob@example.test")
 *   transaction.expect(200)
 *   dialog.ack()
 *   dialog.bye()
 * })
 *
 * describe("my SBC", () => {
 *   afterAll(() => flushHybridIndexReport(OUTPUT_DIR))
 *   it.live("routes alice → bob", () => runner(aliceCallsBob))
 * })
 * ```
 */

// Scenario DSL
export { scenario, sequence, or, ComposableScenario } from "./framework/dsl.js"

// Scenario types
export type {
  Scenario,
  ScenarioResult,
  AgentConfig,
  Step,
  SendStep,
  ExpectStep,
  PauseStep,
  InfraStep,
  K8sStep,
  StepResult,
  StepStatus,
  TestTransport,
  TraceEntry,
  AgentInfo,
  AllowedExtraPattern,
  ScenarioTier,
  Sut,
  SutTarget,
  NetworkTag,
  HeaderOverrides,
  ReceivedPacket,
  Lane,
  LaneKey,
} from "./framework/types.js"
export { TransportError, DEFAULT_NETWORK, ALL_SUTS, DEFAULT_APPLICABLE_SUTS, laneKey } from "./framework/types.js"

// Scenario execution
export { executeScenario } from "./framework/interpreter.js"

// Live UDP transport
export { createLiveTransport } from "./framework/live-backend.js"

// Reports
export { formatReport } from "./framework/report.js"
export { writeScenarioReport, writeIndexReport } from "./framework/html-report.js"
export { writeTextReports } from "./framework/text-report.js"

// One-call convenience for the registrar-front-proxy hybrid use case
export {
  createRegistrarTestProxyRunner,
  createHybridRunner,
  discoverHostReachableIp,
  flushHybridIndexReport,
  hybridProxyCoreDestination,
} from "./hybrid-runner.js"
export type {
  HybridEndpoints,
  HybridRunnerOptions,
  RegistrarTestProxyRunnerOptions,
} from "./hybrid-runner.js"

// Layer-level seam for advanced wiring
export { registrarFrontProxyHybridStackLayer } from "./hybrid-stacks/registrar-front-proxy.js"
