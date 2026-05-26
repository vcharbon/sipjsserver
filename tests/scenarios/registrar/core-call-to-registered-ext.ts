/**
 * core-call-to-registered-ext — bobExt registers, then a `core` agent
 * (representing the K8s app server) sends an INVITE for `sip:bob@…`
 * to the proxy's core ingress. The proxy's `CoreToExtRoutingStrategy.
 * registrarLookup` resolves the userpart against the in-memory registrar
 * and forwards the INVITE across the fabric boundary to bobExt's stored
 * Contact host/port. The original Request-URI is preserved on the
 * outbound INVITE. bobExt replies 180 + 200 (with SDP), and the
 * core-side caller completes the dialog with ACK and BYE.
 *
 * Verifies the **headline core→ext forwarding path**:
 *   - `ProxyCore.handleRequestRegistrarMode` for `INVITE on core`
 *     delegates to `coreToExtStrategy.resolve`.
 *   - `registrarLookup` extracts the RURI userpart, pulls bob's binding
 *     out of the shared `Registrar` and returns `forward { destination }`.
 *   - Egress Via stamped `;net=core` → response routes back to the
 *     core endpoint so the K8s caller receives the 200 OK on its core
 *     socket.
 *   - Record-Route advertises `extAdvertised` so bobExt's view of the
 *     dialog has a route set pointing at the proxy's ext ingress.
 *   - The flip-side of `ext-call-to-core-destination`: in-dialog BYE
 *     arrives on the core endpoint, dispatched via the "opposite-of-
 *     ingress" rule to the ext endpoint with target = parsed RURI
 *     (= bobExt's contact).
 *
 * Two-network scenario — `aliceCore` on `core`, `bobExt` on `ext`. The
 * HTML report has two lanes painted by the proxy participants
 * `proxy(ext)` (gray) and `proxy(core)` (amber).
 */

import { scenario } from "../../../src/test-harness/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../../../src/test-harness/framework/helpers/sdp.js"
import {
  CORE_INGRESS,
  coreIp,
  extIp,
} from "../../support/registrarFrontProxyFakeStack.js"

export const coreCallToRegisteredExt = scenario(
  "core-call-to-registered-ext",
  (s) => {
    // bobExt: ordinary external user; registers with the proxy so the
    // K8s side can later reach him by AOR userpart.
    const bobExt = s.agent("bobExt", {
      uri: "sip:bob@example.test",
      ip: extIp(2),
      network: "ext",
    })
    // aliceCore: stand-in for the K8s app server originating an
    // inbound call. Its `network: "core"` makes the harness send
    // initial INVITEs to the proxy's CORE ingress.
    const aliceCore = s.agent("aliceCore", {
      uri: "sip:alice@k8s.example.test",
      ip: coreIp(1),
      network: "core",
    })

    // 1. bobExt registers — registrar stores his Contact under userpart
    //    `bob`, default 3600s lifetime.
    bobExt.register().expect(200)

    // 2. aliceCore INVITEs `sip:bob@<core-ingress>`. The proxy's
    //    `registrarLookup` strategy resolves `bob` to bobExt's Contact
    //    and forwards across the fabric boundary.
    const { dialog: aliceDialog, transaction: aliceInviteTxn } = aliceCore.invite(
      `sip:bob@${CORE_INGRESS.host}:${CORE_INGRESS.port}`,
      { body: sdpOffer() },
    )

    // 3. bobExt receives the forwarded INVITE on his ext socket.
    const { dialog: bobDialog, transaction: bobInviteTxn } = bobExt.receiveInitialInvite()

    bobInviteTxn.reply(180)
    aliceInviteTxn.expect(180)

    bobInviteTxn.reply(200, { body: sdpAnswer() })
    aliceInviteTxn.expect(200)

    aliceDialog.ack()
    bobDialog.expect("ACK")

    s.pause(1000)

    // 4. aliceCore hangs up — BYE crosses core→ext through the proxy,
    //    200 crosses ext→core on the way back.
    const aliceByeTxn = aliceDialog.bye()
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
  },
)
  .describe(
    "bobExt registers; the K8s core sends an INVITE for `sip:bob@…` " +
      "into the proxy's core ingress. The proxy looks bob up in the " +
      "in-memory registrar, rewrites the RURI to his Contact, and " +
      "forwards across to ext. Full core↔ext call lifecycle (INVITE/180/" +
      "200/ACK/BYE/200) round-trips, with `;net=core` Via tagging " +
      "steering responses back to the core endpoint.",
  )
  .runOn(["registrarFrontProxy"])
  .title("registrar: core→ext call (aliceCore → proxy registrar lookup → bobExt)")
