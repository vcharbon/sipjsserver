/**
 * k8s-register-call-reroute — advanced scenario: alice + bob1 + bob2 with
 * X-Api-Call-driven failover.
 *
 *   alice + bob1 + bob2 each REGISTER.
 *   alice INVITEs sip:bob@kindlab carrying:
 *       X-Api-Call = { action: route, destination: bob1, on_failure: { failover, destination: bob2 } }
 *   proxy → worker → POST /call/new → mock honors X-Api-Call → worker → INVITE → bob1.
 *   bob1 replies 503 Service Unavailable.
 *   worker → POST /call/failure → mock parses callback_context → returns failover to bob2.
 *   worker → INVITE → bob2 → 180 → 200 → ACK.
 *   alice BYE → bob2 BYE → 200.
 *
 * Demonstrates b-leg failover routing through the real kind stack; the
 * destinations are computed at INVITE time from the registry so the
 * scenario doesn't bake in the host gateway IP.
 */

import { scenario } from "../../fullcall/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../../fullcall/helpers/sdp.js"

const ALICE_PORT = 25062
const BOB1_PORT = 25063
const BOB2_PORT = 25064

export const k8sRegisterCallReroute = scenario("k8s-register-call-reroute", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@kindlab", port: ALICE_PORT })
  const bob1 = s.agent("bob1", { uri: "sip:bob1@kindlab", port: BOB1_PORT })
  const bob2 = s.agent("bob2", { uri: "sip:bob2@kindlab", port: BOB2_PORT })

  // bob1 will receive an auto-ACK from the worker for its 503 (RFC 3261 §17.1.1.3).
  bob1.allowExtra("ACK")

  alice.register({ expires: 3600 }).expect(200)
  bob1.register({ expires: 3600 }).expect(200)
  bob2.register({ expires: 3600 }).expect(200)

  s.pause(50)

  // Both the primary route and the on_failure failover target the
  // register-proxy's CORE endpoint. The proxy's registrar resolves
  // each AOR (`bob1` → bob1's contact, `bob2` → bob2's contact) and
  // forwards on the EXT side. The b2bua-worker's only job is to swap
  // RURI between attempts and re-route to the proxy.
  const PROXY_CORE_PORT = 25081
  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
    "sip:bob1@kindlab",
    {
      body: sdpOffer(),
      build: (ctx) => ({
        headers: {
          "X-Api-Call": JSON.stringify({
            action: "route",
            destination: { host: ctx.agent("alice").ip, port: PROXY_CORE_PORT },
            // RURI = sip:bob1@kindlab — proxy looks up "bob1".
            on_failure: {
              action: "failover",
              destination: { host: ctx.agent("alice").ip, port: PROXY_CORE_PORT },
              new_ruri: "sip:bob2@kindlab",
            },
          }),
        },
      }),
    },
  )

  aliceInviteTxn.expect(100)

  // bob1 receives, rejects 503.
  const { transaction: bob1InviteTxn } = bob1.receiveInitialInvite()
  bob1InviteTxn.reply(503)

  // bob2 receives the rerouted INVITE.
  const { dialog: bob2Dialog, transaction: bob2InviteTxn } = bob2.receiveInitialInvite()
  bob2InviteTxn.reply(180)
  aliceInviteTxn.expect(180)
  bob2InviteTxn.reply(200, { body: sdpAnswer() })
  aliceInviteTxn.expect(200)

  aliceDialog.ack()
  bob2Dialog.expect("ACK")

  s.pause(200)

  const aliceByeTxn = aliceDialog.bye()
  const bob2ByeTxn = bob2Dialog.expect("BYE")
  bob2ByeTxn.reply(200)
  aliceByeTxn.expect(200)
})
  .describe(
    "alice REGISTERs, bob1+bob2 REGISTER. alice INVITEs sip:bob@kindlab " +
      "with X-Api-Call routing primary→bob1 + on_failure failover→bob2. " +
      "bob1 503 → worker /call/failure → re-route to bob2 → 200/ACK/BYE.",
  )
  .tier("short")
  .skipFinalSweep()
