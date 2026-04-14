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

// ── Fake rule helpers ────────────────────────────────────────────────────────

function makeRule(opts: {
  readonly id: string
  readonly matches?: boolean
  readonly handleReturns?: "undefined" | "result"
}): AnyRuleDefinition {
  return {
    id: opts.id,
    name: opts.id,
    alwaysActive: true,
    defaultPriority: 500,
    stateSchema: Schema.Undefined as Schema.Schema<unknown>,
    paramsSchema: Schema.Unknown as Schema.Schema<unknown>,
    matches: () => opts.matches ?? true,
    init: () => undefined,
    handle: () =>
      Effect.succeed(
        opts.handleReturns === "result"
          ? ({ actions: [], state: undefined } as RuleHandleResult<unknown>)
          : undefined,
      ),
  }
}

const dummyCtx = {} as RuleContext

// ── Tests ────────────────────────────────────────────────────────────────────

describe("transformRegistry", () => {
  test("wrapHandle observes non-undefined outcomes and preserves undefined passthrough", async () => {
    const registry = createRuleRegistry([
      makeRule({ id: "acts", handleReturns: "result" }),
      makeRule({ id: "declines", handleReturns: "undefined" }),
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
    expect(fired).toEqual(["acts"])
  })

  test("transform returns a new registry and does not mutate the input", () => {
    const registry = createRuleRegistry([makeRule({ id: "r1" })])
    const wrapped = transformRegistry(registry, {
      wrapMatches: () => () => false,
    })
    expect(wrapped).not.toBe(registry)
    expect(registry.definitions.get("r1")!.matches(dummyCtx)).toBe(true)
    expect(wrapped.definitions.get("r1")!.matches(dummyCtx)).toBe(false)
  })
})

describe("disableRule", () => {
  test("forces matches() to false for the named rule only", () => {
    const registry = createRuleRegistry([
      makeRule({ id: "keep", matches: true }),
      makeRule({ id: "drop", matches: true }),
    ])
    const wrapped = disableRule(registry, "drop")
    expect(wrapped.definitions.get("keep")!.matches(dummyCtx)).toBe(true)
    expect(wrapped.definitions.get("drop")!.matches(dummyCtx)).toBe(false)
  })

  test("returns input unchanged when rule id is unknown", () => {
    const registry = createRuleRegistry([makeRule({ id: "only" })])
    expect(disableRule(registry, "missing")).toBe(registry)
  })
})
