/**
 * Smoke test for slice 1 of REGISTER + double-stack proxy:
 *
 *   - the new `agent.register(...)` DSL verb produces a SendStep with
 *     method=REGISTER, To=<aor>, From=<aor>, optional Expires header.
 *   - a `ScenarioResult` whose trace entries carry `network: "core"`
 *     round-trips through the renderers: HTML carries the `core` band
 *     label, TXT files materialise under the `core/` subfolder.
 *
 * No B2BUA, no SignalingNetwork — the test exercises the framework
 * surface directly. End-to-end coverage of REGISTER against the
 * registrar proxy lives in slice 3.
 */

import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { record } from "../../../src/test-harness/framework/recorder.js"
import { hydrateRequest } from "../../../src/sip/parsers/extract-fields.js"
import { writeScenarioReport } from "../../../src/test-harness/framework/html-report.js"
import { writeTextReports } from "../../../src/test-harness/framework/text-report.js"
import type { ScenarioResult, TraceEntry } from "../../../src/test-harness/framework/types.js"

describe("agent.register DSL", () => {
  it("produces a REGISTER SendStep with To=AOR and From=AOR", () => {
    const result = record((s) => {
      const alice = s.agent("alice", { uri: "sip:alice@example.test" })
      alice.register({ uri: "sip:registrar.example.test", expires: 3600 })
    })

    expect(result.steps).toHaveLength(1)
    const step = result.steps[0]!
    expect(step.type).toBe("send")
    if (step.type !== "send") throw new Error("unreachable")
    expect(step.method).toBe("REGISTER")
    expect(step.uri).toBe("sip:registrar.example.test")
    expect(step.overrides?.to).toBe("<sip:alice@example.test>")
    expect(step.overrides?.from).toBe("<sip:alice@example.test>")
    expect(step.overrides?.headers?.["Expires"]).toBe("3600")
  })

  it("omits the Expires header when caller did not pass `expires`", () => {
    const result = record((s) => {
      const bob = s.agent("bob", { uri: "sip:bob@example.test" })
      bob.register()
    })
    const step = result.steps[0]!
    if (step.type !== "send") throw new Error("unreachable")
    expect(step.method).toBe("REGISTER")
    // No header overrides at all — the registrar will fall through to
    // its 3600s default rather than the caller dictating it.
    expect(step.overrides?.headers?.["Expires"]).toBeUndefined()
  })
})

describe("network-tagged TraceEntry round-trip", () => {
  it("renders core-network entries with the 'core' band label and a core/ subfolder", () => {
    const dir = mkdtempSync(join(tmpdir(), "register-smoke-"))

    const reqA = hydrateRequest({
      method: "REGISTER",
      uri: "sip:registrar.test",
      headers: [
        { name: "Via", value: "SIP/2.0/UDP 10.20.0.5:5060;branch=z9hG4bK-test" },
        { name: "From", value: "<sip:alice@test>;tag=t1" },
        { name: "To", value: "<sip:alice@test>" },
        { name: "Call-ID", value: "smoke-1" },
        { name: "CSeq", value: "1 REGISTER" },
        { name: "Contact", value: "<sip:alice@10.20.0.5:5060>" },
      ],
      body: new Uint8Array(),
      raw: Buffer.alloc(0),
    })

    const trace: readonly TraceEntry[] = [
      {
        timestamp: 0,
        sentMs: 0,
        receivedMs: 15,
        from: "alice",
        to: "registrar",
        fromAddr: { ip: "10.20.0.5", port: 5060 },
        toAddr: { ip: "10.20.0.10", port: 5060 },
        direction: "send",
        stepIndex: 0,
        status: "pass",
        message: reqA,
        network: "core",
      },
    ]

    const result: ScenarioResult = {
      scenarioName: "smoke-network-roundtrip",
      transportKind: "fake",
      stepResults: [],
      trace,
      participants: [
        { name: "alice", network: "core" },
        { name: "registrar", network: "core" },
      ],
      lanes: [
        { ip: "10.20.0.5", port: 5060, names: ["alice"], network: "core", killedAt: [] },
        { ip: "10.20.0.10", port: 5060, names: ["registrar"], network: "core", killedAt: [] },
      ],
      anomalies: [],
      passed: 1,
      failed: 0,
      skipped: 0,
    }

    const txtFiles = writeTextReports(result, dir)
    writeScenarioReport(result, dir, txtFiles)

    // Per-agent file lives under core/.
    const aliceTxtRel = txtFiles.find((f) => f.endsWith(".alice.txt"))
    expect(aliceTxtRel).toBeDefined()
    expect(aliceTxtRel!.startsWith("core/")).toBe(true)
    expect(existsSync(join(dir, aliceTxtRel!))).toBe(true)

    // The HTML renders a `core` band label only when more than one
    // network is present in the participant list — so render a second,
    // dual-stack scenario to cover that branch.
    const dualResult: ScenarioResult = {
      ...result,
      scenarioName: "smoke-dual-stack",
      participants: [
        { name: "alice", network: "ext" },
        { name: "registrar", network: "core" },
      ],
      lanes: [
        { ip: "10.20.0.5", port: 5060, names: ["alice"], network: "ext", killedAt: [] },
        { ip: "10.20.0.10", port: 5060, names: ["registrar"], network: "core", killedAt: [] },
      ],
    }
    const dualTxt = writeTextReports(dualResult, dir)
    const htmlPath = writeScenarioReport(dualResult, dir, dualTxt)
    const html = readFileSync(htmlPath, "utf8")
    expect(html).toContain(">core<")
    expect(html).toContain(">ext<")
  })
})
