/**
 * `runProxyScenario` — wraps a proxy `it.effect` body so that:
 *   - a `ProxyParticipants` registry is provisioned for the test scope,
 *   - on completion (pass or fail) the SignalingNetwork's delivery trace is
 *     drained and `.global.txt`, `.<participant>.txt` and `.html` reports
 *     are written under `test-results/sip-front-proxy/` using the fullcall
 *     framework renderers (rich SVG sequence diagram, click-to-inspect),
 *   - the assertion failure (if any) propagates up to vitest unchanged so
 *     the test still fails in the usual way.
 *
 * Recording site: `SignalingNetwork.drainTrace` (populated on every
 * delivery) is the single source of truth. `bindNamedEndpoint` only
 * registers `(host, port) → label` so the report can render participant
 * names.
 *
 * Usage from a test (see `transit-only/invite-200-ack-bye.test.ts` for a
 * full example):
 *
 *   import { runProxyScenario, bindNamedEndpoint } from "../_report/runner.js"
 *
 *   it.effect("happy path", () =>
 *     runProxyScenario({ name: "invite-200-ack-bye", description: "..." }, () =>
 *       Effect.gen(function* () {
 *         const alice = yield* bindNamedEndpoint("alice", ALICE)
 *         const bob   = yield* bindNamedEndpoint("bob", BOB)
 *         …
 *       })
 *     ).pipe(Effect.provide(layer))
 *   )
 */

import { Cause, Effect, Exit, Layer } from "effect"
import { SignalingNetwork } from "../../../src/sip/SignalingNetwork.js"
import { customParser } from "../../../src/sip/parsers/custom/index.js"
import type { SipMessage } from "../../../src/sip/types.js"
import {
  writeScenarioReport,
} from "../../../src/test-harness/framework/html-report.js"
import { writeTextReports } from "../../../src/test-harness/framework/text-report.js"
import type {
  Lane,
  NetworkTag,
  Participant,
  ScenarioResult,
  TraceEntry,
} from "../../../src/test-harness/framework/types.js"
import { DEFAULT_NETWORK } from "../../../src/test-harness/framework/types.js"
import { ProxyParticipants, ProxyParticipantsLive } from "./recorder.js"

export {
  bindNamedEndpoint,
  ProxyParticipants,
  ProxyParticipantsLive,
} from "./recorder.js"

export const DEFAULT_OUTPUT_DIR = "test-results/sip-front-proxy"

export interface RunProxyScenarioOpts {
  readonly name: string
  readonly description?: string
  readonly outputDir?: string
}

const ParticipantsLayer = Layer.effect(ProxyParticipants, ProxyParticipantsLive)

const tryParse = (raw: Buffer): SipMessage | undefined => {
  const r = customParser.parse(raw)
  return r._tag === "Success" ? r.success : undefined
}

const labelKey = (host: string, port: number): string => `${host}:${port}`

const finalize = (
  opts: RunProxyScenarioOpts,
  status: "pass" | "fail",
  failureReason: string | undefined
) =>
  Effect.gen(function* () {
    const participants = yield* ProxyParticipants
    const network = yield* SignalingNetwork
    const { participants: names, addrs } = yield* participants.snapshot
    const netEntries = yield* network.drainTrace()

    // Translate every captured packet into ONE fullcall `TraceEntry`
    // (from→to, single record). Packets whose SIP message can't be
    // parsed are dropped — the fullcall renderer requires a defined
    // `SipMessage` and uses it for arrow labels, Call-ID coloring and
    // detail panels. Unknown endpoints fall back to "<ip>:<port>".
    const trace: TraceEntry[] = []
    const seenParticipants = new Set<string>(names)
    // Lane registry built from observed addresses, in first-appearance
    // order. Each entry tracks the names ever assigned to its
    // `(ip,port)` so the renderer's column header shows whichever
    // participant the test registered for that socket — and nothing else.
    const laneBuilder = new Map<
      string,
      { ip: string; port: number; network: NetworkTag; names: string[] }
    >()
    const seeLane = (ip: string, port: number, name: string): void => {
      const key = labelKey(ip, port)
      const existing = laneBuilder.get(key)
      if (existing === undefined) {
        laneBuilder.set(key, { ip, port, network: DEFAULT_NETWORK, names: [name] })
        return
      }
      if (!existing.names.includes(name)) existing.names.push(name)
    }
    let seq = 0
    for (const e of netEntries) {
      const msg = tryParse(e.raw)
      if (msg === undefined) continue
      const fromLabel =
        addrs.get(labelKey(e.src.ip, e.src.port)) ?? `${e.src.ip}:${e.src.port}`
      const toLabel =
        addrs.get(labelKey(e.dst.ip, e.dst.port)) ?? `${e.dst.ip}:${e.dst.port}`
      seenParticipants.add(fromLabel)
      seenParticipants.add(toLabel)
      seeLane(e.src.ip, e.src.port, fromLabel)
      seeLane(e.dst.ip, e.dst.port, toLabel)
      trace.push({
        timestamp: e.deliveredMs,
        seq: seq++,
        sentMs: e.sentMs,
        receivedMs: e.deliveredMs,
        from: fromLabel,
        to: toLabel,
        fromAddr: { ip: e.src.ip, port: e.src.port },
        toAddr: { ip: e.dst.ip, port: e.dst.port },
        direction: "send",
        stepIndex: -1,
        status: e.delivered ? "pass" : "unexpected",
        message: msg,
        // sip-front-proxy report runner is single-network; tag every
        // entry with the default fabric. Slice 2's registrar tests
        // build the participant registry with explicit network info.
        network: DEFAULT_NETWORK,
      })
    }
    trace.sort((a, b) => a.timestamp - b.timestamp)

    // Build the participant lifeline list. Registered names (alice, bob,
    // worker-1, …) come first in registration order; any unregistered
    // endpoint that showed up in the trace (e.g. the proxy listen
    // address when the test didn't name it) gets appended so the SVG
    // renderer doesn't drop arrows that touch it.
    const orderedParticipants: Participant[] = names.map((n) => ({
      name: n,
      network: DEFAULT_NETWORK,
    }))
    const seenInOrdered = new Set<string>(orderedParticipants.map((p) => p.name))
    for (const p of seenParticipants) {
      if (!seenInOrdered.has(p)) {
        orderedParticipants.push({ name: p, network: DEFAULT_NETWORK })
        seenInOrdered.add(p)
      }
    }

    // Proxy tests don't run a step-based scenario DSL, so there are no
    // `StepResult`s to surface. The fullcall renderers tolerate an empty
    // `stepResults` array — the failure detail panel simply renders nothing.
    // The `failureReason` (when present) is captured at the framework level
    // by vitest itself; the on-disk report shows the FAIL badge plus the
    // global trace, which is enough to diagnose proxy-side regressions.
    const lanes: ReadonlyArray<Lane> = Array.from(laneBuilder.values()).map((l) => ({
      ip: l.ip,
      port: l.port,
      network: l.network,
      names: l.names.slice(),
      killedAt: [] as ReadonlyArray<number>,
    }))

    const result: ScenarioResult = {
      scenarioName: opts.name,
      scenarioDescription: opts.description,
      transportKind: "fake",
      stepResults: [],
      trace,
      participants: orderedParticipants,
      lanes,
      anomalies: [],
      passed: status === "pass" ? 1 : 0,
      failed: status === "fail" ? 1 : 0,
      skipped: 0,
    }

    // Suppress unused-warning for failureReason — the fullcall report
    // surfaces failure via the badge + status counts; vitest captures the
    // assertion message directly.
    void failureReason

    const dir = opts.outputDir ?? DEFAULT_OUTPUT_DIR
    yield* Effect.sync(() => {
      const txtFiles = writeTextReports(result, dir)
      writeScenarioReport(result, dir, txtFiles)
    })
  })

const failureMessage = (cause: Cause.Cause<unknown>): string => {
  // v4: Cause.pretty handles every cause shape (Fail / Die / Interrupt /
  // Sequential / Parallel) and produces a readable trace.
  try {
    return Cause.pretty(cause)
  } catch {
    return "unknown failure"
  }
}

/**
 * Wrap a proxy test body so its UDP traffic (every packet on the shared
 * `SignalingNetwork`) is captured and dumped to per-scenario `.txt` +
 * `.html` reports.
 *
 * The returned effect provides `ProxyParticipants` to `body`. Compose with
 * `Effect.provide(stackLayer)` at the call site to add the proxy stack
 * (proxy-only-fakeStack, proxyFakeStack, etc.).
 */
export const runProxyScenario = <A, E, R>(
  opts: RunProxyScenarioOpts,
  body: Effect.Effect<A, E, R>
): Effect.Effect<A, E, Exclude<R, ProxyParticipants> | SignalingNetwork> =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(body)
    if (Exit.isSuccess(exit)) {
      yield* finalize(opts, "pass", undefined)
      return exit.value
    }
    yield* finalize(opts, "fail", failureMessage(exit.cause))
    return yield* Effect.failCause(exit.cause)
  }).pipe(Effect.provide(ParticipantsLayer)) as Effect.Effect<
    A,
    E,
    Exclude<R, ProxyParticipants> | SignalingNetwork
  >
