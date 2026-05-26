/**
 * RFC 3261 peer-rule unit tests.
 *
 * Each test exercises one rule's "positive coverage" — a non-DUT peer
 * deliberately emits the violating message and the audit channel
 * records the rule's finding. Demonstrates the rule fires (not dead
 * code).
 *
 * See: docs/RFC_Verification.md §"Every landed rule should
 * demonstrably fire — when feasible"
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
import {
  rfcCancelCseqMethod,
  rfcNoRequireOnCancelOrAck,
  rfcNoToTagOnInitialRequest,
} from "../rfc3261-peer-rules.js"

const ANY_ROLES: ReadonlySet<UaRole> = ALL_UA_ROLES

const wire = (lines: ReadonlyArray<string>): Buffer =>
  Buffer.from([...lines, "", ""].join("\r\n"), "utf8")

const INVITE_WITH_TO_TAG = wire([
  "INVITE sip:bob@10.0.0.2 SIP/2.0",
  "Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-fixture-1",
  "From: <sip:alice@10.0.0.1>;tag=alice-tag",
  "To: <sip:bob@10.0.0.2>;tag=premature-bob-tag",
  "Call-ID: rfc3261-to-tag-on-invite@10.0.0.1",
  "CSeq: 1 INVITE",
  "Max-Forwards: 70",
  "Contact: <sip:alice@10.0.0.1:5060>",
  "Content-Length: 0",
])

const REGISTER_WITH_TO_TAG = wire([
  "REGISTER sip:registrar.example.com SIP/2.0",
  "Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-fixture-2",
  "From: <sip:alice@10.0.0.1>;tag=alice-tag",
  "To: <sip:alice@10.0.0.1>;tag=stray-tag",
  "Call-ID: rfc3261-to-tag-on-register@10.0.0.1",
  "CSeq: 1 REGISTER",
  "Max-Forwards: 70",
  "Contact: <sip:alice@10.0.0.1:5060>",
  "Content-Length: 0",
])

const INVITE_CLEAN = wire([
  "INVITE sip:bob@10.0.0.2 SIP/2.0",
  "Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-fixture-3",
  "From: <sip:alice@10.0.0.1>;tag=alice-tag",
  "To: <sip:bob@10.0.0.2>",
  "Call-ID: rfc3261-clean-invite@10.0.0.1",
  "CSeq: 1 INVITE",
  "Max-Forwards: 70",
  "Contact: <sip:alice@10.0.0.1:5060>",
  "Content-Length: 0",
])

const SEQ_INVITE_THEN_BYE_INVITE = wire([
  "INVITE sip:bob@10.0.0.2 SIP/2.0",
  "Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-fixture-4a",
  "From: <sip:alice@10.0.0.1>;tag=alice-tag",
  "To: <sip:bob@10.0.0.2>",
  "Call-ID: rfc3261-in-dialog-bye@10.0.0.1",
  "CSeq: 1 INVITE",
  "Max-Forwards: 70",
  "Contact: <sip:alice@10.0.0.1:5060>",
  "Content-Length: 0",
])

const SEQ_INVITE_THEN_BYE_BYE = wire([
  "BYE sip:bob@10.0.0.2 SIP/2.0",
  "Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-fixture-4b",
  "From: <sip:alice@10.0.0.1>;tag=alice-tag",
  "To: <sip:bob@10.0.0.2>;tag=bob-confirmed",
  "Call-ID: rfc3261-in-dialog-bye@10.0.0.1",
  "CSeq: 2 BYE",
  "Max-Forwards: 70",
  "Content-Length: 0",
])

const CANCEL_WITH_REQUIRE = wire([
  "CANCEL sip:bob@10.0.0.2 SIP/2.0",
  "Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-fixture-5",
  "From: <sip:alice@10.0.0.1>;tag=alice-tag",
  "To: <sip:bob@10.0.0.2>",
  "Call-ID: rfc3261-cancel-require@10.0.0.1",
  "CSeq: 1 CANCEL",
  "Max-Forwards: 70",
  "Require: 100rel",
  "Content-Length: 0",
])

const buildLayer = () =>
  withSignalingNetworkContracts(
    SignalingNetwork.simulated({ transitDelayMs: 5 }),
    {
      scopedAudit: {
        rules: [
          rfcNoToTagOnInitialRequest,
          rfcNoRequireOnCancelOrAck,
          rfcCancelCseqMethod,
        ],
      },
    },
  ).pipe(
    Layer.provide(Layer.mergeAll(Recorder.fake, RunContext.unitTestOf(SignalingNetwork))),
    Layer.provideMerge(Recorder.fake),
    Layer.provideMerge(RunContext.unitTestOf(SignalingNetwork)),
  )

const runSend = (payloads: ReadonlyArray<Buffer>) =>
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
      for (const payload of payloads) {
        yield* alice.send(payload, 5060, "10.0.0.2")
        yield* TestClock.adjust("20 millis")
        yield* bob.take()
      }
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

describe("rfc.noToTagOnInitialRequest", () => {
  it.effect("fires when a peer sends an initial INVITE carrying a To-tag", () =>
    Effect.gen(function* () {
      const exit = yield* runSend([INVITE_WITH_TO_TAG])
      const v = auditViolation(exit)
      expect(v).toBeDefined()
      expect(v?.check).toBe("rfc.noToTagOnInitialRequest")
      expect(v?.detail).toMatch(/INVITE.*premature-bob-tag/)
    }),
  )

  it.effect("fires on a fresh REGISTER carrying a stray To-tag", () =>
    Effect.gen(function* () {
      const exit = yield* runSend([REGISTER_WITH_TO_TAG])
      const v = auditViolation(exit)
      expect(v).toBeDefined()
      expect(v?.check).toBe("rfc.noToTagOnInitialRequest")
      expect(v?.detail).toMatch(/REGISTER.*stray-tag/)
    }),
  )

  it.effect("does not fire on a clean initial INVITE (no To-tag)", () =>
    Effect.gen(function* () {
      const exit = yield* runSend([INVITE_CLEAN])
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.effect("does not fire on an in-dialog BYE carrying a To-tag", () =>
    Effect.gen(function* () {
      const exit = yield* runSend([
        SEQ_INVITE_THEN_BYE_INVITE,
        SEQ_INVITE_THEN_BYE_BYE,
      ])
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )
})

describe("rfc.noRequireOnCancelOrAck", () => {
  it.effect("fires when a peer sends CANCEL carrying Require: 100rel", () =>
    Effect.gen(function* () {
      const exit = yield* runSend([CANCEL_WITH_REQUIRE])
      const v = auditViolation(exit)
      expect(v).toBeDefined()
      expect(v?.check).toBe("rfc.noRequireOnCancelOrAck")
      expect(v?.detail).toMatch(/CANCEL/)
    }),
  )
})

