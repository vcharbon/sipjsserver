import { defineConfig } from "vitest/config"

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
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/fullcall/e2e-real-clock.test.ts", "node_modules/**", "dist/**"],
  },
})
