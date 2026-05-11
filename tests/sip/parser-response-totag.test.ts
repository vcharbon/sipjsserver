/**
 * Parser tightening: response To-tag enforcement.
 *
 * RFC 3261 §8.2.6.2 / §17.1.3: every response except 100 Trying MUST carry a
 * To-tag. The parser rejects non-100 responses missing it; 100 Trying remains
 * lenient (it's a hop-by-hop progress indicator absorbed at the transaction
 * layer before reaching the rule chain).
 *
 * These tests pin both behaviors so the conditional types that depend on
 * `SipResponseTagged.getHeader("to").tag: string` stay sound.
 */

import { describe, test, expect } from "vitest"
import { Result } from "effect"

import { customParser } from "../../src/sip/parsers/custom/index.js"
import { jssipParser } from "../../src/sip/parsers/jssip-adapter.js"
import { sipMsg } from "./fixtures/rfc4475-valid.js"

const responseNoTag = (status: number, reason: string) => sipMsg`SIP/2.0 ${String(status)} ${reason}
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-x
From: <sip:alice@example.com>;tag=from-tag-1
To: <sip:bob@example.com>
Call-ID: notag-${String(status)}@10.0.0.1
CSeq: 1 INVITE
Content-Length: 0

`

const responseWithTag = (status: number, reason: string) => sipMsg`SIP/2.0 ${String(status)} ${reason}
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-x
From: <sip:alice@example.com>;tag=from-tag-1
To: <sip:bob@example.com>;tag=to-tag-2
Call-ID: tag-${String(status)}@10.0.0.1
CSeq: 1 INVITE
Content-Length: 0

`

const trying100NoTag = sipMsg`SIP/2.0 100 Trying
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-100
From: <sip:alice@example.com>;tag=from-tag-1
To: <sip:bob@example.com>
Call-ID: trying-no-tag@10.0.0.1
CSeq: 1 INVITE
Content-Length: 0

`

describe("Parser — non-100 responses must carry To-tag", () => {
  for (const [status, reason] of [
    [180, "Ringing"],
    [183, "Session Progress"],
    [200, "OK"],
    [302, "Moved Temporarily"],
    [404, "Not Found"],
    [486, "Busy Here"],
    [503, "Service Unavailable"],
    [603, "Decline"],
  ] as const) {
    test(`status=${status} without To-tag → parse error (custom)`, () => {
      const r = customParser.parse(responseNoTag(status, reason))
      expect(Result.isFailure(r)).toBe(true)
      if (Result.isFailure(r)) {
        expect(r.failure.reason).toContain("missing mandatory To-tag")
        expect(r.failure.reason).toContain(String(status))
      }
    })

    test(`status=${status} without To-tag → parse error (jssip)`, () => {
      const r = jssipParser.parse(responseNoTag(status, reason))
      expect(Result.isFailure(r)).toBe(true)
    })

    test(`status=${status} with To-tag → success`, () => {
      const r = customParser.parse(responseWithTag(status, reason))
      expect(Result.isSuccess(r)).toBe(true)
      if (Result.isSuccess(r)) {
        if (r.success.type !== "response") throw new Error("expected response")
        expect(r.success.getHeader("to").tag).toBe("to-tag-2")
      }
    })
  }
})

describe("Parser — 100 Trying may omit To-tag", () => {
  test("100 Trying without To-tag parses successfully (custom)", () => {
    const r = customParser.parse(trying100NoTag)
    expect(Result.isSuccess(r)).toBe(true)
    if (Result.isSuccess(r)) {
      if (r.success.type !== "response") throw new Error("expected response")
      expect(r.success.status).toBe(100)
      expect(r.success.getHeader("to").tag).toBeUndefined()
    }
  })

  test("100 Trying without To-tag parses successfully (jssip)", () => {
    const r = jssipParser.parse(trying100NoTag)
    expect(Result.isSuccess(r)).toBe(true)
  })
})
