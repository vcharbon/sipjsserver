/**
 * Matrix entry: BYE — bob-initiated — single-switch failover.
 *
 * Bob's BYE arrives at the proxy carrying the b2b-1 stickiness cookie.
 * The proxy decodes the cookie, sees b2b-1 dead, and promotes to
 * `decode_forward_backup` → b2b-2; b2b-2 serves from `bak:b2b-1:`
 * and forwards the BYE to alice on the a-leg.
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
  switchPattern: "single",
}

// 1 call established on b2b-1; backup b2b-2 drives the post-takeover BYE round-trip → 1 CDR.
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
    "single-switch failover then bob BYE round-trip",
    () => run(buildFailoverScenario(CASE).toScenario()),
    { timeout: 120_000 },
  )
})
