/**
 * WorkerLoadObserver — AIMD state machine unit tests (slice 3).
 *
 * Pure-state suite. No SIP, no fibers — every test calls API methods
 * with synthetic payloads + explicit `nowMs`. Validates:
 *   - Band derivation + hysteresis
 *   - AIMD increase / decrease / cooldown
 *   - Above-critical → floor + filter behaviour
 *   - Token bucket refill
 *   - Worker-restart counter reset
 *   - Stale-payload sweep
 *   - Bootstrap-friendly admit on unknown worker
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  defaultWorkerLoadObserverConfig,
  type OverloadPayload,
  WorkerLoadObserver,
  type WorkerLoadObserverApi,
  type WorkerLoadObserverConfigData,
} from "../../src/sip-front-proxy/WorkerLoadObserver.js"

const W = "worker-A"

function payload(
  elu: number,
  adm = 0,
  gc = 0,
): OverloadPayload {
  return { elu, gc, adm }
}

function withObserver(
  body: (api: WorkerLoadObserverApi) => void,
  overrides: Partial<WorkerLoadObserverConfigData> = {},
): Effect.Effect<void> {
  const cfg: WorkerLoadObserverConfigData = {
    ...defaultWorkerLoadObserverConfig,
    ...overrides,
  }
  return Effect.gen(function* () {
    const obs = yield* WorkerLoadObserver
    body(obs)
  }).pipe(Effect.provide(WorkerLoadObserver.layer(cfg)))
}

// Stable band-test config — pins thresholds so the test stays valid
// regardless of operational-default tuning in defaultWorkerLoadObserverConfig.
const BANDS_CFG: Partial<WorkerLoadObserverConfigData> = {
  eluSoft: 0.6,
  eluHard: 0.8,
  eluCritical: 0.95,
}

describe("WorkerLoadObserver — band derivation", () => {
  it.effect("elu in [0, soft] → below_soft", () =>
    withObserver((obs) => {
      obs.applyPayload(W, payload(0.3), 1000)
      expect(obs.bandFor(W)).toBe("below_soft")
    }, BANDS_CFG),
  )

  it.effect("elu in (soft, hard] → soft_to_hard", () =>
    withObserver((obs) => {
      obs.applyPayload(W, payload(0.7), 1000)
      expect(obs.bandFor(W)).toBe("soft_to_hard")
    }, BANDS_CFG),
  )

  it.effect("elu in (hard, critical] → hard_to_critical", () =>
    withObserver((obs) => {
      obs.applyPayload(W, payload(0.85), 1000)
      expect(obs.bandFor(W)).toBe("hard_to_critical")
    }, BANDS_CFG),
  )

  it.effect("elu > critical → above_critical", () =>
    withObserver((obs) => {
      obs.applyPayload(W, payload(0.99), 1000)
      expect(obs.bandFor(W)).toBe("above_critical")
    }, BANDS_CFG),
  )
})

describe("WorkerLoadObserver — hysteresis", () => {
  it.effect("once in hard_to_critical, elu must drop below hard − h to exit", () =>
    withObserver(
      (obs) => {
        // Enter hard band
        obs.applyPayload(W, payload(0.82), 1000)
        expect(obs.bandFor(W)).toBe("hard_to_critical")
        // Within hysteresis zone — stay
        obs.applyPayload(W, payload(0.79), 2000)
        expect(obs.bandFor(W)).toBe("hard_to_critical")
        // Cross exit threshold (0.80 − 0.02 = 0.78) — drop out
        obs.applyPayload(W, payload(0.77), 3000)
        expect(obs.bandFor(W)).toBe("soft_to_hard")
      },
      { eluSoft: 0.6, eluHard: 0.8, eluCritical: 0.95, bandHysteresis: 0.02 },
    ),
  )

  it.effect("once in above_critical, elu must drop below critical − h to exit", () =>
    withObserver(
      (obs) => {
        obs.applyPayload(W, payload(0.98), 1000)
        expect(obs.bandFor(W)).toBe("above_critical")
        // Within hysteresis — stay
        obs.applyPayload(W, payload(0.94), 2000)
        expect(obs.bandFor(W)).toBe("above_critical")
        // Past exit — drop out
        obs.applyPayload(W, payload(0.92), 3000)
        expect(obs.bandFor(W)).toBe("hard_to_critical")
      },
      { eluSoft: 0.6, eluHard: 0.8, eluCritical: 0.95, bandHysteresis: 0.02 },
    ),
  )
})

describe("WorkerLoadObserver — AIMD increase ladder", () => {
  it.effect("additive increase when below_soft, no cooldown", () =>
    withObserver(
      (obs) => {
        // Three increases at +5 cps each from 100 base.
        obs.applyPayload(W, payload(0.1), 1000)
        let snap = obs.snapshot(1000)[0]
        expect(snap.lastAction).toBe("increase")
        expect(snap.capCps).toBe(105)

        obs.applyPayload(W, payload(0.1), 2000)
        snap = obs.snapshot(2000)[0]
        expect(snap.capCps).toBe(110)

        obs.applyPayload(W, payload(0.1), 3000)
        snap = obs.snapshot(3000)[0]
        expect(snap.capCps).toBe(115)
      },
      { capInitialCps: 100, aimdIncreaseStepCps: 5 },
    ),
  )

  it.effect("cap never exceeds capCeilingCps", () =>
    withObserver(
      (obs) => {
        // 20 increases × 5 = +100 ⇒ would hit 120, but ceiling is 110.
        for (let i = 1; i <= 20; i++) {
          obs.applyPayload(W, payload(0.1), i * 1000)
        }
        const snap = obs.snapshot(20000)[0]
        expect(snap.capCps).toBe(110)
      },
      { capInitialCps: 100, capCeilingCps: 110, aimdIncreaseStepCps: 5 },
    ),
  )
})

// AIMD-test config: pin band thresholds so 0.85 lands hard_to_critical
// regardless of operational defaults.
const AIMD_CFG: Partial<WorkerLoadObserverConfigData> = {
  eluSoft: 0.6,
  eluHard: 0.8,
  eluCritical: 0.95,
}

describe("WorkerLoadObserver — AIMD decrease + cooldown", () => {
  it.effect("multiplicative decrease when in hard_to_critical", () =>
    withObserver(
      (obs) => {
        obs.applyPayload(W, payload(0.85), 1000)
        const snap = obs.snapshot(1000)[0]
        expect(snap.lastAction).toBe("decrease")
        expect(snap.capCps).toBe(75) // 100 × 0.75
      },
      { ...AIMD_CFG, capInitialCps: 100, aimdDecreaseFactor: 0.75 },
    ),
  )

  it.effect("decrease arms a cooldown that blocks subsequent increases", () =>
    withObserver(
      (obs) => {
        // Decrease at t=1000ms. Cooldown = 3 ticks × 1000ms = 3000ms.
        obs.applyPayload(W, payload(0.85), 1000)
        let snap = obs.snapshot(1000)[0]
        expect(snap.cooldownMsRemaining).toBe(3000)
        // At t=2000ms, elu drops to 0.1 — would normally increase, but
        // cooldown still active.
        obs.applyPayload(W, payload(0.1), 2000)
        snap = obs.snapshot(2000)[0]
        expect(snap.lastAction).toBe("cooldown")
        expect(snap.capCps).toBe(75) // unchanged

        // At t=5000ms, cooldown elapsed — increase enabled.
        obs.applyPayload(W, payload(0.1), 5000)
        snap = obs.snapshot(5000)[0]
        expect(snap.lastAction).toBe("increase")
        expect(snap.capCps).toBe(80) // 75 + 5
      },
      {
        ...AIMD_CFG,
        capInitialCps: 100,
        aimdDecreaseFactor: 0.75,
        aimdCooldownTicks: 3,
        optionsIntervalMs: 1000,
        aimdIncreaseStepCps: 5,
      },
    ),
  )

  it.effect("decrease never goes below capFloorCps", () =>
    withObserver(
      (obs) => {
        // Force many decreases past the cooldown window so they all
        // land. Bump time enough each step.
        for (let i = 0; i < 20; i++) {
          obs.applyPayload(W, payload(0.85), 1000 + i * 4000)
        }
        const snap = obs.snapshot(100000)[0]
        expect(snap.capCps).toBeGreaterThanOrEqual(1)
        expect(snap.capCps).toBe(1) // floor pinned
      },
      {
        ...AIMD_CFG,
        capInitialCps: 100,
        capFloorCps: 1,
        aimdDecreaseFactor: 0.75,
        aimdCooldownTicks: 3,
        optionsIntervalMs: 1000,
      },
    ),
  )
})

describe("WorkerLoadObserver — CRITICAL filter behaviour", () => {
  it.effect("above_critical pins cap at floor immediately", () =>
    withObserver(
      (obs) => {
        obs.applyPayload(W, payload(0.99), 1000)
        const snap = obs.snapshot(1000)[0]
        expect(snap.lastAction).toBe("decrease_critical")
        expect(snap.capCps).toBe(1)
        expect(snap.band).toBe("above_critical")
      },
      { ...AIMD_CFG, capInitialCps: 100, capFloorCps: 1 },
    ),
  )
})

describe("WorkerLoadObserver — token bucket", () => {
  it.effect("unknown worker is admitted (bootstrap-friendly)", () =>
    withObserver((obs) => {
      expect(obs.tryConsumeFor("unknown-worker", 1000)).toBe(true)
    }),
  )

  // Seed elu=0.7 lands in soft_to_hard ⇒ AIMD `hold` ⇒ cap stays at
  // capInitialCps. Without this the below_soft AIMD increase would
  // bump the cap on the seed payload and confuse the refill arithmetic.
  it.effect("bucket starts full at capInitialCps tokens", () =>
    withObserver(
      (obs) => {
        obs.applyPayload(W, payload(0.7), 1000)
        for (let i = 0; i < 10; i++) {
          expect(obs.tryConsumeFor(W, 1000)).toBe(true)
        }
        expect(obs.tryConsumeFor(W, 1000)).toBe(false)
      },
      { ...BANDS_CFG, capInitialCps: 10 },
    ),
  )

  it.effect("bucket refills at cap tokens/sec over elapsed time", () =>
    withObserver(
      (obs) => {
        obs.applyPayload(W, payload(0.7), 0)
        // Drain the bucket.
        for (let i = 0; i < 10; i++) obs.tryConsumeFor(W, 0)
        expect(obs.tryConsumeFor(W, 0)).toBe(false)
        // 500ms later → bucket gains 10 × 0.5 = 5 tokens.
        expect(obs.tryConsumeFor(W, 500)).toBe(true)
        // Drain those.
        for (let i = 0; i < 4; i++) {
          expect(obs.tryConsumeFor(W, 500)).toBe(true)
        }
        expect(obs.tryConsumeFor(W, 500)).toBe(false)
      },
      { ...BANDS_CFG, capInitialCps: 10 },
    ),
  )
})

describe("WorkerLoadObserver — counter math", () => {
  it.effect("worker_treated_rate is (adm_delta / dt) in cps", () =>
    withObserver((obs) => {
      obs.applyPayload(W, payload(0.5, 0), 0)
      // 100 admits over 1s → 100 cps treated rate.
      obs.applyPayload(W, payload(0.5, 100), 1000)
      const snap = obs.snapshot(1000)[0]
      expect(snap.workerTreatedRateCps).toBeCloseTo(100, 5)
    }),
  )

  it.effect("adm counter decrease (worker restart) resets baseline", () =>
    withObserver((obs) => {
      obs.applyPayload(W, payload(0.5, 1000), 0)
      obs.applyPayload(W, payload(0.5, 1100), 1000)
      // Worker restarted — adm dropped back to 50.
      obs.applyPayload(W, payload(0.5, 50), 2000)
      const snap = obs.snapshot(2000)[0]
      expect(snap.workerTreatedRateCps).toBe(0) // reset
      // From here forward, normal rate derivation resumes.
      obs.applyPayload(W, payload(0.5, 100), 3000)
      const snap2 = obs.snapshot(3000)[0]
      expect(snap2.workerTreatedRateCps).toBeCloseTo(50, 5)
    }),
  )

  it.effect("recordOwnAdmitted and share metric", () =>
    withObserver((obs) => {
      obs.applyPayload(W, payload(0.5, 0), 0)
      // This LB admits 30 in the first second; worker total is 100.
      for (let i = 0; i < 30; i++) obs.recordOwnAdmitted(W)
      obs.applyPayload(W, payload(0.5, 100), 1000)
      const snap = obs.snapshot(1000)[0]
      // ownAdmittedRateCps EWMA-smoothed: 0.7 × 0 + 0.3 × 30 = 9
      expect(snap.ownAdmittedRateCps).toBeCloseTo(9, 5)
      // share = 9 / 100 = 0.09
      expect(snap.share).toBeCloseTo(0.09, 5)
    }),
  )
})

describe("WorkerLoadObserver — stale-payload sweep", () => {
  // Seed elu=0.7 (hold band under BANDS_CFG: soft=0.6, hard=0.8) so the
  // initial applyPayload does not mutate the cap — isolates the sweep's behaviour.
  it.effect("sweep below stale threshold is a no-op", () =>
    withObserver(
      (obs) => {
        obs.applyPayload(W, payload(0.7), 1000)
        obs.sweepStale(1500)
        const snap = obs.snapshot(1500)[0]
        expect(snap.lastAction).toBe("hold")
        expect(snap.payloadMissingCount).toBe(0)
      },
      { ...BANDS_CFG, payloadStaleMs: 5000 },
    ),
  )

  it.effect("sweep above stale threshold triggers conservative decrease", () =>
    withObserver(
      (obs) => {
        obs.applyPayload(W, payload(0.7), 0)
        obs.sweepStale(6000)
        const snap = obs.snapshot(6000)[0]
        expect(snap.lastAction).toBe("stale_decrease")
        expect(snap.capCps).toBe(75) // 100 × 0.75 — cap unchanged by seed (hold band)
        expect(snap.payloadMissingCount).toBe(1)
      },
      {
        ...BANDS_CFG,
        capInitialCps: 100,
        aimdDecreaseFactor: 0.75,
        payloadStaleMs: 5000,
      },
    ),
  )
})

describe("WorkerLoadObserver — diagnostics", () => {
  it.effect("notePayloadMissing increments counter without an AIMD step", () =>
    withObserver((obs) => {
      obs.applyPayload(W, payload(0.7), 1000) // hold band — cap pinned
      const before = obs.snapshot(1000)[0]
      obs.notePayloadMissing(W, 2000)
      obs.notePayloadMissing(W, 2500)
      const after = obs.snapshot(2500)[0]
      expect(after.payloadMissingCount).toBe(2)
      expect(after.capCps).toBe(before.capCps) // unchanged
    }, BANDS_CFG),
  )

  it.effect("snapshot returns one entry per known worker", () =>
    withObserver((obs) => {
      obs.applyPayload("worker-A", payload(0.3), 1000)
      obs.applyPayload("worker-B", payload(0.9), 1000)
      obs.applyPayload("worker-C", payload(0.5), 1000)
      const snap = obs.snapshot(1000)
      expect(snap.length).toBe(3)
      const byId = new Map(snap.map((s) => [s.workerId, s] as const))
      expect(byId.get("worker-A")?.band).toBe("below_soft")
      expect(byId.get("worker-B")?.band).toBe("hard_to_critical")
      expect(byId.get("worker-C")?.band).toBe("below_soft")
    }, BANDS_CFG),
  )
})
