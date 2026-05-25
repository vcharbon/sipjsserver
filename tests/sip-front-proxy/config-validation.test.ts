/**
 * Validation of cross-component proxy config invariants.
 *
 * The headline check is the 2026-05-25 RCA: `payloadStaleMs` shorter than
 * `2 × (intervalMs + timeoutMs)` causes `sweepStale` to floor the AIMD cap
 * within ~20 seconds of uptime. These tests pin both the happy path and
 * each rejection reason so a future relaxation has to be a deliberate edit.
 */

import { describe, test, expect } from "vitest"
import {
  validateProxyConfig,
  assertValidProxyConfig,
  type ProbeTimingConfig,
} from "../../src/sip-front-proxy/config-validation.js"
import {
  defaultWorkerLoadObserverConfig,
  type WorkerLoadObserverConfigData,
} from "../../src/sip-front-proxy/WorkerLoadObserver.js"

// The Helm chart's current production-shape probe timings. Acts as the
// canonical "real deployment" fixture — if this test breaks because the
// chart changes its defaults, that's the signal to revisit calibration.
const HELM_PROBE: ProbeTimingConfig = { intervalMs: 2000, timeoutMs: 1500 }

const withObserver = (
  overrides: Partial<WorkerLoadObserverConfigData>,
): WorkerLoadObserverConfigData => ({
  ...defaultWorkerLoadObserverConfig,
  ...overrides,
})

describe("validateProxyConfig — happy path", () => {
  test("shipped defaults pass against the deployed Helm probe timings", () => {
    const result = validateProxyConfig(HELM_PROBE, defaultWorkerLoadObserverConfig)
    expect(result.ok).toBe(true)
  })

  test("happy path against the in-code defaults (intervalMs=1000)", () => {
    const result = validateProxyConfig(
      { intervalMs: 1000, timeoutMs: 1500 },
      defaultWorkerLoadObserverConfig,
    )
    expect(result.ok).toBe(true)
  })
})

describe("validateProxyConfig — primary invariant (payloadStaleMs vs probe cycle)", () => {
  test("the exact RCA misconfiguration is rejected (Helm 3500 ms cycle, observer 3000 ms stale)", () => {
    const result = validateProxyConfig(HELM_PROBE, withObserver({ payloadStaleMs: 3000 }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    const msg = result.violations.join("\n")
    expect(msg).toContain("payloadStaleMs")
    expect(msg).toContain("3500 ms") // cycle reported
    expect(msg).toContain("7000 ms") // 2× cycle reported
  })

  test("rejects exactly-one-cycle margin (1.0× cycle is unsafe even though > cycle)", () => {
    // probeCycle=3500, stale=3500 → still rejected (need 2×).
    const result = validateProxyConfig(HELM_PROBE, withObserver({ payloadStaleMs: 3500 }))
    expect(result.ok).toBe(false)
  })

  test("accepts exactly-2x cycle (boundary)", () => {
    const result = validateProxyConfig(HELM_PROBE, withObserver({ payloadStaleMs: 7000 }))
    expect(result.ok).toBe(true)
  })

  test("accepts the new shipped default of 8000 ms", () => {
    const result = validateProxyConfig(HELM_PROBE, withObserver({ payloadStaleMs: 8000 }))
    expect(result.ok).toBe(true)
  })
})

describe("validateProxyConfig — value-positivity guards", () => {
  test.each([
    ["intervalMs=0", { intervalMs: 0, timeoutMs: 1500 } as ProbeTimingConfig],
    ["intervalMs=NaN", { intervalMs: NaN, timeoutMs: 1500 } as ProbeTimingConfig],
    ["intervalMs negative", { intervalMs: -1, timeoutMs: 1500 } as ProbeTimingConfig],
    ["timeoutMs=0", { intervalMs: 2000, timeoutMs: 0 } as ProbeTimingConfig],
    ["timeoutMs negative", { intervalMs: 2000, timeoutMs: -50 } as ProbeTimingConfig],
  ])("rejects %s", (_label, probe) => {
    const result = validateProxyConfig(probe, defaultWorkerLoadObserverConfig)
    expect(result.ok).toBe(false)
  })

  test("rejects payloadStaleMs=0", () => {
    const result = validateProxyConfig(HELM_PROBE, withObserver({ payloadStaleMs: 0 }))
    expect(result.ok).toBe(false)
  })
})

describe("validateProxyConfig — cap-band sanity", () => {
  test("rejects capFloorCps > capInitialCps", () => {
    const result = validateProxyConfig(
      HELM_PROBE,
      withObserver({ capFloorCps: 50, capInitialCps: 30 }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violations.join("\n")).toContain("capFloorCps")
  })

  test("rejects capInitialCps > capCeilingCps", () => {
    const result = validateProxyConfig(
      HELM_PROBE,
      withObserver({ capInitialCps: 500, capCeilingCps: 200 }),
    )
    expect(result.ok).toBe(false)
  })

  test("rejects capFloorCps = 0", () => {
    const result = validateProxyConfig(HELM_PROBE, withObserver({ capFloorCps: 0 }))
    expect(result.ok).toBe(false)
  })
})

describe("validateProxyConfig — ELU band ordering and hysteresis", () => {
  test("rejects eluSoft >= eluHard", () => {
    const result = validateProxyConfig(
      HELM_PROBE,
      withObserver({ eluSoft: 0.6, eluHard: 0.6 }),
    )
    expect(result.ok).toBe(false)
  })

  test("rejects eluHard >= eluCritical", () => {
    const result = validateProxyConfig(
      HELM_PROBE,
      withObserver({ eluHard: 0.75, eluCritical: 0.75 }),
    )
    expect(result.ok).toBe(false)
  })

  test("rejects hysteresis wider than a band gap", () => {
    // hard - soft = 0.6 - 0.4 = 0.2; hysteresis 0.25 traps the controller.
    const result = validateProxyConfig(
      HELM_PROBE,
      withObserver({ bandHysteresis: 0.25 }),
    )
    expect(result.ok).toBe(false)
  })

  test("rejects negative hysteresis", () => {
    const result = validateProxyConfig(
      HELM_PROBE,
      withObserver({ bandHysteresis: -0.01 }),
    )
    expect(result.ok).toBe(false)
  })
})

describe("validateProxyConfig — cooldown sanity", () => {
  test("rejects cooldown shorter than one probe cycle", () => {
    // cooldown = 1 × 1000 = 1000 ms < cycle 3500 ms.
    const result = validateProxyConfig(
      HELM_PROBE,
      withObserver({ aimdCooldownTicks: 1, optionsIntervalMs: 1000 }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violations.join("\n")).toContain("cooldown")
  })

  test("accepts cooldown >= one probe cycle", () => {
    // cooldown = 4 × 1000 = 4000 ms >= 3500 ms cycle.
    const result = validateProxyConfig(
      HELM_PROBE,
      withObserver({ aimdCooldownTicks: 4, optionsIntervalMs: 1000 }),
    )
    expect(result.ok).toBe(true)
  })
})

describe("validateProxyConfig — multiple simultaneous violations are all reported", () => {
  test("invalid probe AND invalid observer → both surface", () => {
    const result = validateProxyConfig(
      { intervalMs: 0, timeoutMs: 1500 },
      withObserver({ payloadStaleMs: 100, capFloorCps: 99, capInitialCps: 30 }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    // We want operators to see ALL problems on the first boot attempt,
    // not play whack-a-mole one error at a time.
    expect(result.violations.length).toBeGreaterThan(1)
  })
})

describe("assertValidProxyConfig — throws on violation", () => {
  test("throws and message includes the refuse-to-start header", () => {
    expect(() =>
      assertValidProxyConfig(HELM_PROBE, withObserver({ payloadStaleMs: 3000 })),
    ).toThrow(/refusing to start/)
  })

  test("does not throw on a valid config", () => {
    expect(() =>
      assertValidProxyConfig(HELM_PROBE, defaultWorkerLoadObserverConfig),
    ).not.toThrow()
  })
})
