/**
 * Phase-0 audit-framework unit tests.
 *
 * Covers the additions introduced for RFC verification:
 *   - per-rule `subject` set vs per-bind `roles` set dispatch
 *   - `severityOverride: "advisory"` downgrade path
 *   - per-test exceptions (`RFC_EXCEPTIONS`) with `ruleName: "*"`
 *     wildcard and DUT-naming refusal
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
  type PeerAuditRule,
  type RfcException as ScopedAuditRfcException,
} from "../../../../../src/sip/SignalingNetwork.contracts.js"
import { Recorder } from "../../../../../src/test-harness/framework/report-recorder/Recorder.js"
import { RunContext } from "../../../../../src/test-harness/framework/RunContext.js"
import { resolveRfcExceptions } from "../../../../support/rfcExceptionLoader.js"

const INVITE = Buffer.from(
  [
    "INVITE sip:bob@10.0.0.2 SIP/2.0",
    "Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-fixture-1",
    "From: <sip:alice@10.0.0.1>;tag=alice-tag",
    "To: <sip:bob@10.0.0.2>",
    "Call-ID: audit-fw-call-id@10.0.0.1",
    "CSeq: 1 INVITE",
    "Max-Forwards: 70",
    "Contact: <sip:alice@10.0.0.1:5060>",
    "Content-Length: 0",
    "",
    "",
  ].join("\r\n"),
  "utf8",
)

const alwaysFiringRule = (
  name: string,
  subject: ReadonlySet<UaRole>,
  severityOverride?: "advisory",
): PeerAuditRule => ({
  name,
  subject,
  severityOverride,
  justification: severityOverride === "advisory" ? "unit test downgrade" : undefined,
  check: () => Effect.succeed(["always fires"]),
})

const buildLayer = (
  rule: PeerAuditRule,
  exceptions?: ReadonlyArray<ScopedAuditRfcException>,
) =>
  withSignalingNetworkContracts(
    SignalingNetwork.simulated({ transitDelayMs: 5 }),
    { scopedAudit: { rules: [rule], exceptions } },
  ).pipe(
    Layer.provide(Layer.mergeAll(Recorder.fake, RunContext.unitTestOf(SignalingNetwork))),
    Layer.provideMerge(Recorder.fake),
    Layer.provideMerge(RunContext.unitTestOf(SignalingNetwork)),
  )

const runWithBindRoles = (
  rule: PeerAuditRule,
  bobRoles: ReadonlySet<UaRole>,
  exceptions?: ReadonlyArray<ScopedAuditRfcException>,
  aliceRoles: ReadonlySet<UaRole> = bobRoles,
) =>
  Effect.gen(function* () {
    const program = Effect.gen(function* () {
      const net = yield* SignalingNetwork
      const bob = yield* net.bindUdp({
        ip: "10.0.0.2",
        port: 5060,
        queueMax: 16,
        roles: bobRoles,
      })
      const alice = yield* net.bindUdp({
        ip: "10.0.0.1",
        port: 5060,
        queueMax: 16,
        roles: aliceRoles,
      })
      yield* alice.send(INVITE, 5060, "10.0.0.2")
      yield* TestClock.adjust("20 millis")
      yield* bob.take()
    })
    return yield* Effect.exit(
      Effect.scoped(program).pipe(Effect.provide(buildLayer(rule, exceptions))),
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

describe("audit-framework — subject dispatch", () => {
  it.effect("rule with subject {proxy} does not fire on a {uac,uas} bind", () =>
    Effect.gen(function* () {
      const rule = alwaysFiringRule("rfc.test.proxyOnly", new Set<UaRole>(["proxy"]))
      const exit = yield* runWithBindRoles(rule, new Set<UaRole>(["uac", "uas"]))
      // Bob's bind is {uac,uas}; rule subject is {proxy}; intersection
      // empty → dispatcher skips the rule, no violation surfaces.
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.effect("rule with subject ALL_UA_ROLES fires on any bind", () =>
    Effect.gen(function* () {
      const rule = alwaysFiringRule("rfc.test.any", ALL_UA_ROLES)
      const exit = yield* runWithBindRoles(rule, new Set<UaRole>(["uac", "uas"]))
      const v = auditViolation(exit)
      expect(v).toBeDefined()
      expect(v?.check).toBe("rfc.test.any")
    }),
  )

  it.effect("rule with subject {proxy} fires on a {uac,uas,proxy} bind", () =>
    Effect.gen(function* () {
      const rule = alwaysFiringRule("rfc.test.proxyHits", new Set<UaRole>(["proxy"]))
      const exit = yield* runWithBindRoles(rule, ALL_UA_ROLES)
      const v = auditViolation(exit)
      expect(v).toBeDefined()
      expect(v?.check).toBe("rfc.test.proxyHits")
    }),
  )
})

describe("audit-framework — severityOverride", () => {
  it.effect("severityOverride: 'advisory' downgrades the finding (test passes)", () =>
    Effect.gen(function* () {
      const rule = alwaysFiringRule("rfc.test.advisory", ALL_UA_ROLES, "advisory")
      const exit = yield* runWithBindRoles(rule, ALL_UA_ROLES)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )
})

describe("audit-framework — per-test exceptions", () => {
  it.effect("ruleName-matched exception downgrades the finding", () =>
    Effect.gen(function* () {
      const rule = alwaysFiringRule("rfc.test.exempt", ALL_UA_ROLES)
      const exit = yield* runWithBindRoles(rule, ALL_UA_ROLES, [
        {
          ruleName: "rfc.test.exempt",
          justification: "unit test allowance",
        },
      ])
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.effect("ruleName: '*' wildcard suppresses every rule", () =>
    Effect.gen(function* () {
      const rule = alwaysFiringRule("rfc.test.wildcardCovered", ALL_UA_ROLES)
      const exit = yield* runWithBindRoles(rule, ALL_UA_ROLES, [
        {
          ruleName: "*",
          justification: "negative-case test",
        },
      ])
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.effect("exception that does not match leaves the violation in place", () =>
    Effect.gen(function* () {
      const rule = alwaysFiringRule("rfc.test.unrelatedExempt", ALL_UA_ROLES)
      const exit = yield* runWithBindRoles(rule, ALL_UA_ROLES, [
        {
          ruleName: "rfc.test.someOtherRule",
          justification: "applies to a different rule",
        },
      ])
      const v = auditViolation(exit)
      expect(v).toBeDefined()
      expect(v?.check).toBe("rfc.test.unrelatedExempt")
    }),
  )
})

describe("audit-framework — exception loader invariants", () => {
  it("throws if an entry's peerBindKey names the DUT bind", () => {
    expect(() =>
      resolveRfcExceptions(
        [
          {
            testPath: __filename,
            ruleName: "rfc.test.any",
            peerBindKey: "127.0.0.1:15060",
            justification: "trying to exempt the DUT (should be rejected)",
          },
        ],
        { dutBindKey: "127.0.0.1:15060" },
      ),
    ).toThrow(/DUT cannot be exempted/)
  })

  it("filters out entries whose testPath does not suffix-match", () => {
    const out = resolveRfcExceptions(
      [
        {
          testPath: "tests/fullcall/some-other-file.test.ts",
          ruleName: "rfc.test.any",
          justification: "different test, should be filtered",
        },
      ],
      { dutBindKey: "127.0.0.1:15060" },
    )
    expect(out).toEqual([])
  })

  it("throws on empty justification", () => {
    expect(() =>
      resolveRfcExceptions(
        [
          {
            testPath: __filename,
            ruleName: "rfc.test.any",
            justification: "   ",
          },
        ],
        { dutBindKey: "127.0.0.1:15060" },
      ),
    ).toThrow(/missing a justification/)
  })
})
