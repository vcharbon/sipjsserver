/**
 * Matrix entry: MESSAGE — alice-initiated — single-switch failover.
 *
 * RFC 3428 in-dialog MESSAGE relayed end-to-end across a backup-promoted
 * b2b-2 after b2b-1 is killed. Exercises the slice-4a `relay-message`
 * rule.
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
  method: "MESSAGE",
  initiator: "alice",
  switchPattern: "single",
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
    "single-switch failover then alice MESSAGE E2E + BYE",
    () => run(buildFailoverScenario(CASE).toScenario()),
    { timeout: 120_000 },
  )
})
