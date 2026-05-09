/**
 * Slice 2 — fake-stack regression test for the production 481 storm.
 *
 * The bug (`docs/plan/fix-the-mising-issue-pure-platypus.md`):
 * `decode_forward_backup` lands the BYE on the backup worker, which
 * resolves the call by `(callId, fromTag)` against `idx:leg:*` keys.
 * If those keys are not on the backup's sidecar after replication,
 * `resolveFromSipKey` falls through and the SipRouter rejects with
 * 481. The matrix tests don't catch this directly because their
 * happy-path `bobByeTxn.expect(200)` could pass via `resolveFromRequest`
 * (URI-side lookup) rather than the storage `idx:` path.
 *
 * This test pins the storage-side guarantee:
 *   1. INVITE on W1, replication settle.
 *   2. Assert W2's sidecar has `idx:leg:{callId}|*` for the call —
 *      the literal regression for the 481 root cause.
 *   3. (Optional kill + BYE pass to confirm in-dialog routing still
 *      works once the index is present.)
 *
 * If anyone reverts the puller transport (Slice 8) or the
 * EchoApply index-derivation, step (2) goes red BEFORE the BYE is
 * sent.
 */

import { describe, it } from "@effect/vitest"
import { afterAll } from "vitest"
import { scenario } from "../../../src/test-harness/framework/dsl.js"
import { K8S_PROXY_ADDR, k8sWorkerId } from "../../support/k8sFakeStack.js"
import { sdpAnswer, sdpOffer } from "../../../src/test-harness/framework/helpers/sdp.js"
import { CALLID_TO_W1 } from "../../scenarios/ha/two-calls-routed-to-two-workers.js"
import {
  createSimulatedRunner,
  expectCdrCount,
  flushIndexReport,
} from "../../support/harness.js"

expectCdrCount("backup-resolves-bye-via-replicated-index", 1)

const OUTPUT_DIR = "test-results/failover"

afterAll(() => {
  flushIndexReport(OUTPUT_DIR)
})

const ALICE_HOST = "10.30.0.1"
const BOB_HOST = "10.40.0.1"
const BOB_PORT = 5060

const W1 = k8sWorkerId(1) as unknown as string
const W2 = k8sWorkerId(2) as unknown as string

const routeToBob = JSON.stringify({
  action: "route",
  destination: { host: BOB_HOST, port: BOB_PORT },
  new_ruri: `sip:bob@${BOB_HOST}:${BOB_PORT}`,
})

const indexReplicationScenario = scenario(
  "backup-resolves-bye-via-replicated-index",
  (s) => {
    s.pause(25_000) // OPTIONS settle + LB fresh-pod-guard

    // ── Establish on W1 ───────────────────────────────────────────
    const alice = s.agent("alice", {
      uri: "sip:alice@test",
      ip: ALICE_HOST,
      callId: CALLID_TO_W1,
    })
    const bob = s.agent("bob", {
      uri: "sip:bob@test",
      ip: BOB_HOST,
      port: BOB_PORT,
    })

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      `sip:+1234@${K8S_PROXY_ADDR.host}:${K8S_PROXY_ADDR.port}`,
      { body: sdpOffer(), headers: { "X-Api-Call": routeToBob } }
    )
    aliceInviteTxn.expect(100)
    const { dialog: bobDialog, transaction: bobInviteTxn } =
      bob.receiveInitialInvite()
    bobInviteTxn.reply(180)
    aliceInviteTxn.expect(180)
    bobInviteTxn.reply(200, { body: sdpAnswer() })
    aliceInviteTxn.expect(200)
    aliceDialog.ack()
    bobDialog.expect("ACK")

    // ── Replication settle — let the puller deliver A's frame to B.
    s.pause(1_000)

    // ── Pre-kill assertions (the load-bearing ones for this test) ──
    s.cluster.expectCallStateOn(W1, { partition: "pri", owner: W1 })
    s.cluster.expectReplicatedTo(W2, { primary: W1 })
    // **The literal regression assertion**: if the storage-side index
    // for this call isn't on W2's sidecar after replication, the BYE
    // below would 481 in production. Reading directly from W2's
    // KvBackend snapshot via `expectIndexOnBackup` proves the puller
    // wrote `idx:leg:{callId}|{tag}` alongside the bak: body.
    s.cluster.expectIndexOnBackup(W2, { callId: CALLID_TO_W1 })

    // ── Kill primary, BYE routes to backup, must resolve via idx ───
    s.cluster.kill(W1)
    s.pause(50)

    const aliceByeTxn = aliceDialog.bye()
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)

    // Drain bob's 200 OK back through the backup so the call reaches
    // "terminated" (call-cdr emitted on b2b-2).
    s.pause(200)

    s.cluster.expectRoutedTo(W2, { decision: "decode_forward_backup" })

    // Tombstone propagated → index removed on the backup post-BYE.
    s.cluster.expectIndexOnBackup(W2, {
      callId: CALLID_TO_W1,
      present: false,
    })
  }
)
  .runOn(["k8sFailover"])
  .skipFinalSweep()

describe("sip-front-proxy/failover — backup-resolves-bye-via-replicated-index", () => {
  const run = createSimulatedRunner({
    outputDir: OUTPUT_DIR,
    sut: "k8sFailover",
  })
  it.effect(
    "backup's idx:leg lookup succeeds after replication, then is cleared by tombstone",
    () => run(indexReplicationScenario.toScenario()),
    { timeout: 120_000 }
  )
})
