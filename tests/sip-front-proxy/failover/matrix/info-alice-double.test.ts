/**
 * Matrix entry: INFO — alice-initiated — double-switch failover.
 *
 * Sequence:
 *   1. INVITE setup on b2b-1.
 *   2. kill b2b-1 → alice INFO + 200 OK roundtrip via b2b-2 (decode_forward_backup).
 *   3. respawn b2b-1 → ReadyGate drains b2b-2's reverse-propagate stream
 *      so b2b-1 holds pri:b2b-1: again.
 *   4. kill b2b-2 → b2b-1 keeps serving as primary.
 *   5. BYE alice → routes to b2b-1 directly (decode_forward).
 */

import { describe, it } from "@effect/vitest"
import { afterAll } from "vitest"
import {
  buildFailoverScenario,
  matrixName,
  type MatrixCase,
} from "../_matrix.js"
import {
  createSimulatedRunner,
  expectCdrCount,
  flushIndexReport,
} from "../../../support/harness.js"

const CASE: MatrixCase = {
  method: "INFO",
  initiator: "alice",
  switchPattern: "double",
}

// 1 call established + post-kill method + post-respawn teardown → 1 CDR.
expectCdrCount(matrixName(CASE), 1)

const OUTPUT_DIR = `test-results/failover/matrix/${matrixName(CASE)}`

afterAll(() => {
  flushIndexReport(OUTPUT_DIR)
})

describe(`sip-front-proxy/failover — matrix: ${matrixName(CASE)}`, () => {
  const run = createSimulatedRunner({
    outputDir: OUTPUT_DIR,
    sut: "k8sFailover",
  })
  it.effect(
    "double-switch: alice INFO via backup, respawn, kill backup, BYE via primary",
    () => run(buildFailoverScenario(CASE).toScenario()),
    { timeout: 120_000 },
  )
})
