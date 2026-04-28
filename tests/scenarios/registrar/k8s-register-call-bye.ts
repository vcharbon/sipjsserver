/**
 * k8s-register-call-bye — full happy-path against the kind-deployed
 * SBC stack.
 *
 *   alice REGISTERs → proxy 200 OK
 *   bob   REGISTERs → proxy 200 OK
 *   alice INVITEs sip:bob@kindlab carrying X-Api-Call that points the
 *         b-leg destination at bob's host-reachable address+port.
 *   proxy → worker (LB) → POST /call/new → mock honors X-Api-Call →
 *         worker → INVITE → bob.
 *   bob   100 → 180 → 200 OK with SDP answer.
 *   alice ACK (relayed to bob).
 *   short hold.
 *   alice BYE → bob 200 OK.
 *
 * The X-Api-Call destination is computed at INVITE time from the agent
 * registry so the test doesn't have to know bob's host IP at module-
 * load time — the hybrid runner injects the kind-bridge gateway IP into
 * each agent's `agentInfo.ip` via `transportAdvertisedIp`.
 */

import { scenario } from "../../fullcall/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../../fullcall/helpers/sdp.js"

const ALICE_PORT = 25060
const BOB_PORT = 25061

export const k8sRegisterCallBye = scenario("k8s-register-call-bye", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@kindlab", port: ALICE_PORT })
  const bob = s.agent("bob", { uri: "sip:bob@kindlab", port: BOB_PORT })

  // Bob auto-ACKs whatever non-2xx fall through (defensive).
  bob.allowExtra("ACK")

  alice.register({ expires: 3600 }).expect(200)
  bob.register({ expires: 3600 }).expect(200)

  s.pause(50)

  // X-Api-Call destination = the in-process register-proxy's CORE
  // endpoint. The k8s b2bua-worker forwards the b-leg INVITE there and
  // the register-proxy then resolves bob via its in-memory registrar
  // and forwards on its EXT endpoint to bob's host:port. This keeps the
  // proxy↔k8s exchange visible on the report's `core` lane while
  // alice↔proxy / bob↔proxy live on the `ext` lane.
  const PROXY_CORE_PORT = 25081
  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
    "sip:bob@kindlab",
    {
      body: sdpOffer(),
      build: (ctx) => ({
        headers: {
          "X-Api-Call": JSON.stringify({
            action: "route",
            destination: { host: ctx.agent("alice").ip, port: PROXY_CORE_PORT },
            // Keep RURI as `sip:bob@kindlab` — the register-proxy will
            // run a registrar lookup on userpart "bob" and forward.
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
