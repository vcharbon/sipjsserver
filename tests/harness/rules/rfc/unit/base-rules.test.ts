/**
 * Per-rule unit tests under `RunContext.unitTestOf(SignalingNetwork)`.
 *
 * Each test stands up a minimal SignalingNetwork + Recorder + scopedAudit
 * with ONE rule under test, sends a deliberately bad message peer→peer,
 * then asserts the layer-close finalizer surfaces a
 * `SignalingAuditViolation` with the expected check name.
 *
 * The canary at tests/fullcall/canary-signaling-audit.test.ts already
 * covers `rfc.contentLength` end-to-end; this file adds the active rule
 * that the deleted legacy `rule.test.ts` exercised (`rfc.maxForwards`)
 * and one structural sanity test (`rfc.branchPrefix`).
 */

import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Result } from "effect"
import { TestClock } from "effect/testing"
import { SignalingNetwork } from "../../../../../src/sip/SignalingNetwork.js"
import {
  withAllContracts as withSignalingNetworkContracts,
  SignalingAuditViolation,
  type PeerAuditRule,
} from "../../../../../src/sip/SignalingNetwork.contracts.js"
import { Recorder } from "../../../../../src/test-harness/framework/report-recorder/Recorder.js"
import { RunContext } from "../../../../../src/test-harness/framework/RunContext.js"
import {
  rfcBranchPrefix,
  rfcMaxForwards,
} from "../starter-peer-rules.js"

const buildLayer = (rule: PeerAuditRule) =>
  withSignalingNetworkContracts(
    SignalingNetwork.simulated({ transitDelayMs: 5 }),
    { scopedAudit: { rules: [rule] } },
  ).pipe(
    Layer.provide(Layer.mergeAll(Recorder.fake, RunContext.unitTestOf(SignalingNetwork))),
    Layer.provideMerge(Recorder.fake),
    Layer.provideMerge(RunContext.unitTestOf(SignalingNetwork)),
  )

const makeInvite = (overrides: { maxForwards?: number; branch?: string }) =>
  Buffer.from(
    [
      "INVITE sip:bob@10.0.0.2 SIP/2.0",
      `Via: SIP/2.0/UDP 10.0.0.1:5060;branch=${overrides.branch ?? "z9hG4bK-unit-1"}`,
      "From: <sip:alice@10.0.0.1>;tag=alice-tag",
      "To: <sip:bob@10.0.0.2>",
      "Call-ID: unit-test-call-id@10.0.0.1",
      "CSeq: 1 INVITE",
      `Max-Forwards: ${overrides.maxForwards ?? 70}`,
      "Contact: <sip:alice@10.0.0.1:5060>",
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n"),
    "utf8",
  )

const runScenario = (rule: PeerAuditRule, packet: Buffer) =>
  Effect.gen(function* () {
    const program = Effect.gen(function* () {
      const net = yield* SignalingNetwork
      const bob = yield* net.bindUdp({ ip: "10.0.0.2", port: 5060, queueMax: 16 })
      const alice = yield* net.bindUdp({ ip: "10.0.0.1", port: 5060, queueMax: 16 })
      yield* alice.send(packet, 5060, "10.0.0.2")
      yield* TestClock.adjust("20 millis")
      yield* bob.take()
    })
    return yield* Effect.exit(Effect.scoped(program).pipe(Effect.provide(buildLayer(rule))))
  })

const violationFromExit = (exit: Exit.Exit<unknown, unknown>): SignalingAuditViolation | undefined => {
  if (Exit.isSuccess(exit)) return undefined
  const defect = Cause.findDefect(exit.cause)
  const failOpt = Cause.findErrorOption(exit.cause)
  const candidate: unknown = Result.isSuccess(defect)
    ? defect.success
    : failOpt._tag === "Some"
      ? failOpt.value
      : undefined
  return candidate instanceof SignalingAuditViolation ? candidate : undefined
}

describe("rfc base validators — unit-test-of-layer", () => {
  it.effect("rfc.maxForwards trips on Max-Forwards: 200", () =>
    Effect.gen(function* () {
      const exit = yield* runScenario(rfcMaxForwards, makeInvite({ maxForwards: 200 }))
      const v = violationFromExit(exit)
      expect(v).toBeDefined()
      expect(v?.check).toBe("rfc.maxForwards")
    }),
  )

  it.effect("rfc.maxForwards passes on Max-Forwards: 70", () =>
    Effect.gen(function* () {
      const exit = yield* runScenario(rfcMaxForwards, makeInvite({}))
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.effect("rfc.branchPrefix trips when the Via branch drops the z9hG4bK cookie", () =>
    Effect.gen(function* () {
      const exit = yield* runScenario(rfcBranchPrefix, makeInvite({ branch: "no-cookie-1" }))
      const v = violationFromExit(exit)
      expect(v).toBeDefined()
      expect(v?.check).toBe("rfc.branchPrefix")
    }),
  )
})
