/**
 * Cross-worker limiter rejection — proves the shared-limiter wiring.
 *
 * Two INVITEs use pre-computed Call-IDs that HRW-route to distinct
 * workers (`CALLID_TO_W1` → b2b-1, `CALLID_TO_W2` → b2b-2). With a
 * limiter `{ id, limit: 1 }`, the first call must be accepted and the
 * second must be rejected with 486 Busy Here — *only* if the limiter is
 * truly shared across both workers' counter stores. Without the shared
 * `CallLimiter.sharedMemoryLayer(map)` injected at SUT scope, each
 * worker holds its own `MutableHashMap` and the second INVITE would be
 * wrongly accepted (each worker's local counter is still 0).
 *
 * This is the fake-clock mirror of the production cluster-shared
 * `LimiterRedisClient` — see `docs/replication/call-cache-backup.md`
 * for the sidecar-vs-shared rationale.
 */

import { describe, it } from "@effect/vitest"
import { afterAll } from "vitest"
import { scenario } from "../../../src/test-harness/framework/dsl.js"
import { K8S_PROXY_ADDR } from "../../support/k8sFakeStack.js"
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

// Accepted call → 1 CDR; rejected call (486) does not produce a CDR.
expectCdrCount("limiter-shared-cross-worker-rejection", 1)

const OUTPUT_DIR = "test-results/failover"

afterAll(() => {
  flushIndexReport(OUTPUT_DIR)
})

const ALICE_HOST_1 = "10.30.0.1"
const ALICE_HOST_2 = "10.30.0.2"
const BOB_HOST = "10.40.0.1"
const BOB_PORT = 5060

const limiterInstruction = JSON.stringify({
  action: "route",
  destination: { host: BOB_HOST, port: BOB_PORT },
  new_ruri: `sip:bob@${BOB_HOST}:${BOB_PORT}`,
  call_limiter: [{ id: "shared-cross-worker", limit: 1 }],
})

const sharedLimiterScenario = scenario(
  "limiter-shared-cross-worker-rejection",
  (s) => {
    // OPTIONS keepalive needs ~2 ticks (≥ 4s) per worker to flip both
    // from `unknown` → `alive`. The LB fresh-pod guard defaults to
    // 20_000ms past `firstSeenAtMs`. 25s clears both windows.
    s.pause(25_000)

    // ── Call 1 — alice-1 → b2b-1 (slot consumed) ───────────────────
    const alice1 = s.agent("alice-1", {
      uri: "sip:alice-1@test",
      ip: ALICE_HOST_1,
      callId: CALLID_TO_W1,
    })
    const bob1 = s.agent("bob-1", {
      uri: "sip:bob-1@test",
      ip: BOB_HOST,
      port: BOB_PORT,
    })

    const { dialog: alice1Dialog, transaction: alice1InviteTxn } =
      alice1.invite(
        `sip:+1234@${K8S_PROXY_ADDR.host}:${K8S_PROXY_ADDR.port}`,
        { body: sdpOffer(), headers: { "X-Api-Call": limiterInstruction } },
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

    // Brief pause so the call is firmly established (slot still held).
    s.pause(100)

    // ── Call 2 — alice-2 → b2b-2 (must be rejected) ────────────────
    // This is the crux: the limiter slot was incremented on b2b-1, but
    // alice-2's INVITE lands on b2b-2. Because the SUT injects the
    // SAME `CallLimiter.sharedMemoryLayer(store)` into both workers,
    // b2b-2's checkAndIncrement sees count=1 and returns -1 → 486.
    const alice2 = s.agent("alice-2", {
      uri: "sip:alice-2@test",
      ip: ALICE_HOST_2,
      callId: CALLID_TO_W2,
    })

    const { dialog: alice2Dialog, transaction: alice2InviteTxn } =
      alice2.invite(
        `sip:+1234@${K8S_PROXY_ADDR.host}:${K8S_PROXY_ADDR.port}`,
        {
          body: sdpOffer(),
          headers: { "X-Api-Call": limiterInstruction },
          skipValidation: ["offerAnswer"],
        },
      )
    alice2InviteTxn.expect(100)
    alice2InviteTxn.expect(486, {
      predicate: (msg) =>
        msg.type === "response" && msg.reason === "Busy Here",
    })
    alice2Dialog.ack()

    // ── Cleanup — release the slot before scenario teardown ────────
    s.pause(100)
    const alice1ByeTxn = alice1Dialog.bye()
    const bob1ByeTxn = bob1Dialog.expect("BYE")
    bob1ByeTxn.reply(200)
    alice1ByeTxn.expect(200)
  },
)
  .runOn(["k8sFailover"])
  .skipFinalSweep()

describe("sip-front-proxy/failover — limiter-shared-cross-worker-rejection", () => {
  const run = createSimulatedRunner({
    outputDir: OUTPUT_DIR,
    sut: "k8sFailover",
  })
  it.effect(
    "second INVITE on a different worker is rejected because the limiter is cluster-shared",
    () => run(sharedLimiterScenario.toScenario()),
    { timeout: 120_000 },
  )
})
