/**
 * Slice 1 e2e — basic-call drive-only run + post-hoc rule engine.
 *
 * Drives the same INVITE/180/200/ACK/BYE flow as
 * [tests/scenarios/basic-call.ts], but every assertion comes from the
 * rule engine in [tests/harness/rules] rather than from inline
 * predicates. Slice success: `assertEnginePassed` reports pass.
 */

import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { basicCall } from "../scenarios2/basic-call.js"
import { allRules } from "./rules/index.js"
import { runDriveOnly, assertEnginePassed } from "./runner.js"
import { loadServiceCase } from "./service-case/load.js"

describe("harness slice 1 — basic-call", () => {
  it.effect(
    "passes every rule under simulated transport",
    () =>
      Effect.gen(function* () {
        const sc = loadServiceCase("basic-call")
        const result = yield* runDriveOnly({
          scenarioId: "basic-call",
          serviceCase: sc,
          script: basicCall,
          rules: allRules,
        })
        assertEnginePassed(result)
      }),
    { timeout: 30_000 }
  )
})
