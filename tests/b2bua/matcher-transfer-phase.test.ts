/**
 * Matcher unit tests for the transferPhase gate.
 *
 * Slice 3 of the REFER implementation: verifies that two rules with
 * otherwise-identical match descriptors are selected based on the
 * current call.transfer?.phase.
 */

import { describe, expect, test } from "vitest"
import { Effect, Schema } from "effect"
import {
  matchAccepts,
  pick,
  pickRanked,
  specificityScore,
} from "../../src/b2bua/rules/framework/Matcher.js"
import type {
  AnyRuleDefinition,
  RuleContext,
  RuleHandleResult,
} from "../../src/b2bua/rules/framework/RuleDefinition.js"
import type { Call, TransferPhase } from "../../src/call/CallModel.js"

// ── Fixture helpers ───────────────────────────────────────────────────────

function makeRule(opts: {
  id: string
  transferPhase?:
    | TransferPhase
    | ReadonlyArray<TransferPhase | null>
    | null
}): AnyRuleDefinition {
  return {
    id: opts.id,
    name: opts.id,
    alwaysActive: true,
    stateSchema: Schema.Undefined as Schema.Schema<unknown>,
    paramsSchema: Schema.Unknown as Schema.Schema<unknown>,
    match: {
      kind: "cancelled",
      transferPhase: opts.transferPhase,
    },
    init: () => undefined,
    handle: () =>
      Effect.succeed({
        actions: [],
        state: undefined,
      } satisfies RuleHandleResult<unknown>),
  }
}

function makeCtx(phase: TransferPhase | null): RuleContext {
  const call = {
    state: "active",
    transfer:
      phase === null
        ? null
        : {
            phase,
            referrerLegId: "b-1",
            referToUri: "sip:charlie@host",
            startedAtMs: 1_700_000_000_000,
          },
  } as unknown as Call
  return {
    call,
    callRef: "test-ref",
    event: { type: "cancelled" },
    sourceLeg: { legId: "a", state: "confirmed" } as unknown as RuleContext["sourceLeg"],
    sourceDialog: undefined,
    direction: "from-a",
    config: {} as RuleContext["config"],
    callControl: {} as RuleContext["callControl"],
    limiter: {} as RuleContext["limiter"],
    nowMs: 1_700_000_000_000,
  }
}

// ── matchAccepts: transferPhase gate semantics ────────────────────────────

describe("matchAccepts — transferPhase gate", () => {
  const phaseRule = makeRule({ id: "phase", transferPhase: "c-ringing" })
  const nullRule = makeRule({ id: "null", transferPhase: null })
  const arrayRule = makeRule({
    id: "array",
    transferPhase: ["c-ringing", "a-realigning"],
  })
  const nullOrPhaseRule = makeRule({
    id: "null-or-phase",
    transferPhase: [null, "refer-authorizing"],
  })
  const omittedRule = makeRule({ id: "omitted" })

  test("phase literal matches only when phase is exactly that literal", () => {
    expect(matchAccepts(phaseRule.match, makeCtx("c-ringing"))).toBe(true)
    expect(matchAccepts(phaseRule.match, makeCtx("a-realigning"))).toBe(false)
    expect(matchAccepts(phaseRule.match, makeCtx(null))).toBe(false)
  })

  test("null gate matches only when call has no transfer", () => {
    expect(matchAccepts(nullRule.match, makeCtx(null))).toBe(true)
    expect(matchAccepts(nullRule.match, makeCtx("c-ringing"))).toBe(false)
  })

  test("array gate matches any listed phase", () => {
    expect(matchAccepts(arrayRule.match, makeCtx("c-ringing"))).toBe(true)
    expect(matchAccepts(arrayRule.match, makeCtx("a-realigning"))).toBe(true)
    expect(matchAccepts(arrayRule.match, makeCtx("c-realigning"))).toBe(false)
    expect(matchAccepts(arrayRule.match, makeCtx(null))).toBe(false)
  })

  test("array gate including null accepts both absent transfer and listed phases", () => {
    expect(matchAccepts(nullOrPhaseRule.match, makeCtx(null))).toBe(true)
    expect(
      matchAccepts(nullOrPhaseRule.match, makeCtx("refer-authorizing")),
    ).toBe(true)
    expect(matchAccepts(nullOrPhaseRule.match, makeCtx("c-ringing"))).toBe(false)
  })

  test("omitted transferPhase accepts every phase including absent", () => {
    expect(matchAccepts(omittedRule.match, makeCtx("c-ringing"))).toBe(true)
    expect(matchAccepts(omittedRule.match, makeCtx(null))).toBe(true)
  })
})

// ── pick: specificity-ranked selection across phase-gated rules ───────────

describe("pick — picks the phase-specific rule when phase matches", () => {
  const generic = makeRule({ id: "generic" })
  const specific = makeRule({ id: "specific", transferPhase: "c-ringing" })

  test("phase-specific rule wins when phase matches", () => {
    const winner = pick([generic, specific], makeCtx("c-ringing"))
    expect(winner?.id).toBe("specific")
  })

  test("generic rule wins when phase does not match the specific rule", () => {
    const winner = pick([generic, specific], makeCtx("a-realigning"))
    expect(winner?.id).toBe("generic")
  })

  test("generic rule wins when call has no transfer", () => {
    const winner = pick([generic, specific], makeCtx(null))
    expect(winner?.id).toBe("generic")
  })

  test("ranked candidates list honours transferPhase gate", () => {
    const ranked = pickRanked([generic, specific], makeCtx("c-ringing"))
    expect(ranked.map((r) => r.id)).toEqual(["specific", "generic"])
  })
})

// ── specificityScore: phase literal beats array, undefined scores zero ────

describe("specificityScore — transferPhase contribution", () => {
  test("singleton phase scores higher than array", () => {
    const single = makeRule({ id: "s", transferPhase: "c-ringing" })
    const multi = makeRule({ id: "m", transferPhase: ["c-ringing", "a-realigning"] })
    expect(specificityScore(single.match)).toBeGreaterThan(
      specificityScore(multi.match),
    )
  })

  test("omitted transferPhase scores zero contribution", () => {
    const withPhase = makeRule({ id: "p", transferPhase: "c-ringing" })
    const withoutPhase = makeRule({ id: "np" })
    expect(specificityScore(withPhase.match)).toBeGreaterThan(
      specificityScore(withoutPhase.match),
    )
  })

  test("null gate is treated as a singleton (beats array)", () => {
    const nullRule = makeRule({ id: "n", transferPhase: null })
    const arrRule = makeRule({
      id: "a",
      transferPhase: [null, "refer-authorizing"],
    })
    expect(specificityScore(nullRule.match)).toBeGreaterThan(
      specificityScore(arrRule.match),
    )
  })
})
