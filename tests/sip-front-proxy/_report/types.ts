/**
 * Proxy-side report types.
 *
 * Minimal analogue of `tests/fullcall/framework/types.ts` for proxy
 * transit-only / load-balancer / transparency tests. Tests record one
 * `ProxyTraceEntry` per `endpoint.send` and one per `endpoint.poll/take`
 * that returns a packet. The runner aggregates these into a
 * `ProxyScenarioResult` and writes per-scenario `.txt` + `.html` reports
 * under `test-results/sip-front-proxy/`.
 *
 * Why not reuse the fullcall framework? It's coupled to a Scenario DSL
 * (`send`/`expect` steps, `AgentInfo`, `executeScenario`) that the proxy
 * tests don't use — they drive raw UDP endpoints directly. The proxy
 * report layer keeps the same on-disk shape (`.global.txt`, `.<name>.txt`,
 * `.html`, `index.html`) so the `test-results/` directory looks uniform.
 */

import type { SipMessage } from "../../../src/sip/types.js"

export type ProxyDirection = "send" | "receive"

export interface ProxyTraceEntry {
  /** Virtual-clock instant the entry was recorded (TestClock). */
  readonly timestampMs: number
  /** Logical participant name supplied at bind time (e.g. "alice", "bob"). */
  readonly participant: string
  readonly direction: ProxyDirection
  /** Peer address: for `send`, the destination; for `receive`, the source. */
  readonly peer: { readonly host: string; readonly port: number }
  /** Parsed SIP message; on parse failure the runner records `undefined`
   *  and falls back to `rawHex` for HTML rendering. */
  readonly message: SipMessage | undefined
  readonly rawBytes: Buffer
  /** Best-effort label for the message ("INVITE sip:bob@…", "200 OK"). */
  readonly label: string
}

export interface ProxyScenarioResult {
  readonly scenarioName: string
  readonly scenarioDescription: string | undefined
  readonly participants: readonly string[]
  readonly trace: readonly ProxyTraceEntry[]
  readonly status: "pass" | "fail"
  /** When `status === "fail"`, the assertion error message. */
  readonly failureReason?: string
}
