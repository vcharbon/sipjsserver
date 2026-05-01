/**
 * Smoke test for the new transparent in-dialog relay rules added in slice 4a:
 * `relay-update` (RFC 3311) and `relay-message` (RFC 3428).
 *
 * These rules are required for the failover matrix to exercise UPDATE and
 * MESSAGE end-to-end. Both share the `makeTransparentRelayRule` factory, so
 * the test here only verifies that they are wired into `defaultRules` with
 * the right method match.
 */

import { describe, test, expect } from "vitest"
import { defaultRules } from "../../src/b2bua/rules/defaults/index.js"
import { relayUpdateRule, relayMessageRule } from "../../src/b2bua/rules/defaults/RelayRules.js"
import type { AnyRuleDefinition } from "../../src/b2bua/rules/framework/RuleDefinition.js"

function findRule(id: string): AnyRuleDefinition | undefined {
  return defaultRules.find((r) => r.id === id)
}

describe("relay-update / relay-message rule registration", () => {
  test("relay-update is present in defaultRules with method=UPDATE", () => {
    expect(findRule("relay-update")).toBe(relayUpdateRule)
    expect(relayUpdateRule.match).toMatchObject({ kind: "request", method: "UPDATE" })
    expect(relayUpdateRule.alwaysActive).toBe(true)
  })

  test("relay-message is present in defaultRules with method=MESSAGE", () => {
    expect(findRule("relay-message")).toBe(relayMessageRule)
    expect(relayMessageRule.match).toMatchObject({ kind: "request", method: "MESSAGE" })
    expect(relayMessageRule.alwaysActive).toBe(true)
  })
})
