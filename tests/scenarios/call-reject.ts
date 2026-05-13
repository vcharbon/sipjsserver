/**
 * Call rejection scenario: INVITE to +403xxx → 100 → 403 Forbidden
 *
 * Tests the MockCallControlServer reject path — dialing a +403 number
 * returns action: "reject" with code 403.
 */

import { scenario } from "../../src/test-harness/framework/dsl.js"
import { sdpOffer } from "../../src/test-harness/framework/helpers/sdp.js"

export const callReject = scenario("call-reject", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  // No bob agent needed — the call is rejected before reaching a B-leg

  // Alice sends INVITE to a +403 number (triggers reject in MockCallControlServer).
  // Call is rejected with 403 before any answer — offer is never answered by design.
  const { transaction: aliceInviteTxn } = alice.invite("sip:+4031234@127.0.0.1:15060", {
    body: sdpOffer(),
    skipValidation: ["offerAnswer"],
  })

  // Alice receives 100 Trying
  aliceInviteTxn.expect(100)

  // Alice receives 403 Forbidden
  aliceInviteTxn.expect(403, {
    predicate: (msg) => msg.reason === "Forbidden",
  })
}).title("call rejection (403)")
