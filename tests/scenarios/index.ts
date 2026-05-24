/**
 * Scenario barrel — re-exports every scenario module under tests/scenarios.
 *
 * Test files iterate this namespace via `import * as S from
 * "../scenarios/index.js"`, then walk `Object.entries(S)` to discover all
 * scenarios. `registerScenarios()` at the bottom of this module assigns
 * a canonical kebab-case name to any scenario constructed without one
 * (i.e. via `scenario(builder)` rather than `scenario(name, builder)`)
 * by deriving it from the export key.
 *
 * Re-exports include helper functions and types alongside scenarios;
 * `registerScenarios` filters by `instanceof ComposableScenario` so
 * non-scenario exports are ignored.
 */

import { registerScenarios } from "../../src/test-harness/framework/dsl.js"

// Self-import: read back the namespace this module exposes so registration
// can walk every re-exported `ComposableScenario`. Safe under ESM — by the
// time the side-effect block at the bottom runs, all `export *` linkages
// above have populated `Self`.
import * as Self from "./index.js"

export * from "./basic-call.js"
export * from "./bye-directions.js"
export * from "./call-reject.js"
export * from "./cancel-200ok-crossing.js"
export * from "./cancel.js"
export * from "./delayed-offer-failure.js"
export * from "./failover-reroute.js"
export * from "./fake-prack.js"
export * from "./from-to-override.js"
export * from "./ha/keepalive-happy-ha.js"
export * from "./ha/keepalive-timeout-ha.js"
export * from "./ha/two-calls-routed-to-two-workers.js"
export * from "./indialog-info.js"
export * from "./indialog-options.js"
export * from "./indialog-unknown-reject.js"
export * from "./keepalive-481.js"
export * from "./keepalive-happy.js"
export * from "./keepalive-via-proxy.js"
export * from "./limiter-cancel.js"
export * from "./limiter-rejection.js"
export * from "./options-keepalive-timeout.js"
export * from "./p2p-direct-call.js"
export { p2pExtraMessage } from "./p2p-extra-message.js"
export * from "./prack-forking.js"
export * from "./prack.js"
export * from "./promote-pem-to-200.js"
export * from "./refer-allow.js"
export * from "./refer-c-realign.js"
export * from "./refer-full-transfer.js"
export * from "./refer-gating.js"
export * from "./refer-reject.js"
export * from "./refer-timers.js"
export * from "./registrar/core-call-to-registered-ext.js"
export * from "./registrar/deregister-via-expires-zero.js"
export * from "./registrar/ext-call-to-core-destination.js"
export * from "./registrar/k8s-register-call-bye.js"
export * from "./registrar/k8s-register-call-reroute.js"
export * from "./registrar/k8s-register-smoke.js"
export * from "./registrar/register-happy-path.js"
export * from "./registrar/ttl-expiry-under-testclock.js"
export * from "./reinvite.js"
export * from "./reject-with-headers.js"
export * from "./retransmit-200.js"
export * from "./route-set-propagation.js"
export * from "./suppress-18x.js"

registerScenarios(Self as unknown as Record<string, unknown>)
