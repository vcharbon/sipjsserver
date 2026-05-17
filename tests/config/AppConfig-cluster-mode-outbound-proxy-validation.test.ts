/**
 * Cluster-mode workers MUST route b-leg outbound traffic through the LB
 * proxy. The proxy is the single point of failover-aware routing
 * (cookie-decode, dead-worker promotion). A worker that sends b-leg
 * INVITEs direct to bob bypasses this guarantee — bob-side responses
 * and in-dialog requests have no path back to a healthy worker when
 * the original primary dies. The "direct to bob" path is reserved for
 * the standalone single-b2b deployment.
 *
 * Detection signal: `clusterWorkers > 0` (set via `CLUSTER_WORKERS`).
 * Single-node deployments leave it at 0 and bypass this gate.
 *
 * See `validateClusterModeOutboundProxy` in src/config/AppConfig.ts.
 */

import { describe, expect, test } from "vitest"
import { validateClusterModeOutboundProxy } from "../../src/config/AppConfig.js"
import type { AppConfigData } from "../../src/config/AppConfig.js"

function minimalCfg(overrides: Partial<AppConfigData>): AppConfigData {
  return overrides as unknown as AppConfigData
}

describe("AppConfig — cluster-mode outbound-proxy validator", () => {
  test("passes in standalone mode (clusterWorkers = 0) without outbound proxy", () => {
    expect(() =>
      validateClusterModeOutboundProxy(
        minimalCfg({ clusterWorkers: 0 }),
      ),
    ).not.toThrow()
  })

  test("passes in cluster mode when B2B_OUTBOUND_PROXY is set", () => {
    expect(() =>
      validateClusterModeOutboundProxy(
        minimalCfg({
          clusterWorkers: 2,
          b2bOutboundProxy: { host: "10.10.0.1", port: 15060 },
        }),
      ),
    ).not.toThrow()
  })

  test("rejects cluster mode when B2B_OUTBOUND_PROXY is missing", () => {
    expect(() =>
      validateClusterModeOutboundProxy(
        minimalCfg({ clusterWorkers: 2 }),
      ),
    ).toThrowError(/B2B_OUTBOUND_PROXY is unset/)
  })

  test("error message names the failure mode and the remediation", () => {
    expect(() =>
      validateClusterModeOutboundProxy(
        minimalCfg({ clusterWorkers: 3 }),
      ),
    ).toThrowError(/cluster mode|standalone single-b2b/)
  })
})
