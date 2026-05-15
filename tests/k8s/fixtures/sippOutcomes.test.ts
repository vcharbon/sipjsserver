import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { parseSippMessageTrace, parseSippStat } from "./sippOutcomes.js"

/**
 * Regression test for the sipp trace parsers, anchored on a real
 * sample captured from a kind-cluster run (5 calls @ 2 cps,
 * `uac-basic.xml`, no failures). The sample lives under
 * `__samples__/` so the parser can be re-validated against the exact
 * format sipp produced — guessing at the format is forbidden by the
 * shared-infra slice plan in
 * `docs/plan/proper-end-to-end-cheerful-lobster.md`.
 */
describe("sippOutcomes — sipp trace parser", () => {
  const here = path.dirname(fileURLToPath(import.meta.url))

  it("parseSippMessageTrace classifies all 5 sample calls as clean", () => {
    const samplePath = path.join(here, "__samples__", "sipp-msg-trace.sample.txt")
    const log = fs.readFileSync(samplePath, "utf8")
    const result = parseSippMessageTrace(log)

    // Sample contains exactly 5 distinct Call-IDs.
    expect(result.size).toBe(5)

    const expectedCallIds = [
      "1-11@10.244.3.130",
      "2-11@10.244.3.130",
      "3-11@10.244.3.130",
      "4-11@10.244.3.130",
      "5-11@10.244.3.130",
    ]
    for (const cid of expectedCallIds) {
      const entry = result.get(cid)
      expect(entry, `Call-ID ${cid} should be present`).toBeDefined()
      if (!entry) continue
      expect(entry.outcome).toBe("clean")
      expect(entry.retransmits).toBe(0)
      expect(entry.lastResponse).toBe(200)
      expect(entry.tFirstInvite).toBeInstanceOf(Date)
      expect(entry.tAck).toBeInstanceOf(Date)
    }
  })

  it("parseSippStat reads cumulative totals from the stat.csv sample", () => {
    const samplePath = path.join(here, "__samples__", "sipp-stat.sample.csv")
    const csv = fs.readFileSync(samplePath, "utf8")
    const totals = parseSippStat(csv)
    expect(totals).toBeDefined()
    if (!totals) return
    expect(totals.totalCalls).toBe(5)
    expect(totals.successful).toBe(5)
    expect(totals.failed).toBe(0)
  })

  it("parseSippMessageTrace returns empty Map for an empty input", () => {
    expect(parseSippMessageTrace("").size).toBe(0)
  })

  // sipp v3.7.7 (current k8s/kind image) writes the separator
  // timestamp in ISO-8601: `YYYY-MM-DDTHH:MM:SS.ssssssZ`. Pre-v3.7
  // builds wrote `YYYY-MM-DD HH:MM:SS.ssssss` (space-separated, local
  // time). The parser was originally pinned to the old format and
  // silently returned an empty Map against the new one — broke every
  // per-event verdict in the chaos sub-command. This regression test
  // pins the new format so a future regex regression won't slip past.
  it("parseSippMessageTrace handles ISO-8601 separator timestamps (sipp v3.7+)", () => {
    const log = [
      "----------------------------------------------- 2026-05-15T16:24:27.276466Z",
      "UDP message sent [589] bytes:",
      "",
      "INVITE sip:test@172.20.255.250:5060 SIP/2.0",
      "Via: SIP/2.0/UDP 10.244.6.7:5060;branch=z9hG4bK-10-1-0;rport",
      "From: sipp <sip:sipp@10.244.6.7:5060>;tag=10SIPpTag001",
      "To: sut <sip:test@172.20.255.250:5060>",
      "Call-ID: iso-sample-1@det",
      "CSeq: 1 INVITE",
      "Content-Length: 0",
      "",
      "----------------------------------------------- 2026-05-15T16:24:27.300715Z",
      "UDP message received [769] bytes:",
      "",
      "SIP/2.0 200 OK",
      "Via: SIP/2.0/UDP 10.244.6.7:5060;branch=z9hG4bK-10-1-0;rport=5060",
      "From: sipp <sip:sipp@10.244.6.7:5060>;tag=10SIPpTag001",
      "To: sut <sip:test@172.20.255.250:5060>;tag=9httw7ls",
      "Call-ID: iso-sample-1@det",
      "CSeq: 1 INVITE",
      "Content-Length: 0",
      "",
      "----------------------------------------------- 2026-05-15T16:24:27.300877Z",
      "UDP message sent [498] bytes:",
      "",
      "ACK sip:test@172.20.255.250:5060 SIP/2.0",
      "Via: SIP/2.0/UDP 10.244.6.7:5060;branch=z9hG4bK-10-1-4;rport",
      "From: sipp <sip:sipp@10.244.6.7:5060>;tag=10SIPpTag001",
      "To: sut <sip:test@172.20.255.250:5060>;tag=9httw7ls",
      "Call-ID: iso-sample-1@det",
      "CSeq: 1 ACK",
      "Content-Length: 0",
      "",
    ].join("\n")
    const result = parseSippMessageTrace(log)
    expect(result.size).toBe(1)
    const entry = result.get("iso-sample-1@det")
    expect(entry).toBeDefined()
    if (!entry) return
    expect(entry.lastResponse).toBe(200)
    expect(entry.tFirstInvite).toBeInstanceOf(Date)
    expect(entry.tFirstInvite?.toISOString()).toBe("2026-05-15T16:24:27.276Z")
    expect(entry.tAck).toBeInstanceOf(Date)
    expect(entry.tAck?.toISOString()).toBe("2026-05-15T16:24:27.300Z")
  })

  it("parseSippStat returns undefined for an empty CSV", () => {
    expect(parseSippStat("")).toBeUndefined()
  })
})
