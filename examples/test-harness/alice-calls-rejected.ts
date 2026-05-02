/**
 * examples/test-harness/alice-calls-rejected.ts
 *
 * Example scenario asserting that the SUT rejects a call to an
 * unregistered AOR with a configurable failure status.
 *
 * Showcases:
 *   - `call.expect(statusCode, { predicate })` — assertion on the
 *     response with a custom predicate (here: status code 4xx OR a
 *     specific Reason header).
 */

import { scenario } from "@vcharbon/sipjs/test-harness"

export const aliceCallsRejected = scenario(
  "alice calls an unregistered URI — SUT rejects",
  (s) => {
    const alice = s.agent("alice", {
      uri: "sip:alice@example.test",
      ip: "127.0.0.1",
      port: 0,
    })
    alice.register()

    // ghost intentionally does NOT exist as an agent — alice INVITEs
    // an unregistered URI and we expect a 4xx/5xx final response.
    const { transaction } = alice.invite("sip:ghost@example.test")
    transaction.expect(404, {
      predicate: (msg) => {
        if (msg.type !== "response") return false
        return msg.status >= 400 && msg.status < 600
      },
    })
  },
).describe(
  "alice tries to call ghost (never registered). Expect any 4xx or 5xx " +
    "final response from the SUT (e.g. 404 Not Found, 480 Temporarily " +
    "Unavailable, 503 Service Unavailable depending on routing policy).",
)
