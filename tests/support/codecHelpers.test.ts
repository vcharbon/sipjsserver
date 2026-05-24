/**
 * Unit tests for the post-msgpackr-migration test-side codec helpers.
 *
 * Asserts the contract three production code paths rely on:
 *   1. `bodyBuf` → `decodeBuf` is a lossless round-trip on Call-shaped
 *      JS values (the canonical encode path for new fixtures).
 *   2. `legacyJsonBuf` payloads are auto-detected by `decodeBuf` on the
 *      first byte (`0x7B = "{"`), exercising the rolling-upgrade compat
 *      path that `src/call/CallCodec.ts:decodeBodyAuto` implements.
 *   3. Extra properties grafted onto a Call before encoding (notably
 *      `__writtenAtMs`, set by the storage write path for observability)
 *      survive pack/unpack — msgpackr packs all own-enumerable keys,
 *      including those Schema would otherwise treat as extras.
 */

import { describe, expect, it } from "@effect/vitest"
import { bodyBuf, decodeBuf, legacyJsonBuf } from "./codecHelpers.js"

describe("codecHelpers — bodyBuf / decodeBuf round-trip", () => {
  it("round-trips a primitive value", () => {
    const value = { v: 1, src: "test" }
    const decoded = decodeBuf(bodyBuf(value))
    expect(decoded).toEqual(value)
  })

  it("preserves nested structures, arrays, and undefined fields", () => {
    const value = {
      callRef: "abc-123",
      legs: [
        { id: "leg-a", state: "trying" as const, tags: ["primary"] },
        { id: "leg-b", state: "confirmed" as const, tags: [] },
      ],
      callbackContext: undefined,
      meta: { gen: 7, retries: 0 },
    }
    expect(decodeBuf(bodyBuf(value))).toEqual(value)
  })

  it("survives non-ASCII bytes (binary safety, not UTF-8 round-trip only)", () => {
    const value = { x: 0xff, bytes: Uint8Array.from([0xde, 0xad, 0xbe, 0xef]) }
    const decoded = decodeBuf(bodyBuf(value)) as {
      x: number
      bytes: Uint8Array
    }
    expect(decoded.x).toBe(0xff)
    expect(Array.from(decoded.bytes)).toEqual([0xde, 0xad, 0xbe, 0xef])
  })

  it("first byte never collides with legacy JSON (0x7B)", () => {
    // With useRecords on, msgpackr emits fixext1 (0xd4) at the head of
    // records-mode payloads. With useRecords off it emits a fixmap
    // (0x80..0x8f) / map16 (0xde) / map32 (0xdf). Either way the byte
    // is NOT 0x7B ("{"), which is the only invariant the auto-detect
    // path in `CallCodec.decodeBodyAuto` cares about.
    const buf = bodyBuf({ x: 1 })
    expect(buf.length).toBeGreaterThan(0)
    expect(buf[0]).not.toBe(0x7b)
  })
})

describe("codecHelpers — legacyJsonBuf auto-detect", () => {
  it("decodeBuf dispatches on first byte 0x7B and parses legacy JSON", () => {
    const value = { v: 1, src: "legacy" }
    const buf = legacyJsonBuf(value)
    expect(buf[0]).toBe(0x7b)
    expect(decodeBuf(buf)).toEqual(value)
  })

  it("legacyJsonBuf and bodyBuf produce incompatible bytes on the wire", () => {
    const value = { v: 2 }
    const legacy = legacyJsonBuf(value)
    const modern = bodyBuf(value)
    expect(legacy[0]).toBe(0x7b)
    expect(modern[0]).not.toBe(0x7b)
    expect(Buffer.compare(legacy, modern)).not.toBe(0)
  })
})

describe("codecHelpers — extras survive pack/unpack", () => {
  it("__writtenAtMs grafted onto an opaque payload round-trips through bodyBuf", () => {
    const value = { callRef: "r-1", state: "active" } as Record<string, unknown>
    value.__writtenAtMs = 1_700_000_000_123
    const decoded = decodeBuf(bodyBuf(value)) as Record<string, unknown>
    expect(decoded.__writtenAtMs).toBe(1_700_000_000_123)
    expect(decoded.callRef).toBe("r-1")
  })
})
