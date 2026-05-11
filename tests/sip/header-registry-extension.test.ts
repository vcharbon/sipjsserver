/**
 * Third-party extension smoke test for the unified header API. Verifies
 * the two pieces a downstream consumer is expected to wire up:
 *
 *   1. Runtime: `defaultRegistry.register({ name, parse })` installs a
 *      parser the message will use on first `getHeader(name)`.
 *   2. Compile-time: `declare module` extending `SipHeaderTypes` makes
 *      `getHeader('x-custom')` return the typed value instead of the
 *      raw `ReadonlyArray<string>` fallback.
 *
 * Also checks per-message memoization (parser invoked at most once) and
 * the built-in collision guard (a third party cannot shadow 'from').
 */

import { describe, test, expect } from "vitest"
import { Result } from "effect"
import { customParser } from "../../src/sip/parsers/custom/index.js"
import { defaultRegistry } from "../../src/sip/header-registry.js"
import { sipMsg } from "./fixtures/rfc4475-valid.js"

// ---------------------------------------------------------------------------
// (1) Declaration-merge a custom typed entry.
// ---------------------------------------------------------------------------

interface RoutingHint {
  readonly hop: string
  readonly priority: number
}

declare module "../../src/sip/types.js" {
  interface SipHeaderTypes {
    "x-routing-hint": ReadonlyArray<RoutingHint>
  }
}

const baseHeaders = `Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-ext
From: <sip:alice@example.com>;tag=tagA
To: <sip:bob@example.com>
Call-ID: ext-test
CSeq: 1 INVITE`

describe("SipHeaderRegistry — third-party extension", () => {
  test("registered parser is invoked exactly once per message and result is typed", () => {
    let parseCalls = 0
    defaultRegistry.register<ReadonlyArray<RoutingHint>>({
      name: "x-routing-hint",
      parse: (raws) => {
        parseCalls++
        return raws.map((r) => {
          const [hop, prio] = r.split(":")
          return { hop: hop ?? "", priority: Number(prio ?? "0") }
        })
      },
    })

    const msg = Result.getOrThrow(
      customParser.parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
X-Routing-Hint: edge-a:10
X-Routing-Hint: edge-b:20
Content-Length: 0

`),
    )

    const first = msg.getHeader("x-routing-hint")
    const second = msg.getHeader("x-routing-hint")
    // Typed: it's the ReadonlyArray<RoutingHint> from the declaration merge.
    expect(first.length).toBe(2)
    expect(first[0]).toEqual({ hop: "edge-a", priority: 10 })
    expect(first[1]).toEqual({ hop: "edge-b", priority: 20 })
    // Memoized: parse runs once even though we called getHeader twice.
    expect(parseCalls).toBe(1)
    // Same allocation returned on every subsequent call.
    expect(second).toBe(first)
  })

  test("memoization is per-message — a second parsed message re-runs the parser", () => {
    // Carries over the registration from the previous test. (Per-test
    // isolation isn't required since registration is idempotent and the
    // counter is local.)
    let parseCalls = 0
    // Re-register with a fresh counter — this also exercises the
    // "re-register overwrites silently" contract.
    defaultRegistry.register<ReadonlyArray<RoutingHint>>({
      name: "x-routing-hint",
      parse: (raws) => {
        parseCalls++
        return raws.map((r) => ({ hop: r, priority: 0 }))
      },
    })
    const msgA = Result.getOrThrow(
      customParser.parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
X-Routing-Hint: A
Content-Length: 0

`),
    )
    const msgB = Result.getOrThrow(
      customParser.parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
X-Routing-Hint: B
Content-Length: 0

`),
    )
    msgA.getHeader("x-routing-hint")
    msgA.getHeader("x-routing-hint")
    msgB.getHeader("x-routing-hint")
    expect(parseCalls).toBe(2)
  })

  test("re-registering a built-in name throws", () => {
    expect(() =>
      defaultRegistry.register({
        name: "from",
        parse: () => undefined,
      }),
    ).toThrow(/built-in/)
  })

  test("unknown header name (no registration) still falls through to raw strings", () => {
    const msg = Result.getOrThrow(
      customParser.parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
X-Acme-Trace: hop-1
X-Acme-Trace: hop-2
Content-Length: 0

`),
    )
    // No registration for x-acme-trace → ReadonlyArray<string>.
    expect(msg.getHeader("x-acme-trace")).toEqual(["hop-1", "hop-2"])
  })
})
