/**
 * Timer reactivation big-case scenario — exercises the boot-time timer
 * rehydration path that runs after `ReadyGate` finishes.
 *
 * Sequence:
 *   1. Settle 25s so OPTIONS keepalive flips both workers
 *      `unknown` → `alive` and clears the LB fresh-pod guard.
 *   2. INVITE on b2b-1; pre-computed Call-ID `CALLID_TO_W1` ensures the
 *      LB picks W1 as primary, W2 as backup.
 *   3. Replication settle; assert `bak:W1:` present on W2.
 *   4. First keepalive cycle (15 min virtual) — alice + bob each see
 *      OPTIONS, reply 200. Baseline keepalive flow proves the timer
 *      works pre-restart.
 *   5. `kill(W1)` + short pause well under `callContextTtlSec`. Backup
 *      is passive — no OPTIONS expected (the documented restriction).
 *   6. `respawn(W1)`. The worker build closure runs ReadyGate (drains
 *      the reverse-propagate stream from W2), then
 *      `SipRouter.rehydrateOwnedCalls(handlers)` which:
 *        - calls `loadOwnedCalls` to populate `callsMap`
 *        - calls `TimerService.restoreFromEntries` to respawn the
 *          OPTIONS / limiter-refresh timer fibers from the persisted
 *          `TimerEntry[]`.
 *   7. Second keepalive cycle (15 min virtual) AFTER respawn — alice +
 *      bob each see OPTIONS, reply 200. **This is the crux: it fails
 *      on master because the rehydration code path is dead, and passes
 *      after the §1/§2 wiring of
 *      [docs/plan/timer-management-on-backup-transient-hollerith.md]
 *      lands.**
 *   8. BYE alice → bob, 200 OK on each leg.
 *   9. End-of-scenario sweep (no `.skipFinalSweep()`):
 *        - cluster-wide `verifyCleanStateOnAllWorkers` checks that
 *          both workers' `TimerService` and `CallState` are empty.
 *        - explicit `expectCallStateOn(W1, pri, present:false)` and
 *          `expectCallStateOn(W2, bak, present:false)` confirm
 *          tombstones propagated through teardown.
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
  expectCdrCount,
  flushIndexReport,
} from "../../support/harness.js"

// One call from setup through teardown → exactly one CDR.
expectCdrCount("timer-reactivation-big-case", 1)

const OUTPUT_DIR = "test-results/failover/timer-reactivation-big-case"

afterAll(() => {
  flushIndexReport(OUTPUT_DIR)
})

const ALICE_HOST = "10.30.0.1"
const BOB_HOST = "10.40.0.1"
const BOB_PORT = 5060

const W1 = k8sWorkerId(1) as unknown as string // "b2b-1"
const W2 = k8sWorkerId(2) as unknown as string // "b2b-2"

const KEEPALIVE_INTERVAL_MS = 900_000

const timerReactivationBigCase = scenario(
  "timer-reactivation-big-case",
  (s) => {
    // Clear the 20s fresh-pod guard and let HealthProbe flip both
    // workers `unknown` → `alive`.
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

    // ── INVITE setup on W1 ─────────────────────────────────────────
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

    // Replication settle; bak:W1: hydrated on W2.
    s.pause(1_000)
    s.cluster.expectReplicatedTo(W2, { primary: W1 })

    // ── Pre-restart keepalive cycle: timer works on the live W1 ────
    s.pause(KEEPALIVE_INTERVAL_MS)
    aliceDialog.expect("OPTIONS").reply(200)
    bobDialog.expect("OPTIONS").reply(200)

    // ── Kill W1 ────────────────────────────────────────────────────
    s.cluster.kill(W1)
    // Short pause well under callContextTtlSec (default 1800s).
    // No OPTIONS expected — backup is passive (documented restriction
    // in §16 of docs/replication/call-cache-backup.md).
    s.pause(1_000)

    // ── Respawn W1 (process restart, sidecar persists) ───────────
    // `preserveStorage:true` models §11.1 of
    // docs/replication/call-cache-backup.md — the B2BUA process
    // crashed but the sidecar Redis kept its `pri:W1:` data, so the
    // returning process recovers state by reading its own local
    // partition (no peer pull needed). This is exactly the path
    // `loadOwnedCalls` + `restoreFromEntries` cover.
    s.cluster.respawn(W1, { preserveStorage: true })
    // Tiny pause to let rehydration run on the rebuilt worker.
    s.pause(50)
    s.cluster.expectCallStateOn(W1, {
      partition: "pri",
      owner: W1,
      present: true,
    })

    // ── Post-restart keepalive cycle ───────────────────────────────
    // Crux of the scenario: without timer-fiber rehydration the
    // rebuilt worker holds the call in cache but never spawns
    // keepalive fibers, so this expect() times out. With the §1/§2
    // wiring, restoreFromEntries respawns the fiber and OPTIONS fires
    // on schedule.
    s.pause(KEEPALIVE_INTERVAL_MS)
    aliceDialog.expect("OPTIONS").reply(200)
    bobDialog.expect("OPTIONS").reply(200)

    // ── Teardown ───────────────────────────────────────────────────
    const aliceByeTxn = aliceDialog.bye()
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
    s.pause(100)

    // Tombstones propagated.
    s.cluster.expectCallStateOn(W1, {
      partition: "pri",
      owner: W1,
      present: false,
    })
    s.cluster.expectCallStateOn(W2, {
      partition: "bak",
      owner: W1,
      present: false,
    })
  },
).runOn(["k8sFailover"])

describe("sip-front-proxy/failover — timer reactivation big case", () => {
  const run = createSimulatedRunner({
    outputDir: OUTPUT_DIR,
    sut: "k8sFailover",
  })
  it.effect(
    "kill → respawn → OPTIONS keepalive resumes from rehydrated TimerEntry",
    () => run(timerReactivationBigCase.toScenario()),
    { timeout: 240_000 },
  )
})
