/**
 * `runProxyScenario` — wraps a proxy `it.effect` body so that:
 *   - a `ProxyParticipants` registry is provisioned for the test scope,
 *   - on completion (pass or fail) the SignalingNetwork's delivery trace is
 *     drained and `.global.txt`, `.<participant>.txt` and `.html` reports
 *     are written under `test-results/sip-front-proxy/`,
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
import { writeHtmlReport } from "./html-report.js"
import { ProxyParticipants, ProxyParticipantsLive } from "./recorder.js"
import { writeTextReports } from "./text-report.js"
import type { ProxyScenarioResult, ProxyTraceEntry } from "./types.js"

export {
  bindNamedEndpoint,
  ProxyParticipants,
  ProxyParticipantsLive,
} from "./recorder.js"
export type { ProxyTraceEntry, ProxyScenarioResult } from "./types.js"

export const DEFAULT_OUTPUT_DIR = "test-results/sip-front-proxy"

export interface RunProxyScenarioOpts {
  readonly name: string
  readonly description?: string
  readonly outputDir?: string
}

const ParticipantsLayer = Layer.effect(ProxyParticipants, ProxyParticipantsLive)

const labelForMsg = (msg: SipMessage | undefined, raw: Buffer): string => {
  if (msg === undefined) return `<unparseable ${raw.length}B>`
  if (msg.type === "request") {
    return msg.uri ? `${msg.method} ${msg.uri}` : msg.method
  }
  const cseqMethod = msg.parsed.cseq.method
  return `${msg.status} ${msg.reason}${cseqMethod ? ` (${cseqMethod})` : ""}`
}

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

    // Translate every captured packet into TWO `ProxyTraceEntry`s — one
    // from the sender's perspective (`direction: "send"`) and one from
    // the receiver's (`direction: "receive"`) — matching the previous
    // recorder's per-endpoint shape so the text/html renderers don't
    // need to know about the migration. Packets whose endpoint is not
    // a registered participant are skipped (e.g. proxy↔external traffic
    // when the test doesn't name the proxy).
    const trace: ProxyTraceEntry[] = []
    for (const e of netEntries) {
      const msg = tryParse(e.raw)
      const label = labelForMsg(msg, e.raw)
      const srcLabel = addrs.get(labelKey(e.src.ip, e.src.port))
      const dstLabel = addrs.get(labelKey(e.dst.ip, e.dst.port))
      if (srcLabel !== undefined) {
        trace.push({
          timestampMs: e.sentMs,
          participant: srcLabel,
          direction: "send",
          peer: { host: e.dst.ip, port: e.dst.port },
          message: msg,
          rawBytes: e.raw,
          label,
        })
      }
      if (dstLabel !== undefined && e.delivered) {
        trace.push({
          timestampMs: e.deliveredMs,
          participant: dstLabel,
          direction: "receive",
          peer: { host: e.src.ip, port: e.src.port },
          message: msg,
          rawBytes: e.raw,
          label,
        })
      }
    }
    trace.sort((a, b) => a.timestampMs - b.timestampMs)

    const result: ProxyScenarioResult = {
      scenarioName: opts.name,
      scenarioDescription: opts.description,
      participants: names,
      trace,
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
