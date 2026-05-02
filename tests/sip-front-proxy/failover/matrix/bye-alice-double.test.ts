/**
 * Matrix entry: BYE — alice-initiated — double-switch failover.
 *
 * Sequence:
 *   1. INVITE setup on b2b-1.
 *   2. kill b2b-1 → alice BYE → routes to b2b-2 via decode_forward_backup.
 *      Call terminates on b2b-2.
 *   3. respawn b2b-1 → ReadyGate drains b2b-2's reverse-propagate
 *      stream (the terminated call's bak:b2b-1: snapshot lands as
 *      pri:b2b-1: on b2b-1).
 *   4. kill b2b-2.
 *
 * The per-worker scope close on kill-1 + rebuild on respawn + scope
 * close on kill-2 collectively prove the slice 4b-ii lifecycle wiring.
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
  initiator: "alice",
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
    "double-switch lifecycle: kill-respawn-kill around terminating BYE",
    () => run(buildFailoverScenario(CASE).toScenario()),
    { timeout: 120_000 },
  )
})
