/**
 * Wire-protocol codec round-trip + member-parsing tests
 * (post-msgpackr-migration).
 *
 * Asserts:
 *   - `encodeFrame` produces length-prefixed msgpack bytes
 *     (`[4-byte BE uint32 length][msgpack payload]`).
 *   - `decodeFrame` is the inverse for both Data and Noop frames; the
 *     `body` field round-trips as a Buffer regardless of whether the
 *     originator used legacy JSON or msgpack inside it.
 *   - Malformed payloads surface as `ProtocolError`.
 *   - `parseMember` extracts (op, partition, callRef) from `KvBackend`
 *     member strings without allocating temporaries.
 *   - `buildDataFrame` derives all wire-frame fields from a `PulledEntry`
 *     and computes `latency_ms` from the body's `__writtenAtMs` field.
 */

import { describe, expect, it } from "vitest"
import { Encoder } from "msgpackr"
import {
  ProtocolError,
  buildDataFrame,
  decodeFrame,
  encodeFrame,
  parseMember,
  type DataFrame,
  type NoopFrame,
} from "../../src/replication/ReplicationProtocol.js"
import { bodyBuf } from "../support/codecHelpers.js"

// Same Encoder config as the production wire codec — used here to
// fabricate length-prefixed payloads for the error-case tests.
const encoder = new Encoder({
  useRecords: false,
  copyBuffers: true,
  encodeUndefinedAsNil: false,
})

const lengthPrefix = (payload: Buffer): Buffer => {
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.length >>> 0, 0)
  return Buffer.concat([header, payload])
}

const readLengthPrefixedPayload = (encoded: Buffer): Buffer => {
  const length = encoded.readUInt32BE(0)
  return encoded.subarray(4, 4 + length)
}

describe("encodeFrame / decodeFrame round-trip — Data", () => {
  const innerBody = { _topology: { gen: 42 }, state: "active" }
  const data: DataFrame = {
    _tag: "Data",
    gen: 42,
    counter: 105,
    op: "update",
    partition: "pri",
    callRef: "abc",
    body: bodyBuf(innerBody),
    body_ttl_remaining_sec: 540,
    latency_ms: 12,
    callGen: 42,
    indexes: ["leg:abc|tag1"],
  }

  it("encodes to a length-prefixed msgpack frame", () => {
    const encoded = encodeFrame(data)
    expect(encoded.length).toBeGreaterThan(4)
    const length = encoded.readUInt32BE(0)
    expect(encoded.length).toBe(4 + length)

    const payload = readLengthPrefixedPayload(encoded)
    const obj = encoder.unpack(payload) as Record<string, unknown>
    expect(obj["type"]).toBe("data")
    expect(obj["gen"]).toBe(42)
    expect(obj["counter"]).toBe(105)
    expect(obj["op"]).toBe("update")
    expect(obj["partition"]).toBe("pri")
    expect(obj["callRef"]).toBe("abc")
    // body is nested msgpack bytes inside the outer map.
    const bodyField = obj["body"]
    expect(Buffer.isBuffer(bodyField) || bodyField instanceof Uint8Array).toBe(
      true,
    )
    expect(obj["body_ttl_remaining_sec"]).toBe(540)
    expect(obj["latency_ms"]).toBe(12)
  })

  it("decodes the payload back to an equivalent frame", () => {
    const encoded = encodeFrame(data)
    const decoded = decodeFrame(readLengthPrefixedPayload(encoded))
    expect(decoded._tag).toBe("Data")
    expect(decoded.gen).toBe(42)
    expect(decoded.counter).toBe(105)
    expect((decoded as DataFrame).callRef).toBe("abc")
    expect(Buffer.isBuffer((decoded as DataFrame).body)).toBe(true)
    expect(((decoded as DataFrame).body as Buffer).equals(bodyBuf(innerBody))).toBe(true)
  })
})

describe("encodeFrame / decodeFrame round-trip — Noop", () => {
  const noop: NoopFrame = {
    _tag: "Noop",
    gen: 42,
    counter: 999,
    latency_ms: 0,
  }

  it("encodes to a length-prefixed noop frame", () => {
    const encoded = encodeFrame(noop)
    const payload = readLengthPrefixedPayload(encoded)
    const obj = encoder.unpack(payload) as Record<string, unknown>
    expect(obj["type"]).toBe("noop")
    expect(obj["gen"]).toBe(42)
    expect(obj["counter"]).toBe(999)
    expect("op" in obj).toBe(false)
    expect("body" in obj).toBe(false)
  })

  it("decodes back to an equivalent frame", () => {
    const encoded = encodeFrame(noop)
    expect(decodeFrame(readLengthPrefixedPayload(encoded))).toEqual(noop)
  })
})

describe("decodeFrame — error and edge cases", () => {
  it("throws ProtocolError for a payload that is not a msgpack object", () => {
    // Single positive fixint (123 = 0x7b — happens to be `{` in ASCII,
    // but at the msgpack level it's a scalar number, not a map).
    expect(() => decodeFrame(Buffer.from([0x7b]))).toThrow(ProtocolError)
  })

  it("throws ProtocolError for an unknown frame type", () => {
    const payload = encoder.pack({ type: "hello", gen: 1, counter: 1 }) as Buffer
    expect(() => decodeFrame(payload)).toThrow(ProtocolError)
  })

  it("throws ProtocolError for a data frame missing op/partition/callRef", () => {
    const payload = encoder.pack({
      type: "data",
      gen: 1,
      counter: 1,
      body: null,
    }) as Buffer
    expect(() => decodeFrame(payload)).toThrow(ProtocolError)
  })

  it("delete frame may have body=null and decodes correctly", () => {
    const payload = encoder.pack({
      type: "data",
      gen: 1,
      counter: 1,
      op: "delete",
      partition: "pri",
      callRef: "x",
      body: null,
      body_ttl_remaining_sec: 0,
      latency_ms: 0,
    }) as Buffer
    const decoded = decodeFrame(payload) as DataFrame
    expect(decoded._tag).toBe("Data")
    expect(decoded.op).toBe("delete")
    expect(decoded.body).toBeNull()
    expect(decoded.body_ttl_remaining_sec).toBe(0)
  })

  it("end-to-end encode → length-prefix → decode survives a full byte round-trip", () => {
    const original: DataFrame = {
      _tag: "Data",
      gen: 7,
      counter: 13,
      op: "create",
      partition: "bak",
      callRef: "round-trip",
      body: bodyBuf({ foo: 1 }),
      body_ttl_remaining_sec: 30,
      latency_ms: 5,
      callGen: 7,
      indexes: ["leg:abc|tag1", "ctx:foo"],
    }
    const encoded = encodeFrame(original)
    const payload = readLengthPrefixedPayload(encoded)
    const decoded = decodeFrame(payload)
    expect(decoded._tag).toBe("Data")
    expect((decoded as DataFrame).callRef).toBe("round-trip")
    expect((decoded as DataFrame).callGen).toBe(7)
    expect((decoded as DataFrame).indexes).toEqual(["leg:abc|tag1", "ctx:foo"])
    // Re-encode with the same length-prefix logic and verify byte equality.
    const reEncoded = lengthPrefix(encoder.pack({
      type: "data",
      gen: original.gen,
      counter: original.counter,
      op: original.op,
      partition: original.partition,
      callRef: original.callRef,
      body: original.body,
      body_ttl_remaining_sec: original.body_ttl_remaining_sec,
      latency_ms: original.latency_ms,
      callGen: original.callGen,
      indexes: original.indexes,
    }) as Buffer)
    expect(encoded.equals(reEncoded)).toBe(true)
  })
})

describe("parseMember", () => {
  it("decomposes U-prefixed pri member", () => {
    expect(parseMember("U:pri:worker-A:call:abc")).toEqual({
      op: "update",
      partition: "pri",
      callRef: "abc",
    })
  })

  it("decomposes D-prefixed bak member", () => {
    expect(parseMember("D:bak:worker-B:call:xyz")).toEqual({
      op: "delete",
      partition: "bak",
      callRef: "xyz",
    })
  })

  it("preserves callRef colons (callRef may itself contain colons)", () => {
    expect(parseMember("U:pri:worker-A:call:CID-1:tag-A")).toEqual({
      op: "update",
      partition: "pri",
      callRef: "CID-1:tag-A",
    })
  })

  it("returns null for malformed members", () => {
    expect(parseMember("")).toBeNull()
    expect(parseMember("X:pri:o:call:a")).toBeNull()        // bad op tag
    expect(parseMember("U:foo:o:call:a")).toBeNull()        // bad partition
    expect(parseMember("U:pri:owner-no-call-marker")).toBeNull()
  })
})

describe("buildDataFrame", () => {
  it("derives op/partition/callRef from the member; gen comes from entry.entryGen; ttl_remaining passes through", () => {
    const inner = { _topology: { gen: 42 }, state: "active" }
    const frame = buildDataFrame(
      {
        member: "U:pri:worker-A:call:abc",
        entryGen: 42,
        score: 105,
        body: bodyBuf(inner),
        body_ttl_remaining_sec: 600,
      },
      1_000,
    )
    expect(frame).not.toBeNull()
    expect(frame!.gen).toBe(42)
    expect(frame!.counter).toBe(105)
    expect(frame!.op).toBe("update")
    expect(frame!.partition).toBe("pri")
    expect(frame!.callRef).toBe("abc")
    expect((frame!.body as Buffer).equals(bodyBuf(inner))).toBe(true)
    expect(frame!.body_ttl_remaining_sec).toBe(600)
  })

  it("mirror entries (entryGen=0) produce frames with gen=0 — the cycle-break sentinel", () => {
    const frame = buildDataFrame(
      {
        member: "U:bak:worker-A:call:abc",
        entryGen: 0,
        score: 7,
        body: bodyBuf({ _topology: { gen: 1 } }),
        body_ttl_remaining_sec: 60,
      },
      0,
    )
    expect(frame!.gen).toBe(0)
    expect(frame!.counter).toBe(7)
  })

  it("computes latency_ms from body.__writtenAtMs when present", () => {
    const frame = buildDataFrame(
      {
        member: "U:pri:worker-A:call:abc",
        entryGen: 1,
        score: 1,
        body: bodyBuf({ __writtenAtMs: 900 }),
        body_ttl_remaining_sec: 60,
      },
      1_000,
    )
    expect(frame!.latency_ms).toBe(100)
  })

  it("latency_ms = 0 when body has no __writtenAtMs field", () => {
    const frame = buildDataFrame(
      {
        member: "U:pri:worker-A:call:abc",
        entryGen: 1,
        score: 1,
        body: bodyBuf({ x: 1 }),
        body_ttl_remaining_sec: 60,
      },
      1_000,
    )
    expect(frame!.latency_ms).toBe(0)
  })

  it("body=null when the source body has TTL'd or was DEL'd", () => {
    const frame = buildDataFrame(
      {
        member: "D:pri:worker-A:call:abc",
        entryGen: 1,
        score: 5,
        body: null,
        body_ttl_remaining_sec: 0,
      },
      1_000,
    )
    expect(frame!.body).toBeNull()
    expect(frame!.op).toBe("delete")
    expect(frame!.body_ttl_remaining_sec).toBe(0)
  })

  it("returns null for a malformed member (programming bug upstream)", () => {
    const frame = buildDataFrame(
      { member: "garbage", entryGen: 1, score: 1, body: bodyBuf({}), body_ttl_remaining_sec: 60 },
      0,
    )
    expect(frame).toBeNull()
  })
})
