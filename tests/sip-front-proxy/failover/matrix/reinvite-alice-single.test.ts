/**
 * Matrix entry: re-INVITE — alice-initiated — single-switch failover.
 *
 * After b2b-1 is killed, alice's re-INVITE (delayed offer) routes
 * via decode_forward_backup to b2b-2. b2b-2 serves from `bak:b2b-1:`,
 * relays the re-INVITE, returns the 200 OK, then forwards alice's
 * ACK (carrying the SDP answer) to bob. The dialog is then torn down
 * with a clean BYE.
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
  method: "REINVITE",
  initiator: "alice",
  switchPattern: "single",
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
    "single-switch failover then alice re-INVITE E2E + BYE",
    () => run(buildFailoverScenario(CASE).toScenario()),
    { timeout: 120_000 },
  )
})
