/**
 * HA SUT scenario — two calls routed to two distinct B2BUA workers.
 *
 * Topology: `sipproxyHA` SUT (proxy + 2 B2BUAs, OPTIONS keepalive
 * wired). Both workers admit as `unknown` (MS-1) — the scenario
 * `s.pause(5000)` lets the OPTIONS round-trip transition them to
 * `alive` before the first INVITE.
 *
 * The two calls use **pre-computed Call-IDs** whose HRW rendezvous
 * winners are deterministically `b2b-1` and `b2b-2`. With only two
 * workers, brute-forcing two consecutive integers reliably hits one
 * of each. The constants below were obtained by:
 *
 *     const score64 = (key, id) => {
 *       const h = createHash("sha1").update(`${key}:${id}`).digest()
 *       let acc = 0n
 *       for (let i = 0; i < 8; i++) acc = (acc << 8n) | BigInt(h[i])
 *       return acc
 *     }
 *     const winner = (cid) =>
 *       score64(cid, "b2b-1") > score64(cid, "b2b-2") ? "b2b-1" : "b2b-2"
 *     // ha-call-0@alice → b2b-1
 *     // ha-call-1@alice → b2b-2
 *
 * `tests/sip-front-proxy/load-balancer/callid-routing-guard.test.ts`
 * re-derives the routing under the real LoadBalancer's `rendezvousSelect`
 * and fails loudly if these constants ever rot.
 *
 * BYE direction is mixed across the two calls so both proxy in-dialog
 * paths are exercised in one scenario:
 *
 *   - Call 1 (alice-1 → b2b-1 → bob-1): alice-1 sends BYE.
 *     Forward in-dialog path — proxy sees a request from a UAC, routes
 *     by Route header to the originating B2BUA.
 *   - Call 2 (alice-2 → b2b-2 → bob-2): bob-2 sends BYE.
 *     Cookie-decode in-dialog path — proxy sees a BYE from the B-leg,
 *     decodes the stickiness cookie stamped during the original INVITE,
 *     routes back to b2b-2.
 *
 * Sequential — concurrency under TestClock is the next slice's concern.
 */

import { scenario } from "../../../src/test-harness/framework/dsl.js"
import {
  HA_PROXY_ADDR,
  haAliceIp,
  haBobIp,
} from "../../support/proxyB2bFakeStack.js"
import { basicCallBody } from "../basic-call.js"

/** Pre-computed Call-ID — HRW winner is `b2b-1` under the {b2b-1, b2b-2} set. */
export const CALLID_TO_W1 = "ha-call-0@alice"
/** Pre-computed Call-ID — HRW winner is `b2b-2` under the {b2b-1, b2b-2} set. */
export const CALLID_TO_W2 = "ha-call-1@alice"

export const twoCallsRoutedToTwoWorkers = scenario(
  "two-calls-routed-to-two-workers",
  (s) => {
    // Settle: workers are admitted to the proxy registry as `unknown`
    // (MS-1). HealthProbe (every 2s) flips them to `alive` after the
    // first 200 OK to OPTIONS. 5s of virtual time ≥ 2 probe ticks per
    // worker, comfortably clear of the 1.5s probe timeout.
    s.pause(5000)

    // Call 1 — alice-1 → b2b-1 → bob-1. Alice initiates the BYE
    // (forward in-dialog path through the proxy).
    basicCallBody(s, {
      aliceName: "alice-1",
      bobName: "bob-1",
      aliceHost: haAliceIp(1),
      bobHost: haBobIp(1),
      bobPort: 5060,
      proxyHost: HA_PROXY_ADDR.host,
      proxyPort: HA_PROXY_ADDR.port,
      callId: CALLID_TO_W1,
      byeFrom: "alice",
    })

    // Call 2 — alice-2 → b2b-2 → bob-2. Bob initiates the BYE
    // (cookie-decode in-dialog path back through the proxy).
    basicCallBody(s, {
      aliceName: "alice-2",
      bobName: "bob-2",
      aliceHost: haAliceIp(2),
      bobHost: haBobIp(2),
      bobPort: 5060,
      proxyHost: HA_PROXY_ADDR.host,
      proxyPort: HA_PROXY_ADDR.port,
      callId: CALLID_TO_W2,
      byeFrom: "bob",
    })
  },
)
  .runOn(["sipproxyHA"])
  // Skip the post-scenario 24h TestClock sweep + verifyCleanState.
  // Under sipproxyHA, the OPTIONS health probe runs every 2s for both
  // workers — a 24h sweep would generate ~85k OPTIONS exchanges and
  // any transient timing window where a worker binding is unavailable
  // would be amplified into hundreds of "undeliverable" entries.
  // verifyCleanState's CallState/TimerService check is also misleading
  // here because the harness only inspects the primary worker's
  // services (the secondary worker's are hidden in a forked scope).
  // HA-specific cleanliness assertions belong in dedicated HA scenarios.
  .skipFinalSweep()
  .title("HA: two calls routed to two workers (alice-BYE + bob-BYE)")
