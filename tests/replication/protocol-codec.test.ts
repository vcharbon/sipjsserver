/**
 * Wire-protocol codec round-trip + member-parsing tests (Slice 4).
 *
 * Asserts:
 *   - `encodeFrame` produces the spec NDJSON shape (one JSON object per
 *     line, trailing newline, the wire-level "type" field).
 *   - `decodeFrame` is the inverse for both Data and Noop frames.
 *   - Malformed lines surface as `ProtocolError`.
 *   - `parseMember` extracts (op, partition, callRef) from `KvBackend`
 *     member strings without allocating temporaries.
 *   - `buildDataFrame` derives all wire-frame fields from a `PulledEntry`
 *     and computes `latency_ms` from `body.written_at_ms` if present.
 */

import { describe, expect, it } from "vitest"
import {
  ProtocolError,
  buildDataFrame,
  decodeFrame,
  encodeFrame,
  parseMember,
  type DataFrame,
  type NoopFrame,
} from "../../src/replication/ReplicationProtocol.js"

describe("encodeFrame / decodeFrame round-trip — Data", () => {
  const data: DataFrame = {
    _tag: "Data",
    gen: 42,
    counter: 105,
    op: "update",
    partition: "pri",
    callRef: "abc",
    body: { _topology: { gen: 42 }, state: "active" },
    body_ttl_remaining_sec: 540,
    latency_ms: 12,
  }

  it("encodes to the expected wire shape", () => {
    const encoded = encodeFrame(data)
    expect(encoded.endsWith("\n")).toBe(true)
    const obj = JSON.parse(encoded.trim()) as Record<string, unknown>
    expect(obj["type"]).toBe("data")
    expect(obj["gen"]).toBe(42)
    expect(obj["counter"]).toBe(105)
    expect(obj["op"]).toBe("update")
    expect(obj["partition"]).toBe("pri")
    expect(obj["callRef"]).toBe("abc")
    expect(obj["body"]).toEqual({ _topology: { gen: 42 }, state: "active" })
    expect(obj["body_ttl_remaining_sec"]).toBe(540)
    expect(obj["latency_ms"]).toBe(12)
  })

  it("decodes back to an equivalent frame", () => {
    const encoded = encodeFrame(data)
    const decoded = decodeFrame(encoded)
    expect(decoded).toEqual(data)
  })
})

describe("encodeFrame / decodeFrame round-trip — Noop", () => {
  const noop: NoopFrame = {
    _tag: "Noop",
    gen: 42,
    counter: 999,
    latency_ms: 0,
  }

  it("encodes to a noop wire shape", () => {
    const encoded = encodeFrame(noop)
    const obj = JSON.parse(encoded.trim()) as Record<string, unknown>
    expect(obj["type"]).toBe("noop")
    expect(obj["gen"]).toBe(42)
    expect(obj["counter"]).toBe(999)
    expect("op" in obj).toBe(false)
    expect("body" in obj).toBe(false)
  })

  it("decodes back to an equivalent frame", () => {
    const encoded = encodeFrame(noop)
    expect(decodeFrame(encoded)).toEqual(noop)
  })
})

describe("decodeFrame — error and edge cases", () => {
  it("returns null for a blank line", () => {
    expect(decodeFrame("")).toBeNull()
    expect(decodeFrame("   \n")).toBeNull()
  })

  it("throws ProtocolError for malformed JSON", () => {
    expect(() => decodeFrame("not json")).toThrow(ProtocolError)
  })

  it("throws ProtocolError for an unknown frame type", () => {
    expect(() =>
      decodeFrame(JSON.stringify({ type: "hello", gen: 1, counter: 1 }))
    ).toThrow(ProtocolError)
  })

  it("throws ProtocolError for a data frame missing op/partition/callRef", () => {
    expect(() =>
      decodeFrame(
        JSON.stringify({ type: "data", gen: 1, counter: 1, body: {} })
      )
    ).toThrow(ProtocolError)
  })

  it("delete frame may have body=null and decodes correctly", () => {
    const line = JSON.stringify({
      type: "data",
      gen: 1,
      counter: 1,
      op: "delete",
      partition: "pri",
      callRef: "x",
      body: null,
      body_ttl_remaining_sec: 0,
      latency_ms: 0,
    })
    const decoded = decodeFrame(line) as DataFrame
    expect(decoded._tag).toBe("Data")
    expect(decoded.op).toBe("delete")
    expect(decoded.body).toBeNull()
    expect(decoded.body_ttl_remaining_sec).toBe(0)
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
    // Some callRefs are signaling-derived and contain colons.
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
    const frame = buildDataFrame(
      {
        member: "U:pri:worker-A:call:abc",
        entryGen: 42,
        score: 105,
        body: '{"_topology":{"gen":42},"state":"active"}',
        body_ttl_remaining_sec: 600,
      },
      1_000
    )
    expect(frame).not.toBeNull()
    expect(frame!.gen).toBe(42)
    expect(frame!.counter).toBe(105)
    expect(frame!.op).toBe("update")
    expect(frame!.partition).toBe("pri")
    expect(frame!.callRef).toBe("abc")
    expect(frame!.body).toEqual({ _topology: { gen: 42 }, state: "active" })
    expect(frame!.body_ttl_remaining_sec).toBe(600)
  })

  it("mirror entries (entryGen=0) produce frames with gen=0 — the cycle-break sentinel", () => {
    const frame = buildDataFrame(
      {
        member: "U:bak:worker-A:call:abc",
        entryGen: 0,
        score: 7,
        body: '{"_topology":{"gen":1}}',
        body_ttl_remaining_sec: 60,
      },
      0
    )
    expect(frame!.gen).toBe(0)
    expect(frame!.counter).toBe(7)
  })

  it("computes latency_ms from body.written_at_ms when present", () => {
    const frame = buildDataFrame(
      {
        member: "U:pri:worker-A:call:abc",
        entryGen: 1,
        score: 1,
        body: '{"written_at_ms":900}',
        body_ttl_remaining_sec: 60,
      },
      1_000
    )
    expect(frame!.latency_ms).toBe(100)
  })

  it("latency_ms = 0 when body has no written_at_ms field", () => {
    const frame = buildDataFrame(
      {
        member: "U:pri:worker-A:call:abc",
        entryGen: 1,
        score: 1,
        body: '{"x":1}',
        body_ttl_remaining_sec: 60,
      },
      1_000
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
      1_000
    )
    expect(frame!.body).toBeNull()
    expect(frame!.op).toBe("delete")
    expect(frame!.body_ttl_remaining_sec).toBe(0)
  })

  it("returns null for a malformed member (programming bug upstream)", () => {
    const frame = buildDataFrame(
      { member: "garbage", entryGen: 1, score: 1, body: "{}", body_ttl_remaining_sec: 60 },
      0
    )
    expect(frame).toBeNull()
  })
})
