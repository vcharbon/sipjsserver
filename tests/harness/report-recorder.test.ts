/**
 * Recorder smoke test — Slice 1 of the recording-layer plan
 * (.claude/plans/html-report-recording-layer-faithful-trace.md).
 *
 * Asserts the Recorder service exposes the API we agreed on and the
 * snapshot shape carries every recorded fact through unchanged.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  Recorder,
} from "../../src/test-harness/framework/report-recorder/Recorder.js"
import { laneKey } from "../../src/test-harness/framework/report-recorder/types.js"
import type { RecordedSipEntry } from "../../src/test-harness/framework/report-recorder/types.js"
import { SipParser } from "../../src/sip/Parser.js"
import type { SipMessage } from "../../src/sip/types.js"

const INVITE_RAW = Buffer.from(
  [
    "INVITE sip:bob@example.test SIP/2.0",
    "Via: SIP/2.0/UDP 10.10.0.1:5060;branch=z9hG4bK-rec-test",
    "From: <sip:alice@example.test>;tag=alice-tag",
    "To: <sip:bob@example.test>",
    "Call-ID: rec-call-1@10.10.0.1",
    "CSeq: 1 INVITE",
    "Contact: <sip:alice@10.10.0.1:5060>",
    "Max-Forwards: 70",
    "Content-Length: 0",
    "",
    "",
  ].join("\r\n"),
)

const parseInvite = Effect.gen(function* () {
  const parser = yield* SipParser
  return (yield* parser.parse(INVITE_RAW)) as SipMessage
}).pipe(Effect.provide(SipParser.layer))

describe("Recorder smoke (Slice 1)", () => {
  it.effect("captures lanes, traces, kills, and anomalies through snapshot", () =>
    Effect.gen(function* () {
      const rec = yield* Recorder
      const msg = yield* parseInvite

      yield* rec.registerLane({
        ip: "10.10.0.1",
        port: 5060,
        name: "alice",
        network: "ext",
      })
      yield* rec.registerLane({
        ip: "10.10.0.2",
        port: 5060,
        name: "bob",
        network: "ext",
      })

      // Conflicting alias on alice's lane → triggers a nameConflict anomaly.
      yield* rec.registerLane({
        ip: "10.10.0.1",
        port: 5060,
        name: "alice-shadow",
        network: "ext",
      })

      // Repeated register of an existing name is a no-op (no extra anomaly).
      yield* rec.registerLane({
        ip: "10.10.0.1",
        port: 5060,
        name: "alice",
        network: "ext",
      })

      const sipEntry: RecordedSipEntry = {
        timestamp: 1000,
        sentMs: 1000,
        receivedMs: 1005,
        fromAddr: { ip: "10.10.0.1", port: 5060 },
        toAddr: { ip: "10.10.0.2", port: 5060 },
        direction: "send",
        stepIndex: 0,
        status: "pass",
        message: msg,
        network: "ext",
      }
      yield* rec.recordSip(sipEntry)

      yield* rec.recordRepl({
        timestamp: 1010,
        from: "worker-1",
        to: "worker-2",
        frame: { _tag: "Noop", gen: 1, counter: 42 },
      })

      // Mark alice's lane killed after registration.
      yield* rec.markLaneKilled({ ip: "10.10.0.1", port: 5060, at: 2000 })

      // Mark a not-yet-registered lane killed — should be folded in when
      // the lane is registered later.
      yield* rec.markLaneKilled({ ip: "10.10.0.3", port: 5060, at: 1500 })
      yield* rec.registerLane({
        ip: "10.10.0.3",
        port: 5060,
        name: "proxy",
        network: "ext",
      })

      const snap = yield* rec.snapshot

      expect(snap.transportKind).toBe("fake")
      expect(snap.lanes).toHaveLength(3)

      const aliceKey = laneKey("10.10.0.1", 5060)
      const alice = snap.lanes.find((l) => laneKey(l.ip, l.port) === aliceKey)
      expect(alice).toBeDefined()
      expect(alice!.names).toEqual(["alice", "alice-shadow"])
      expect(alice!.killedAt).toEqual([2000])

      const proxy = snap.lanes.find(
        (l) => laneKey(l.ip, l.port) === laneKey("10.10.0.3", 5060),
      )
      expect(proxy).toBeDefined()
      expect(proxy!.names).toEqual(["proxy"])
      expect(proxy!.killedAt).toEqual([1500])

      expect(snap.sipTrace).toHaveLength(1)
      expect(snap.sipTrace[0]!.fromAddr).toEqual({ ip: "10.10.0.1", port: 5060 })
      expect(snap.sipTrace[0]!.toAddr).toEqual({ ip: "10.10.0.2", port: 5060 })

      expect(snap.replTrace).toHaveLength(1)
      expect(snap.replTrace[0]!.from).toBe("worker-1")
      expect(snap.replTrace[0]!.to).toBe("worker-2")

      expect(snap.anomalies).toHaveLength(1)
      const anomaly = snap.anomalies[0]!
      expect(anomaly.kind).toBe("nameConflict")
      if (anomaly.kind === "nameConflict") {
        expect(anomaly.laneKey).toBe(aliceKey)
        expect(anomaly.names).toEqual(["alice", "alice-shadow"])
      }
    }).pipe(Effect.provide(Recorder.fake)))

  it.effect("tags the snapshot with the transport kind it was built with", () =>
    Effect.gen(function* () {
      const rec = yield* Recorder
      const snap = yield* rec.snapshot
      expect(snap.transportKind).toBe("live")
    }).pipe(Effect.provide(Recorder.live)))
})
