/**
 * Limiter TTL leak budget when the primary is permanently dead.
 *
 * Sequence:
 *   1. Limit=1, `LIMITER_WINDOW_SECONDS=120`, `limiterTtlSeconds=120`.
 *      A 2-minute window is realistic — long enough to exceed any
 *      plausible call-establishment timer, short enough to keep the
 *      test fast under TestClock.
 *   2. Call A → b2b-1 → accepted, counter=1.
 *   3. `cluster.kill(W1)` permanently. No BYE arrives, no respawn —
 *      the counter is leaked.
 *   4. Advance TestClock by ~125 seconds (one full window + slack).
 *      The shared limiter store sweeps expired entries on every
 *      check; the next `checkAndIncrement` sees an empty bucket.
 *   5. Call B → b2b-2 → accepted (counter recovered to 0 via TTL).
 *
 * What this documents: the worst-case capacity-recovery budget. If
 * `LIMITER_WINDOW_SECONDS` or `limiterTtlSeconds` is changed and the
 * sweep no longer fires inside the window, this test fails — flagging
 * a regression that would otherwise leak slots indefinitely after a
 * crash with no peer takeover.
 *
 * In production (`LimiterRedisClient`) the same recovery happens via
 * Redis key TTLs configured to the same window/TTL constants.
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

// Only Call B terminates cleanly; Call A is killed mid-call without a
// graceful BYE.
expectCdrCount("limiter-ttl-leak-budget", 1)

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
  call_limiter: [{ id: "ttl-leak", limit: 1 }],
})

const limiterRouteToBob2 = JSON.stringify({
  action: "route",
  destination: { host: BOB_HOST_2, port: BOB_PORT },
  new_ruri: `sip:bob@${BOB_HOST_2}:${BOB_PORT}`,
  call_limiter: [{ id: "ttl-leak", limit: 1 }],
})

const ttlLeakScenario = scenario("limiter-ttl-leak-budget", (s) => {
  s.pause(25_000) // OPTIONS settle + LB fresh-pod-guard

  // ── Call A — alice-1 → b2b-1, slot consumed ─────────────────────
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

  const { transaction: alice1InviteTxn } = alice1.invite(
    `sip:+1234@${K8S_PROXY_ADDR.host}:${K8S_PROXY_ADDR.port}`,
    { body: sdpOffer(), headers: { "X-Api-Call": limiterRouteToBob1 } },
  )
  alice1InviteTxn.expect(100)
  const { transaction: bob1InviteTxn } = bob1.receiveInitialInvite()
  bob1InviteTxn.reply(180)
  alice1InviteTxn.expect(180)
  bob1InviteTxn.reply(200, { body: sdpAnswer() })
  alice1InviteTxn.expect(200)
  alice1.invite // (suppress unused — alice1Dialog not needed; call is killed)

  s.pause(50)

  // ── Permanently kill primary, no BYE, no respawn ───────────────
  s.cluster.kill(W1)

  // ── Advance past the window so Redis TTL fires ─────────────────
  // 125s = 120s window + 5s slack. The in-memory limiter sweeps
  // expired entries on every read; the shared Redis variant relies
  // on per-key TTL set to `limiterTtlSeconds`.
  s.pause(125_000)

  // ── Call B — must be accepted because counter is TTL-cleared ───
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

  const { dialog: alice2Dialog, transaction: alice2InviteTxn } = alice2.invite(
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

  // Drain so terminate → write-cdr → remove-call all fire before
  // scope close (we use .skipFinalSweep below).
  s.pause(200)
})
  .runOn(["k8sFailover"])
  .skipFinalSweep()

describe("sip-front-proxy/failover — limiter-ttl-leak-budget", () => {
  // 2-minute window/TTL — realistic but bounded so TestClock advances
  // to ~125s of virtual time without the test costing real wall time.
  const run = createSimulatedRunner({
    outputDir: OUTPUT_DIR,
    sut: "k8sFailover",
    configOverrides: {
      limiterWindowSeconds: 120,
      limiterActiveWindows: 1,
      limiterTtlSeconds: 120,
    },
  })
  it.effect(
    "leaked limiter slot recovers via TTL when primary is permanently dead",
    () => run(ttlLeakScenario.toScenario()),
    { timeout: 120_000 },
  )
})
