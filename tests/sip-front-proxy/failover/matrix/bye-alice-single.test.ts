/**
 * Matrix entry: BYE — alice-initiated — single-switch failover.
 *
 * After b2b-1 is killed, alice's BYE traverses the proxy via
 * `decode_forward_backup` to b2b-2; b2b-2 finds the call in
 * `bak:b2b-1:` and runs the standard relay-bye flow.
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
  method: "BYE",
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
    "single-switch failover then alice BYE round-trip",
    () => run(buildFailoverScenario(CASE).toScenario()),
    { timeout: 120_000 },
  )
})
