import { defineConfig } from "vitest/config"

/**
 * Live-stack vitest config.
 *
 * Runs only the real-clock e2e suite (`tests/fullcall/e2e-real-clock.test.ts`).
 * Each scenario advertises a tier via `.tier("short"|"medium"|"long")`;
 * the suite itself consults `process.env.TEST_TIER` to decide which
 * tiers to include (default = "short"). Higher tiers implicitly include
 * lower ones:
 *
 *   - TEST_TIER=short  → short only            (< 2s real per scenario)
 *   - TEST_TIER=medium → short + medium        (< 30s real per scenario)
 *   - TEST_TIER=long   → short + medium + long (no cap — nightly only)
 */
export default defineConfig({
  test: {
    include: [
      "tests/fullcall/e2e-real-clock.test.ts",
      "tests/harness/limiter-rejection.test.ts",
    ],
  },
})
