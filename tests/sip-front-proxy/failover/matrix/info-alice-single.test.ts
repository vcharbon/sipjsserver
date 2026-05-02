/**
 * Matrix entry: INFO — alice-initiated — single-switch failover.
 *
 * After b2b-1 is killed, alice's INFO is routed to b2b-2 via
 * `decode_forward_backup`; b2b-2 relays it to bob and 200's it back.
 * The dialog is then torn down with a clean BYE round-trip.
 *
 * This is the first matrix entry that exercises a non-terminating
 * in-dialog method post-failover — it proves auto-flush keeps the
 * remoteCSeq side of the bak: snapshot fresh enough that b2b-2 doesn't
 * mistakenly drop the INFO as out-of-window.
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
    "single-switch failover then alice INFO E2E + BYE",
    () => run(buildFailoverScenario(CASE).toScenario()),
    { timeout: 120_000 },
  )
})
