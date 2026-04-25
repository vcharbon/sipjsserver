/**
 * Slice 4 e2e — additional scenario migrations under the new harness.
 *
 * Each scenario gets its own drive-only run + full rule pack pass.
 * The set demonstrates the harness handles common SIP flow shapes:
 *   - CANCEL transactions (cancel.ts)
 *   - Callee-initiated BYE (callee-hangup.ts)
 *
 * Single-call scenarios run under TestClock; multi-call/parallel
 * scenarios live in their own files and use real-clock mode.
 */

import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { cancelCall } from "../scenarios2/cancel.js"
import { calleeHangup } from "../scenarios2/callee-hangup.js"
import { allRules } from "./rules/index.js"
import { runDriveOnly, assertEnginePassed } from "./runner.js"
import { loadServiceCase } from "./service-case/load.js"

describe("harness slice 4 — migrated scenarios", () => {
  it.effect(
    "cancel: alice cancels mid-ring",
    () =>
      Effect.gen(function* () {
        const sc = loadServiceCase("cancel")
        const result = yield* runDriveOnly({
          scenarioId: "cancel",
          serviceCase: sc,
          script: cancelCall,
          rules: allRules,
        })
        assertEnginePassed(result)
      }),
    { timeout: 30_000 }
  )

  it.effect(
    "callee-hangup: bob initiates the BYE",
    () =>
      Effect.gen(function* () {
        const sc = loadServiceCase("callee-hangup")
        const result = yield* runDriveOnly({
          scenarioId: "callee-hangup",
          serviceCase: sc,
          script: calleeHangup,
          rules: allRules,
        })
        assertEnginePassed(result)
      }),
    { timeout: 30_000 }
  )
})
