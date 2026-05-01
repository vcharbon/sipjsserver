/**
 * Matrix entry: UPDATE — alice-initiated — single-switch failover.
 *
 * RFC 3311 in-dialog UPDATE relayed end-to-end across a backup-promoted
 * b2b-2 after b2b-1 is killed. Exercises the slice-4a `relay-update`
 * rule against a stale-state-free bak: snapshot.
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
    "single-switch failover then alice UPDATE E2E + BYE",
    () => run(buildFailoverScenario(CASE).toScenario()),
    { timeout: 120_000 },
  )
})
