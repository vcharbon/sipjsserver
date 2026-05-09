import { defineConfig } from "vitest/config"
import { sipjsSubpathAliases } from "./vitest.aliases.js"

/**
 * Fake-stack vitest config.
 *
 * Runs every test suite that lives entirely under TestClock — i.e. the
 * full `tests/fake` analogue (currently `tests/fullcall/e2e-fake-clock.*`
 * plus the unit suites in `tests/sip`, `tests/b2bua`, `tests/support`,
 * `tests/http`, and `tests/fullcall/refer`).
 *
 * The real-clock e2e suite (`tests/fullcall/e2e-real-clock.test.ts`) is
 * excluded — it runs under `vitest.config.live.ts`.
 */
export default defineConfig({
  resolve: { alias: sipjsSubpathAliases },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [
      "tests/fullcall/e2e-real-clock.test.ts",
      "tests/harness/limiter-rejection.test.ts",
      // Exclude the live K8s suites — they need a kind cluster and run
      // under `vitest.config.k8s.ts`. The pure parser tests under
      // `tests/k8s/fixtures/` (e.g. sippOutcomes.test.ts) only read
      // checked-in samples and are part of the inner loop.
      "tests/k8s/*.test.ts",
      "tests/k8s/scripts/**",
      "node_modules/**",
      "dist/**",
    ],
    // Cap each test worker fork at 1 GB so a runaway test cannot starve
    // the rest of WSL. Applies to `npx vitest` as well as `npm run test*`.
    poolOptions: {
      forks: { execArgv: ["--max-old-space-size=1024"] },
    },
  },
})
