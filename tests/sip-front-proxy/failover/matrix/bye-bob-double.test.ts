/**
 * Matrix entry: BYE — bob-initiated — double-switch failover.
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
  method: "BYE",
  initiator: "bob",
  switchPattern: "double",
}

// Double-switch: kill primary, BYE on backup, respawn primary, kill backup.
// The kill-backup step closes the per-worker scope on b2b-2 and the
// respawned b2b-1 ingests the terminated call's bak: snapshot via
// ReadyGate reverse-drain, driving the call to terminated → 1 CDR fires.
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
    "double-switch lifecycle: kill-respawn-kill around bob-initiated BYE",
    () => run(buildFailoverScenario(CASE).toScenario()),
    { timeout: 120_000 },
  )
})
