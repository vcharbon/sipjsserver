import { defineConfig } from "vitest/config"

/**
 * K8s-tier vitest config.
 *
 * Runs the property-level invariant tests for the sip-front-proxy
 * load-balancer mechanism against a live `kind` cluster. Each test file
 * installs the production Helm charts into a freshly-created namespace,
 * drives a SIPp Pod, and asserts on Loki/Prometheus.
 *
 * Sequential execution: install/teardown of namespaces, chaos CRDs,
 * pod-kill state, and routing-log buffers are not isolated across
 * files. Two settings are needed:
 *
 *   - `pool: "forks"` + `singleFork: true` — one worker PROCESS so
 *     setup/teardown happens once.
 *   - `fileParallelism: false` — files execute one-after-another in
 *     that fork. Without this the failover suite would have 7 tests
 *     all kicking off sipp jobs and pod-kills at the same wall-clock
 *     second; routing decisions would be polluted across tests.
 */
export default defineConfig({
  test: {
    include: ["tests/k8s/**/*.test.ts"],
    // Exclude long-running soak tests from the default suite. They are
    // tier-gated to nightly via the `test:k8s:soak` npm script.
    exclude: ["**/proxy-limiter-soak.test.ts", "**/node_modules/**"],
    // Idempotent: ensures the kind cluster exists, all required images
    // are built + side-loaded, and the proxy/worker/sipp charts are
    // installed into the `sip-test` namespace before any test file
    // loads. Lets `npx vitest run -c vitest.config.k8s.ts <file>` work
    // against a fresh cluster without manual setup.
    globalSetup: ["./tests/k8s/globalSetup.ts"],
    pool: "forks",
    forks: { singleFork: true },
    // Cap the singleton fork at 1 GB so a runaway test cannot starve
    // the rest of WSL. Applies to `npx vitest` as well as `npm run test*`.
    poolOptions: {
      forks: { execArgv: ["--max-old-space-size=1024"] },
    },
    fileParallelism: false,
    testTimeout: 5 * 60 * 1000,
    hookTimeout: 10 * 60 * 1000,
  },
})
