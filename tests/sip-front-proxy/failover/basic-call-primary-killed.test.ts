/**
 * Primary-kill failover with full E2E BYE round-trip — closes the loop
 * opened by slices 3b/3c.
 *
 * Slice 3c wired per-worker ReplPuller pull loops into the fake stack,
 * so `bak:b2b-1:` on b2b-2 is hydrated from b2b-1's propagate stream
 * before the kill. Slice 4a closes the b-leg-stale gap: the rule
 * framework now auto-emits `flush-redis` whenever a rule mutates the
 * call (RuleExecutor's `appendAutoFlush` + `setRuleState`
 * reference-stability fix), so the snapshot replicated to the backup
 * mirrors the confirmed-dialog state of the b-leg, not the early
 * "trying" snapshot.
 *
 * What this test verifies:
 *   1. Happy-path call (INVITE / 100 / 180 / 200 / ACK) lands on b2b-1
 *      (HRW pinning via the cookie).
 *   2. After the 1s settle pause, ReplPuller has drained the
 *      propagate set and `bak:b2b-1:call:*` is populated on b2b-2,
 *      with the b-leg in the confirmed state. `expectReplicatedTo`
 *      proves the partition is hydrated.
 *   3. `cluster.kill("b2b-1")` flips registry to dead and disconnects
 *      the network gate.
 *   4. Alice BYE → proxy routes to b2b-2 via `decode_forward_backup`.
 *      b2b-2 finds the call in `bak:b2b-1:` with the confirmed b-leg,
 *      sends 200 OK to alice AND a real BYE to bob, who 200's it.
 *   5. Single-owner invariant
 *      ([docs/replication/call-cache-backup.md §0](../../../docs/replication/call-cache-backup.md)):
 *      `pri:b2b-2:call:*` MUST stay empty throughout — the backup
 *      never moves the call into its own primary partition.
 */

import { describe, it } from "@effect/vitest"
import { afterAll } from "vitest"
import { scenario } from "../../fullcall/framework/dsl.js"
import {
  K8S_PROXY_ADDR,
  k8sWorkerId,
} from "../../support/k8sFakeStack.js"
import { sdpAnswer, sdpOffer } from "../../fullcall/helpers/sdp.js"
import { CALLID_TO_W1 } from "../../scenarios/ha/two-calls-routed-to-two-workers.js"
import {
  createSimulatedRunner,
  flushIndexReport,
} from "../../support/harness.js"

const OUTPUT_DIR = "test-results/failover"

afterAll(() => {
  flushIndexReport(OUTPUT_DIR)
})

const ALICE_HOST = "10.30.0.1"
const BOB_HOST = "10.40.0.1"
const BOB_PORT = 5060

const W1 = k8sWorkerId(1) as unknown as string // "b2b-1"
const W2 = k8sWorkerId(2) as unknown as string // "b2b-2"

const failoverScenario = scenario("basic-call-primary-killed", (s) => {
  // OPTIONS keepalive needs ~2 ticks (≥ 4s) per worker to flip both
  // from `unknown` → `alive`. The LB fresh-pod guard defaults to
  // 20_000ms past `firstSeenAtMs` (auto-stamped at t=0 by the SUT
  // layer). Pausing 25s clears both windows so the subsequent BYE
  // routing is driven by registry health alone — without this pause,
  // every in-dialog request inside the first 20s would be promoted to
  // `decode_forward_backup` regardless of whether we killed anything.
  s.pause(25_000)

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

  const inviteHeaders = {
    "X-Api-Call": JSON.stringify({
      action: "route",
      destination: { host: BOB_HOST, port: BOB_PORT },
      new_ruri: `sip:bob@${BOB_HOST}:${BOB_PORT}`,
    }),
  }

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
    `sip:+1234@${K8S_PROXY_ADDR.host}:${K8S_PROXY_ADDR.port}`,
    { body: sdpOffer(), headers: inviteHeaders },
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

  // Replication settle. ReplPuller pull loops drain the propagate set
  // every ~250ms (REPL_PULL_MAX_OPEN_MS + REPL_PULL_RECONNECT_GAP_MS),
  // so 1s gives ample slack for the bak: partition to populate.
  s.pause(1_000)

  // Primary owns the call.
  s.cluster.expectCallStateOn(W1, { partition: "pri", owner: W1 })
  // ReplPuller drove the call into the backup partition.
  s.cluster.expectReplicatedTo(W2, { primary: W1 })
  // Single-owner invariant pre-kill: backup has no pri:b2b-2 entry.
  s.cluster.expectCallStateOn(W2, {
    partition: "pri",
    owner: W2,
    present: false,
  })

  // Kill primary. Default timing collapses the four-phase pipeline
  // onto a single tick — fine for this steady-state assertion (the
  // gap-knobs are exercised separately by SimulatedK8sCluster.test.ts).
  s.cluster.kill(W1)
  // Let the registry-dead transition settle before sending BYE.
  s.pause(50)

  // Alice BYE — proxy reads the cookie, sees w_pri=b2b-1 dead, routes
  // to w_bak=b2b-2. b2b-2 finds the call in bak:b2b-1: with the
  // b-leg already confirmed (auto-flush keeps the bak snapshot fresh)
  // and runs the standard relay-bye flow: 200 OK to alice + real BYE
  // to bob, who 200's it.
  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)

  // Routing-decision proof: the BYE was promoted from `decode_forward`
  // to `decode_forward_backup` (cookie's primary was dead-ROUtable).
  s.cluster.expectRoutedTo(W2, { decision: "decode_forward_backup" })

  // Single-owner invariant (post-routing): backup MUST NOT move the
  // call into its own pri: even when serving a request as backup-on-
  // behalf-of-primary. The assertion holds whether or not the b-leg
  // round-trip completes — it's about the partition geometry, not the
  // SIP message flow.
  s.cluster.expectCallStateOn(W2, {
    partition: "pri",
    owner: W2,
    present: false,
  })
})
  .runOn(["k8sFailover"])
  // OPTIONS keepalive runs every 2s on both workers; the 24h
  // post-scenario sweep would generate ~85k OPTIONS exchanges and any
  // transient binding-unavailable window post-kill would be amplified
  // into hundreds of "undeliverable" entries. HA-style scenarios use
  // skipFinalSweep here for the same reason as
  // `two-calls-routed-to-two-workers`.
  .skipFinalSweep()

describe("sip-front-proxy/failover — basic-call-primary-killed", () => {
  const run = createSimulatedRunner({
    outputDir: OUTPUT_DIR,
    sut: "k8sFailover",
  })
  it.effect(
    "primary killed mid-call → BYE routed to backup, 200 OK from replicated state",
    () => run(failoverScenario.toScenario()),
    { timeout: 120_000 },
  )
})
