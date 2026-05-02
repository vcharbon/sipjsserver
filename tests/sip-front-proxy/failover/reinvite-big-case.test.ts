/**
 * Comprehensive re-INVITE failover scenario — exercises the full
 * "kill primary, re-INVITE both directions, respawn primary, wait for
 * sync + OPTIONS to flip primary back to alive, re-INVITE both
 * directions again, BYE" loop in a single scenario.
 *
 * Validates two distinct routing modes for re-INVITE:
 *
 *   1. **decode_forward_backup** — primary dead, cookie's w_bak handles
 *      the re-INVITE end-to-end including ACK relay (slice 4b-iii fix:
 *      ACK no longer pinned to the dead primary).
 *
 *   2. **decode_forward** — primary respawned, fresh-pod guard cleared,
 *      OPTIONS keepalive flipped it back to `alive`. The cookie's
 *      primary is once again the routing target. Both alice- and
 *      bob-initiated re-INVITEs land on the original primary.
 *
 * Sequence (what each step asserts):
 *   - INVITE setup on b2b-1.
 *   - Replication settle (1s) → bak:b2b-1: hydrated on b2b-2.
 *   - kill(b2b-1).
 *   - alice re-INVITE → routes to b2b-2 via decode_forward_backup.
 *   - bob re-INVITE → also via b2b-2.
 *   - respawn(b2b-1).
 *   - 25s pause: clears the 20s fresh-pod guard AND lets OPTIONS
 *     keepalive flip b2b-1 from `unknown` back to `alive`.
 *   - alice re-INVITE → routes to b2b-1 via decode_forward.
 *   - bob re-INVITE → also via b2b-1.
 *   - BYE alice / 200 / BYE bob / 200.
 *   - Single-owner invariant: pri:b2b-2: stays empty throughout.
 */

import { describe, it } from "@effect/vitest"
import { afterAll } from "vitest"
import { scenario } from "../../../src/test-harness/framework/dsl.js"
import {
  K8S_PROXY_ADDR,
  k8sWorkerId,
} from "../../support/k8sFakeStack.js"
import { sdpAnswer, sdpOffer } from "../../../src/test-harness/framework/helpers/sdp.js"
import { CALLID_TO_W1 } from "../../scenarios/ha/two-calls-routed-to-two-workers.js"
import {
  createSimulatedRunner,
  expectCdrCount,
  flushIndexReport,
} from "../../support/harness.js"

// 1 call exercised across kill/respawn cycles → 1 CDR on teardown.
expectCdrCount("reinvite-big-case", 1)

const OUTPUT_DIR = "test-results/failover/reinvite-big-case"

afterAll(() => {
  flushIndexReport(OUTPUT_DIR)
})

const ALICE_HOST = "10.30.0.1"
const BOB_HOST = "10.40.0.1"
const BOB_PORT = 5060

const W1 = k8sWorkerId(1) as unknown as string // "b2b-1"
const W2 = k8sWorkerId(2) as unknown as string // "b2b-2"

const reinviteBigCase = scenario("reinvite-big-case", (s) => {
  // Settle the LB fresh-pod guard (20s) on the initial workers and
  // let OPTIONS keepalive flip both from `unknown` → `alive`.
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

  // ── Initial INVITE setup on b2b-1 ──────────────────────────────
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

  // Replication settle.
  s.pause(1_000)
  s.cluster.expectReplicatedTo(W2, { primary: W1 })

  // ── Phase 1: kill primary, exercise both directions via backup ─
  s.cluster.kill(W1)
  s.pause(50)

  // alice re-INVITE → b2b-2 (decode_forward_backup).
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

  // bob re-INVITE → b2b-2 (decode_forward_backup).
  {
    const txn = bobDialog.send("INVITE")
    txn.expect(100)
    aliceDialog
      .expect("INVITE")
      .reply(200, { overrides: { body: sdpOffer(undefined, 30002) } })
    txn.expect(200)
    bobDialog.ack({
      build: () => ({ body: sdpAnswer(undefined, { port: 30002 }) }),
    })
    aliceDialog.expect("ACK")
  }

  // ── Phase 2: respawn primary, wait for sync + OPTIONS ──────────
  s.cluster.respawn(W1)
  // 25s clears the 20s fresh-pod guard AND gives OPTIONS keepalive
  // (~3.5s cadence) several rounds to flip W1 from `unknown` →
  // `alive`. Without this pause the next re-INVITEs would still
  // route via decode_forward_backup (fresh-pod-guard promotion),
  // not via decode_forward as the test expects.
  s.pause(25_000)

  // ── Phase 3: re-INVITEs now route to the respawned primary ─────
  // alice re-INVITE → b2b-1 (decode_forward).
  {
    const txn = aliceDialog.send("INVITE")
    txn.expect(100)
    bobDialog
      .expect("INVITE")
      .reply(200, { overrides: { body: sdpOffer(undefined, 30003) } })
    txn.expect(200)
    aliceDialog.ack({
      build: () => ({ body: sdpAnswer(undefined, { port: 30003 }) }),
    })
    bobDialog.expect("ACK")
  }

  // bob re-INVITE → b2b-1 (decode_forward).
  {
    const txn = bobDialog.send("INVITE")
    txn.expect(100)
    aliceDialog
      .expect("INVITE")
      .reply(200, { overrides: { body: sdpOffer(undefined, 30004) } })
    txn.expect(200)
    bobDialog.ack({
      build: () => ({ body: sdpAnswer(undefined, { port: 30004 }) }),
    })
    aliceDialog.expect("ACK")
  }

  // ── Teardown ───────────────────────────────────────────────────
  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
  // Drain bob's 200 OK so the call reaches "terminated" before scope
  // close; .skipFinalSweep() below disables the implicit end-of-scenario
  // sweep that would otherwise drive cleanup.
  s.pause(100)

  // Both routing modes were exercised.
  s.cluster.expectRoutedTo(W2, { decision: "decode_forward_backup" })
  s.cluster.expectRoutedTo(W1, { decision: "decode_forward" })

  // Single-owner invariant.
  s.cluster.expectCallStateOn(W2, {
    partition: "pri",
    owner: W2,
    present: false,
  })
})
  .runOn(["k8sFailover"])
  .skipFinalSweep()

describe("sip-front-proxy/failover — comprehensive re-INVITE big case", () => {
  const run = createSimulatedRunner({
    outputDir: OUTPUT_DIR,
    sut: "k8sFailover",
  })
  it.effect(
    "kill → re-INVITE both ways via backup → respawn → wait sync → re-INVITE both ways via primary → BYE",
    () => run(reinviteBigCase.toScenario()),
    { timeout: 240_000 },
  )
})
