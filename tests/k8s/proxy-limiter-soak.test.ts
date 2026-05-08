import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { FRONT_PROXY_VIP_TARGET } from "./fixtures/frontProxyTarget.js"
import { runSippJob } from "./fixtures/sippJob.js"

const NAMESPACE = process.env.K8S_TEST_NAMESPACE ?? "sip-test"

/**
 * Cluster-shared `CallLimiter` soak — proves the limiter actually
 * caps concurrent calls fleet-wide via the shared `LimiterRedisClient`.
 *
 * Setup:
 *   - sipp drives 10 cps, 10s ACK→BYE hold per call → steady state
 *     ~100 calls in flight after a 10s warmup.
 *   - The limiter directive (`X-Api-Call:
 *     {"action":"route","call_limiter":[{"id":"soak-test","limit":50}]}`)
 *     is embedded in the sipp INVITE template
 *     (`tests/k8s/charts/sipp/scenarios/uac-limiter-soak.xml`). Both
 *     b2bua-worker pods see the same limiter id and write to the
 *     cluster-shared Redis (`tests/k8s/charts/redis/`,
 *     `LIMITER_REDIS_URL=redis://redis:6379`).
 *   - Steady-state expectation: ~50 of every ~100 in-flight INVITEs
 *     are accepted, ~50 rejected with 486. Across the ~20-minute
 *     soak this lands the rejection ratio (failed / created) in the
 *     `[0.35, 0.65]` range. Looser than 50/50 because:
 *       * The first 10s warmup admits more than 50% (counter starts
 *         at 0).
 *       * BYE/ACK timing slop produces ±10% windows.
 *
 * If the limiter were per-pod (the bug fixed by `LimiterRedisClient`),
 * each worker would independently allow up to 50 concurrent calls →
 * effective fleet limit ~100, and at 100 in-flight the rejection
 * ratio would collapse toward 0.
 *
 * Tier: nightly only. ~20 minutes wall-time. Run via the
 * `test:k8s:nightly` npm script (which `test:nightly` includes).
 *
 * Sampling: rejection ratio is checked at the end against the global
 * cumulative counters (sipp's "Successful call" / "Failed call"). The
 * per-minute sampling discussed in the plan is left for a future
 * iteration if intra-soak drift becomes interesting; the end-state
 * ratio is enough to catch the per-pod-counter regression.
 */
describe("k8s/proxy-limiter-soak — cluster-shared CallLimiter under sustained load", () => {
  it.live(
    "rejection ratio stays in [0.35, 0.65] when 100 in-flight collide with limit=50",
    () =>
      Effect.gen(function* () {
        // 10 cps × 1200s = 12,000 calls. waitTimeoutSec covers the
        // generation window plus the longest-call drain (10s hold +
        // BYE retrans worst case ~32s) plus slack.
        const TOTAL_CALLS = 12_000
        const CPS = 10
        const SOAK_SECONDS = TOTAL_CALLS / CPS // 1200s = 20 minutes
        const TIMEOUT_SECONDS = SOAK_SECONDS + 90 // hold + BYE retrans + slack

        const stamp = Date.now().toString(36)
        const jobName = `limiter-soak-${stamp}`

        const result = yield* runSippJob({
          namespace: NAMESPACE,
          name: jobName,
          scenario: "uac-limiter-soak.xml",
          target: FRONT_PROXY_VIP_TARGET,
          service: "test",
          calls: TOTAL_CALLS,
          callsPerSecond: CPS,
          timeoutSec: TIMEOUT_SECONDS,
          waitTimeoutSec: TIMEOUT_SECONDS + 60,
        })

        const { successful, failed, created } = result.stats
        // sanity: sipp actually generated the load
        expect(created).toBeGreaterThanOrEqual(TOTAL_CALLS - 50)

        const completed = successful + failed
        expect(completed).toBeGreaterThan(TOTAL_CALLS * 0.95)

        const rejectionRatio = failed / completed
        // The actual assertion: limit=50 against ~100 in-flight should
        // reject roughly half. A per-pod-counter bug would collapse
        // this to ~0; an excess-rejection bug would push it toward 1.
        expect(rejectionRatio).toBeGreaterThan(0.35)
        expect(rejectionRatio).toBeLessThan(0.65)
      }),
    // 25 minutes — soak is 20m + ramp-down + sipp Job teardown.
    { timeout: 25 * 60 * 1000 },
  )
})
