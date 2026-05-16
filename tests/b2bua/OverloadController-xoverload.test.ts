/**
 * OverloadController — X-Overload publish surface (slice 2 of overload rework).
 *
 * Pins:
 *   - `xOverloadHeaderValue()` returns the v=1 schema.
 *   - `incrementNonEmergencyAdmitted()` advances the `adm` counter.
 *   - The published `elu` / `gc` values reflect what `LoadSampler`
 *     observes (after EWMA convergence — driven by the 100ms sampler).
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { OverloadController } from "../../src/b2bua/OverloadController.js"
import { AppConfig, type AppConfigData } from "../../src/config/AppConfig.js"
import {
  LoadSamplerSimulatedControl,
  simulatedLayer as loadSamplerSimulatedLayer,
} from "../../src/observability/LoadSampler.js"
import { MetricsRegistry } from "../../src/observability/MetricsRegistry.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"

const cfg: AppConfigData = testAppConfigDefaults({
  sipLocalIp: "127.0.0.1",
  sipLocalPort: 5060,
})

// `provideMerge` keeps `LoadSamplerSimulatedControl` in the Out channel
// so the test body can yield it; `provide` would consume it.
const stackLayer = OverloadController.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(AppConfig, cfg),
      MetricsRegistry.layer,
      loadSamplerSimulatedLayer(),
    ),
  ),
)

describe("OverloadController — X-Overload publishing", () => {
  it.effect("header value follows v=1 schema with elu, gc, adm fields", () =>
    Effect.gen(function* () {
      const overload = yield* OverloadController
      const header = overload.xOverloadHeaderValue()
      // Schema check, not value check — EWMAs may be 0 if the sampler
      // hasn't fired yet. Format-only assertion.
      expect(header).toMatch(
        /^v=1; elu=\d+\.\d{3}; gc=\d+\.\d{3}; adm=\d+$/,
      )
    }).pipe(Effect.provide(stackLayer)),
  )

  it.effect("incrementNonEmergencyAdmitted advances adm counter in the header", () =>
    Effect.gen(function* () {
      const overload = yield* OverloadController
      const before = overload.xOverloadHeaderValue()
      const beforeAdm = parseAdm(before)
      overload.incrementNonEmergencyAdmitted()
      overload.incrementNonEmergencyAdmitted()
      overload.incrementNonEmergencyAdmitted()
      const after = overload.xOverloadHeaderValue()
      expect(parseAdm(after)).toBe(beforeAdm + 3)
      // metrics surface mirrors the counter
      expect(overload.metrics.nonEmergencyAdmittedTotal).toBe(beforeAdm + 3)
    }).pipe(Effect.provide(stackLayer)),
  )

  it.effect("metrics.eluEwma and gcFractionEwma start at 0 before the sampler fires", () =>
    Effect.gen(function* () {
      const overload = yield* OverloadController
      // Right after layer init the 100ms sampler hasn't fired yet under
      // the test runtime (TestClock-free unit test fires real time, but
      // this Effect.gen completes well under 100ms).
      expect(overload.metrics.eluEwma).toBe(0)
      expect(overload.metrics.gcFractionEwma).toBe(0)
    }).pipe(Effect.provide(stackLayer)),
  )

  // it.live: the sampler is a raw setInterval on the host clock — TestClock
  // does not advance it. This single test runs on real time so the sampler
  // gets a chance to read injected values.
  it.live("LoadSampler injection drives eluEwma once the sampler fires", () =>
    Effect.gen(function* () {
      const overload = yield* OverloadController
      const control = yield* LoadSamplerSimulatedControl
      control.setElu(0.8)
      control.setGcFraction(0.2)
      // Wait long enough for the 100ms setInterval sampler to fire at
      // least twice (alpha=0.2; convergence is partial, just assert > 0).
      yield* Effect.sleep("400 millis")
      expect(overload.metrics.eluEwma).toBeGreaterThan(0)
      expect(overload.metrics.gcFractionEwma).toBeGreaterThan(0)
      const header = overload.xOverloadHeaderValue()
      expect(header).toMatch(/^v=1; elu=\d+\.\d{3}; gc=\d+\.\d{3}; adm=\d+$/)
    }).pipe(Effect.provide(stackLayer)),
  )
})

function parseAdm(header: string): number {
  const m = /adm=(\d+)/.exec(header)
  if (!m) throw new Error(`no adm in header: ${header}`)
  return Number(m[1])
}
