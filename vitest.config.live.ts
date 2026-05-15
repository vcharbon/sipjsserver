import { defineConfig } from "vitest/config"
import { sipjsSubpathAliases } from "./vitest.aliases.js"

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
  resolve: { alias: sipjsSubpathAliases },
  test: {
    include: [
      "tests/fullcall/e2e-real-clock.test.ts",
      "tests/harness/limiter-rejection.test.ts",
      // Hybrid kind-cluster suite — no-ops unless `E2E_KIND=1` in env.
      "tests/fullcall/e2e-register-fakeExt-realCore.test.ts",
      // Replication-stream medium-tier soak (real Redis + real HTTP);
      // self-skips when TEST_TIER < medium, Redis is unreachable, or
      // `--expose-gc` is not present.
      "tests/fullcall/replication-stream-medium.test.ts",
    ],
    // Cap each test worker fork at 1 GB so a runaway test cannot starve
    // the rest of WSL. Applies to `npx vitest` as well as `npm run test*`.
    // `--expose-gc` is required by the replication-stream medium-tier
    // heap assertions; harmless when other tests ignore it.
    //
    // Vitest 4 moved poolOptions to top-level — `execArgv` is now
    // applied directly to the worker fork.
    execArgv: ["--max-old-space-size=1024", "--expose-gc"],
  },
})
