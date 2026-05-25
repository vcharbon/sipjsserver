/**
 * Diagnostic: prove who writes the CDRs in `ha-keepalive-happy`.
 *
 * Runs the scenario in isolation against `sipproxyHA`, with
 * `DEBUG_CDR=1` set so the harness dumps every CDR record's
 * `callRef` to the test log alongside the writer-attribution check.
 * The first `|`-segment of `callRef` is the call's primary worker
 * (`b2b-1` / `b2b-2` here). Two outcomes worth distinguishing:
 *
 *   (a) one record per distinct callRef → each call's primary worker
 *       wrote its CDR exactly once. This is the architecturally
 *       expected shape: rule processing only happens on the worker
 *       holding the call in its in-memory `callsMap`. The backup
 *       receives replicated body state via `EchoApply` but never
 *       runs the rule chain, so `write-cdr` cannot fire on it.
 *
 *   (b) duplicate callRefs → both workers wrote the CDR for the same
 *       call. That would be a bug.
 *
 * Run with:
 *   DEBUG_CDR=1 TEST_MODE=fake npx vitest run \
 *     tests/fullcall/ha-cdr-attribution.diagnostic.test.ts
 */

import { describe, it } from "@effect/vitest"
import { haKeepaliveHappy } from "../scenarios/ha/keepalive-happy-ha.js"
import {
  createSimulatedRunner,
  skipCdrCheck,
} from "../support/harness.js"

// Skip the cumulative-count assertion — the diagnostic owns the CDR
// inspection via the DEBUG_CDR=1 dump path in `assertCleanCallTermination`.
skipCdrCheck("ha-keepalive-happy")

describe("HA CDR attribution diagnostic", () => {
  // Fresh runner → fresh CDR buffer, isolated from the main e2e run.
  const run = createSimulatedRunner({
    outputDir: "test-results/diagnostic",
    sut: "sipproxyHA",
  })

  it.effect(
    "ha-keepalive-happy CDR breakdown (set DEBUG_CDR=1 to see the dump)",
    () => run(haKeepaliveHappy.toScenario()),
    { timeout: 120_000 },
  )
})
