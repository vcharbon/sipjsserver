/**
 * Test harness — B2BUA lifecycle management for E2E tests.
 *
 * Provides Effect-based helpers that handle transport setup, scenario
 * execution, report generation, and assertion in a single pipeline.
 *
 * The simulated runner uses TestClock to drive virtual time forward
 * during scenario `pause()` steps. This makes time-dependent tests
 * (keepalive timeouts, no-answer timers, retransmits) effectively
 * instant: a `pause(60_000)` becomes a TestClock.adjust("60 seconds")
 * that runs in microseconds while still firing all the B2BUA's timer
 * fibers in the expected order — because the B2BUA itself runs inside
 * the same Effect runtime as the test, sharing the same TestClock.
 */

import { Effect } from "effect"
import type { Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import type { AppConfigData } from "../../src/config/AppConfig.js"
import { CallState } from "../../src/call/CallState.js"
import { CdrWriter } from "../../src/cdr/CdrWriter.js"
import type { Scenario, ScenarioResult } from "../fullcall/framework/types.js"
import { executeScenario } from "../fullcall/framework/interpreter.js"
import { createSimulatedTransport, type Sut } from "../fullcall/framework/simulated-backend.js"
import { createLiveTransport } from "../fullcall/framework/live-backend.js"
import { formatReport } from "../fullcall/framework/report.js"
import { writeScenarioReport, writeIndexReport } from "../fullcall/framework/html-report.js"
import { writeTextReports } from "../fullcall/framework/text-report.js"
import { HA_PROXY_ADDR } from "./proxyB2bFakeStack.js"
import { K8S_PROXY_ADDR } from "./k8sFakeStack.js"
import {
  CORE_INGRESS as REGISTRAR_CORE_INGRESS,
  EXT_INGRESS as REGISTRAR_EXT_INGRESS,
} from "./registrarFrontProxyFakeStack.js"

export type { Sut }

// ---------------------------------------------------------------------------
// Per-scenario clean-termination assertion
// ---------------------------------------------------------------------------
//
// After every fake-clock scenario, the harness asserts:
//   1. The number of CDR records written equals the number of calls created
//      (default: every created call produced exactly one CDR — proof the
//      rule-engine cleanup path or the framework invariant drove the call
//      to `terminated` and `write-cdr` fired).
//   2. The orphan sweep never had to recover anything (counter stays 0).
//
// Both are sentinels for the leak class fixed in Slices 1-4: a regression
// to any of those layers shows up here as a per-scenario failure naming
// the scenario, instead of being silently masked by sweep recovery.
//
// Per-scenario overrides (call before the scenario runs, e.g. at module top
// level alongside the scenario import):
//   skipCdrCheck("scenario-name")        // multi-worker SUTs, intentional partial-call tests
//   expectCdrCount("scenario-name", 2)   // scenarios that legitimately create more than one call
//   expectNoCdr("scenario-name")         // scenarios that explicitly assert no CDR is written

const cdrCheckSkippedScenarios = new Set<string>()
const expectedCdrCounts = new Map<string, number>()

/** Opt out of the CDR / orphan-sweep clean-termination assertion. */
export function skipCdrCheck(scenarioName: string): void {
  cdrCheckSkippedScenarios.add(scenarioName)
}

/** Expect a specific CDR record count after the scenario settles. */
export function expectCdrCount(scenarioName: string, count: number): void {
  expectedCdrCounts.set(scenarioName, count)
}

/** Shorthand for `expectCdrCount(scenarioName, 0)`. */
export function expectNoCdr(scenarioName: string): void {
  expectedCdrCounts.set(scenarioName, 0)
}

const assertCleanCallTermination = (scenarioName: string) =>
  Effect.gen(function* () {
    if (cdrCheckSkippedScenarios.has(scenarioName)) return
    const cdr = yield* CdrWriter
    const records = yield* cdr.readAll
    const explicitExpected = expectedCdrCounts.get(scenarioName)

    // Multi-worker SUTs don't expose CallState at the harness scope (per-worker
    // services are hidden inside Layer.effectDiscard wrappers). Try to read it;
    // if absent, fall back to the explicit `expectCdrCount` only.
    const callStateOpt = yield* Effect.serviceOption(CallState)
    const stats = callStateOpt._tag === "Some" ? callStateOpt.value.statsSync() : undefined

    const expected = explicitExpected ?? stats?.total
    if (expected === undefined) {
      throw new Error(
        `[${scenarioName}] CDR completeness check: no CallState in scope and no expectCdrCount set. ` +
          `Multi-worker SUT scenarios must call expectCdrCount("${scenarioName}", n) to declare ` +
          `the expected total CDR count across all workers.`
      )
    }
    if (records.length !== expected) {
      const ctx = stats
        ? ` (callsCreated=${stats.total}, removeInvocations=${stats.removeInvocations}, concurrent=${stats.concurrent})`
        : ""
      throw new Error(
        `[${scenarioName}] CDR completeness check failed: ` +
          `expected ${expected} CDR record(s), got ${records.length}${ctx}`
      )
    }
    if (stats !== undefined && stats.orphanSweepRecoveredCount > 0) {
      throw new Error(
        `[${scenarioName}] orphan sweep recovered ${stats.orphanSweepRecoveredCount} call(s) — ` +
          `the rule-engine cleanup path missed them; investigate before merging`
      )
    }
  })

// ---------------------------------------------------------------------------
// Result collection (per output directory)
// ---------------------------------------------------------------------------

const resultsByDir = new Map<string, ScenarioResult[]>()

function recordResult(result: ScenarioResult, outputDir: string, expectFailure = false): void {
  // For negative-harness scenarios that failed as expected, skip the verbose
  // text files — they are noisy and expected to be wrong. Only write the HTML.
  const textFilenames =
    expectFailure && result.failed > 0 ? [] : writeTextReports(result, outputDir)
  writeScenarioReport(result, outputDir, textFilenames)
  let arr = resultsByDir.get(outputDir)
  if (!arr) {
    arr = []
    resultsByDir.set(outputDir, arr)
  }
  arr.push(result)
}

/**
 * Write the index report from all collected results for the given directory.
 * Call this in `afterAll` to generate the master index page.
 */
export function flushIndexReport(outputDir: string): void {
  const results = resultsByDir.get(outputDir) ?? []
  if (results.length > 0) {
    writeIndexReport(results, outputDir)
  }
}

// ---------------------------------------------------------------------------
// Common runner shell
// ---------------------------------------------------------------------------

// Promote any transport-level Error to a defect — at the harness layer
// these are infrastructure failures, not assertion errors. Tests should
// either pass or throw an assertion (handled below in
// assertScenarioPassed/Failed); they should not have a typed error
// channel that vitest doesn't know how to surface.
const runScoped = <A, E>(eff: Effect.Effect<A, E, Scope.Scope>): Effect.Effect<A, never> =>
  Effect.orDie(Effect.scoped(eff))

// ---------------------------------------------------------------------------
// Simulated backend (in-process B2BUA, TestClock-driven)
// ---------------------------------------------------------------------------

export function createSimulatedRunner(opts?: {
  sipPort?: number
  httpPort?: number
  configOverrides?: Partial<AppConfigData> | undefined
  realClock?: boolean
  outputDir?: string
  /**
   * SUT topology to run scenarios against. `b2bonly` (default) talks to
   * a bare B2BUA; `proxy+b2b` puts a `ProxyCore` in front of one
   * B2BUA worker on the same SignalingNetwork. Reports land under
   * `<outputDir>/<sut>/` so the two runs don't overwrite each other.
   */
  sut?: Sut
}) {
  const sipPort = opts?.sipPort ?? 15060
  const httpPort = opts?.httpPort ?? 13002
  const sut: Sut = opts?.sut ?? "b2bonly"
  const baseOutputDir = opts?.outputDir ?? "test-results"
  const outputDir = opts?.sut !== undefined ? `${baseOutputDir}/${sut}` : baseOutputDir

  // Use TestClock.adjust so scenario pauses are virtual — the B2BUA's
  // own timer fibers run inside the same Effect runtime and share this
  // TestClock, so adjusting it fires every pending Timer A/B/E/F/no-
  // answer/keepalive that should have elapsed.
  //
  // Step in 100 chunks rather than one large adjust so that forked
  // fibers (notably the 15ms simulated-network delivery delay) observe
  // intermediate time values and get interleaved wakeups — a single
  // large adjust would fire all due timers atomically at the target
  // time, masking ordering issues that occur when messages arrive
  // spaced out in virtual time.
  const clockSleep: (ms: number) => Effect.Effect<void> = opts?.realClock
    ? (ms: number) => Effect.sleep(`${ms} millis`)
    : (ms: number) =>
        Effect.gen(function* () {
          let remaining = ms
          while (remaining > 0) {
            const step = remaining < 100 ? remaining : 100
            yield* TestClock.adjust(`${step} millis`)
            remaining -= step
          }
        })

  const realClock = opts?.realClock === true
  const transportOpts: Parameters<typeof createSimulatedTransport>[0] =
    opts?.configOverrides !== undefined
      ? { sipPort, httpPort, configOverrides: opts.configOverrides, clockSleep, realClock, sut }
      : { sipPort, httpPort, clockSleep, realClock, sut }
  const transport = createSimulatedTransport(transportOpts)
  // SUT ingress address — used by scenario steps that send their
  // initial INVITE without specifying a destination explicitly. The
  // sipproxyHA SUT exposes its proxy on a non-loopback subnet IP; the
  // registrarFrontProxy SUT exposes its ext-side ingress on a 10.30
  // subnet IP; the legacy SUTs keep 127.0.0.1.
  const target =
    sut === "sipproxyHA"
      ? { host: HA_PROXY_ADDR.host, port: HA_PROXY_ADDR.port }
      : sut === "k8sFailover"
        ? { host: K8S_PROXY_ADDR.host, port: K8S_PROXY_ADDR.port }
        : sut === "registrarFrontProxy"
          ? { host: REGISTRAR_EXT_INGRESS.host, port: REGISTRAR_EXT_INGRESS.port }
          : { host: "127.0.0.1", port: sipPort }

  return (scenario: Scenario): Effect.Effect<void> => {
    // Provide the simulated stack at the *outer* runScoped scope — NOT
    // inside `transport.setup`. UdpTransport's `bindUdp` is a scoped
    // resource; if we provided the layer only around setup, its scope
    // would close the moment setup returned and the bound endpoint
    // would vanish out from under every agent's subsequent `send`.
    //
    // Per-agent target resolution (slice 3 of REGISTER + double-stack):
    // for the registrar SUT, agents on `network: "core"` send to the
    // proxy's core-side ingress, not the ext-side default. Other SUTs
    // route every agent to the same SUT ingress.
    const targetFor: ((agent: string) => { host: string; port: number }) | undefined =
      sut === "registrarFrontProxy"
        ? (agentName) => {
            const agentNet = scenario.agents[agentName]?.network
            return agentNet === "core"
              ? { host: REGISTRAR_CORE_INGRESS.host, port: REGISTRAR_CORE_INGRESS.port }
              : target
          }
        : undefined
    const program = Effect.gen(function* () {
      const result = yield* executeScenario(
        scenario,
        transport,
        target,
        targetFor,
        clockSleep
      )
      console.log(formatReport(result))
      recordResult(result, outputDir)
      assertScenarioPassed(result)
      yield* assertCleanCallTermination(scenario.name)
    })
    const layer = transport.stackLayer
    return runScoped(
      (layer ? program.pipe(Effect.provide(layer)) : program) as Effect.Effect<
        void,
        unknown,
        Scope.Scope
      >
    )
  }
}

// ---------------------------------------------------------------------------
// Live UDP backend (real wall clock, external B2BUA)
// ---------------------------------------------------------------------------

export function createLiveRunner(opts?: {
  b2buaHost?: string
  b2buaPort?: number
  outputDir?: string
}) {
  const b2buaHost = opts?.b2buaHost ?? "127.0.0.1"
  const b2buaPort = opts?.b2buaPort ?? 5060
  const outputDir = opts?.outputDir ?? "test-results"
  const transport = createLiveTransport({ b2buaHost, b2buaPort })
  const target = { host: b2buaHost, port: b2buaPort }

  return (scenario: Scenario): Effect.Effect<void> =>
    runScoped(
      Effect.gen(function* () {
        const result = yield* executeScenario(scenario, transport, target)
        console.log(formatReport(result))
        recordResult(result, outputDir)
        assertScenarioPassed(result)
      })
    )
}

// ---------------------------------------------------------------------------
// Peer-to-peer backend (no B2BUA, agents talk directly to each other)
// ---------------------------------------------------------------------------

/**
 * Run a scenario in peer-to-peer mode: agents send directly to each
 * other over real UDP sockets. No B2BUA is involved. Use this to
 * validate the test framework itself in isolation from the SUT.
 *
 * `peers` maps each agent name to its peer's bind host:port. Each agent
 * must declare a fixed `port` in its AgentConfig so peers know where to
 * reach it.
 */
export function createPeerToPeerRunner(opts: {
  peers: Record<string, { host: string; port: number }>
  expectFailure?: boolean
  outputDir?: string
}) {
  const outputDir = opts.outputDir ?? "test-results"
  const transport = createLiveTransport({ b2buaHost: "127.0.0.1", b2buaPort: 0 })
  const targetFor = (agent: string) => {
    const peer = opts.peers[agent]
    if (!peer) throw new Error(`No peer target for agent "${agent}"`)
    return peer
  }

  return (scenario: Scenario): Effect.Effect<void> =>
    runScoped(
      Effect.gen(function* () {
        const result = yield* executeScenario(
          scenario,
          transport,
          { host: "127.0.0.1", port: 0 },
          targetFor
        )
        console.log(formatReport(result))
        recordResult(result, outputDir, opts.expectFailure)
        if (opts.expectFailure) {
          assertScenarioFailed(result)
        } else {
          assertScenarioPassed(result)
        }
      })
    )
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/**
 * Assert that a scenario result has zero failures.
 * On failure, throws with the formatted report for diagnostics.
 */
export function assertScenarioPassed(result: ScenarioResult): void {
  if (result.failed > 0) {
    const report = formatReport(result)
    throw new Error(`Scenario "${result.scenarioName}" failed:\n\n${report}`)
  }
}

/**
 * Assert that a scenario result has at least one failure.
 * Use this when a scenario is expected to fail (e.g. a negative test
 * that verifies the framework correctly flags unexpected messages).
 */
export function assertScenarioFailed(result: ScenarioResult): void {
  if (result.failed === 0) {
    const report = formatReport(result)
    throw new Error(
      `Scenario "${result.scenarioName}" was expected to fail but all steps passed:\n\n${report}`
    )
  }
}
