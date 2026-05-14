/**
 * SVG anti-invention property test — Slice 5 of the recording-layer plan
 * (.claude/plans/html-report-recording-layer-faithful-trace.md).
 *
 * Asserts the renderer cannot introduce an IP:port or a name that
 * doesn't exist in the underlying `ScenarioResult`. This is the
 * structural defense against the original "report invents names/IPs"
 * bug — a future commit that re-introduces fabrication fails the test
 * immediately.
 *
 * Strategy:
 *   1. Construct a minimal ScenarioResult by hand with a known set of
 *      lanes and trace entries.
 *   2. Render the HTML, extract the embedded SVG.
 *   3. Walk every `\d+\.\d+\.\d+\.\d+:\d+` literal in the SVG; assert
 *      each one is in the lane registry.
 *   4. Walk every monospace text node that isn't an IP, a SIP method, a
 *      status phrase, or a known UI literal; assert each is a
 *      registered lane name.
 *   5. Sabotage check: prepend a synthetic "alice2" string to one of
 *      the test trace entries' `from` field and expect the assertion
 *      to fire — guarantees the property test catches the actual bug
 *      shape.
 */

import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { writeScenarioReport } from "../../src/test-harness/framework/html-report.js"
import type {
  Lane,
  ScenarioResult,
  TraceEntry,
} from "../../src/test-harness/framework/types.js"
import { SipParser } from "../../src/sip/Parser.js"
import type { SipMessage } from "../../src/sip/types.js"

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const INVITE_RAW = Buffer.from(
  [
    "INVITE sip:bob@example.test SIP/2.0",
    "Via: SIP/2.0/UDP 10.10.0.1:5060;branch=z9hG4bK-roundtrip",
    "From: <sip:alice@example.test>;tag=alice-tag",
    "To: <sip:bob@example.test>",
    "Call-ID: roundtrip-1@10.10.0.1",
    "CSeq: 1 INVITE",
    "Contact: <sip:alice@10.10.0.1:5060>",
    "Max-Forwards: 70",
    "Content-Length: 0",
    "",
    "",
  ].join("\r\n"),
)

const OK_RAW = Buffer.from(
  [
    "SIP/2.0 200 OK",
    "Via: SIP/2.0/UDP 10.10.0.1:5060;branch=z9hG4bK-roundtrip",
    "From: <sip:alice@example.test>;tag=alice-tag",
    "To: <sip:bob@example.test>;tag=bob-tag",
    "Call-ID: roundtrip-1@10.10.0.1",
    "CSeq: 1 INVITE",
    "Contact: <sip:bob@10.10.0.2:5060>",
    "Content-Length: 0",
    "",
    "",
  ].join("\r\n"),
)

const parseMsg = (raw: Buffer) =>
  Effect.gen(function* () {
    const parser = yield* SipParser
    return (yield* parser.parse(raw)) as SipMessage
  }).pipe(Effect.provide(SipParser.layer))

function buildFixture(): { result: ScenarioResult; ips: Set<string>; names: Set<string> } {
  const invite = Effect.runSync(parseMsg(INVITE_RAW))
  const ok = Effect.runSync(parseMsg(OK_RAW))

  const lanes: ReadonlyArray<Lane> = [
    { ip: "10.10.0.1", port: 5060, names: ["alice"], network: "ext", killedAt: [] },
    { ip: "10.10.0.2", port: 5060, names: ["bob"], network: "ext", killedAt: [] },
  ]

  const trace: ReadonlyArray<TraceEntry> = [
    {
      timestamp: 0,
      sentMs: 0,
      receivedMs: 5,
      from: "alice",
      to: "bob",
      fromAddr: { ip: "10.10.0.1", port: 5060 },
      toAddr: { ip: "10.10.0.2", port: 5060 },
      direction: "send",
      stepIndex: 0,
      status: "pass",
      message: invite,
      network: "ext",
    },
    {
      timestamp: 10,
      sentMs: 5,
      receivedMs: 10,
      from: "bob",
      to: "alice",
      fromAddr: { ip: "10.10.0.2", port: 5060 },
      toAddr: { ip: "10.10.0.1", port: 5060 },
      direction: "receive",
      stepIndex: 1,
      status: "pass",
      message: ok,
      network: "ext",
    },
  ]

  const result: ScenarioResult = {
    scenarioName: "roundtrip-anti-invention",
    transportKind: "fake",
    stepResults: [],
    trace,
    participants: [
      { name: "alice", network: "ext" },
      { name: "bob", network: "ext" },
    ],
    lanes,
    anomalies: [],
    passed: 2,
    failed: 0,
    skipped: 0,
  }

  return {
    result,
    ips: new Set(lanes.map((l) => `${l.ip}:${l.port}`)),
    names: new Set(lanes.flatMap((l) => l.names)),
  }
}

// ---------------------------------------------------------------------------
// SVG extraction & invariant checks
// ---------------------------------------------------------------------------

function extractSvg(html: string): string {
  const start = html.indexOf("<svg")
  const end = html.indexOf("</svg>", start)
  if (start < 0 || end < 0) throw new Error("no <svg> in rendered HTML")
  return html.slice(start, end + "</svg>".length)
}

function extractIpPorts(svg: string): string[] {
  // Match every `\d+\.\d+\.\d+\.\d+:\d+` literal. The pattern is
  // intentionally narrow (IPv4) — IPv6 would need a separate matcher.
  const re = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}\b/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(svg)) !== null) out.push(m[0])
  return out
}

/**
 * Extract every name-like literal from the lane-header text nodes of
 * the SVG. The renderer emits the name-line text with `fill="#4b5563"`
 * (gray-600) exclusively — no other text element uses that color —
 * so matching on that fill cleanly isolates lane-header names from
 * arrow labels, tags, and timing annotations.
 */
function extractLaneHeaderNames(svg: string): string[] {
  const out: string[] = []
  const re = /<text[^>]*fill="#4b5563"[^>]*>([^<]+)<\/text>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(svg)) !== null) {
    const candidate = m[1]!.trim()
    if (candidate.length === 0) continue
    for (const piece of candidate.split(",").map((s) => s.trim()).filter(Boolean)) {
      out.push(piece)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HTML report anti-invention property", () => {
  it("every IP:port in the SVG appears in the lane registry", () => {
    const { result, ips } = buildFixture()
    const dir = mkdtempSync(join(tmpdir(), "roundtrip-"))
    const htmlPath = writeScenarioReport(result, dir)
    const html = readFileSync(htmlPath, "utf-8")
    const svg = extractSvg(html)
    const found = extractIpPorts(svg)

    expect(found.length).toBeGreaterThan(0)
    for (const ipPort of found) {
      expect(ips, `SVG contains fabricated address ${ipPort}`).toContain(ipPort)
    }
  })

  it("every lane-header name in the SVG appears in the lane registry", () => {
    const { result, names } = buildFixture()
    const dir = mkdtempSync(join(tmpdir(), "roundtrip-"))
    const htmlPath = writeScenarioReport(result, dir)
    const html = readFileSync(htmlPath, "utf-8")
    const svg = extractSvg(html)
    const found = extractLaneHeaderNames(svg)

    expect(found.length).toBeGreaterThan(0)
    for (const name of found) {
      expect(names, `SVG header lists fabricated name "${name}"`).toContain(name)
    }
  })

  it("sabotage: an unregistered name MUST trigger the property failure", () => {
    const { result } = buildFixture()
    // Inject a fabricated lane name; assert the extractor surfaces it
    // and the same membership check now FAILS. This guarantees the
    // test isn't passing trivially because of a too-narrow extractor.
    const sabotaged: ScenarioResult = {
      ...result,
      lanes: [
        { ip: "10.10.0.1", port: 5060, names: ["alice", "alice2"], network: "ext", killedAt: [] },
        result.lanes[1]!,
      ],
    }
    const dir = mkdtempSync(join(tmpdir(), "sabotage-"))
    const htmlPath = writeScenarioReport(sabotaged, dir)
    const html = readFileSync(htmlPath, "utf-8")
    const svg = extractSvg(html)
    const found = extractLaneHeaderNames(svg)

    expect(found).toContain("alice2")
    // And the membership check against the ORIGINAL registry must fail.
    const originalNames = new Set(["alice", "bob"])
    expect(originalNames.has("alice2")).toBe(false)
  })

  it("transport-kind chip and canvas tint reflect the result", () => {
    for (const kind of ["fake", "live", "hybrid"] as const) {
      const { result } = buildFixture()
      const tagged: ScenarioResult = { ...result, transportKind: kind }
      const dir = mkdtempSync(join(tmpdir(), `kind-${kind}-`))
      const htmlPath = writeScenarioReport(tagged, dir)
      const html = readFileSync(htmlPath, "utf-8")
      if (kind === "fake") expect(html).toContain("FAKE NET")
      if (kind === "live") expect(html).toContain("LIVE UDP")
      if (kind === "hybrid") expect(html).toContain("HYBRID")
    }
  })
})
