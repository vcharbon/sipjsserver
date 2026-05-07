/**
 * Slice B′ — Fake-clock diagnostic mini-test for the event-5
 * replication-gap shape from the 2 h K8s endurance run.
 *
 * Reproduces the 127-calls × 481-BYE failure shape under TestClock
 * with absolute timing control. Strict acceptance: zero 481s on BYE
 * for any call established before the kill.
 *
 * Phases:
 *   1. Establish 20 calls (`diag-call-0..19@alice`) — natural
 *      rendezvous-hash distribution between b2b-1 and b2b-2.
 *   2. Settle 25 s — clears the LB fresh-pod-guard window AND lets
 *      ReplPuller drain `propagate:{peer}` on both directions. Assert
 *      lag-zero across every (producer, consumer) edge.
 *   3. Kill b2b-1 + 5 s pause for HealthProbe to flip it to `dead`.
 *   4. Establish 20 more calls (`diag-call-20..39@alice`) — all land
 *      on b2b-2 (rendezvous picks among `alive` only).
 *   5. First BYE batch: 10 phase-1 calls + 10 phase-4 calls.
 *      Phase-1 calls whose primary was b2b-1 traverse
 *      `decode_forward_backup` to b2b-2 which checks out from
 *      `bak:b2b-1:`. Acceptance: every BYE returns 200.
 *   6. Respawn b2b-1 + settle 25 s — covers ReadyGate's reverse
 *      drain + freshPodGuard window. b2b-1 hydrates its
 *      `pri:b2b-1:` from b2b-2's `bak:b2b-1:` over the ReadyGate
 *      path.
 *   7. Second BYE batch: 10 phase-1 calls + 10 phase-4 calls.
 *      Phase-1 calls whose primary was b2b-1 route back to b2b-1
 *      (it's `alive` again, post-fresh-pod-guard); b2b-1 should
 *      have hydrated state from the ReadyGate drain.
 *
 * The lag-zero assertion is implemented in the framework as a new
 * `expectLagSeqZero` K8s step (interpreter inspects each peer's
 * `replpos:*` and `propagate_seq:*` keys directly; ReplMetrics is
 * not wired in the fake stack so the slice-A snapshot would be
 * empty here).
 */

import { describe, it } from "@effect/vitest"
import { afterAll } from "vitest"
import { scenario } from "../../../src/test-harness/framework/dsl.js"
import {
  K8S_PROXY_ADDR,
  k8sWorkerId,
} from "../../support/k8sFakeStack.js"
import {
  createSimulatedRunner,
  expectCdrCount,
  flushIndexReport,
} from "../../support/harness.js"
import {
  byeCallBody,
  establishCallBody,
  type EstablishedCall,
} from "../../scenarios/basic-call.js"

const N_PHASE1 = 20
const N_PHASE4 = 20
const TOTAL_CALLS = N_PHASE1 + N_PHASE4

expectCdrCount("replication-gap-mini", TOTAL_CALLS)

const OUTPUT_DIR = "test-results/failover"

afterAll(() => {
  flushIndexReport(OUTPUT_DIR)
})

const ALICE_HOST_BASE = "10.30"
const BOB_HOST_BASE = "10.40"
const BOB_PORT = 5060

const W1 = k8sWorkerId(1) as unknown as string
const W2 = k8sWorkerId(2) as unknown as string

// Encode the call index into the alice/bob IPs so each call lives on
// its own simulated UDP endpoint pair. 20 calls per phase fits in a
// /24 subnet trivially; we use the second octet to separate phase 1
// (.1.x) from phase 4 (.2.x) for trace readability.
const aliceIp = (phase: 1 | 4, index: number): string =>
  `${ALICE_HOST_BASE}.${phase}.${index + 1}`
const bobIp = (phase: 1 | 4, index: number): string =>
  `${BOB_HOST_BASE}.${phase}.${index + 1}`

const replicationGapMini = scenario("replication-gap-mini", (s) => {
  // 25 s settle clears the freshPodGuard window AND gives HealthProbe
  // ≥ 2 ticks per worker to flip both from `unknown` → `alive`.
  s.pause(25_000)

  // ── Phase 1: establish 20 calls — natural HRW distribution ────────
  const phase1: EstablishedCall[] = []
  for (let i = 0; i < N_PHASE1; i++) {
    phase1.push(
      establishCallBody(s, {
        aliceName: `alice-p1-${i}`,
        bobName: `bob-p1-${i}`,
        aliceHost: aliceIp(1, i),
        bobHost: bobIp(1, i),
        bobPort: BOB_PORT,
        proxyHost: K8S_PROXY_ADDR.host,
        proxyPort: K8S_PROXY_ADDR.port,
        callId: `diag-call-${i}@alice`,
      })
    )
  }

  // ── Phase 2: replication settle ──────────────────────────────────
  // 5 s of virtual time — ReplPuller's per-cycle latency is
  // ~250 ms (REPL_PULL_MAX_OPEN_MS + reconnect gap), so 5 s gives
  // ample slack for both directions of `propagate:*` to drain.
  s.pause(5_000)
  s.cluster.expectLagSeqZero([W1, W2])

  // ── Phase 3: kill b2b-1 ──────────────────────────────────────────
  s.cluster.kill(W1)
  // 5 s for HealthProbe to see ≥ 2 misses on b2b-1 → registry "dead".
  s.pause(5_000)

  // ── Phase 4: establish 20 more calls — all land on b2b-2 ─────────
  const phase4: EstablishedCall[] = []
  for (let i = 0; i < N_PHASE4; i++) {
    phase4.push(
      establishCallBody(s, {
        aliceName: `alice-p4-${i}`,
        bobName: `bob-p4-${i}`,
        aliceHost: aliceIp(4, i),
        bobHost: bobIp(4, i),
        bobPort: BOB_PORT,
        proxyHost: K8S_PROXY_ADDR.host,
        proxyPort: K8S_PROXY_ADDR.port,
        callId: `diag-call-${N_PHASE1 + i}@alice`,
      })
    )
  }

  // ── Phase 5: first BYE batch — 10 phase-1 + 10 phase-4 ───────────
  for (let i = 0; i < 10; i++) {
    byeCallBody(phase1[i]!, { byeFrom: "alice" })
  }
  for (let i = 0; i < 10; i++) {
    byeCallBody(phase4[i]!, { byeFrom: "alice" })
  }
  // Drain b-leg 200 OKs so write-cdr fires before the next phase.
  s.pause(1_000)

  // ── Phase 6: respawn b2b-1 + settle ──────────────────────────────
  s.cluster.respawn(W1)
  // 25 s settle covers HealthProbe (un -> alive after first
  // OPTIONS round-trip ≈ 1 s) AND the freshPodGuard window
  // (default 20 s past `firstSeenAtMs`, auto-stamped on respawn).
  s.pause(25_000)

  // After respawn b2b-1 should have rebuilt `pri:b2b-1:` from
  // b2b-2's reverse-propagate over ReadyGate. Lag should be back to
  // zero on both directions. (If this fires, ReadyGate's drain on
  // respawn didn't catch up — same diagnostic signal as Slice C.)
  s.cluster.expectLagSeqZero([W1, W2])

  // ── Phase 7: second BYE batch — 10 phase-1 + 10 phase-4 ──────────
  for (let i = 10; i < N_PHASE1; i++) {
    byeCallBody(phase1[i]!, { byeFrom: "alice" })
  }
  for (let i = 10; i < N_PHASE4; i++) {
    byeCallBody(phase4[i]!, { byeFrom: "alice" })
  }
  // Drain remaining b-leg 200 OKs so every call reaches "terminated"
  // and write-cdr fires before scope close.
  s.pause(1_000)
})
  .runOn(["k8sFailover"])
  .skipFinalSweep()

describe("sip-front-proxy/failover — replication-gap-mini", () => {
  const run = createSimulatedRunner({
    outputDir: OUTPUT_DIR,
    sut: "k8sFailover",
  })
  // Strict acceptance gate: "zero 481 on BYE for any call established
  // before the kill". Phase 7's quiet-call recovery flows through the
  // ReclaimRunner safety net wired in on respawn — without it those
  // 20 BYEs would all return 481 (the bug Slice B′ originally surfaced).
  it.effect(
    "40 calls × kill + respawn — zero 481 on BYE, lag_seq=0 at settle",
    () => run(replicationGapMini.toScenario()),
    { timeout: 300_000 },
  )
})
