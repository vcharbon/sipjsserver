import { defineConfig } from "vitest/config"
import { sipjsSubpathAliases } from "./vitest.aliases.js"

/**
 * Unified vitest config.
 *
 * Switched by `TEST_MODE` env var:
 *
 *   - `TEST_MODE=fake` (default) — fake-stack suites: everything under
 *     `tests/**` except the real-clock e2e file, the live limiter
 *     rejection probe, the k8s suites, and the replication-stream soak.
 *     Each test runs under `it.effect` + TestClock + in-memory
 *     dependencies + simulated `SignalingNetwork`.
 *
 *   - `TEST_MODE=live` — live-stack suites: real-clock e2e
 *     (`tests/fullcall/e2e-real-clock.test.ts`), limiter-rejection probe,
 *     hybrid kind-cluster smoke, and the replication-stream medium-tier
 *     soak. Each scenario advertises a tier via `.tier("short" | "medium"
 *     | "long")`; `TEST_TIER` (default `short`) decides which ones run.
 *     Higher tiers include lower ones.
 *
 * `TEST_TIER` is orthogonal — it gates scenarios inside the live suite
 * and is also read by individual fake-mode scenarios when needed.
 *
 * The k8s tier still has its own config (`vitest.config.k8s.ts`) —
 * it needs a `globalSetup`, sequential file execution, and `singleFork`
 * semantics that don't compose cleanly with this binary mode switch.
 */
const TEST_MODE = (process.env.TEST_MODE ?? "fake") as "fake" | "live"

if (TEST_MODE !== "fake" && TEST_MODE !== "live") {
  throw new Error(
    `Invalid TEST_MODE=${process.env.TEST_MODE!}. Expected "fake" or "live".`,
  )
}

const fakeInclude = ["tests/**/*.test.ts"]
const fakeExclude = [
  "tests/fullcall/e2e-real-clock.test.ts",
  "tests/fullcall/e2e-register-fakeExt-realCore.test.ts",
  "tests/fullcall/e2e-register-noRr-realFabric.test.ts",
  "tests/fullcall/replication-stream-medium.test.ts",
  "tests/harness/limiter-rejection.test.ts",
  // K8s suites need a kind cluster and run under `vitest.config.k8s.ts`.
  // The pure parser tests under `tests/k8s/fixtures/` (e.g.
  // sippOutcomes.test.ts) only read checked-in samples and are part
  // of the inner loop.
  "tests/k8s/*.test.ts",
  "tests/k8s/scripts/**",
  "node_modules/**",
  "dist/**",
]

const liveInclude = [
  "tests/fullcall/e2e-real-clock.test.ts",
  "tests/harness/limiter-rejection.test.ts",
  // Hybrid kind-cluster suite — no-ops unless `E2E_KIND=1` in env.
  "tests/fullcall/e2e-register-fakeExt-realCore.test.ts",
  "tests/fullcall/e2e-register-noRr-realFabric.test.ts",
  // Replication-stream medium-tier soak (real Redis + real HTTP);
  // self-skips when TEST_TIER < medium, Redis is unreachable, or
  // `--expose-gc` is not present.
  "tests/fullcall/replication-stream-medium.test.ts",
]

export default defineConfig({
  resolve: { alias: sipjsSubpathAliases },
  test:
    TEST_MODE === "fake"
      ? {
          include: fakeInclude,
          exclude: fakeExclude,
          // WSL has ~19 GiB shared with kind (~3 GB), VSCode, and Claude
          // Code (~2 GB), leaving ~9 GB for tests. The default fork count
          // (=nproc, 24) and even maxForks=4 thrashes: 4×1 GB heap caps
          // push V8 into constant GC, which pegs CPU via GC/JIT background
          // threads. maxForks=2 with a 1.5 GB heap halves both pressures
          // (≈3 GB ceiling, less GC churn) at the cost of ~2× wall time
          // on the full sip-front-proxy suite.
          poolOptions: {
            forks: {
              execArgv: ["--max-old-space-size=1536"],
              maxForks: 2,
              minForks: 1,
            },
          },
        }
      : {
          include: liveInclude,
          // Cap each test worker fork at 1 GB so a runaway test cannot
          // starve the rest of WSL. `--expose-gc` is required by the
          // replication-stream medium-tier heap assertions; harmless when
          // other tests ignore it.
          //
          // Vitest 4 moved poolOptions to top-level — `execArgv` is now
          // applied directly to the worker fork.
          execArgv: ["--max-old-space-size=1024", "--expose-gc"],
        },
})
