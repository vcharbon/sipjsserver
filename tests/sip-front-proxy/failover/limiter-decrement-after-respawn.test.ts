/**
 * Limiter decrement after the primary is killed and then respawned.
 *
 * Sequence:
 *   1. Limit=1. Call A (CALLID_TO_W1) lands on b2b-1 → accepted →
 *      shared limiter counter = 1. Replication settles so
 *      `bak:b2b-1:call:A` is hydrated on b2b-2.
 *   2. `cluster.kill(W1)` — counter still 1; no BYE arrived during
 *      downtime, so no decrement happened on backup either.
 *   3. `cluster.respawn(W1, { preserveStorage: true })` — b2b-1 boots
 *      again. ReadyGate drains the propagate stream from b2b-2 and the
 *      worker rehydrates `pri:b2b-1:call:A` (b2b-1's own sidecar
 *      survived; the propagate drain is a no-op here since the call
 *      wasn't touched on the backup). After ~25s the LB fresh-pod
 *      guard window closes and OPTIONS keepalive flips W1 back to
 *      `alive`.
 *   4. Alice BYE → proxy routes to W1 (now alive) via plain
 *      `decode_forward` (NOT backup). W1 terminates locally and emits
 *      `decrement-limiter` against the shared store.
 *   5. Call B → b2b-2 → accepted (counter was decremented to 0, then
 *      back to 1). If the decrement at step 4 were per-worker (the
 *      bug fixed by `LimiterRedisClient`), Call B's increment on
 *      b2b-2 would see a stale 1 from b2b-1's local store and return
 *      486.
 *
 * Mirror in production: a respawned primary picks up its own pri:
 * partition from its sidecar, runs terminate locally, and writes the
 * decrement to the cluster-shared `LimiterRedisClient` — observable
 * from any worker, including the one serving the next INVITE.
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
// (steps #21–#29 in the trace). Only Call B writes a CDR — Call A's
// respawned-primary CDR write does not aggregate into the SUT-level
// shared buffer through the rebuilt worker scope (same observable
// shape as `limiter-decrement-via-backup-bye`).
expectCdrCount("limiter-decrement-after-respawn", 1)

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
  call_limiter: [{ id: "decrement-after-respawn", limit: 1 }],
})

const limiterRouteToBob2 = JSON.stringify({
  action: "route",
  destination: { host: BOB_HOST_2, port: BOB_PORT },
  new_ruri: `sip:bob@${BOB_HOST_2}:${BOB_PORT}`,
  call_limiter: [{ id: "decrement-after-respawn", limit: 1 }],
})

const decrementAfterRespawnScenario = scenario(
  "limiter-decrement-after-respawn",
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

    // Replication settle so bak:b2b-1: is hydrated.
    s.pause(1_000)

    // ── Kill primary, no BYE during downtime ───────────────────────
    s.cluster.kill(W1)
    s.pause(50)

    // ── Respawn primary, wait for it to come back to `alive` ───────
    // preserveStorage: true keeps the sidecar so pri:b2b-1: still
    // holds Call A. ReadyGate drains the (empty) propagate stream
    // from b2b-2 (no backup writes happened). 25s clears the LB
    // fresh-pod-guard window AND lets OPTIONS keepalive flip W1
    // from `unknown` → `alive`.
    s.cluster.respawn(W1, { preserveStorage: true })
    s.pause(25_000)

    // ── Alice BYE → respawned W1 (decode_forward, not backup) ──────
    // W1 terminates Call A locally, emits decrement-limiter against
    // the shared store.
    const alice1ByeTxn = alice1Dialog.bye()
    const bob1ByeTxn = bob1Dialog.expect("BYE")
    bob1ByeTxn.reply(200)
    alice1ByeTxn.expect(200)

    // Allow write-cdr / decrement-limiter to fire.
    s.pause(200)

    // ── Call B — alice-2 → b2b-2, must be accepted ─────────────────
    // CALLID_TO_W2 deterministically targets b2b-2. With the shared
    // limiter decremented by W1 in the previous step, b2b-2 sees
    // count=0 and accepts. If the decrement had gone to W1's local
    // store only, b2b-2 would still see 1 here and 486.
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

    s.pause(100)
    const alice2ByeTxn = alice2Dialog.bye()
    const bob2ByeTxn = bob2Dialog.expect("BYE")
    bob2ByeTxn.reply(200)
    alice2ByeTxn.expect(200)
  },
)
  .runOn(["k8sFailover"])
  .skipFinalSweep()

describe("sip-front-proxy/failover — limiter-decrement-after-respawn", () => {
  const run = createSimulatedRunner({
    outputDir: OUTPUT_DIR,
    sut: "k8sFailover",
  })
  it.effect(
    "respawned primary handles BYE and decrements the cluster-shared limiter",
    () => run(decrementAfterRespawnScenario.toScenario()),
    { timeout: 120_000 },
  )
})
