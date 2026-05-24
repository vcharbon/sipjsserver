/**
 * Tests for transformRegistry + disableRule.
 *
 * These helpers back the e2e harness's coverage tracker and the rule-kill
 * mutation script, so we validate them directly with fake rules rather
 * than running a full scenario.
 */

import { describe, test, expect } from "vitest"
import { Effect, Schema } from "effect"
import {
  createRuleRegistry,
  disableRule,
  transformRegistry,
} from "../../src/b2bua/rules/framework/RuleRegistry.js"
import type {
  AnyRuleDefinition,
  RuleContext,
  RuleHandleResult,
} from "../../src/b2bua/rules/framework/RuleDefinition.js"
import { matchAccepts } from "../../src/b2bua/rules/framework/Matcher.js"

// ── Fake rule helpers ────────────────────────────────────────────────────────

function makeRule(opts: {
  readonly id: string
  readonly handleReturns?: "undefined" | "result"
  readonly overrides?: string
}): AnyRuleDefinition {
  const base = {
    id: opts.id,
    name: opts.id,
    alwaysActive: true as const,
    stateSchema: Schema.Undefined as Schema.Schema<unknown>,
    paramsSchema: Schema.Unknown as Schema.Schema<unknown>,
    match: { kind: "cancelled" } as const,
    init: () => undefined,
    handle: () =>
      Effect.succeed(
        opts.handleReturns === "result"
          ? ({ actions: [], state: undefined } as RuleHandleResult<unknown>)
          : undefined,
      ),
  }
  return opts.overrides === undefined ? base : { ...base, overrides: opts.overrides }
}

const dummyCtx = {
  event: { type: "cancelled" },
  call: { state: "active" },
} as unknown as RuleContext

// ── Tests ────────────────────────────────────────────────────────────────────

describe("transformRegistry", () => {
  test("wrapHandle observes non-undefined outcomes and preserves undefined passthrough", async () => {
    const registry = createRuleRegistry([
      makeRule({ id: "acts", handleReturns: "result" }),
      makeRule({ id: "declines", handleReturns: "undefined", overrides: "acts" }),
    ])

    const fired: string[] = []
    const wrapped = transformRegistry(registry, {
      wrapHandle: (rule, original) => (ctx, state, params) =>
        Effect.map(original(ctx, state, params), (outcome) => {
          if (outcome !== undefined && outcome !== null) fired.push(rule.id)
          return outcome
        }),
    })

    for (const [, rule] of wrapped.definitions) {
      await Effect.runPromise(rule.handle(dummyCtx, undefined, {}))
    }
    expect(fired.sort()).toEqual(["acts"])
  })

  test("transform returns a new registry and does not mutate the input", () => {
    const registry = createRuleRegistry([makeRule({ id: "r1" })])
    const wrapped = transformRegistry(registry, {
      wrapHandle: (_rule, _original) => () => Effect.succeed(undefined),
    })
    expect(wrapped).not.toBe(registry)
    expect(registry.definitions.get("r1")).toBeDefined()
    expect(wrapped.definitions.get("r1")).toBeDefined()
  })
})

describe("disableRule", () => {
  test("forces the rule's match to reject the event", () => {
    const registry = createRuleRegistry([
      makeRule({ id: "keep" }),
      makeRule({ id: "drop", overrides: "keep" }),
    ])
    const wrapped = disableRule(registry, "drop")
    const keep = wrapped.definitions.get("keep")!
    const drop = wrapped.definitions.get("drop")!
    expect(matchAccepts(keep.match, dummyCtx)).toBe(true)
    expect(matchAccepts(drop.match, dummyCtx)).toBe(false)
  })

  test("returns input unchanged when rule id is unknown", () => {
    const registry = createRuleRegistry([makeRule({ id: "only" })])
    expect(disableRule(registry, "missing")).toBe(registry)
  })
})
