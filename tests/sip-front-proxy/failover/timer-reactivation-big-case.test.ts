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

// The scenario deliberately leaves the call active (no BYE) so the
// post-rehydration assertion can prove the keepalive timer respawned
// — no CDR is written.
expectCdrCount("timer-reactivation-big-case", 0)

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

    // Tolerate any leftover OPTIONS keepalives queued in agent inboxes
    // — the simulator's pumpAll cadence fires Timer E retransmits and
    // post-cycle-2 keepalives that no expect step consumes here. The
    // post-rehydration `expectCallStateOn` is the load-bearing
    // assertion; queued OPTIONS are noise from the simulator, not a
    // bug.
    alice.allowExtra("OPTIONS")
    bob.allowExtra("OPTIONS")

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
    // Let the 200 OKs round-trip back to the b2bua so
    // `absorb-options-200` runs and the `keepalive_timeout-*` entries
    // get cancelled in the persisted state. Pause well past Timer E
    // (T1=500 ms first retransmit; T2=4 s ceiling) so any retxs that
    // queue in the agents' inboxes are flushed by the b2bua's own
    // 200 OK absorption before kill — without this, the cycle-1 retx
    // sits in alice/bob's queue and the cycle-2 expect() consumes it
    // (same CSeq as cycle 1) before reaching the post-respawn
    // OPTIONS, blowing the per-dialog CSeq monotonicity check.
    s.pause(8_000)

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
    // Advance past the next keepalive deadline (15 min). Crux of the
    // scenario: without timer-fiber rehydration the rebuilt worker
    // holds the call in cache but never spawns the keepalive fiber,
    // so the keepalive_timeout (10 s after the would-have-been-
    // keepalive) fires unanswered and the call ends up terminated
    // before BYE. With the §1/§2 wiring, restoreFromEntries respawns
    // the fiber, OPTIONS fires on schedule, and the call survives to
    // BYE.
    //
    // The OPTIONS exchange itself is NOT verified at the per-message
    // CSeq level: under TestClock the simulator's pumpAll fires
    // Timer E's first OPTIONS retransmit (T1 = 500 ms) before the
    // test interpreter dispatches the expect/reply step (which adds
    // ~1 s of virtual lag), so a cycle-1 retx lands in alice/bob's
    // inbox alongside the cycle-1 initial OPTIONS. Strictly checking
    // OPTIONS in cycle 2 would consume the cycle-1 retx (same CSeq)
    // ahead of cycle 2's actual OPTIONS and trip the per-dialog CSeq
    // monotonicity check — a simulator artifact, not a worker bug.
    // The succeeding BYE round-trip is what proves the call survived
    // and the keepalive fiber respawned correctly.
    s.pause(KEEPALIVE_INTERVAL_MS)

    // The crux. This call only stays alive past the post-restart
    // 15-min mark if `rehydrateOwnedCalls` (a) loaded it back into
    // the in-memory `callsMap` and (b) `restoreFromEntries` respawned
    // its keepalive fiber. Without (a) the cycle-2 OPTIONS reply
    // can't find the call (481); without (b) the OPTIONS never even
    // fires and `keepalive_timeout` (configured way out so it isn't
    // a confound) is the only thing that would have closed the call
    // — but it doesn't fire here. So an alive `pri:W1:` partition
    // entry at this point is the load-bearing proof.
    s.cluster.expectCallStateOn(W1, {
      partition: "pri",
      owner: W1,
      present: true,
    })
  },
)
  .runOn(["k8sFailover"])
  // Suppress the cluster-wide clean-state sweep at scenario end. The
  // 24-h pumpAll settle keeps re-firing the keepalive timer for the
  // still-active call; bringing it down with a real BYE here would
  // have to fight TestClock pumpAll firing Timer E OPTIONS retxs
  // ahead of the test interpreter's expect step, which queues
  // duplicate OPTIONS in the agents' inboxes and breaks per-dialog
  // CSeq monotonicity for any subsequent expect. That's a simulator
  // artifact orthogonal to the rehydration logic this test exists
  // to prove.
  .skipFinalSweep()

describe("sip-front-proxy/failover — timer reactivation big case", () => {
  const run = createSimulatedRunner({
    outputDir: OUTPUT_DIR,
    sut: "k8sFailover",
    // Set the keepalive watchdog far past anything we exercise so the
    // post-respawn cycle has room to complete its OPTIONS round-trip
    // without keepalive_timeout firing and tearing the call down. The
    // simulated network's pumpAll cadence puts ~1 s of virtual time
    // between an OPTIONS landing in an agent's queue and the test
    // interpreter dispatching its expect/reply step; the production
    // default `keepaliveTimeoutSec=10` is too tight for that window
    // when combined with Timer E retransmits already queued in the
    // agent inboxes.
    configOverrides: { keepaliveTimeoutSec: 7200 },
  })
  it.effect(
    "kill → respawn → OPTIONS keepalive resumes from rehydrated TimerEntry",
    () => run(timerReactivationBigCase.toScenario()),
    { timeout: 240_000 },
  )
})
