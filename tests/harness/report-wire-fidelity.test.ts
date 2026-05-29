/**
 * Detail-panel byte-fidelity test.
 *
 * The HTML report's message detail panel must show each message exactly as
 * it crossed the wire (`msg.raw`), NOT a re-serialization of the parsed
 * structure. The motivating case is a message carrying several Contact
 * headers: the parsed structure keeps a single Contact slot, so a re-encode
 * would misrepresent the message. Rendering from the wire bytes preserves
 * every Contact line, the header order, and the exact whitespace.
 *
 * A 302 is used on purpose — RFC 3261 §8.1.3.4 allows a redirect to list
 * multiple Contacts, so the fixture stays valid even after the parser gains
 * single-occurrence cardinality enforcement for dialog-creating messages.
 */

import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { writeScenarioReport } from "../../src/test-harness/framework/html-report.js"
import {
  serializeMessage,
  wireText,
} from "../../src/test-harness/framework/svg-sequence-diagram.js"
import type {
  Lane,
  ScenarioResult,
  TraceEntry,
} from "../../src/test-harness/framework/types.js"
import { SipParser } from "../../src/sip/Parser.js"
import type { SipMessage } from "../../src/sip/types.js"

// Two Contact headers (redirect targets). The first carries non-canonical
// spacing after the colon — a re-serialization trims it to a single space,
// so its survival in the report proves the bytes came from the wire.
const REDIRECT_RAW = Buffer.from(
  [
    "SIP/2.0 302 Moved Temporarily",
    "Via: SIP/2.0/UDP 10.20.0.1:5060;branch=z9hG4bK-redirect",
    "From: <sip:alice@example.test>;tag=alice-tag",
    "To: <sip:bob@example.test>;tag=redirect-tag",
    "Call-ID: redirect-1@10.20.0.1",
    "CSeq: 1 INVITE",
    "Contact:   <sip:bob@10.20.0.2:5060>;q=0.8",
    "Contact: <sip:bob@10.20.0.3:5060>;q=0.5",
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

function buildFixture(): ScenarioResult {
  const redirect = Effect.runSync(parseMsg(REDIRECT_RAW))

  const lanes: ReadonlyArray<Lane> = [
    { ip: "10.20.0.1", port: 5060, names: ["alice"], network: "ext", killedAt: [] },
    { ip: "10.20.0.2", port: 5060, names: ["bob"], network: "ext", killedAt: [] },
  ]

  const trace: ReadonlyArray<TraceEntry> = [
    {
      timestamp: 0,
      seq: 0,
      sentMs: 0,
      receivedMs: 5,
      from: "bob",
      to: "alice",
      fromAddr: { ip: "10.20.0.2", port: 5060 },
      toAddr: { ip: "10.20.0.1", port: 5060 },
      direction: "receive",
      stepIndex: 0,
      status: "pass",
      message: redirect,
      network: "ext",
    },
  ]

  return {
    scenarioName: "wire-fidelity-multi-contact",
    transportKind: "fake",
    stepResults: [],
    trace,
    participants: [
      { name: "alice", network: "ext" },
      { name: "bob", network: "ext" },
    ],
    lanes,
    anomalies: [],
    passed: 1,
    failed: 0,
    skipped: 0,
  }
}

describe("HTML report detail panel byte-fidelity", () => {
  it("wireText reproduces the wire bytes verbatim for an all-ASCII message", () => {
    const redirect = Effect.runSync(parseMsg(REDIRECT_RAW))
    expect(wireText(redirect)).toBe(REDIRECT_RAW.toString("utf8"))
  })

  it("wireText preserves both Contact lines and the exact whitespace", () => {
    const redirect = Effect.runSync(parseMsg(REDIRECT_RAW))
    const text = wireText(redirect)
    expect(text).toContain("Contact:   <sip:bob@10.20.0.2:5060>;q=0.8")
    expect(text).toContain("Contact: <sip:bob@10.20.0.3:5060>;q=0.5")
  })

  it("contrast: a re-encode normalizes the wire whitespace that wireText preserves", () => {
    const redirect = Effect.runSync(parseMsg(REDIRECT_RAW))
    const reencoded = serializeMessage(redirect)
    // Re-serialization reads trimmed header values, collapsing the triple
    // space the peer put on the wire — wireText keeps the bytes exactly.
    expect(reencoded).not.toContain("Contact:   <sip:bob")
    expect(reencoded).toContain("Contact: <sip:bob@10.20.0.2:5060>;q=0.8")
    expect(wireText(redirect)).toContain("Contact:   <sip:bob@10.20.0.2:5060>;q=0.8")
  })

  it("the rendered detail panel embeds the wire bytes, not the re-encode", () => {
    const result = buildFixture()
    const dir = mkdtempSync(join(tmpdir(), "wire-fidelity-"))
    const htmlPath = writeScenarioReport(result, dir)
    const html = readFileSync(htmlPath, "utf-8")

    // Both Contact targets present, with the first's exact wire spacing.
    expect(html).toContain("Contact:   <sip:bob@10.20.0.2:5060>;q=0.8")
    expect(html).toContain("<sip:bob@10.20.0.3:5060>;q=0.5")
  })
})
