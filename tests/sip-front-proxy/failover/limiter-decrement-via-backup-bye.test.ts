/**
 * Limiter decrement when BYE is processed by the backup worker.
 *
 * Sequence:
 *   1. Limit=1. Call A (CALLID_TO_W1) lands on b2b-1 → accepted →
 *      shared limiter counter = 1.
 *   2. `cluster.kill(W1)` — b2b-1 is dead, only b2b-2 is alive.
 *   3. Alice sends BYE for Call A → proxy routes to b2b-2 via
 *      `decode_forward_backup`. b2b-2 reads from `bak:b2b-1:`, runs
 *      terminate, and emits the `decrement-limiter` side effect against
 *      the *same* shared limiter store.
 *   4. New Call B arrives. With only b2b-2 alive, it lands there. If
 *      the decrement at step 3 properly hit the shared store, Call B
 *      is accepted (counter back to 1, under the limit). If the
 *      decrement went to a per-worker store (the bug the new
 *      `LimiterRedisClient` topology fixes in production), Call B is
 *      wrongly rejected with 486.
 *
 * Mirror in production: the SIP backup worker writes the limiter
 * decrement to the cluster-shared `LimiterRedisClient`, so the count
 * recovers fleet-wide regardless of which worker terminates the call.
 */

import { describe, it } from "@effect/vitest"
import { afterAll } from "vitest"
import { scenario } from "../../../src/test-harness/framework/dsl.js"
import { K8S_PROXY_ADDR, k8sWorkerId } from "../../support/k8sFakeStack.js"
import { sdpAnswer, sdpOffer } from "../../../src/test-harness/framework/helpers/sdp.js"
import {
  CALLID_TO_W1,
  CALLID_TO_W2,
} from "../../scenarios/ha/two-calls-routed-to-two-workers.js"
import {
  createSimulatedRunner,
  expectCdrCount,
  flushIndexReport,
} from "../../support/harness.js"

// The limiter-decrement assertion is implicit: Call B is accepted
// (steps #19–#27 in the trace). If the BYE-on-backup did not decrement
// the shared store, Call B would 486. Only Call B writes a CDR via the
// normal terminate path; Call A's CDR is dropped at kill time (b2b-1's
// per-worker writer fiber is torn down with the scope, and the backup
// write of `bak:b2b-1:` does not emit `write-cdr` in this fake-stack —
// the same single-CDR shape used by `basic-call-primary-killed`).
expectCdrCount("limiter-decrement-via-backup-bye", 1)

const OUTPUT_DIR = "test-results/failover"

afterAll(() => {
  flushIndexReport(OUTPUT_DIR)
})

const ALICE_HOST_1 = "10.30.0.1"
const ALICE_HOST_2 = "10.30.0.2"
const BOB_HOST_1 = "10.40.0.1"
const BOB_HOST_2 = "10.40.0.2"
const BOB_PORT = 5060

const W1 = k8sWorkerId(1) as unknown as string

const limiterRouteToBob1 = JSON.stringify({
  action: "route",
  destination: { host: BOB_HOST_1, port: BOB_PORT },
  new_ruri: `sip:bob@${BOB_HOST_1}:${BOB_PORT}`,
  call_limiter: [{ id: "decrement-via-backup", limit: 1 }],
})

const limiterRouteToBob2 = JSON.stringify({
  action: "route",
  destination: { host: BOB_HOST_2, port: BOB_PORT },
  new_ruri: `sip:bob@${BOB_HOST_2}:${BOB_PORT}`,
  call_limiter: [{ id: "decrement-via-backup", limit: 1 }],
})

const decrementViaBackupScenario = scenario(
  "limiter-decrement-via-backup-bye",
  (s) => {
    s.pause(25_000) // OPTIONS settle + LB fresh-pod-guard

    // ── Call A — alice-1 → b2b-1, slot consumed ────────────────────
    const alice1 = s.agent("alice-1", {
      uri: "sip:alice-1@test",
      ip: ALICE_HOST_1,
      callId: CALLID_TO_W1,
    })
    const bob1 = s.agent("bob-1", {
      uri: "sip:bob-1@test",
      ip: BOB_HOST_1,
      port: BOB_PORT,
    })

    const { dialog: alice1Dialog, transaction: alice1InviteTxn } =
      alice1.invite(
        `sip:+1234@${K8S_PROXY_ADDR.host}:${K8S_PROXY_ADDR.port}`,
        { body: sdpOffer(), headers: { "X-Api-Call": limiterRouteToBob1 } },
      )
    alice1InviteTxn.expect(100)
    const { dialog: bob1Dialog, transaction: bob1InviteTxn } =
      bob1.receiveInitialInvite()
    bob1InviteTxn.reply(180)
    alice1InviteTxn.expect(180)
    bob1InviteTxn.reply(200, { body: sdpAnswer() })
    alice1InviteTxn.expect(200)
    alice1Dialog.ack()
    bob1Dialog.expect("ACK")

    // Replication settle so bak:b2b-1: on b2b-2 is hydrated with the
    // confirmed call state (including the limiterEntries field — see
    // CallModel.ts).
    s.pause(1_000)

    // ── Kill primary, BYE routes to backup ─────────────────────────
    s.cluster.kill(W1)
    s.pause(50)

    // Alice BYE → proxy decodes cookie, sees w_pri=b2b-1 dead, routes
    // to w_bak=b2b-2 (decode_forward_backup). b2b-2 finds the call in
    // bak:b2b-1:, sends 200 OK to alice + real BYE to bob, bob 200's
    // it. The terminate path emits decrement-limiter against the
    // shared store.
    const alice1ByeTxn = alice1Dialog.bye()
    const bob1ByeTxn = bob1Dialog.expect("BYE")
    bob1ByeTxn.reply(200)
    alice1ByeTxn.expect(200)

    // Drain bob's 200 OK back through the backup so the call reaches
    // "terminated" and the decrement-limiter side effect actually
    // executes (helpers.ts:102 finalCleanupEffects).
    s.pause(200)

    // ── Call B — alice-2 → b2b-2 (only alive worker) ───────────────
    // With CALLID_TO_W2 routing target dead, the LB picks the only
    // alive worker (b2b-2). Acceptance of this call proves the prior
    // BYE's decrement landed in the shared store. If the decrement
    // had gone to a per-worker store, b2b-2's local counter would
    // still be 1 (or 0 depending on which worker's bug) and this
    // would either 486 or pass for the wrong reason.
    const alice2 = s.agent("alice-2", {
      uri: "sip:alice-2@test",
      ip: ALICE_HOST_2,
      callId: CALLID_TO_W2,
    })
    const bob2 = s.agent("bob-2", {
      uri: "sip:bob-2@test",
      ip: BOB_HOST_2,
      port: BOB_PORT,
    })

    const { dialog: alice2Dialog, transaction: alice2InviteTxn } =
      alice2.invite(
        `sip:+1234@${K8S_PROXY_ADDR.host}:${K8S_PROXY_ADDR.port}`,
        { body: sdpOffer(), headers: { "X-Api-Call": limiterRouteToBob2 } },
      )
    alice2InviteTxn.expect(100)
    const { dialog: bob2Dialog, transaction: bob2InviteTxn } =
      bob2.receiveInitialInvite()
    bob2InviteTxn.reply(180)
    alice2InviteTxn.expect(180)
    bob2InviteTxn.reply(200, { body: sdpAnswer() })
    alice2InviteTxn.expect(200)
    alice2Dialog.ack()
    bob2Dialog.expect("ACK")

    // Cleanup
    s.pause(100)
    const alice2ByeTxn = alice2Dialog.bye()
    const bob2ByeTxn = bob2Dialog.expect("BYE")
    bob2ByeTxn.reply(200)
    alice2ByeTxn.expect(200)
  },
)
  .runOn(["k8sFailover"])
  .skipFinalSweep()

describe("sip-front-proxy/failover — limiter-decrement-via-backup-bye", () => {
  const run = createSimulatedRunner({
    outputDir: OUTPUT_DIR,
    sut: "k8sFailover",
  })
  it.effect(
    "BYE handled by backup worker decrements the cluster-shared limiter",
    () => run(decrementViaBackupScenario.toScenario()),
    { timeout: 120_000 },
  )
})
