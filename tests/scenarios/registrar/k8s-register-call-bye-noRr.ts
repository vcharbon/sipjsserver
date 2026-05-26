/**
 * k8s-register-call-bye-noRr — full happy-path against the kind-deployed
 * SBC stack with the registrar proxy in NON-RECORD-ROUTING mode.
 *
 * Same call flow as `k8s-register-call-bye.ts` (alice REGISTER, bob
 * REGISTER, alice INVITE → proxy(ext) → cluster → b-leg INVITE →
 * proxy(core) → bob, dialog setup, BYE), but the proxy does NOT stamp
 * Record-Route. The intent is to assert wire-level interoperability with
 * the kind b2bua under no-RR; in-dialog ACK / BYE delivery between
 * alice and the b2bua then depends on the b2bua's own Record-Route
 * insertion (it's the B2BUA, so it does), and ACK to bob bypasses our
 * proxy entirely.
 *
 * The new fabric topology is **all-real, single-fabric**: alice/bob and
 * both proxy endpoints all bind on real UDP at the docker bridge
 * gateway IP so the b2bua in kind can reach every participant directly.
 * Per-agent ports are passed in by the runner.
 *
 * Built as a factory so the runner can pass:
 *   - `proxyCoreAdvertised` — proxy(core)'s real UDP address (the
 *     `X-Api-Call.destination` the kind worker uses for the b-leg).
 *   - `aliceIp` / `bobIp` — both equal to the bridge-gateway IP under
 *     the all-real-fabric topology; spelled out as separate fields so
 *     the test can also wire NAT-style setups in the future.
 *   - `alicePort` / `bobPort` — distinct kernel-bound ports on the host.
 */

import { scenario } from "../../../src/test-harness/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../../../src/test-harness/framework/helpers/sdp.js"

export interface K8sRegisterCallByeNoRrOpts {
  readonly proxyCoreAdvertised: { readonly host: string; readonly port: number }
  readonly aliceIp: string
  readonly alicePort: number
  readonly bobIp: string
  readonly bobPort: number
}

export const k8sRegisterCallByeNoRr = (opts: K8sRegisterCallByeNoRrOpts) =>
  scenario("k8s-register-call-bye-noRr", (s) => {
    // Real-UDP bind addresses — must be routable from the kind cluster
    // so the b-leg INVITE the b2bua-worker generates can reach bob and
    // the in-dialog requests (ACK/BYE) sent peer-to-peer via Contact
    // can reach the right endpoints.
    const alice = s.agent("alice", {
      uri: "sip:alice@kindlab",
      ip: opts.aliceIp,
      port: opts.alicePort,
    })
    const bob = s.agent("bob", {
      uri: "sip:bob@kindlab",
      ip: opts.bobIp,
      port: opts.bobPort,
    })

    bob.allowExtra("ACK")

    alice.register({ expires: 3600 }).expect(200)
    bob.register({ expires: 3600 }).expect(200)

    s.pause(50)

    // RURI host:port points at proxy(core) because the in-cluster
    // worker's outbound proxy strips self-Route and falls back to the
    // RURI host. `kindlab` isn't resolvable inside the cluster — the
    // wire-level target must be a real address.
    const bobRuri = `sip:bob@${opts.proxyCoreAdvertised.host}:${opts.proxyCoreAdvertised.port}`

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:bob@kindlab",
      {
        body: sdpOffer(),
        build: () => ({
          headers: {
            "X-Api-Call": JSON.stringify({
              action: "route",
              destination: opts.proxyCoreAdvertised,
              new_ruri: bobRuri,
            }),
            "X-Full-Trace-Sample-Rate": "1.0",
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

    s.pause(200)
  })
    .describe(
      "Non-record-routing variant of k8s-register-call-bye: same flow, " +
        "but proxy(ext)/(core) does NOT stamp Record-Route; in-dialog " +
        "ACK/BYE traverse the b2bua's RR (not ours).",
    )
    .tier("short")
