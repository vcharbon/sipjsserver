import { defineConfig } from "vitest/config"

/**
 * K8s-tier vitest config.
 *
 * Runs the property-level invariant tests for the sip-front-proxy
 * load-balancer mechanism against a live `kind` cluster. Each test file
 * installs the production Helm charts into a freshly-created namespace,
 * drives a SIPp Pod, and asserts on Loki/Prometheus.
 *
 * Single fork: install/teardown of namespaces + chaos CRDs is not
 * isolated across files. Tests within a single file may run in parallel
 * if they namespace-scope explicitly.
 *
 * Bring the cluster up before running with `npm run test:k8s:up`, or use
 * `npm run test:k8s` which runs `up` then `test`. `npm run test:k8s:fresh`
 * tears down + recreates from scratch.
 */
export default defineConfig({
  test: {
    include: ["tests/k8s/**/*.test.ts"],
    pool: "forks",
    forks: { singleFork: true },
    testTimeout: 5 * 60 * 1000,
    hookTimeout: 10 * 60 * 1000,
  },
})
