/**
 * Unit tests for `RegisterStrategy.inMemoryRegistrarLayer` — slice 2 of
 * the REGISTER + double-stack proxy work.
 *
 * Acceptance per the plan:
 *   - 200 OK echoes the Contact + computed Expires (from header > URI
 *     param > default 3600).
 *   - `Expires: 0` removes the binding (no-op via the registrar) and
 *     returns 200 OK.
 *   - The `noop` variant returns `501 Not Implemented`.
 *
 * Tests construct a synthetic REGISTER `SipRequest` with `hydrateRequest`
 * and assert on the response shape — no UDP fabric involved.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { getHeader } from "../../../src/sip/MessageHelpers.js"
import { hydrateRequest } from "../../../src/sip/parsers/extract-fields.js"
import type { SipHeader, SipRequest } from "../../../src/sip/types.js"
import { Registrar } from "../../../src/sip-front-proxy/Registrar.js"
import { RegisterStrategy } from "../../../src/sip-front-proxy/RegisterStrategy.js"

function buildRegister(opts: {
  readonly aor?: string // To-URI userpart, defaults to "alice"
  readonly contactUri?: string // bare URI inside `<>`
  readonly expiresHeader?: number | undefined // omitted when undefined
  readonly contactExpiresParam?: number | undefined
}): SipRequest {
  const aor = opts.aor ?? "alice"
  const contactUri = opts.contactUri ?? "sip:alice@10.20.0.5:5061"
  const contactValue =
    opts.contactExpiresParam !== undefined
      ? `<${contactUri}>;expires=${opts.contactExpiresParam}`
      : `<${contactUri}>`
  const headers: SipHeader[] = [
    { name: "Via", value: "SIP/2.0/UDP 10.20.0.5:5061;branch=z9hG4bK-test" },
    { name: "From", value: `<sip:${aor}@example.test>;tag=t1` },
    { name: "To", value: `<sip:${aor}@example.test>` },
    { name: "Call-ID", value: "register-smoke-1" },
    { name: "CSeq", value: "1 REGISTER" },
    { name: "Contact", value: contactValue },
    { name: "Max-Forwards", value: "70" },
  ]
  if (opts.expiresHeader !== undefined) {
    headers.push({ name: "Expires", value: String(opts.expiresHeader) })
  }
  return hydrateRequest({
    method: "REGISTER",
    uri: "sip:registrar.example.test",
    headers,
    body: new Uint8Array(),
    raw: Buffer.alloc(0),
  })
}

const testLayer = RegisterStrategy.inMemoryRegistrarLayer.pipe(
  Layer.provideMerge(Registrar.inMemoryLayer),
)

describe("RegisterStrategy.inMemoryRegistrarLayer", () => {
  it.effect("returns 200 OK with Contact + Expires (default 3600)", () =>
    Effect.gen(function* () {
      const strategy = yield* RegisterStrategy
      const req = buildRegister({})
      const resp = yield* strategy.handle(req)
      expect(resp.status).toBe(200)
      expect(resp.reason).toBe("OK")
      const echoed = getHeader(resp.headers, "contact")
      expect(echoed).toBeDefined()
      expect(echoed!).toContain("sip:alice@10.20.0.5:5061")
      expect(echoed!).toContain("expires=3600")
      expect(getHeader(resp.headers, "expires")).toBe("3600")
    }).pipe(Effect.provide(testLayer)),
  )

  it.effect("honours `Expires` header over the registrar default", () =>
    Effect.gen(function* () {
      const strategy = yield* RegisterStrategy
      const req = buildRegister({ expiresHeader: 120 })
      const resp = yield* strategy.handle(req)
      expect(resp.status).toBe(200)
      expect(getHeader(resp.headers, "expires")).toBe("120")
    }).pipe(Effect.provide(testLayer)),
  )

  it.effect("falls back to Contact `;expires=` when no Expires header", () =>
    Effect.gen(function* () {
      const strategy = yield* RegisterStrategy
      const req = buildRegister({ contactExpiresParam: 240 })
      const resp = yield* strategy.handle(req)
      expect(resp.status).toBe(200)
      expect(getHeader(resp.headers, "expires")).toBe("240")
    }).pipe(Effect.provide(testLayer)),
  )

  it.effect("Expires header beats the Contact param when both present", () =>
    Effect.gen(function* () {
      const strategy = yield* RegisterStrategy
      const req = buildRegister({ expiresHeader: 60, contactExpiresParam: 999 })
      const resp = yield* strategy.handle(req)
      expect(resp.status).toBe(200)
      expect(getHeader(resp.headers, "expires")).toBe("60")
    }).pipe(Effect.provide(testLayer)),
  )

  it.effect("persists the binding so Registrar.lookup observes it", () =>
    Effect.gen(function* () {
      const strategy = yield* RegisterStrategy
      const registrar = yield* Registrar
      yield* strategy.handle(buildRegister({}))
      const found = yield* registrar.lookup("alice")
      expect(Option.isSome(found)).toBe(true)
      if (Option.isSome(found)) {
        expect(found.value.contactUri).toBe("sip:alice@10.20.0.5:5061")
      }
    }).pipe(Effect.provide(testLayer)),
  )

  it.effect("Expires=0 removes the binding and still returns 200 OK", () =>
    Effect.gen(function* () {
      const strategy = yield* RegisterStrategy
      const registrar = yield* Registrar
      yield* strategy.handle(buildRegister({}))
      const before = yield* registrar.lookup("alice")
      expect(Option.isSome(before)).toBe(true)

      const resp = yield* strategy.handle(buildRegister({ expiresHeader: 0 }))
      expect(resp.status).toBe(200)
      expect(getHeader(resp.headers, "expires")).toBe("0")

      const after = yield* registrar.lookup("alice")
      expect(Option.isNone(after)).toBe(true)
    }).pipe(Effect.provide(testLayer)),
  )
})

describe("RegisterStrategy.noopLayer", () => {
  it.effect("returns 501 Not Implemented for any REGISTER", () =>
    Effect.gen(function* () {
      const strategy = yield* RegisterStrategy
      const resp = yield* strategy.handle(buildRegister({}))
      expect(resp.status).toBe(501)
      expect(resp.reason).toBe("Not Implemented")
    }).pipe(Effect.provide(RegisterStrategy.noopLayer)),
  )
})
