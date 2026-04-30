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

  it("parseSippStat returns undefined for an empty CSV", () => {
    expect(parseSippStat("")).toBeUndefined()
  })
})
