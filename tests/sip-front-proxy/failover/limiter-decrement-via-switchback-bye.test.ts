/**
 * Slice 4 — switchback regression test.
 *
 * Sequence:
 *   1. INVITE on W1 with `call_limiter[id, limit=1]` →
 *      `expectLimiterCount(1)`.
 *   2. Replication settle. W2's `bak:W1:` has the body and the
 *      `idx:leg:{callId}|*` index (the production-fix regression
 *      assertion).
 *   3. `kill(W1)`.
 *   4. Alice delayed-offer re-INVITE → routes to W2 via
 *      `decode_forward_backup`. Re-INVITE must NOT touch the
 *      counter — `expectLimiterCount(1)`.
 *   5. `respawn(W1)` + 25s pause. ReadyGate drains W2's reverse-
 *      propagate stream; OPTIONS keepalive flips W1 → alive; LB
 *      fresh-pod-guard expires.
 *   6. Alice BYE → cookie's w_pri=W1 is alive again →
 *      `decode_forward` to W1. The respawned primary terminates the
 *      call; `decrement-limiter` runs against the cluster-shared
 *      store using the call's persisted `originWindow`.
 *   7. `expectLimiterCount(0)` — the FULL round-trip preserves the
 *      origin window across bak→pri switchback. If it doesn't, the
 *      decrement misses, the count stays at 1, and the next call
 *      under the same id would 486.
 *
 * This test catches a class of bugs the matrix `_matrix.ts` does
 * not — specifically, BYE-on-returned-primary after re-INVITE-on-
 * backup. The matrix double-switch ends with the BYE on W2 (because
 * it kills W2 just before teardown); this scenario explicitly
 * routes the BYE back to W1 to validate the data merge through
 * ReadyGate.
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

expectCdrCount("limiter-decrement-via-switchback-bye", 1)

const OUTPUT_DIR = "test-results/failover"

afterAll(() => {
  flushIndexReport(OUTPUT_DIR)
})

const ALICE_HOST = "10.30.0.1"
const BOB_HOST = "10.40.0.1"
const BOB_PORT = 5060

const W1 = k8sWorkerId(1) as unknown as string
const W2 = k8sWorkerId(2) as unknown as string

const LIMITER_ID = "switchback-bye"

const routeToBob = JSON.stringify({
  action: "route",
  destination: { host: BOB_HOST, port: BOB_PORT },
  new_ruri: `sip:bob@${BOB_HOST}:${BOB_PORT}`,
  call_limiter: [{ id: LIMITER_ID, limit: 1 }],
})

const switchbackBye = scenario(
  "limiter-decrement-via-switchback-bye",
  (s) => {
    s.pause(25_000) // OPTIONS settle + LB fresh-pod-guard

    // ── Phase 0: establish on W1, slot consumed ────────────────────
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

    // Replication settle.
    s.pause(1_000)
    s.cluster.expectReplicatedTo(W2, { primary: W1 })
    s.cluster.expectIndexOnBackup(W2, { callId: CALLID_TO_W1 })
    s.cluster.expectLimiterCount(LIMITER_ID, 1)

    // ── Phase 1: kill primary, re-INVITE via backup ────────────────
    s.cluster.kill(W1)
    s.pause(50)

    // Delayed-offer re-INVITE: alice INVITE without body, bob 200 with
    // offer, alice ACK with answer. Mirrors `_matrix.ts:178`.
    {
      const txn = aliceDialog.send("INVITE")
      txn.expect(100)
      bobDialog
        .expect("INVITE")
        .reply(200, { overrides: { body: sdpOffer(undefined, 30001) } })
      txn.expect(200)
      aliceDialog.ack({
        build: () => ({ body: sdpAnswer(undefined, { port: 30001 }) }),
      })
      bobDialog.expect("ACK")
    }
    s.pause(100)

    s.cluster.expectRoutedTo(W2, { decision: "decode_forward_backup" })
    // re-INVITE must not touch the limiter (no
    // checkAndIncrement-on-reinvite path).
    s.cluster.expectLimiterCount(LIMITER_ID, 1)

    // ── Phase 2: respawn primary, wait for switchback window ───────
    s.cluster.respawn(W1)
    // 25s clears the LB fresh-pod-guard (20s) AND gives OPTIONS
    // keepalive several rounds to flip W1 from `unknown` → `alive`.
    s.pause(25_000)

    // ── Phase 3: BYE routes back to the returned primary ───────────
    const aliceByeTxn = aliceDialog.bye()
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
    s.pause(200)

    s.cluster.expectRoutedTo(W1, { decision: "decode_forward" })
    // The decrement must run against the originWindow stored in the
    // replicated call body, not against the current window. If the
    // switchback path re-stamps the origin to W1's current epoch, the
    // decrement targets a key the original increment never wrote and
    // the count stays at 1. expectLimiterCount = 0 proves preservation.
    s.cluster.expectLimiterCount(LIMITER_ID, 0)

    // Single-owner invariant after teardown.
    s.cluster.expectCallStateOn(W2, {
      partition: "pri",
      owner: W2,
      present: false,
    })
  }
)
  .runOn(["k8sFailover"])
  .skipFinalSweep()

describe("sip-front-proxy/failover — limiter-decrement-via-switchback-bye", () => {
  const run = createSimulatedRunner({
    outputDir: OUTPUT_DIR,
    sut: "k8sFailover",
  })
  it.effect(
    "re-INVITE on backup → respawn → BYE on returned-primary decrements the cluster-shared limiter",
    () => run(switchbackBye.toScenario()),
    { timeout: 240_000 }
  )
})
