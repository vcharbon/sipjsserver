/**
 * Consumer-API gate for `@vcharbon/sipjs/sip`.
 *
 * Exercises the load-bearing parser / serializer / helper symbols on a
 * real SIP REGISTER message. Failure here means a Slice 5+ refactor
 * dropped a public re-export from the /sip subpath.
 */

import { describe, expect, it } from "vitest"
import { Effect } from "effect"

import {
  SipParser,
  serialize,
  getHeader,
  setHeader,
  parseNameAddr,
  parseCSeq,
  newCallId,
  newBranch,
  newTag,
} from "@vcharbon/sipjs/sip"
import type { SipMessage, SipRequest, SipHeader } from "@vcharbon/sipjs/sip"

const REGISTER_RAW = Buffer.from(
  [
    "REGISTER sip:example.test SIP/2.0",
    "Via: SIP/2.0/UDP 127.0.0.1:5060;branch=z9hG4bK-test",
    "From: <sip:alice@example.test>;tag=alice-tag",
    "To: <sip:alice@example.test>",
    "Call-ID: call-123@127.0.0.1",
    "CSeq: 1 REGISTER",
    "Contact: <sip:alice@127.0.0.1:5060>",
    "Max-Forwards: 70",
    "Content-Length: 0",
    "",
    "",
  ].join("\r\n"),
)

describe("@vcharbon/sipjs/sip public surface", () => {
  it("parses a REGISTER, mutates a header, and round-trips through serialize()", () =>
    Effect.gen(function* () {
      const parser = yield* SipParser
      const msg: SipMessage = yield* parser.parse(REGISTER_RAW)
      expect(msg.type).toBe("request")
      const req = msg as SipRequest
      expect(req.method).toBe("REGISTER")

      // helper accessors
      const callId = getHeader(req.headers, "Call-ID")
      expect(callId).toBe("call-123@127.0.0.1")

      // setHeader produces a new ReadonlyArray<SipHeader>
      const updated: ReadonlyArray<SipHeader> = setHeader(
        req.headers,
        "Max-Forwards",
        "69",
      )
      expect(getHeader(updated, "Max-Forwards")).toBe("69")

      // serialize back to wire and re-parse — round-trip preserves Call-ID
      const reSerialized = serialize({ ...req, headers: updated })
      const reParsed = (yield* parser.parse(reSerialized)) as SipRequest
      expect(getHeader(reParsed.headers, "Call-ID")).toBe("call-123@127.0.0.1")
      expect(getHeader(reParsed.headers, "Max-Forwards")).toBe("69")
    }).pipe(Effect.provide(SipParser.layer), Effect.runPromise))

  it("parses structured headers", () => {
    const fromHeader = "<sip:alice@example.test>;tag=alice-tag"
    const parsed = parseNameAddr(fromHeader)
    expect(parsed.uri).toContain("sip:alice@example.test")
    const cseq = parseCSeq("1 REGISTER")
    expect(cseq.seq).toBe(1)
    expect(cseq.method).toBe("REGISTER")
  })

  it("generates fresh Call-ID / branch / tag tokens", () => {
    const a = newCallId("127.0.0.1")
    const b = newCallId("127.0.0.1")
    expect(a).not.toBe(b)
    const branch = newBranch()
    expect(branch).toMatch(/^z9hG4bK/)
    const tag = newTag()
    expect(tag.length).toBeGreaterThan(0)
  })
})
