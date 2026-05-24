/**
 * Header-partition validator tests (SplitServiceLogic.md §D3 / B.1).
 *
 * Covers:
 *   - Runtime rejection of FORBIDDEN headers (case-insensitive).
 *   - Runtime rejection of PARTIAL headers (From, To).
 *   - Runtime rejection of body-slot headers (Content-Type etc.).
 *   - Acceptance of FREE headers (X-*, P-Asserted-Identity).
 *   - `AdapterHeaderName` compile-time exclusion via `ts-expect-error` fixtures.
 */

import { describe, expect, it } from "@effect/vitest"
import {
  classifyHeader,
  isAdapterHeaderName,
  validateUpdateHeaders,
  validateRejectUpdateHeaders,
  type AdapterHeaderName,
} from "../../src/decision/validators/forbiddenHeaders.js"
import { H } from "../../src/b2bua/rules/framework/actions/factories.js"

describe("classifyHeader", () => {
  it.each([
    ["Call-ID", "forbidden"],
    ["call-id", "forbidden"],
    ["CONTACT", "forbidden"],
    ["Via", "forbidden"],
    ["CSeq", "forbidden"],
    ["Max-Forwards", "forbidden"],
    ["Record-Route", "forbidden"],
    ["Route", "forbidden"],
    ["Content-Length", "forbidden"],
  ] as const)("classifies %s as forbidden", (name, tier) => {
    expect(classifyHeader(name)).toBe(tier)
  })

  it.each([
    ["From", "partial"],
    ["to", "partial"],
  ] as const)("classifies %s as partial", (name, tier) => {
    expect(classifyHeader(name)).toBe(tier)
  })

  it.each([
    ["Content-Type", "body-slot"],
    ["content-disposition", "body-slot"],
    ["Content-ID", "body-slot"],
    ["MIME-Version", "body-slot"],
  ] as const)("classifies %s as body-slot", (name, tier) => {
    expect(classifyHeader(name)).toBe(tier)
  })

  it.each(["X-Trace", "P-Asserted-Identity", "Subject", "Diversion"])(
    "classifies %s as ok",
    (name) => {
      expect(classifyHeader(name)).toBe("ok")
    },
  )
})

describe("validateUpdateHeaders", () => {
  it("accepts undefined", () => {
    expect(validateUpdateHeaders("mock", "newCall", undefined)).toBeNull()
  })

  it("accepts FREE headers", () => {
    const result = validateUpdateHeaders("mock", "newCall", {
      "X-Trace": "abc123",
      "P-Asserted-Identity": "<sip:a@b>",
      Subject: null,
    })
    expect(result).toBeNull()
  })

  it("rejects FORBIDDEN header with semantic-violation", () => {
    const result = validateUpdateHeaders("mock", "newCall", {
      Via: "SIP/2.0/UDP 1.2.3.4",
    })
    expect(result).not.toBeNull()
    expect(result?.kind).toBe("semantic-violation")
    expect(result?.adapterName).toBe("mock")
    expect(result?.method).toBe("newCall")
    expect(result?.detail).toMatch(/forbidden header/)
  })

  it("rejects case-insensitively (call-id / CALL-ID)", () => {
    const lower = validateUpdateHeaders("mock", "callFailure", { "call-id": "x" })
    const upper = validateUpdateHeaders("mock", "callFailure", { "CALL-ID": "x" })
    expect(lower?.kind).toBe("semantic-violation")
    expect(upper?.kind).toBe("semantic-violation")
  })

  it("rejects PARTIAL header (From) with dedicated detail", () => {
    const result = validateUpdateHeaders("mock", "callRefer", { From: "<sip:a@b>" })
    expect(result?.kind).toBe("semantic-violation")
    expect(result?.detail).toMatch(/partial header/)
  })

  it("rejects body-slot header (Content-Type)", () => {
    const result = validateUpdateHeaders("mock", "newCall", {
      "Content-Type": "application/sdp",
    })
    expect(result?.kind).toBe("semantic-violation")
    expect(result?.detail).toMatch(/body-slot header/)
  })

  it("short-circuits on the first violation", () => {
    const result = validateUpdateHeaders("mock", "newCall", {
      "X-Allowed": "fine",
      Via: "bad",
      From: "also bad",
    })
    expect(result?.detail).toMatch(/forbidden header "Via"/)
  })

  it("works with ReadonlyMap input", () => {
    const map = new Map<string, string | null>([["X-Trace", "abc"]])
    expect(validateUpdateHeaders("mock", "newCall", map)).toBeNull()
    const bad = new Map<string, string | null>([["Route", "<sip:p@x>"]])
    expect(validateUpdateHeaders("mock", "newCall", bad)?.kind).toBe(
      "semantic-violation",
    )
  })
})

describe("isAdapterHeaderName", () => {
  it("allows FREE well-known headers", () => {
    expect(isAdapterHeaderName(H["P-Asserted-Identity"])).toBe(true)
    expect(isAdapterHeaderName(H.Subject)).toBe(true)
  })

  it("blocks FORBIDDEN and PARTIAL well-known headers", () => {
    expect(isAdapterHeaderName(H.Via)).toBe(false)
    expect(isAdapterHeaderName(H["Call-ID"])).toBe(false)
    expect(isAdapterHeaderName(H.Contact)).toBe(false)
    expect(isAdapterHeaderName(H.From)).toBe(false)
    expect(isAdapterHeaderName(H.To)).toBe(false)
  })
})

describe("validateRejectUpdateHeaders", () => {
  it("accepts undefined", () => {
    expect(validateRejectUpdateHeaders("mock", "newCall", undefined)).toBeNull()
  })

  it("allows Contact unconditionally on reject (3xx redirect path)", () => {
    const result = validateRejectUpdateHeaders("mock", "newCall", {
      Contact: "<sip:alt@10.0.0.1>",
    })
    expect(result).toBeNull()
  })

  it("allows Contact even on a non-3xx reject (no family gating)", () => {
    const result = validateRejectUpdateHeaders("mock", "newCall", {
      Contact: "<sip:fallback@10.0.0.1>",
    })
    expect(result).toBeNull()
  })

  it("allows Reason / Retry-After / Warning / P-Asserted-Identity / X-* headers", () => {
    const result = validateRejectUpdateHeaders("mock", "newCall", {
      Reason: 'SIP ;cause=403;text="forbidden"',
      "Retry-After": "60",
      Warning: '399 example.com "demo"',
      "P-Asserted-Identity": "<sip:a@b>",
      "X-Trace-Id": "abc123",
    })
    expect(result).toBeNull()
  })

  it.each([
    ["Via", "via"],
    ["To", "to"],
    ["From", "from"],
    ["Call-ID", "call-id"],
    ["call-id", "call-id"],
    ["CSeq", "cseq"],
  ] as const)("rejects %s as RFC-mandated copy from request", (name, _canonical) => {
    const result = validateRejectUpdateHeaders("mock", "newCall", {
      [name]: "anything",
    })
    expect(result?.kind).toBe("semantic-violation")
    expect(result?.detail).toMatch(/RFC 3261/)
  })

  it("works with ReadonlyMap input", () => {
    const map = new Map<string, string | null>([["Reason", 'SIP ;cause=403']])
    expect(validateRejectUpdateHeaders("mock", "newCall", map)).toBeNull()
    const bad = new Map<string, string | null>([["Via", "anything"]])
    expect(validateRejectUpdateHeaders("mock", "newCall", bad)?.kind).toBe(
      "semantic-violation",
    )
  })
})

// ── Compile-time negative coverage ───────────────────────────────────────
//
// These fixtures fail to compile if an adapter manages to type a FORBIDDEN
// or PARTIAL well-known header into `AdapterHeaderName`. They are exercised
// by `npm run typecheck` — the test body asserts nothing at runtime.

describe("AdapterHeaderName — compile-time exclusion", () => {
  it("rejects FORBIDDEN / PARTIAL names at type level", () => {
    // @ts-expect-error — "Via" is FORBIDDEN, excluded from AdapterHeaderName.
    const via: AdapterHeaderName = { kind: "well-known", name: "Via" }
    // @ts-expect-error — "From" is PARTIAL, excluded from AdapterHeaderName.
    const from: AdapterHeaderName = { kind: "well-known", name: "From" }
    // @ts-expect-error — "Contact" is FORBIDDEN.
    const contact: AdapterHeaderName = { kind: "well-known", name: "Contact" }
    void via
    void from
    void contact
  })

  it("permits FREE well-known names and proprietary names", () => {
    const pai: AdapterHeaderName = { kind: "well-known", name: "P-Asserted-Identity" }
    const xTrace: AdapterHeaderName = { kind: "proprietary", name: "x-trace" }
    expect(pai.kind).toBe("well-known")
    expect(xTrace.kind).toBe("proprietary")
  })
})
