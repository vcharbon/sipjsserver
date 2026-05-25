/**
 * Verifies TransactionLayer.sendRequest returns a typed
 * ClientTransactionHandle with the Via branch, original request, and
 * destination populated. Consumed by generator-based CANCEL / ACK-for-2xx
 * call sites in later slices.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TransactionLayer } from "../../src/sip/TransactionLayer.js"
import { fakeStackLayer } from "../support/fakeStack.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"
import type { SipRequest } from "../../src/sip/types.js"
import { hydrateRequest } from "../../src/sip/parsers/extract-fields.js"

function makeOutboundRequest(method: "INVITE" | "BYE", branch: string): SipRequest {
  return hydrateRequest({
    method,
    uri: "sip:bob@192.0.2.20:5060",
    headers: [
      { name: "Via", value: `SIP/2.0/UDP 127.0.0.1:15070;branch=${branch}` },
      { name: "Max-Forwards", value: "70" },
      { name: "From", value: "<sip:b2bua@127.0.0.1:15070>;tag=b2bua-tag" },
      { name: "To", value: "<sip:bob@192.0.2.20:5060>" },
      { name: "Call-ID", value: "handle-shape-test" },
      { name: "CSeq", value: `1 ${method}` },
      { name: "Contact", value: "<sip:b2bua@127.0.0.1:15070>" },
      { name: "Content-Length", value: "0" },
    ],
    body: new Uint8Array(0),
    raw: Buffer.alloc(0),
  })
}

describe("TransactionLayer handle shape", () => {
  it.effect("sendRequest('invite') returns InviteClientTransactionHandle with the INVITE's branch and request", () =>
    Effect.gen(function* () {
      const txn = yield* TransactionLayer
      const branch = "z9hG4bKhandle-invite"
      const invite = makeOutboundRequest("INVITE", branch)

      const handle = yield* txn.sendRequest(invite, { host: "192.0.2.20", port: 5060 }, "invite")

      expect(handle.kind).toBe("invite")
      expect(handle.branch).toBe(branch)
      expect(handle.destination).toEqual({ host: "192.0.2.20", port: 5060 })
      if (handle.kind === "invite") {
        expect(handle.originalInvite).toBe(invite)
      }
    }).pipe(
      Effect.provide(
        fakeStackLayer({
          config: testAppConfigDefaults({ sipLocalIp: "127.0.0.1", sipLocalPort: 15070 }),
        }),
      ),
    ),
  )

  it.effect("sendRequest('non-invite') returns NonInviteClientTransactionHandle", () =>
    Effect.gen(function* () {
      const txn = yield* TransactionLayer
      const branch = "z9hG4bKhandle-bye"
      const bye = makeOutboundRequest("BYE", branch)

      const handle = yield* txn.sendRequest(bye, { host: "192.0.2.20", port: 5060 }, "non-invite")

      expect(handle.kind).toBe("non-invite")
      expect(handle.branch).toBe(branch)
      expect(handle.destination).toEqual({ host: "192.0.2.20", port: 5060 })
      if (handle.kind === "non-invite") {
        expect(handle.originalRequest).toBe(bye)
      }
    }).pipe(
      Effect.provide(
        fakeStackLayer({
          config: testAppConfigDefaults({ sipLocalIp: "127.0.0.1", sipLocalPort: 15070 }),
        }),
      ),
    ),
  )
})
