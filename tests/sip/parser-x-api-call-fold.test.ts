import { describe, test, expect } from "vitest"
import { Result } from "effect"
import { jssipParser } from "../../src/sip/parsers/jssip-adapter.js"
import { customParser } from "../../src/sip/parsers/custom/index.js"
import { nativeParser } from "../../src/sip/parsers/native-adapter.js"
import type { SipParserImpl } from "../../src/sip/parsers/interface.js"

// The three parsers wired into the production stack: customParser (b2bua
// worker + proxy default), jssipParser (legacy), nativeParser (rvoip).
// We deliberately exclude `sipParserNpm` here — the npm `sip-parser`
// package strips header parameters from `fieldValue` (verified: Via comes
// out as "SIP/2.0/UDP 5.1.1.1:5060" with no `;branch=`), so it can't
// pass the magic-cookie gate in `extract-fields.ts`. That limitation is
// documented in `parser-compliance.test.ts` where it's in `knownFailValid`
// for nearly every RFC 4475 fixture. This test is about whether parsers
// USED BY THE B2BUA fold JSON commas — `sipParserNpm` isn't one of them.
const parsers: SipParserImpl[] = [customParser, jssipParser, nativeParser]

// JSON payload matching the failing k8s reroute scenario.
const apiCallReroute = JSON.stringify({
  action: "route",
  destination: { host: "172.20.0.1", port: 25081 },
  new_ruri: "sip:bob1@172.20.0.1:25081",
  on_failure: {
    action: "failover",
    destination: { host: "172.20.0.1", port: 25081 },
    new_ruri: "sip:bob2@172.20.0.1:25081",
  },
})

const apiCallSimple = JSON.stringify({
  action: "route",
  destination: { host: "172.20.0.1", port: 25081 },
  new_ruri: "sip:bob@172.20.0.1:25081",
})

function buildInvite(xApiCall: string): Buffer {
  const msg =
    "INVITE sip:bob1@kindlab SIP/2.0\r\n" +
    "Via: SIP/2.0/UDP 5.1.1.1:5060;branch=z9hG4bK-test\r\n" +
    "From: <sip:alice@kindlab>;tag=fromtag\r\n" +
    "To: <sip:bob1@kindlab>\r\n" +
    "Call-ID: test-call-id@5.1.1.1\r\n" +
    "CSeq: 1 INVITE\r\n" +
    "Max-Forwards: 70\r\n" +
    "Contact: <sip:alice@5.1.1.1:5060>\r\n" +
    `X-Api-Call: ${xApiCall}\r\n` +
    "Content-Length: 0\r\n" +
    "\r\n"
  return Buffer.from(msg, "utf-8")
}

function findXApiCallValues(headers: ReadonlyArray<{ name: string; value: string }>): string[] {
  return headers
    .filter((h) => h.name.toLowerCase() === "x-api-call")
    .map((h) => h.value)
}

describe.each(parsers)("$name — X-Api-Call JSON integrity", (impl) => {
  test("simple X-Api-Call (no nested object) round-trips", () => {
    const raw = buildInvite(apiCallSimple)
    const r = impl.parse(raw)
    expect(Result.isSuccess(r), `parse failed: ${Result.isFailure(r) ? String(r.failure) : ""}`).toBe(true)
    if (!Result.isSuccess(r)) return
    const vals = findXApiCallValues(r.success.headers)
    console.log(`  [${impl.name}] simple: ${vals.length} entries`)
    expect(vals.length).toBe(1)
    expect(vals[0]).toBe(apiCallSimple)
    // The mock does this:
    expect(() => JSON.parse(vals[0]!)).not.toThrow()
  })

  test("nested X-Api-Call (with on_failure) round-trips", () => {
    const raw = buildInvite(apiCallReroute)
    const r = impl.parse(raw)
    expect(Result.isSuccess(r), `parse failed: ${Result.isFailure(r) ? String(r.failure) : ""}`).toBe(true)
    if (!Result.isSuccess(r)) return
    const vals = findXApiCallValues(r.success.headers)
    console.log(`  [${impl.name}] reroute: ${vals.length} entries: ${vals.map((v) => v.slice(0, 50)).join(" | ")}`)
    expect(vals.length).toBe(1)
    expect(vals[0]).toBe(apiCallReroute)
    expect(() => JSON.parse(vals[0]!)).not.toThrow()
  })

  test("last-write-wins emulation matches extractSipHeaders semantic", () => {
    const raw = buildInvite(apiCallReroute)
    const r = impl.parse(raw)
    if (!Result.isSuccess(r)) {
      console.log(`  [${impl.name}] parse failed: ${String(r.failure)}`)
      return
    }
    // Replicate src/b2bua/InitialInviteHandler.ts:51-62
    const out: Record<string, string> = {}
    for (const h of r.success.headers) {
      const lower = h.name.toLowerCase()
      if (["from","to","via","contact","content-type","call-id","cseq","max-forwards","content-length"].includes(lower)) continue
      out[h.name] = h.value
    }
    const value = out["X-Api-Call"]
    console.log(`  [${impl.name}] extractSipHeaders→X-Api-Call: ${value?.slice(0, 80)}`)
    expect(value).toBeDefined()
    let parsed: unknown
    let parseError: string | undefined
    try { parsed = JSON.parse(value!) } catch (e) { parseError = String(e) }
    if (parseError) {
      console.log(`  [${impl.name}] JSON.parse FAIL: ${parseError}`)
    }
    expect(parseError).toBeUndefined()
    expect((parsed as { on_failure?: unknown }).on_failure).toBeDefined()
  })
})
