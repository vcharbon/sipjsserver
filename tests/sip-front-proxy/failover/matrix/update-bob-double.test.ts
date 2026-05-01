/**
 * Matrix entry: UPDATE — bob-initiated — double-switch failover.
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
  flushIndexReport,
} from "../../../support/harness.js"

const CASE: MatrixCase = {
  method: "UPDATE",
  initiator: "bob",
  switchPattern: "double",
}

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
    "double-switch: bob UPDATE via backup, respawn, kill backup, BYE via primary",
    () => run(buildFailoverScenario(CASE).toScenario()),
    { timeout: 120_000 },
  )
})
