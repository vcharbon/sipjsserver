/**
 * Reject + `update_headers` scenarios (Issue 9 of the upstream-consumer
 * plan). Verifies that consumer-supplied headers on a
 * `NewCallRejectResponse` reach the wire on the rejection response we
 * emit toward the A-leg peer.
 *
 * The MockCallControlServer reads the X-Api-Call SIP header to pick the
 * decision; passing `update_headers` through that JSON wires the
 * canonical schema's new slot end-to-end.
 *
 * The matching validator-rejection path (forbidden Via / From in
 * `update_headers`) is covered by the unit tests in
 * `tests/http/forbidden-headers.test.ts`; running it as a full scenario
 * would only re-exercise the adapter → 503 fallback, which the
 * "call control unavailable" path already covers elsewhere.
 */

import { scenario } from "../../src/test-harness/framework/dsl.js"
import { sdpOffer } from "../../src/test-harness/framework/helpers/sdp.js"
import type { SipHeader } from "../../src/sip/types.js"

function findHeader(headers: ReadonlyArray<SipHeader>, name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value
}

const REASON_VALUE = 'SIP ;cause=403;text="Carrier blocked"'

const rejectWithReasonInstruction = JSON.stringify({
  action: "reject",
  reject_code: 403,
  reject_reason: "Forbidden",
  update_headers: {
    Reason: REASON_VALUE,
    "X-Trace-Id": "abc-123",
  },
})

export const rejectWithReasonHeader = scenario(
  "reject-with-reason-header",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })

    const { transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15060",
      {
        body: sdpOffer(),
        skipValidation: ["offerAnswer"],
        headers: { "X-Api-Call": rejectWithReasonInstruction },
      },
    )

    aliceInviteTxn.expect(100)

    aliceInviteTxn.expect(403, {
      predicate: (msg) => {
        if (msg.type !== "response") return false
        if (msg.reason !== "Forbidden") return false
        if (findHeader(msg.headers, "Reason") !== REASON_VALUE) return false
        if (findHeader(msg.headers, "X-Trace-Id") !== "abc-123") return false
        return true
      },
    })
  },
)

const REDIRECT_CONTACT = "<sip:alt@10.0.0.42:5060;transport=udp>"

const reject302WithContactInstruction = JSON.stringify({
  action: "reject",
  reject_code: 302,
  reject_reason: "Moved Temporarily",
  update_headers: {
    Contact: REDIRECT_CONTACT,
  },
})

export const reject302WithContact = scenario(
  "reject-302-with-contact",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })

    const { transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15060",
      {
        body: sdpOffer(),
        skipValidation: ["offerAnswer"],
        headers: { "X-Api-Call": reject302WithContactInstruction },
      },
    )

    aliceInviteTxn.expect(100)

    aliceInviteTxn.expect(302, {
      predicate: (msg) => {
        if (msg.type !== "response") return false
        // Consumer-supplied Contact must override the B2BUA's a-leg contact.
        return findHeader(msg.headers, "Contact") === REDIRECT_CONTACT
      },
    })
  },
)

const FALLBACK_CONTACT = "<sip:fallback@10.0.0.99:5060;transport=udp>"

const reject403WithContactInstruction = JSON.stringify({
  action: "reject",
  reject_code: 403,
  reject_reason: "Forbidden",
  update_headers: {
    Contact: FALLBACK_CONTACT,
  },
})

export const reject403WithContactPassesThrough = scenario(
  "reject-contact-on-4xx-passes-through",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })

    const { transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15060",
      {
        body: sdpOffer(),
        skipValidation: ["offerAnswer"],
        headers: { "X-Api-Call": reject403WithContactInstruction },
      },
    )

    aliceInviteTxn.expect(100)

    // Issue 9 final decision: Contact is allowed on reject UNCONDITIONALLY,
    // no 3xx-family gating. The B2BUA does not police RFC meaningfulness.
    aliceInviteTxn.expect(403, {
      predicate: (msg) => {
        if (msg.type !== "response") return false
        return findHeader(msg.headers, "Contact") === FALLBACK_CONTACT
      },
    })
  },
)
