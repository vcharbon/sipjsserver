/**
 * Unit tests for `CoreToExtRoutingStrategy.registrarLookupLayer` —
 * slice 2 of the REGISTER + double-stack proxy work.
 *
 * Covers the three outcome paths for the registrar-lookup variant
 * (forward, 404, 400), plus the noop variant. End-to-end coverage on
 * top of an actual `ProxyCore` lives in slice 3.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { hydrateRequest } from "../../../src/sip/parsers/extract-fields.js"
import type { SipRequest } from "../../../src/sip/types.js"
import { CoreToExtRoutingStrategy } from "../../../src/sip-front-proxy/CoreToExtRoutingStrategy.js"
import { Registrar } from "../../../src/sip-front-proxy/Registrar.js"

function buildInvite(opts: { readonly aor?: string; readonly ruri?: string }): SipRequest {
  const aor = opts.aor ?? "bob"
  const ruri = opts.ruri ?? `sip:${aor}@proxy.example.test`
  return hydrateRequest({
    method: "INVITE",
    uri: ruri,
    headers: [
      { name: "Via", value: "SIP/2.0/UDP 10.30.0.1:5060;branch=z9hG4bK-core" },
      { name: "From", value: "<sip:caller@core.example.test>;tag=core1" },
      { name: "To", value: `<${ruri}>` },
      { name: "Call-ID", value: "core-invite-1" },
      { name: "CSeq", value: "1 INVITE" },
      { name: "Max-Forwards", value: "70" },
      { name: "Contact", value: "<sip:caller@10.30.0.1:5060>" },
    ],
    body: new Uint8Array(),
    raw: Buffer.alloc(0),
  })
}

const testLayer = CoreToExtRoutingStrategy.registrarLookupLayer.pipe(
  Layer.provideMerge(Registrar.inMemoryLayer),
)

describe("CoreToExtRoutingStrategy.registrarLookupLayer", () => {
  it.effect("forwards to the registered Contact when the AOR exists", () =>
    Effect.gen(function* () {
      const registrar = yield* Registrar
      yield* registrar.register("bob", "sip:bob@10.20.0.7:5062", 3600)

      const strategy = yield* CoreToExtRoutingStrategy
      const outcome = yield* strategy.resolve(buildInvite({ aor: "bob" }))
      expect(outcome._tag).toBe("forward")
      if (outcome._tag === "forward") {
        expect(outcome.destination).toEqual({ host: "10.20.0.7", port: 5062 })
        expect(outcome.ruriOverride).toBe("sip:bob@10.20.0.7:5062")
      }
    }).pipe(Effect.provide(testLayer)),
  )

  it.effect("rejects with 404 when the AOR has no live binding", () =>
    Effect.gen(function* () {
      const strategy = yield* CoreToExtRoutingStrategy
      const outcome = yield* strategy.resolve(buildInvite({ aor: "ghost" }))
      expect(outcome._tag).toBe("reject")
      if (outcome._tag === "reject") {
        expect(outcome.status).toBe(404)
        expect(outcome.reason).toBe("Not Found")
      }
    }).pipe(Effect.provide(testLayer)),
  )

  it.effect("rejects with 400 when the Request-URI lacks a userpart", () =>
    Effect.gen(function* () {
      const strategy = yield* CoreToExtRoutingStrategy
      // RURI without userpart — the registrar has nothing to key on.
      const outcome = yield* strategy.resolve(buildInvite({ ruri: "sip:proxy.example.test" }))
      expect(outcome._tag).toBe("reject")
      if (outcome._tag === "reject") {
        expect(outcome.status).toBe(400)
      }
    }).pipe(Effect.provide(testLayer)),
  )
})

describe("CoreToExtRoutingStrategy.noopLayer", () => {
  it.effect("always returns 404 Not Found", () =>
    Effect.gen(function* () {
      const strategy = yield* CoreToExtRoutingStrategy
      const outcome = yield* strategy.resolve(buildInvite({ aor: "anyone" }))
      expect(outcome._tag).toBe("reject")
      if (outcome._tag === "reject") {
        expect(outcome.status).toBe(404)
      }
    }).pipe(Effect.provide(CoreToExtRoutingStrategy.noopLayer)),
  )
})
