/**
 * k8s-register-call-bye — full happy-path against the kind-deployed
 * SBC stack.
 *
 *   alice REGISTERs → proxy 200 OK
 *   bob   REGISTERs → proxy 200 OK
 *   alice INVITEs sip:bob@kindlab carrying X-Api-Call that points the
 *         b-leg destination at the proxy(core) endpoint (real fabric).
 *   proxy(ext) → proxy(core) → k8s-ingress → worker (LB) →
 *         POST /call/new → mock honors X-Api-Call → worker →
 *         INVITE → proxy(core) → proxy(ext) registrar lookup → bob.
 *   bob   100 → 180 → 200 OK with SDP answer.
 *   alice ACK (relayed to bob).
 *   short hold.
 *   alice BYE → bob 200 OK.
 *
 * Built as a factory so the runner can pass in the proxy(core)
 * advertised address (discovered at test startup, depends on the host's
 * docker-bridge gateway).
 */

import { scenario } from "../../../src/test-harness/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../../../src/test-harness/framework/helpers/sdp.js"

export interface K8sRegisterCallByeOpts {
  /**
   * Address of the in-process register-proxy's CORE endpoint, as it
   * must appear in `X-Api-Call.destination`. The kind b2bua-worker
   * forwards the b-leg INVITE to this address on real UDP. Provided
   * by the runner at test time (depends on the discovered host-
   * reachable IP), so the scenario can't hard-code it.
   */
  readonly proxyCoreAdvertised: { readonly host: string; readonly port: number }
}

export const k8sRegisterCallBye = (opts: K8sRegisterCallByeOpts) =>
  scenario("k8s-register-call-bye", (s) => {
    // Synthetic ext-fabric addresses. proxy(ext) lives at 5.1.0.1:5060;
    // alices on 5.1.1.x:5060, bobs on 5.1.2.x:5060. SIP well-known port
    // is fine — the simulated fabric is in-memory.
    const alice = s.agent("alice", { uri: "sip:alice@kindlab", ip: "5.1.1.1", port: 5060 })
    const bob = s.agent("bob", { uri: "sip:bob@kindlab", ip: "5.1.2.1", port: 5060 })

    // Bob auto-ACKs whatever non-2xx fall through (defensive).
    bob.allowExtra("ACK")

    alice.register({ expires: 3600 }).expect(200)
    bob.register({ expires: 3600 }).expect(200)

    s.pause(50)

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:bob@kindlab",
      {
        body: sdpOffer(),
        build: () => ({
          headers: {
            "X-Api-Call": JSON.stringify({
              action: "route",
              destination: opts.proxyCoreAdvertised,
              // Keep RURI as `sip:bob@kindlab` — the register-proxy
              // will run a registrar lookup on userpart "bob" and
              // forward.
            }),
          },
        }),
      },
    )

    aliceInviteTxn.expect(100)

    const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()
    bobInviteTxn.reply(180)
    aliceInviteTxn.expect(180)
    bobInviteTxn.reply(200, { body: sdpAnswer() })
    aliceInviteTxn.expect(200)

    aliceDialog.ack()
    bobDialog.expect("ACK")

    s.pause(200)

    const aliceByeTxn = aliceDialog.bye()
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
  })
    .describe(
      "Full happy path against the kind-deployed SBC: alice + bob REGISTER, " +
        "alice INVITEs bob via X-Api-Call routing, BYE cleanly.",
    )
    .tier("short")
    .skipFinalSweep()
