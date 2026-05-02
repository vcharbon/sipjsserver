/**
 * E2E test suite — real wall-clock variants.
 *
 * These tests use real `Effect.sleep` (it.live) and depend on actual
 * elapsed time. Reasons a scenario lives here rather than in
 * `e2e-fake-clock.test.ts`:
 *   - it talks to peers over real UDP (peer-to-peer self-tests, live B2BUA)
 *   - it relies on Redis-driven timing windows the test runtime cannot
 *     virtualise (call limiter sliding windows, keepalive intervals)
 *
 * Anything that can run under TestClock should be in the fake-clock file.
 */

import { describe, it } from "@effect/vitest"
import { afterAll } from "vitest"
import type { ScenarioTier } from "../../src/test-harness/framework/types.js"
import { basicCall } from "../scenarios/basic-call.js"
import { callReject } from "../scenarios/call-reject.js"
import { cancelCall } from "../scenarios/cancel.js"
import { prackCall } from "../scenarios/prack.js"
import { prackForkingCall } from "../scenarios/prack-forking.js"
import { cancelCrossing200Ok } from "../scenarios/cancel-200ok-crossing.js"
import { callerHangup, calleeHangup } from "../scenarios/bye-directions.js"
import { optionsKeepaliveTimeout } from "../scenarios/options-keepalive-timeout.js"
import { limiterRejection } from "../scenarios/limiter-rejection.js"
import { limiterCancel } from "../scenarios/limiter-cancel.js"
import { failoverReroute } from "../scenarios/failover-reroute.js"
import {
  createSimulatedRunner,
  createLiveRunner,
  createPeerToPeerRunner,
  flushIndexReport,
} from "../support/harness.js"

const OUTPUT_DIR = "test-results/real-clock"
import {
  p2pDirectCall,
  ALICE_PORT as P2P_ALICE_PORT,
  BOB_PORT as P2P_BOB_PORT,
} from "../scenarios/p2p-direct-call.js"
import {
  p2pExtraMessage,
  ALICE_PORT as P2P_X_ALICE_PORT,
  BOB_PORT as P2P_X_BOB_PORT,
} from "../scenarios/p2p-extra-message.js"

afterAll(() => flushIndexReport(OUTPUT_DIR))

// ---------------------------------------------------------------------------
// Tier gating — see vitest.config.live.ts for the tier rank semantics.
// ---------------------------------------------------------------------------

const tierRank: Record<ScenarioTier, number> = { short: 0, medium: 1, long: 2 }
const configuredTier = (process.env.TEST_TIER ?? "short") as ScenarioTier
const includeTier = (t: ScenarioTier): boolean =>
  tierRank[t] <= (tierRank[configuredTier] ?? 0)

// ---------------------------------------------------------------------------
// Simulated backend tests — short keepalive (separate B2BUA instance)
// ---------------------------------------------------------------------------

describe.skipIf(!includeTier("medium"))("E2E (real clock) — simulated backend (keepalive)", () => {
  const run = createSimulatedRunner({
    sipPort: 15070,
    httpPort: 13012,
    realClock: true,
    outputDir: OUTPUT_DIR,
    configOverrides: {
      keepaliveIntervalSec: 3,
      keepaliveTimeoutSec: 2,
    },
  })

  it.live("OPTIONS keepalive timeout → BYE", () => run(optionsKeepaliveTimeout.toScenario()), { timeout: 30_000 })
})

// ---------------------------------------------------------------------------
// Simulated backend tests — call limiter (separate B2BUA instance)
// ---------------------------------------------------------------------------

describe("E2E (real clock) — simulated backend (limiter)", () => {
  const run = createSimulatedRunner({
    sipPort: 15080,
    httpPort: 13022,
    realClock: true,
    outputDir: OUTPUT_DIR,
  })

  it.live("limiter rejection (parallel calls)", () => run(limiterRejection.toScenario()), { timeout: 30_000 })
  it.live("limiter cancel (early dialog + re-accept)", () => run(limiterCancel.toScenario()), { timeout: 30_000 })
  it.live("failover reroute (b-leg reject → backup)", () => run(failoverReroute.toScenario()), { timeout: 30_000 })
})

// ---------------------------------------------------------------------------
// Peer-to-peer framework self-tests (no B2BUA, alice <-> bob direct UDP)
// ---------------------------------------------------------------------------

describe("E2E (real clock) — peer-to-peer framework self-test", () => {
  const runDirect = createPeerToPeerRunner({
    peers: {
      alice: { host: "127.0.0.1", port: P2P_BOB_PORT },
      bob: { host: "127.0.0.1", port: P2P_ALICE_PORT },
    },
    outputDir: OUTPUT_DIR,
  })

  it.live("p2p direct basic call", () => runDirect(p2pDirectCall.toScenario()), {
    timeout: 30_000,
  })

  const runExtra = createPeerToPeerRunner({
    peers: {
      alice: { host: "127.0.0.1", port: P2P_X_BOB_PORT },
      bob: { host: "127.0.0.1", port: P2P_X_ALICE_PORT },
    },
    expectFailure: true,
    outputDir: OUTPUT_DIR,
  })

  it.live("p2p extra message is flagged as unexpected (negative)", () =>
    runExtra(p2pExtraMessage.toScenario()), { timeout: 30_000 })
})

// ---------------------------------------------------------------------------
// Live backend tests (require running B2BUA + Redis)
// ---------------------------------------------------------------------------

const LIVE_ENABLED = process.env.E2E_LIVE === "1"

describe.skipIf(!LIVE_ENABLED)("E2E (real clock) — live UDP backend", () => {
  const b2buaHost = process.env.E2E_B2BUA_HOST ?? "127.0.0.1"
  const b2buaPort = parseInt(process.env.E2E_B2BUA_PORT ?? "5060", 10)
  const run = createLiveRunner({ b2buaHost, b2buaPort, outputDir: OUTPUT_DIR })

  it.live("basic call", () => run(basicCall.toScenario()), { timeout: 30_000 })
  it.live("call rejection (403)", () => run(callReject.toScenario()), { timeout: 30_000 })
  it.live("CANCEL during early dialog", () => run(cancelCall.toScenario()), { timeout: 30_000 })
  it.live.skip("CANCEL ↔ 200 OK crossing", () => run(cancelCrossing200Ok.toScenario()), { timeout: 30_000 })
  it.live("PRACK flow", () => run(prackCall.toScenario()), { timeout: 30_000 })
  it.live("PRACK forking flow", () => run(prackForkingCall.toScenario()), { timeout: 30_000 })
  it.live("caller hangup (composed)", () => run(callerHangup.toScenario()), { timeout: 30_000 })
  it.live("callee hangup (composed)", () => run(calleeHangup.toScenario()), { timeout: 30_000 })
})
