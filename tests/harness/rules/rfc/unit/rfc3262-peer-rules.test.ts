/**
 * RFC 3262 peer-rule unit tests.
 *
 * Each test exercises one rule's "positive coverage" — a non-DUT peer
 * deliberately emits the violating message and the audit channel
 * records the rule's finding. Demonstrates the rule fires (not dead
 * code).
 *
 * See: docs/RFC_Verification.md §"Every landed rule must demonstrably
 * fire"
 */

import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Result } from "effect"
import { TestClock } from "effect/testing"
import {
  ALL_UA_ROLES,
  SignalingNetwork,
  type UaRole,
} from "../../../../../src/sip/SignalingNetwork.js"
import {
  withAllContracts as withSignalingNetworkContracts,
  SignalingAuditViolation,
} from "../../../../../src/sip/SignalingNetwork.contracts.js"
import { Recorder } from "../../../../../src/test-harness/framework/report-recorder/Recorder.js"
import { RunContext } from "../../../../../src/test-harness/framework/RunContext.js"
import { rfcNo100relRequireOnNonInvite } from "../rfc3262-peer-rules.js"

const ANY_ROLES: ReadonlySet<UaRole> = ALL_UA_ROLES

const wire = (lines: ReadonlyArray<string>): Buffer =>
  Buffer.from([...lines, "", ""].join("\r\n"), "utf8")

const REGISTER_WITH_100REL = wire([
  "REGISTER sip:registrar.example.com SIP/2.0",
  "Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-fixture-1",
  "From: <sip:alice@10.0.0.1>;tag=alice-tag",
  "To: <sip:alice@10.0.0.1>",
  "Call-ID: rfc3262-non-invite-require@10.0.0.1",
  "CSeq: 1 REGISTER",
  "Max-Forwards: 70",
  "Contact: <sip:alice@10.0.0.1:5060>",
  "Require: 100rel",
  "Content-Length: 0",
])

const REGISTER_NO_REQUIRE = wire([
  "REGISTER sip:registrar.example.com SIP/2.0",
  "Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-fixture-2",
  "From: <sip:alice@10.0.0.1>;tag=alice-tag",
  "To: <sip:alice@10.0.0.1>",
  "Call-ID: rfc3262-non-invite-clean@10.0.0.1",
  "CSeq: 1 REGISTER",
  "Max-Forwards: 70",
  "Contact: <sip:alice@10.0.0.1:5060>",
  "Content-Length: 0",
])

const INVITE_WITH_100REL = wire([
  "INVITE sip:bob@10.0.0.2 SIP/2.0",
  "Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-fixture-3",
  "From: <sip:alice@10.0.0.1>;tag=alice-tag",
  "To: <sip:bob@10.0.0.2>",
  "Call-ID: rfc3262-invite-require@10.0.0.1",
  "CSeq: 1 INVITE",
  "Max-Forwards: 70",
  "Contact: <sip:alice@10.0.0.1:5060>",
  "Require: 100rel",
  "Content-Length: 0",
])

const OPTIONS_WITH_MIXED = wire([
  "OPTIONS sip:bob@10.0.0.2 SIP/2.0",
  "Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-fixture-4",
  "From: <sip:alice@10.0.0.1>;tag=alice-tag",
  "To: <sip:bob@10.0.0.2>",
  "Call-ID: rfc3262-options-mixed@10.0.0.1",
  "CSeq: 1 OPTIONS",
  "Max-Forwards: 70",
  "Contact: <sip:alice@10.0.0.1:5060>",
  "Require: timer, 100rel, replaces",
  "Content-Length: 0",
])

const buildLayer = () =>
  withSignalingNetworkContracts(
    SignalingNetwork.simulated({ transitDelayMs: 5 }),
    { scopedAudit: { rules: [rfcNo100relRequireOnNonInvite] } },
  ).pipe(
    Layer.provide(Layer.mergeAll(Recorder.fake, RunContext.unitTestOf(SignalingNetwork))),
    Layer.provideMerge(Recorder.fake),
    Layer.provideMerge(RunContext.unitTestOf(SignalingNetwork)),
  )

const runSend = (payload: Buffer) =>
  Effect.gen(function* () {
    const program = Effect.gen(function* () {
      const net = yield* SignalingNetwork
      const bob = yield* net.bindUdp({
        ip: "10.0.0.2",
        port: 5060,
        queueMax: 16,
        roles: ANY_ROLES,
      })
      const alice = yield* net.bindUdp({
        ip: "10.0.0.1",
        port: 5060,
        queueMax: 16,
        roles: ANY_ROLES,
      })
      yield* alice.send(payload, 5060, "10.0.0.2")
      yield* TestClock.adjust("20 millis")
      yield* bob.take()
    })
    return yield* Effect.exit(
      Effect.scoped(program).pipe(Effect.provide(buildLayer())),
    )
  })

const auditViolation = (exit: Exit.Exit<unknown, unknown>): SignalingAuditViolation | undefined => {
  if (Exit.isSuccess(exit)) return undefined
  const defect = Cause.findDefect(exit.cause)
  const errOpt = Cause.findErrorOption(exit.cause)
  const candidate: unknown = Result.isSuccess(defect)
    ? defect.success
    : errOpt._tag === "Some"
      ? errOpt.value
      : undefined
  return candidate instanceof SignalingAuditViolation ? candidate : undefined
}

describe("rfc.no100relRequireOnNonInvite", () => {
  it.effect("fires when a peer sends REGISTER with Require: 100rel", () =>
    Effect.gen(function* () {
      const exit = yield* runSend(REGISTER_WITH_100REL)
      const v = auditViolation(exit)
      expect(v).toBeDefined()
      expect(v?.check).toBe("rfc.no100relRequireOnNonInvite")
      expect(v?.detail).toMatch(/REGISTER.*Require: 100rel/)
    }),
  )

  it.effect("fires when Require carries 100rel mixed with other tags", () =>
    Effect.gen(function* () {
      const exit = yield* runSend(OPTIONS_WITH_MIXED)
      const v = auditViolation(exit)
      expect(v).toBeDefined()
      expect(v?.check).toBe("rfc.no100relRequireOnNonInvite")
      expect(v?.detail).toMatch(/OPTIONS/)
    }),
  )

  it.effect("does not fire on a clean REGISTER (no Require header)", () =>
    Effect.gen(function* () {
      const exit = yield* runSend(REGISTER_NO_REQUIRE)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.effect("does not fire on an INVITE carrying Require: 100rel", () =>
    Effect.gen(function* () {
      const exit = yield* runSend(INVITE_WITH_100REL)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )
})
