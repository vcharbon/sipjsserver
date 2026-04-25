/**
 * Slice 3 e2e — multi-call call-limiter scenario under the new harness.
 *
 * Drives three parallel calls sharing one limiter slot; the rule pack
 * (including the new cross-call.* rules) must pass on the resulting
 * recordings.
 *
 * Uses realClock because parallel sub-scenarios coordinate via wall
 * time (s.pause). Under TestClock each fiber advances the virtual
 * clock independently, so cross-fiber pauses don't line up — see
 * [tests/fullcall/e2e-real-clock.test.ts] for the same pattern in
 * the legacy suite.
 */

import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { limiterRejection } from "../scenarios2/limiter-rejection.js"
import { allRules } from "./rules/index.js"
import { runDriveOnly, assertEnginePassed } from "./runner.js"
import { loadServiceCase } from "./service-case/load.js"

describe("harness slice 3 — limiter-rejection", () => {
  it.live(
    "passes every rule including cross-call.limiter-concurrency",
    () =>
      Effect.gen(function* () {
        const sc = loadServiceCase("limiter-rejection")
        const result = yield* runDriveOnly({
          scenarioId: "limiter-rejection",
          serviceCase: sc,
          script: limiterRejection,
          rules: allRules,
          sipPort: 15080,
          httpPort: 13022,
          realClock: true,
        })
        assertEnginePassed(result)
      }),
    { timeout: 30_000 }
  )
})
