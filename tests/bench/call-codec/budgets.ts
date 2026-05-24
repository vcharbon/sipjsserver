/**
 * Absolute per-stage budgets for the champion variant.
 *
 * The bench has historically reported relative numbers ("v6 is 7× v1")
 * which mask absolute regressions — the May 2026 endurance run revealed
 * v6-msgpackr burning ~25 % CPU in pack/unpack despite winning every
 * relative comparison. These budgets are the regression gate.
 *
 * **Calibration method.** Numbers are the rough p95 observed when
 * running `driver.ts 20000` on a quiesced WSL2 host (Linux 6.6, 32 GB,
 * Node 22). They are NOT tightly calibrated yet — they leave headroom
 * (~1.5–2×) so the gate fires only on real regressions, not jitter.
 * Tighten by running the bench 5 times on the target hardware, taking
 * the median, and updating these numbers in a PR with the new median
 * + the runner's `uname -a`.
 *
 * Adding a new stage? Add a budget entry here in the same PR that adds
 * the stage to `worker.ts`. A missing budget for a stage is allowed
 * (the gate silently skips it); making absence-of-budget a build error
 * encourages forgetfulness over correctness.
 */

export interface StageBudget {
  readonly meanNs?: number
  readonly p95Ns?: number
  readonly p99Ns?: number
  readonly gcPctOfWall?: number
}

/** Budget for the current production codec (v6-msgpackr). */
export const V6_MSGPACKR_BUDGETS: Record<string, StageBudget> = {
  // encodeCall(stamped) — body pack + spread allocation.
  A: { meanNs: 35_000, p95Ns: 95_000, p99Ns: 150_000 },
  // wireEncode(env, body) — envelope pack.
  B: { meanNs: 7_500, p95Ns: 20_000, p99Ns: 40_000 },
  // wireDecode(frame).
  C: { meanNs: 7_500, p95Ns: 25_000, p99Ns: 60_000 },
  // decodeCall(body).
  D: { meanNs: 30_000, p95Ns: 80_000, p99Ns: 150_000 },
  // The production hot loop: body pack + envelope pack back-to-back.
  // This is the line item that the May 2026 endurance regression
  // would have tripped. Headline of the comparative table.
  fullFlush: { meanNs: 45_000, p95Ns: 120_000, p99Ns: 200_000, gcPctOfWall: 35 },
  // Full round-trip (A+B+C+D) for replication-receiver side budgeting.
  FULL: { meanNs: 80_000, p95Ns: 200_000, p99Ns: 350_000, gcPctOfWall: 40 },
}

export const BUDGETS_BY_VARIANT: Record<string, Record<string, StageBudget>> = {
  "v6-msgpackr": V6_MSGPACKR_BUDGETS,
}
