/**
 * Slice 3b — media RTP rides the *audited* SIP fabric without tripping the SIP
 * audit contracts. The fake stack wraps `SignalingNetwork.simulated` with
 * `withSignalingNetworkContracts` (RFC rules, tracer, queue-leak finalizer);
 * media binds set `raw: true` so RTP is not parsed as SIP, audited, or traced.
 * If the raw-bind bypass regressed, the scoped audit would either choke on
 * non-SIP datagrams or fail the bind scope at close — so a clean play→record
 * over the audited fabric is the proof.
 *
 * Also covers the endpoint's auto port allocation (no explicit RTP port).
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import { withAllContracts as withSignalingNetworkContracts } from "../../src/sip/SignalingNetwork.contracts.js"
import { Recorder } from "../../src/test-harness/framework/report-recorder/Recorder.js"
import { RunContext } from "../../src/test-harness/framework/RunContext.js"
import { MediaEndpoint } from "../../src/media/MediaEndpoint.js"
import { MediaEndpointTs } from "../../src/media/ts/MediaEndpointTs.js"
import { classify } from "../../src/test-harness/media/audio/classify.js"
import { referenceClip } from "../../src/test-harness/media/audio/clips.js"
import { negotiateCall } from "./support-negotiate.js"

const auditedNet = withSignalingNetworkContracts(
  SignalingNetwork.simulated({ transitDelayMs: 1 }),
  { scopedAudit: { rules: [], crossMessageRules: [], exceptions: [] }, paranoidInputs: true },
).pipe(Layer.provide(Layer.mergeAll(Recorder.fake, RunContext.testWithRecorder)))

const stack = MediaEndpointTs.pipe(Layer.provide(auditedNet))

describe("media on the audited SIP fabric (raw bind)", () => {
  it.effect("RTP rides the audited fabric and both sides hear each other", () =>
    Effect.gen(function* () {
      const me = yield* MediaEndpoint
      // No explicit port → endpoint auto-allocates from its RTP range.
      const alice = yield* me.open("10.10.0.1")
      const bob = yield* me.open("10.20.0.1")

      expect(alice.localAddr.port % 2).toBe(0)
      expect(bob.localAddr.port).toBe(alice.localAddr.port + 2)

      const { aliceSession, bobSession } = yield* negotiateCall(alice, bob)
      yield* aliceSession.play({ kind: "pcm", pcm: referenceClip("alice") })
      yield* bobSession.play({ kind: "pcm", pcm: referenceClip("bob") })
      yield* TestClock.adjust("3 seconds")

      expect(classify((yield* aliceSession.recorded()).pcm).matched).toBe("bob")
      expect(classify((yield* bobSession.recorded()).pcm).matched).toBe("alice")
    }).pipe(Effect.scoped, Effect.provide(stack)),
  )
})
