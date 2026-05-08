import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { FRONT_PROXY_VIP_TARGET } from "./fixtures/frontProxyTarget.js"
import { deleteSippJob, runSippJob } from "./fixtures/sippJob.js"
import { fetchRoutingDecisions } from "./fixtures/proxyLogs.js"

const NAMESPACE = process.env.K8S_TEST_NAMESPACE ?? "sip-test"

/**
 * INV-5 — HMAC cookie validation (Phase A scope).
 *
 * The full INV-5 has three legs:
 *   - Tampered or missing cookie → `sip_routing_hmac_failure_total`
 *     increments; SIPp re-INVITE times out.
 *   - Valid current-key cookie → routed.
 *   - Valid previous-key cookie → routed (rotation grace verified).
 *
 * Phase A scope is narrower:
 *
 *   1. The proxy MUST generate a Record-Route URI containing the
 *      stickiness param (`w=<workerId>;v=1;kid=…;sig=…`) on every
 *      forwarded INVITE — verifiable from a SIPp message trace.
 *   2. No `decode_reject` decisions occur during normal traffic — the
 *      cookie-validation path, when exercised, succeeds.
 *
 * Phase A++ findings (out of scope here, tracked as follow-ups):
 *
 *   - The cookie-validation success path (`decode_forward`) is NOT
 *     exercised end-to-end by SIPp's stock UAC scenario because the
 *     B2BUA worker does not currently reflect the Leg-A Record-Route in
 *     its 200 OK — so SIPp's [routes] macro expands to empty in
 *     subsequent in-dialog requests, and the proxy falls back to HRW.
 *     The B2BUA fix (preserve Leg-A Record-Route across the leg
 *     bridge) is a separate workstream from PR5/PR6's load balancer.
 *   - Tampered-cookie verification needs a custom UDP client to mutate
 *     a Record-Route mid-dialog — deferred.
 *   - Key rotation needs a Helm upgrade flow that swaps `hmacKey` /
 *     `previousHmacKey` mid-test — deferred.
 */
describe("k8s/proxy-hmac — INV-5: HMAC cookie validation (Phase A scope)", () => {
  it.live(
    "no decode_reject decisions during normal traffic",
    () =>
      Effect.gen(function* () {
        const stamp = Date.now().toString(36)
        const jobName = `inv5-${stamp}`
        const cidStr = `inv5-${stamp}-%u@det`
        const cidPrefix = `inv5-${stamp}-`
        const N = 12

        try {
          const result = yield* runSippJob({
            namespace: NAMESPACE,
            name: jobName,
            scenario: "uac-basic.xml",
            target: FRONT_PROXY_VIP_TARGET,
            service: "test",
            calls: N,
            callsPerSecond: 12,
            timeoutSec: 30,
            waitTimeoutSec: 60,
            extraArgs: ["-cid_str", cidStr],
          })
          expect(result.jobStatus).toBe("succeeded")
          expect(result.stats.successful).toBe(N)
          expect(result.stats.failed).toBe(0)

          const decisions = yield* fetchRoutingDecisions(NAMESPACE, { since: "120s" })
          const ours = decisions.filter((d) => d.callId.startsWith(cidPrefix))
          expect(ours.length).toBeGreaterThan(0)

          const rejected = ours.filter((d) => d.decision === "decode_reject")
          expect(
            rejected,
            `INV-5 success-path violation: ${rejected.length} decisions rejected by HMAC validation:\n${JSON.stringify(rejected, null, 2)}`,
          ).toEqual([])

          // Phase A signal: log whether cookie validation is even being
          // exercised. If decode_forward count == 0, the SIPp scenario
          // is not propagating Record-Route via [routes] (B2BUA Leg-A
          // R-R reflection is the missing piece).
          const decoded = ours.filter((d) => d.decision === "decode_forward")
          yield* Effect.logInfo(
            `INV-5 signal: decode_forward=${decoded.length} ` +
              `select_new=${ours.filter((d) => d.decision === "select_new").length} ` +
              `(decode_forward=0 expected in Phase A pending B2BUA Record-Route fix)`,
          )
        } finally {
          yield* deleteSippJob(NAMESPACE, jobName).pipe(Effect.ignore)
        }
      }),
    { timeout: 120_000 },
  )
})
