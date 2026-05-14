/**
 * k8s-register-call-reroute — advanced scenario: alice + bob1 + bob2 with
 * X-Api-Call-driven failover.
 *
 *   alice + bob1 + bob2 each REGISTER.
 *   alice INVITEs sip:bob1@kindlab carrying:
 *       X-Api-Call = { action: route, destination: proxy(core),
 *                      on_failure: { failover, destination: proxy(core),
 *                                    new_ruri: sip:bob2@kindlab } }
 *   proxy(ext) → proxy(core) → k8s-ingress → worker (LB) →
 *         POST /call/new → mock honors X-Api-Call → worker →
 *         INVITE → proxy(core) → proxy(ext) registrar lookup → bob1.
 *   bob1 replies 503 Service Unavailable.
 *   worker → POST /call/failure → mock parses callback_context → returns
 *         failover to proxy(core) with new RURI sip:bob2@kindlab.
 *   worker → INVITE → proxy(core) → proxy(ext) registrar lookup → bob2.
 *   bob2 → 180 → 200 → ACK.
 *   alice BYE → bob2 BYE → 200.
 *
 * Built as a factory so the runner can pass in the proxy(core)
 * advertised address (discovered at test startup, depends on the host's
 * docker-bridge gateway).
 */

import { scenario } from "../../../src/test-harness/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../../../src/test-harness/framework/helpers/sdp.js"

export interface K8sRegisterCallRerouteOpts {
  /**
   * Address of the in-process register-proxy's CORE endpoint, as it
   * must appear in `X-Api-Call.destination` (and `on_failure.destination`).
   * The kind b2bua-worker forwards the b-leg INVITE to this address on
   * real UDP for both the primary attempt and the failover retry.
   */
  readonly proxyCoreAdvertised: { readonly host: string; readonly port: number }
}

export const k8sRegisterCallReroute = (opts: K8sRegisterCallRerouteOpts) =>
  scenario("k8s-register-call-reroute", (s) => {
    // Synthetic ext-fabric addresses. proxy(ext) lives at 5.1.0.1:5060;
    // alice on 5.1.1.x:5060, bobs on 5.1.2.x:5060. Distinct AORs (bob1 /
    // bob2) because the registrar keys on userpart — two `sip:bob@…`
    // would overwrite each other.
    const alice = s.agent("alice", { uri: "sip:alice@kindlab", ip: "5.1.1.1", port: 5060 })
    const bob1 = s.agent("bob1", { uri: "sip:bob1@kindlab", ip: "5.1.2.1", port: 5060 })
    const bob2 = s.agent("bob2", { uri: "sip:bob2@kindlab", ip: "5.1.2.2", port: 5060 })

    // bob1 receives an auto-ACK from the upstream for its 503 (RFC 3261 §17.1.1.3).
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
    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:bob1@kindlab",
      {
        body: sdpOffer(),
        build: () => ({
          headers: {
            "X-Api-Call": JSON.stringify({
              action: "route",
              destination: opts.proxyCoreAdvertised,
              // RURI = sip:bob1@kindlab — proxy looks up "bob1".
              on_failure: {
                action: "failover",
                destination: opts.proxyCoreAdvertised,
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
      "alice REGISTERs, bob1+bob2 REGISTER. alice INVITEs sip:bob1@kindlab " +
        "with X-Api-Call routing primary→proxy(core) + on_failure failover→proxy(core) " +
        "with new_ruri=bob2. bob1 503 → worker /call/failure → re-route to bob2 → 200/ACK/BYE.",
    )
    .tier("short")
    .skipFinalSweep()
