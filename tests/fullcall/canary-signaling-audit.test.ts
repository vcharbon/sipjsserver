/**
 * Canary regression gate for the SignalingNetwork.scopedAudit wrappers.
 *
 * Constructs a minimal two-peer scenario on the SignalingNetwork
 * fabric — no DUT, no agents library — where peer "alice" sends a
 * deliberately-malformed INVITE to peer "bob" (Via branch missing the
 * RFC 3261 §8.1.1.7 z9hG4bK magic cookie). bob's bindUdp scope close
 * runs the starter `rfc.branchPrefix` rule, detects the violation, and
 * the layer-close finalizer surfaces a `SignalingAuditViolation` as a
 * defect on the surrounding scope's cause.
 *
 * If this test STOPS failing on the audit path, something has broken
 * the wrapper plumbing — the rule never ran. Treat that as a
 * regression of the audit gates, not a fixture issue.
 */

import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Result } from "effect"
import { TestClock } from "effect/testing"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import {
  withAllContracts as withSignalingNetworkContracts,
  SignalingAuditViolation,
} from "../../src/sip/SignalingNetwork.contracts.js"
import { Recorder } from "../../src/test-harness/framework/report-recorder/Recorder.js"
import { RunContext } from "../../src/test-harness/framework/RunContext.js"
import { starterPeerRules } from "../harness/rules/rfc/starter-peer-rules.js"

// Deliberate Content-Length mismatch — declares 0, ships 6 body bytes.
// The lenient parser accepts both because `wireGrammar: false`; the
// per-peer `rfc.contentLength` rule re-checks the raw bytes and trips.
const MALFORMED_INVITE = Buffer.from(
  [
    "INVITE sip:bob@10.0.0.2 SIP/2.0",
    "Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-canary-1",
    "From: <sip:alice@10.0.0.1>;tag=alice-tag",
    "To: <sip:bob@10.0.0.2>",
    "Call-ID: canary-call-id@10.0.0.1",
    "CSeq: 1 INVITE",
    "Max-Forwards: 70",
    "Contact: <sip:alice@10.0.0.1:5060>",
    "Content-Length: 0",
    "",
    "lying",
  ].join("\r\n"),
  "utf8",
)

const RawNetworkLayer = SignalingNetwork.simulated({ transitDelayMs: 5 })
const RecorderLayer = Recorder.fake
const RunContextLayer = RunContext.testWithRecorder

const TestLayer = withSignalingNetworkContracts(RawNetworkLayer, {
  scopedAudit: { rules: starterPeerRules },
}).pipe(
  Layer.provide(Layer.mergeAll(RecorderLayer, RunContextLayer)),
  Layer.provideMerge(RecorderLayer),
  Layer.provideMerge(RunContextLayer),
)

describe("canary: SignalingNetwork.scopedAudit wakes up on malformed INVITE", () => {
  it.effect("layer-close finalizer fails with SignalingAuditViolation", () =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const net = yield* SignalingNetwork
        const bob = yield* net.bindUdp({
          ip: "10.0.0.2",
          port: 5060,
          queueMax: 16,
        })
        const alice = yield* net.bindUdp({
          ip: "10.0.0.1",
          port: 5060,
          queueMax: 16,
        })
        // Send the malformed INVITE alice → bob.
        yield* alice.send(MALFORMED_INVITE, 5060, "10.0.0.2")
        // Advance virtual time past the simulated fabric's transit
        // delay so the forked delivery fiber lands the packet on
        // bob's queue. Without this, bob.take() hangs.
        yield* TestClock.adjust("20 millis")
        const arrived = yield* bob.take()
        expect(arrived.raw.toString("utf8")).toContain("Content-Length: 0")
      })

      // `it.effect` provides the surrounding Scope; we close a NESTED
      // scope tied to the test layer so the wrapper's layer-close
      // finalizer fires while we can still observe the Exit.
      const exit = yield* Effect.exit(
        Effect.scoped(program).pipe(Effect.provide(TestLayer)),
      )

      // A pass = the wrapper fired and surfaced a SignalingAuditViolation
      // as a defect (deferred-fail mode surfaces via Effect.die at layer
      // close). Bare exit "Success" means the audit path is asleep.
      if (Exit.isSuccess(exit)) {
        throw new Error(
          "canary did not trip: scopedAudit's layer-close finalizer never fired",
        )
      }
      const defect = Cause.findDefect(exit.cause)
      const failOpt = Cause.findErrorOption(exit.cause)
      const candidate: unknown = Result.isSuccess(defect)
        ? defect.success
        : failOpt._tag === "Some"
          ? failOpt.value
          : undefined
      if (!(candidate instanceof SignalingAuditViolation)) {
        throw new Error(
          `canary did not surface SignalingAuditViolation; got ${String(candidate)} from cause ${Cause.pretty(exit.cause)}`,
        )
      }
      expect(candidate.check).toBe("rfc.contentLength")
    }),
  )
})
