/**
 * Mid-ring primary kill — closes the establishment-window gap that
 * `basic-call-primary-killed.test.ts` does not cover.
 *
 * KNOWN FAILING (intentional — see docs/plan/crash-of-b2b-during-
 * drifting-lemur.md "Diagnostic outcome"). Marked `describe.skip` so CI
 * stays green; run manually with `npx vitest --config vitest.config.fake.ts
 * run tests/sip-front-proxy/failover/mid-ring-primary-killed.test.ts`.
 *
 * The sibling post-ACK test kills the primary after the call is fully
 * established and asserts the in-dialog BYE survives. This test puts a
 * 10s ring between 180 Ringing and 200 OK, kills the primary at the 5s
 * mark, then asserts the call still completes end-to-end.
 *
 * Pass criterion (success-required): alice receives 200 OK to her
 * INVITE, ACK reaches bob, BYE round-trip terminates the call cleanly,
 * proxy promoted to `decode_forward_backup`, single-owner invariant
 * intact.
 *
 * Diagnostic outcome (2026-05-17): replication is adequate — the
 * pre-kill `expectReplicatedTo(W2, …)` passes, proving the early-dialog
 * frame did land on the backup. The failure mode is downstream: bob's
 * 200 OK is sent to the (now dead) b2b-1, and the proxy does not sit
 * between b2b and bob — there is no recovery path for bob's in-flight
 * UAS transaction. Alice's INVITE Timer B eventually fires. Closing
 * this gap is a b-leg-failover problem, not a replication-level
 * problem; the L0..L3 ladder parked in the plan would not help.
 */

import { describe, it } from "@effect/vitest"
import { afterAll } from "vitest"
import { scenario } from "../../../src/test-harness/framework/dsl.js"
import { K8S_PROXY_ADDR, k8sWorkerId } from "../../support/k8sFakeStack.js"
import { CALLID_TO_W1 } from "../../scenarios/ha/two-calls-routed-to-two-workers.js"
import { basicCallBody } from "../../scenarios/basic-call.js"
import {
  createSimulatedRunner,
  expectCdrCount,
  flushIndexReport,
} from "../../support/harness.js"

// Single call from alice → b2b-1 (killed mid-ring) → b2b-2 (backup) → 1 CDR.
expectCdrCount("mid-ring-primary-killed", 1)

const OUTPUT_DIR = "test-results/failover"

afterAll(() => {
  flushIndexReport(OUTPUT_DIR)
})

const ALICE_HOST = "10.30.0.1"
const BOB_HOST = "10.40.0.1"
const BOB_PORT = 5060

const W1 = k8sWorkerId(1) as unknown as string // "b2b-1" — pre-computed HRW winner for CALLID_TO_W1
const W2 = k8sWorkerId(2) as unknown as string // "b2b-2" — backup for the same Call-ID

const midRingKilledScenario = scenario("mid-ring-primary-killed", (s) => {
  // Same OPTIONS keepalive + LB fresh-pod guard settle as the post-ACK
  // failover test: 25s clears both windows so the post-kill BYE routing
  // is driven by registry health alone.
  s.pause(25_000)

  basicCallBody(s, {
    aliceName: "alice",
    bobName: "bob",
    aliceHost: ALICE_HOST,
    bobHost: BOB_HOST,
    bobPort: BOB_PORT,
    proxyHost: K8S_PROXY_ADDR.host,
    proxyPort: K8S_PROXY_ADDR.port,
    callId: CALLID_TO_W1,
    byeFrom: "alice",
    ringMs: 10_000,
    killSpec: {
      atRingOffsetMs: 5_000,
      worker: W1,
      beforeKill: (sc) => {
        // 5s of virtual time is ample for the puller to drain the
        // early-dialog frame: REPL_PULL_MAX_OPEN_MS +
        // REPL_PULL_RECONNECT_GAP_MS ≈ 250ms, so by t+5s the b-leg's
        // 180 has been replicated to `bak:b2b-1:` on b2b-2.
        sc.cluster.expectCallStateOn(W1, { partition: "pri", owner: W1 })
        sc.cluster.expectReplicatedTo(W2, { primary: W1 })
        // Pre-kill: backup MUST NOT have moved the call into its own
        // pri: (single-owner invariant, docs/replication/call-cache-
        // backup.md §0).
        sc.cluster.expectCallStateOn(W2, {
          partition: "pri",
          owner: W2,
          present: false,
        })
      },
      afterKill: (sc) => {
        // Let the multi-phase kill pipeline (drain → disconnect →
        // registry → fabric) settle before bob's 200 OK arrives at
        // what is now a corpse. The remaining ringMs pause comes
        // from basicCallBody after this hook returns.
        sc.pause(50)
      },
    },
  })

  // Post-call assertions: the BYE was promoted from `decode_forward` to
  // `decode_forward_backup` (cookie's primary was dead), and the backup
  // never moved the call into its own pri: partition.
  s.cluster.expectRoutedTo(W2, { decision: "decode_forward_backup" })
  s.cluster.expectCallStateOn(W2, {
    partition: "pri",
    owner: W2,
    present: false,
  })
})
  .runOn(["k8sFailover"])
  // Same rationale as basic-call-primary-killed: OPTIONS keepalive runs
  // every 2s on both workers; a 24h post-scenario sweep would amplify
  // any transient binding-unavailable window into noise.
  .skipFinalSweep()

describe("sip-front-proxy/failover — mid-ring-primary-killed", () => {
  const run = createSimulatedRunner({
    outputDir: OUTPUT_DIR,
    sut: "k8sFailover",
  })
  it.effect(
    "primary killed mid-ring → call completes via backup",
    () => run(midRingKilledScenario.toScenario()),
    { timeout: 120_000 },
  )
})
