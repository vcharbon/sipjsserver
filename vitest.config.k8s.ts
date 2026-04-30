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
    pool: "forks",
    forks: { singleFork: true },
    fileParallelism: false,
    testTimeout: 5 * 60 * 1000,
    hookTimeout: 10 * 60 * 1000,
  },
})
