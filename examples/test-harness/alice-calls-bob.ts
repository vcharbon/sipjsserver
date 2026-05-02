/**
 * examples/test-harness/alice-calls-bob.ts
 *
 * Minimal example scenario for `@vcharbon/sipjs/test-harness`.
 *
 * Demonstrates the load-bearing surface a consumer needs:
 *   - `scenario(name, builder)` — declarative DSL
 *   - `s.agent(name, { uri, ip, port })` — declare a fake SIP UA
 *   - `agent.register()` — REGISTER and expect 200 OK
 *   - `agent.invite(other)` — send INVITE, returns a Call handle
 *   - `call.expect(status)` / `call.bye()` — assertions + termination
 *
 * Wire this into a vitest suite using `createRegistrarTestProxyRunner`.
 * See `docs/external-usage/test-harness.md` for the full setup.
 */

import { scenario } from "@vcharbon/sipjs/test-harness"

export const aliceCallsBob = scenario(
  "alice calls bob through the SUT",
  (s) => {
    const alice = s.agent("alice", {
      uri: "sip:alice@example.test",
      ip: "127.0.0.1",
      port: 0,
    })
    const bob = s.agent("bob", {
      uri: "sip:bob@example.test",
      ip: "127.0.0.1",
      port: 0,
    })

    alice.register()
    bob.register()

    const { dialog, transaction } = alice.invite("sip:bob@example.test")
    transaction.expect(200)
    dialog.ack()
    dialog.bye()
  },
).describe(
  "Smallest happy-path call: both agents register, alice invites bob, " +
    "bob auto-answers (200 OK), alice hangs up. Exercises REGISTER + " +
    "INVITE/200/ACK + BYE/200 against your SUT's call routing.",
)
