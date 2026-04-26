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
import type { Scenario, ScenarioResult } from "../fullcall/framework/types.js"
import { executeScenario } from "../fullcall/framework/interpreter.js"
import { createSimulatedTransport, type Sut } from "../fullcall/framework/simulated-backend.js"
import { createLiveTransport } from "../fullcall/framework/live-backend.js"
import { formatReport } from "../fullcall/framework/report.js"
import { writeScenarioReport, writeIndexReport } from "../fullcall/framework/html-report.js"
import { writeTextReports } from "../fullcall/framework/text-report.js"

export type { Sut }

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
  const target = { host: "127.0.0.1", port: sipPort }

  return (scenario: Scenario): Effect.Effect<void> => {
    // Provide the simulated stack at the *outer* runScoped scope — NOT
    // inside `transport.setup`. UdpTransport's `bindUdp` is a scoped
    // resource; if we provided the layer only around setup, its scope
    // would close the moment setup returned and the bound endpoint
    // would vanish out from under every agent's subsequent `send`.
    const program = Effect.gen(function* () {
      const result = yield* executeScenario(
        scenario,
        transport,
        target,
        undefined,
        clockSleep
      )
      console.log(formatReport(result))
      recordResult(result, outputDir)
      assertScenarioPassed(result)
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
