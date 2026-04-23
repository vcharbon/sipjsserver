/**
 * BodyIntent tests — golden coverage for B.2.
 *
 *   - Multipart assembly: boundary, part headers, CRLF framing, Content-Type.
 *   - Materialisation: incoming-sdp / incoming-body / bytes backings.
 *   - Content-ID wrapping + cross-reference resolution (PIDF-LO + Geolocation).
 *   - cid validator positive + negative cases.
 */

import { describe, expect, it } from "@effect/vitest"
import {
  assembleMultipart,
  MultipartAssemblyError,
} from "../../src/decision/apply/multipart.js"
import {
  extractCidIds,
  validateCidCrossReferences,
} from "../../src/decision/validators/cidCrossRef.js"
import type {
  BodyIntent,
  BodyIntentMultipart,
} from "../../src/decision/schemas/body.js"

const utf8 = (s: string) => new TextEncoder().encode(s)
const decode = (b: Uint8Array) => new TextDecoder().decode(b)

// ── assembleMultipart ─────────────────────────────────────────────────────

describe("assembleMultipart", () => {
  const incomingSdp = utf8("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\n")
  const ctx = { rawBody: incomingSdp, sdp: incomingSdp }

  it("emits a single-part envelope with matching boundary and Content-Type", () => {
    const intent: BodyIntentMultipart = {
      kind: "multipart",
      subtype: "mixed",
      parts: [
        {
          contentType: "application/sdp",
          body: { kind: "incoming-sdp" },
        },
      ],
    }
    const out = assembleMultipart(intent, ctx)
    expect(out.contentType).toMatch(/^multipart\/mixed; boundary="b2bua-[0-9a-f]{24}"$/)
    const text = decode(out.bytes)
    expect(text.startsWith(`--${out.boundary}\r\n`)).toBe(true)
    expect(text.endsWith(`--${out.boundary}--\r\n`)).toBe(true)
    expect(text).toContain("Content-Type: application/sdp\r\n")
    expect(text).toContain("v=0")
  })

  it("emits PIDF-LO + SDP with Content-ID preserved (Geolocation handshake)", () => {
    const pidf = utf8(`<?xml version="1.0" encoding="UTF-8"?><presence/>`)
    const intent: BodyIntentMultipart = {
      kind: "multipart",
      subtype: "mixed",
      parts: [
        {
          contentType: "application/sdp",
          body: { kind: "incoming-sdp" },
        },
        {
          contentType: "application/pidf+xml",
          contentId: "location@example.com",
          body: { kind: "bytes", value: pidf },
        },
      ],
    }
    const out = assembleMultipart(intent, ctx)
    const text = decode(out.bytes)
    expect(text).toContain("Content-ID: <location@example.com>")
    expect(text).toContain("application/pidf+xml")
    // Part bodies separated by CRLF--boundary, final --boundary--
    const boundaryCount = [...text.matchAll(new RegExp(`--${out.boundary}`, "g"))].length
    expect(boundaryCount).toBe(3) // 2 opens + 1 close
  })

  it("inlines incoming-body / bytes / incoming-sdp parts", () => {
    const extra = utf8("custom-payload")
    const intent: BodyIntentMultipart = {
      kind: "multipart",
      subtype: "alternative",
      parts: [
        { contentType: "text/plain", body: { kind: "bytes", value: extra } },
        { contentType: "application/sdp", body: { kind: "incoming-sdp" } },
        { contentType: "application/octet-stream", body: { kind: "incoming-body" } },
      ],
    }
    const out = assembleMultipart(intent, ctx)
    expect(out.contentType.startsWith("multipart/alternative")).toBe(true)
    const text = decode(out.bytes)
    expect(text).toContain("custom-payload")
    expect(text).toContain("v=0")
  })

  it("preserves already-bracketed Content-ID", () => {
    const intent: BodyIntentMultipart = {
      kind: "multipart",
      subtype: "mixed",
      parts: [
        {
          contentType: "text/plain",
          contentId: "<abc@x>",
          body: { kind: "bytes", value: utf8("p") },
        },
      ],
    }
    const out = assembleMultipart(intent, ctx)
    expect(decode(out.bytes)).toContain("Content-ID: <abc@x>")
  })

  it("rejects zero parts", () => {
    expect(() =>
      assembleMultipart(
        { kind: "multipart", subtype: "mixed", parts: [] },
        ctx,
      ),
    ).toThrow(MultipartAssemblyError)
  })

  it("rejects incoming-sdp when no sdp segment is available", () => {
    const bareCtx = { rawBody: utf8("raw"), sdp: undefined }
    expect(() =>
      assembleMultipart(
        {
          kind: "multipart",
          subtype: "mixed",
          parts: [{ contentType: "application/sdp", body: { kind: "incoming-sdp" } }],
        },
        bareCtx,
      ),
    ).toThrow(/incoming-sdp/)
  })
})

// ── extractCidIds ─────────────────────────────────────────────────────────

describe("extractCidIds", () => {
  it("extracts from <cid:id> angle syntax", () => {
    expect(extractCidIds("<cid:abc@example.com>")).toEqual(["abc@example.com"])
  })

  it("is case-insensitive on the scheme", () => {
    expect(extractCidIds("<CID:abc@example.com>")).toEqual(["abc@example.com"])
  })

  it("ignores substrings (acid:…)", () => {
    expect(extractCidIds("acid:xyz")).toEqual([])
  })

  it("extracts multiple references from one value", () => {
    expect(
      extractCidIds("<cid:a@x>; purpose=foo, <cid:b@x>; purpose=bar"),
    ).toEqual(["a@x", "b@x"])
  })
})

// ── validateCidCrossReferences ────────────────────────────────────────────

describe("validateCidCrossReferences", () => {
  const headers = [
    { name: "Geolocation", value: "<cid:loc@b2bua.local>" },
  ]

  const body = (overrides: Partial<BodyIntentMultipart["parts"][number]>): BodyIntent => ({
    kind: "multipart",
    subtype: "mixed",
    parts: [
      { contentType: "application/sdp", body: { kind: "incoming-sdp" } },
      {
        contentType: "application/pidf+xml",
        contentId: "loc@b2bua.local",
        body: { kind: "bytes", value: utf8("<pidf/>") },
        ...overrides,
      },
    ],
  })

  it("accepts matching cid ↔ Content-ID", () => {
    expect(validateCidCrossReferences("mock", "newCall", headers, body({}))).toBeNull()
  })

  it("accepts an already-angle-wrapped part contentId", () => {
    expect(
      validateCidCrossReferences("mock", "newCall", headers, body({ contentId: "<loc@b2bua.local>" })),
    ).toBeNull()
  })

  it("rejects a dangling cid with semantic-violation", () => {
    const err = validateCidCrossReferences(
      "mock",
      "newCall",
      [{ name: "Geolocation", value: "<cid:missing@b2bua.local>" }],
      body({}),
    )
    expect(err?.kind).toBe("semantic-violation")
    expect(err?.detail).toMatch(/cid:missing@b2bua\.local/)
  })

  it("rejects cid references against non-multipart bodies", () => {
    const err = validateCidCrossReferences(
      "mock",
      "newCall",
      headers,
      { kind: "inherit" },
    )
    expect(err?.kind).toBe("semantic-violation")
  })

  it("is a no-op when no headers reference cid:", () => {
    expect(
      validateCidCrossReferences(
        "mock",
        "newCall",
        [{ name: "X-Trace", value: "abc" }],
        { kind: "inherit" },
      ),
    ).toBeNull()
  })
})
