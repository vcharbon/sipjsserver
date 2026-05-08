import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { FRONT_PROXY_VIP_TARGET } from "./fixtures/frontProxyTarget.js"
import { deleteSippJob, runSippJob } from "./fixtures/sippJob.js"
import {
  aggregatePerCall,
  fetchRoutingDecisions,
  workerIpToName,
} from "./fixtures/proxyLogs.js"

const NAMESPACE = process.env.K8S_TEST_NAMESPACE ?? "sip-test"

/**
 * INV-1 — Sticky in-dialog routing.
 *
 * Every in-dialog request (re-INVITE, ACK, BYE, CANCEL) for an established
 * dialog reaches the same worker that handled the initial INVITE. Without
 * this property the B2BUA loses dialog state coherence.
 *
 * Method: send N calls, then parse the proxy's `routed METHOD callId →
 * workerIp` log lines. For every Call-ID, the set of worker IPs MUST
 * have size 1.
 */
describe("k8s/proxy-routing — INV-1: sticky in-dialog routing", () => {
  it.live(
    "every Call-ID is handled by exactly one worker across INVITE/ACK/BYE",
    () =>
      Effect.gen(function* () {
        const jobName = `inv1-${Date.now().toString(36)}`
        const N = 20
        try {
          const result = yield* runSippJob({
            namespace: NAMESPACE,
            name: jobName,
            scenario: "uac-basic.xml",
            target: FRONT_PROXY_VIP_TARGET,
            service: "test",
            calls: N,
            callsPerSecond: 10,
            timeoutSec: 60,
            waitTimeoutSec: 90,
          })
          // In Phase A the shared `sip-test` namespace can have residual
          // worker pressure from prior tests. The INVARIANT we care
          // about is sticky in-dialog routing for ANY call that
          // completes — not throughput. Require ≥80% success.
          const minSuccess = Math.ceil(N * 0.8)
          expect(
            result.stats.successful,
            `expected ≥${minSuccess} successful calls, got ${result.stats.successful}`,
          ).toBeGreaterThanOrEqual(minSuccess)

          const decisions = yield* fetchRoutingDecisions(NAMESPACE, { since: "180s" })
          const perCall = aggregatePerCall(decisions)
          // At least the successful calls should have routing decisions.
          expect(perCall.length).toBeGreaterThanOrEqual(result.stats.successful)

          const ipMap = yield* workerIpToName(NAMESPACE)
          const violators: Array<{ callId: string; workers: ReadonlyArray<string> }> = []
          for (const c of perCall) {
            if (c.workerIps.size !== 1) {
              violators.push({
                callId: c.callId,
                workers: Array.from(c.workerIps).map(
                  (ip) => ipMap.get(ip) ?? ip,
                ),
              })
            }
          }
          expect(
            violators,
            `INV-1 violation: calls hit multiple workers:\n${JSON.stringify(violators, null, 2)}`,
          ).toEqual([])
        } finally {
          yield* deleteSippJob(NAMESPACE, jobName).pipe(Effect.ignore)
        }
      }),
    { timeout: 180_000 },
  )
})

/**
 * INV-2 — HRW determinism under stable pool.
 *
 * With a stable worker set, the same Call-ID always routes to the same
 * worker. The proxy uses rendezvous-hash on Call-ID for initial-INVITE
 * placement; in-dialog stickiness is the HMAC cookie (covered by INV-1).
 *
 * Method: run two SIPp bursts with the SAME deterministic Call-IDs.
 * The first burst runs end-to-end. The second burst's calls will be
 * rejected by the worker (duplicate Call-ID in its still-warm cache),
 * but that is irrelevant — the proxy's `routed INVITE` log line fires
 * BEFORE the worker rejects, so the routing decision is still
 * observable. We ignore the second SIPp Job's exit status and assert
 * only that both bursts produced the same proxy → worker mapping.
 *
 * SIPp's `-cid_str` overrides Call-ID generation. Using a format
 * without `%p` (pid) makes the IDs stable across runs.
 */
describe("k8s/proxy-routing — INV-2: HRW determinism under stable pool", () => {
  it.live(
    "same Call-IDs route to the same worker across two bursts",
    () =>
      Effect.gen(function* () {
        const stamp = Date.now().toString(36)
        const N = 10
        const cidPrefix = `inv2-${stamp}`
        const cidStr = `${cidPrefix}-%u@deterministic`

        try {
          // Burst A — runs end-to-end; tolerate a small loss rate.
          const r1 = yield* runSippJob({
            namespace: NAMESPACE,
            name: `inv2-${stamp}-a`,
            scenario: "uac-basic.xml",
            target: FRONT_PROXY_VIP_TARGET,
            service: "test",
            calls: N,
            callsPerSecond: 10,
            timeoutSec: 30,
            waitTimeoutSec: 60,
            extraArgs: ["-cid_str", cidStr],
          })
          expect(
            r1.stats.successful,
            `INV-2 burst A needs ≥${Math.ceil(N * 0.8)} successful calls, got ${r1.stats.successful}`,
          ).toBeGreaterThanOrEqual(Math.ceil(N * 0.8))

          const decisionsA = yield* fetchRoutingDecisions(NAMESPACE, { since: "120s" })
          const burstA = invitesByCallId(
            decisionsA.filter((d) => d.callId.startsWith(cidPrefix)),
          )
          expect(burstA.size).toBeGreaterThanOrEqual(r1.stats.successful)

          // Quiet window so burst-B's INVITEs are clearly later in the
          // proxy log timeline.
          yield* Effect.sleep("3 seconds")

          // Burst B — same Call-IDs. Worker will reject (dup) so SIPp
          // calls won't complete; we ignore the timeout and parse logs.
          yield* runSippJob({
            namespace: NAMESPACE,
            name: `inv2-${stamp}-b`,
            scenario: "uac-basic.xml",
            target: FRONT_PROXY_VIP_TARGET,
            service: "test",
            calls: N,
            callsPerSecond: 10,
            timeoutSec: 5,
            waitTimeoutSec: 15,
            extraArgs: ["-cid_str", cidStr],
          }).pipe(Effect.ignore)

          // Give the proxy a moment to emit log lines for burst-B.
          yield* Effect.sleep("2 seconds")

          const decisionsB = yield* fetchRoutingDecisions(NAMESPACE, { since: "180s" })
          const onlyB = decisionsB.filter(
            (d) => d.callId.startsWith(cidPrefix) && d.method === "INVITE",
          )
          // Bucket by Call-ID and pick the SECOND INVITE per Call-ID
          // (first comes from burst A, second from burst B). If only
          // one INVITE is present for a Call-ID, burst-B never reached
          // the proxy and the test cannot verify INV-2 for that ID.
          const burstB = new Map<string, string>()
          const seenCounts = new Map<string, number>()
          for (const d of onlyB) {
            const cnt = (seenCounts.get(d.callId) ?? 0) + 1
            seenCounts.set(d.callId, cnt)
            if (cnt === 2) burstB.set(d.callId, d.workerIp)
          }
          // Burst B INVITEs may not all reach the proxy if SIPp dies
          // very early; require at least half of A's set is comparable.
          expect(burstB.size).toBeGreaterThanOrEqual(Math.ceil(burstA.size / 2))

          // Compare burst-A vs burst-B INVITE worker per Call-ID.
          const violators: Array<{ callId: string; a: string; b: string }> = []
          for (const [cid, wA] of burstA) {
            const wB = burstB.get(cid)
            if (wB && wB !== wA) {
              violators.push({ callId: cid, a: wA, b: wB })
            }
          }
          expect(
            violators,
            `INV-2 violation: same Call-ID routed to different workers across bursts:\n${JSON.stringify(
              violators,
              null,
              2,
            )}`,
          ).toEqual([])
        } finally {
          yield* deleteSippJob(NAMESPACE, `inv2-${stamp}-a`).pipe(Effect.ignore)
          yield* deleteSippJob(NAMESPACE, `inv2-${stamp}-b`).pipe(Effect.ignore)
        }
      }),
    { timeout: 180_000 },
  )
})

/**
 * Bucket routing decisions by Call-ID, returning the worker IP that
 * received the FIRST INVITE for each Call-ID. Useful for HRW comparison
 * across runs.
 */
const invitesByCallId = (
  decisions: ReadonlyArray<import("./fixtures/proxyLogs.js").RoutingDecision>,
): Map<string, string> => {
  const out = new Map<string, string>()
  for (const d of decisions) {
    if (d.method !== "INVITE") continue
    if (out.has(d.callId)) continue
    out.set(d.callId, d.workerIp)
  }
  return out
}
