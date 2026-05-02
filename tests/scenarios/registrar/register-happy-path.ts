/**
 * register-happy-path — Alice REGISTERs with the front proxy in
 * registrar mode and gets a 200 OK that echoes her Contact and the
 * default `Expires: 3600` the registrar applied.
 *
 * Slice 3 of `docs/plan/register-and-double-stack-bright-panda.md`.
 *
 * Single-network scenario — Alice lives on `ext`. The trace has just
 * two entries (REGISTER → 200 OK) but the lane on the HTML report
 * carries the `ext` network tag end-to-end.
 */

import { scenario } from "../../../src/test-harness/framework/dsl.js"
import { extIp } from "../../support/registrarFrontProxyFakeStack.js"
import type { SipHeader } from "../../../src/sip/types.js"

function getHeader(headers: ReadonlyArray<SipHeader>, name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value
}

export const registerHappyPath = scenario("register-happy-path", (s) => {
  const alice = s.agent("alice", {
    uri: "sip:alice@example.test",
    ip: extIp(1),
    network: "ext",
  })

  const txn = alice.register()

  // 200 OK with echoed Contact and `Expires: 3600` (the registrar default
  // when the REGISTER carries neither an `Expires` header nor a
  // `;expires=N` Contact param).
  // The echoed Contact carries Alice's wire-level address (IP:port) —
  // that's what the registrar stores per RFC 3261 §10.3 — not the AOR
  // userpart. Verify the address shape and that `Expires=3600` was applied.
  txn.expect(200, {
    predicate: (msg) => {
      if (msg.type !== "response") return false
      const expires = getHeader(msg.headers, "expires")
      const contact = getHeader(msg.headers, "contact")
      return (
        expires === "3600" &&
        contact !== undefined &&
        contact.includes(extIp(1)) &&
        contact.includes("expires=3600")
      )
    },
  })
})
  .describe(
    "Alice REGISTERs with the registrar front proxy. The proxy's " +
      "inMemoryRegistrar strategy stores the binding and returns 200 OK " +
      "with the Contact echoed and the default Expires=3600 applied.",
  )
  .runOn(["registrarFrontProxy"])
