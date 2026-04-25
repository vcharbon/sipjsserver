/**
 * `runProxyScenario` — wraps a proxy `it.effect` body so that:
 *   - a `ProxyRecorder` service is provisioned for the test scope,
 *   - on completion (pass or fail) `.global.txt`, `.<participant>.txt`
 *     and `.html` reports are written under `test-results/sip-front-proxy/`,
 *   - the assertion failure (if any) propagates up to vitest unchanged so
 *     the test still fails in the usual way.
 *
 * Usage from a test (see `transit-only/invite-200-ack-bye.test.ts` for a
 * full example):
 *
 *   import { runProxyScenario, bindRecordedEndpoint } from "../_report/runner.js"
 *
 *   it.effect("happy path", () =>
 *     runProxyScenario({ name: "invite-200-ack-bye", description: "..." }, () =>
 *       Effect.gen(function* () {
 *         const alice = yield* bindRecordedEndpoint("alice", ALICE)
 *         const bob   = yield* bindRecordedEndpoint("bob", BOB)
 *         …
 *       })
 *     ).pipe(Effect.provide(layer))
 *   )
 */

import { Cause, Effect, Exit, Layer } from "effect"
import { writeHtmlReport } from "./html-report.js"
import { ProxyRecorder, ProxyRecorderLive } from "./recorder.js"
import { writeTextReports } from "./text-report.js"
import type { ProxyScenarioResult } from "./types.js"

export {
  bindRecordedEndpoint,
  ProxyRecorder,
  ProxyRecorderLive,
  wrapEndpoint,
} from "./recorder.js"
export type { ProxyTraceEntry, ProxyScenarioResult } from "./types.js"

export const DEFAULT_OUTPUT_DIR = "test-results/sip-front-proxy"

export interface RunProxyScenarioOpts {
  readonly name: string
  readonly description?: string
  readonly outputDir?: string
}

const ProxyRecorderLayer = Layer.effect(ProxyRecorder, ProxyRecorderLive)

const finalize = (
  opts: RunProxyScenarioOpts,
  status: "pass" | "fail",
  failureReason: string | undefined
) =>
  Effect.gen(function* () {
    const recorder = yield* ProxyRecorder
    const { participants, entries } = yield* recorder.snapshot
    const result: ProxyScenarioResult = {
      scenarioName: opts.name,
      scenarioDescription: opts.description,
      participants,
      trace: entries,
      status,
      ...(failureReason !== undefined ? { failureReason } : {}),
    }
    const dir = opts.outputDir ?? DEFAULT_OUTPUT_DIR
    yield* Effect.sync(() => writeTextReports(result, dir))
    yield* Effect.sync(() => writeHtmlReport(result, dir))
  })

const failureMessage = (cause: Cause.Cause<unknown>): string => {
  const fail = cause.failures.length > 0 ? cause.failures[0] : undefined
  if (fail !== undefined) {
    if (fail instanceof Error) return fail.stack ?? fail.message
    return String(fail)
  }
  const def = cause.defects.length > 0 ? cause.defects[0] : undefined
  if (def !== undefined) {
    if (def instanceof Error) return def.stack ?? def.message
    return String(def)
  }
  return "interrupted"
}

/**
 * Wrap a proxy test body so its UDP traffic (via `bindRecordedEndpoint`)
 * is captured and dumped to per-scenario `.txt` + `.html` reports.
 *
 * The returned effect provides `ProxyRecorder` to `body`. Compose with
 * `Effect.provide(stackLayer)` at the call site to add the proxy stack
 * (proxy-only-fakeStack, proxyFakeStack, etc.).
 */
export const runProxyScenario = <A, E, R>(
  opts: RunProxyScenarioOpts,
  body: Effect.Effect<A, E, R>
): Effect.Effect<A, E, Exclude<R, ProxyRecorder>> =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(body)
    if (Exit.isSuccess(exit)) {
      yield* finalize(opts, "pass", undefined)
      return exit.value
    }
    yield* finalize(opts, "fail", failureMessage(exit.cause))
    return yield* Effect.failCause(exit.cause)
  }).pipe(Effect.provide(ProxyRecorderLayer)) as Effect.Effect<
    A,
    E,
    Exclude<R, ProxyRecorder>
  >
