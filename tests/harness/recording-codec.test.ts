/**
 * Recording codec round-trip tests — Slice 0 verification gate.
 *
 * Per the plan: "every recorded run is serialized and re-parsed; the
 * reparsed object must deep-equal the original. This guarantees the
 * hand-editable format losslessly represents what the runner captured."
 */

import { describe, it, expect } from "vitest"
import { parseRecording, serializeRecording } from "./recording-codec.js"
import type { CallRecording } from "./recording.js"

function stripParsed(rec: CallRecording): CallRecording {
  // The codec ignores `parsed` (it's not on disk). Strip before deep-equal.
  return {
    ...rec,
    entries: rec.entries.map((e) => {
      if (e.kind !== "message") return e
      const { parsed: _ignored, ...rest } = e
      return rest
    }),
  }
}

describe("recording-codec round-trip", () => {
  it("empty recording", () => {
    const rec: CallRecording = {
      scenarioId: "demo",
      serviceCaseId: null,
      callId: "abc@host",
      startMs: 0,
      entries: [],
    }
    const back = parseRecording(serializeRecording(rec))
    expect(back).toEqual(rec)
  })

  it("single message with label", () => {
    const rec: CallRecording = {
      scenarioId: "basic-call",
      serviceCaseId: "basic-call",
      callId: "abc@host",
      startMs: 100,
      entries: [
        {
          kind: "message",
          direction: "sent",
          from: "alice",
          to: "DUT",
          label: "alice.invite",
          sentMs: 100,
          receivedMs: 115,
          raw:
            "INVITE sip:+1234@127.0.0.1:15060 SIP/2.0\r\n" +
            "Via: SIP/2.0/UDP 127.0.0.1:15661;branch=z9hG4bK1\r\n" +
            "From: <sip:alice@test>;tag=t1\r\n" +
            "To: <sip:+1234@test>\r\n" +
            "Call-ID: abc@host\r\n" +
            "CSeq: 1 INVITE\r\n" +
            "Content-Length: 0\r\n\r\n",
        },
      ],
    }
    const back = parseRecording(serializeRecording(rec))
    expect(stripParsed(back)).toEqual(rec)
  })

  it("mixed entries (message + timeout + marker)", () => {
    const rec: CallRecording = {
      scenarioId: "mixed",
      serviceCaseId: "case-a",
      callId: "id@h",
      startMs: 0,
      entries: [
        {
          kind: "message",
          direction: "received",
          from: "DUT",
          to: "bob",
          sentMs: 5,
          receivedMs: 20,
          raw: "100 Trying SIP/2.0\r\n\r\n",
        },
        {
          kind: "timeout",
          agent: "alice",
          waitingFor: "180 Ringing",
          atMs: 5000,
          label: "ringing",
        },
        {
          kind: "marker",
          atMs: 6000,
          label: "phaseTwo",
          note: "second leg",
        },
      ],
    }
    const back = parseRecording(serializeRecording(rec))
    expect(stripParsed(back)).toEqual(rec)
  })

  it("preserves multi-line raw with empty lines", () => {
    const rawSip =
      "INVITE sip:x SIP/2.0\r\n" +
      "Via: SIP/2.0/UDP 1.2.3.4;branch=z9hG4bK\r\n" +
      "Content-Type: application/sdp\r\n" +
      "Content-Length: 5\r\n" +
      "\r\n" +
      "v=0\r\n"
    const rec: CallRecording = {
      scenarioId: "x",
      serviceCaseId: null,
      callId: "id@h",
      startMs: 0,
      entries: [
        {
          kind: "message",
          direction: "sent",
          from: "a",
          to: "b",
          sentMs: 0,
          receivedMs: 1,
          raw: rawSip,
        },
      ],
    }
    const back = parseRecording(serializeRecording(rec))
    expect(stripParsed(back)).toEqual(rec)
  })

  it("rejects unknown top-level keys", () => {
    expect(() => parseRecording("scenario: x\nbogus: y\nentries: []\n")).toThrow(
      /unknown top-level key/
    )
  })
})
