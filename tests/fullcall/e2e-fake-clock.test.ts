/**
 * E2E test suite — fake clock (TestClock) variants.
 *
 * All tests in this file run under @effect/vitest's TestClock so virtual
 * time is advanced by `pause()` steps. The B2BUA runs in-process inside
 * the same Effect runtime and shares the same TestClock — pauses become
 * effectively instant.
 *
 * If a scenario needs real wall-clock behaviour (live UDP, real Redis
 * timing windows, peer-to-peer agents) put it in `e2e-real-clock.test.ts`.
 *
 * Test selection is barrel-driven: every `ComposableScenario` exported
 * from `../scenarios/index.js` becomes a test. Title and SUT applicability
 * come from the scenario itself (`.title(...)`, `.runOn(...)`). Per-test
 * config overrides (custom timeout, custom runner options) live in
 * `OVERRIDES` below, keyed by scenario canonical name.
 */

import { describe, it } from "@effect/vitest"
import { afterAll } from "vitest"
import * as Scenarios from "../scenarios/index.js"
import { ComposableScenario } from "../../src/test-harness/framework/dsl.js"
import {
  createSimulatedRunner,
  expectCdrCount,
  flushIndexReport,
  skipCdrCheck,
} from "../support/harness.js"
import { ALL_SUTS } from "../../src/test-harness/framework/types.js"

// ── Per-scenario CDR-check overrides ────────────────────────────────────────
expectCdrCount("suppress-18x-failover-reject", 1)
expectCdrCount("two-calls-routed-to-two-workers", 2)
expectCdrCount("ha-keepalive-happy", 2)
expectCdrCount("ha-keepalive-timeout", 2)

skipCdrCheck("register-happy-path")
skipCdrCheck("deregister-via-expires-zero")
skipCdrCheck("ttl-expiry-under-testclock")
skipCdrCheck("ext-call-to-core-destination")
skipCdrCheck("core-call-to-registered-ext")

// ── Per-scenario test-runner overrides ──────────────────────────────────────
// Keyed by scenario.name (kebab-case canonical id). Defaults: 30s timeout,
// default runner (no extra opts). Only list scenarios that need to deviate.

interface Override {
  readonly timeout?: number
  readonly simulateMissingOutboundProxy?: boolean
}

const OVERRIDES: Record<string, Override> = {
  "two-calls-routed-to-two-workers": { timeout: 60_000 },
  "ha-keepalive-happy": { timeout: 120_000 },
  "ha-keepalive-timeout": { timeout: 120_000 },
  "ttl-expiry-under-testclock": { timeout: 60_000 },
  "keepalive-missing-outbound-proxy-regression-guard": {
    simulateMissingOutboundProxy: true,
  },
}

const OUTPUT_DIR = "test-results/fake-clock"

afterAll(() => {
  flushIndexReport(OUTPUT_DIR)
  for (const sut of ALL_SUTS) {
    flushIndexReport(`${OUTPUT_DIR}/${sut}`)
  }
})

// Scenarios that opt into this test file via `.title(...)`. Scenarios
// without a title belong to other test files (e2e-real-clock, sip-front-
// proxy failover suite, k8s smoke, etc.) and are skipped here.
const FAKE_CLOCK_SCENARIOS: ReadonlyArray<ComposableScenario> = Object.values(Scenarios).filter(
  (v): v is ComposableScenario => v instanceof ComposableScenario && v.displayTitle !== undefined,
)

for (const sut of ALL_SUTS) {
  describe(`E2E (fake clock) — ${sut}`, () => {
    const defaultRun = createSimulatedRunner({ outputDir: OUTPUT_DIR, sut })

    for (const sc of FAKE_CLOCK_SCENARIOS) {
      if (!sc.appliesTo(sut)) continue

      const override = OVERRIDES[sc.name] ?? {}
      const timeout = override.timeout ?? 30_000

      const run = override.simulateMissingOutboundProxy
        ? createSimulatedRunner({
            outputDir: OUTPUT_DIR,
            sut,
            simulateMissingOutboundProxy: true,
          })
        : defaultRun

      it.effect(sc.displayTitle!, () => run(sc.toScenario()), { timeout })
    }
  })
}
