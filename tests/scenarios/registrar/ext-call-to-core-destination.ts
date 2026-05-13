/**
 * ext-call-to-core-destination — Alice on `ext` registers, then places
 * an INVITE that the registrar proxy unconditionally forwards to its
 * configured `coreDestination` (the K8s app server in production). A
 * stand-in `bobCore` agent bound at exactly `CORE_DESTINATION` receives
 * the INVITE, replies 180 + 200 (with SDP), and Alice completes the
 * dialog with ACK and a caller-initiated BYE.
 *
 * Verifies the **headline ext→core forwarding path**:
 *   - `ProxyCore.handleRequestRegistrarMode` for `INVITE on ext` picks
 *     `target = registrarCfg.coreDestination` (no registrar lookup —
 *     ext-side INVITEs always bound for core in v1).
 *   - Egress Via stamped `;net=ext` → response routes back to the ext
 *     endpoint so Alice receives the 200 OK on her ext socket.
 *   - Record-Route inserted on the egress side advertises `coreAdvertised`
 *     so bobCore's view of the dialog has a route set anchored at the
 *     proxy's core ingress.
 *   - In-dialog BYE arrives on the ext endpoint, dispatched via the
 *     "opposite-of-ingress" rule to the core endpoint with target =
 *     parsed RURI (= bobCore's contact). Response routes back across
 *     the fabric boundary the same way as the 200 OK.
 *
 * Two-network scenario — Alice on `ext`, bobCore on `core`. The HTML
 * report has two lanes (ext gray, core amber) with the cross-fabric
 * hops painted by the proxy participants `proxy(ext)` and `proxy(core)`.
 */

import { scenario } from "../../../src/test-harness/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../../../src/test-harness/framework/helpers/sdp.js"
import {
  CORE_DESTINATION,
  EXT_INGRESS,
  extIp,
} from "../../support/registrarFrontProxyFakeStack.js"

export const extCallToCoreDestination = scenario(
  "ext-call-to-core-destination",
  (s) => {
    const alice = s.agent("alice", {
      uri: "sip:alice@example.test",
      ip: extIp(1),
      network: "ext",
    })
    // bobCore must bind at the exact `CORE_DESTINATION` (host + port) so
    // packets the proxy forwards on its core endpoint actually land on
    // his socket. In production this would be the K8s app server.
    const bobCore = s.agent("bobCore", {
      uri: "sip:bob@k8s.example.test",
      ip: CORE_DESTINATION.host,
      port: CORE_DESTINATION.port,
      network: "core",
    })

    // 1. Alice registers — registrar grants the default 3600s.
    alice.register().expect(200)

    // 2. Alice INVITEs through the proxy. The Request-URI userpart is
    //    not consulted on the ext-INVITE path (proxy unconditionally
    //    forwards to coreDestination); we still address the proxy's
    //    ext ingress explicitly for shape parity with a real UA.
    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      `sip:bob@${EXT_INGRESS.host}:${EXT_INGRESS.port}`,
      { body: sdpOffer() },
    )

    // 3. bobCore (at CORE_DESTINATION) receives the forwarded INVITE.
    const { dialog: bobDialog, transaction: bobInviteTxn } = bobCore.receiveInitialInvite()

    bobInviteTxn.reply(180)
    aliceInviteTxn.expect(180)

    bobInviteTxn.reply(200, { body: sdpAnswer() })
    aliceInviteTxn.expect(200)

    aliceDialog.ack()
    bobDialog.expect("ACK")

    s.pause(1000)

    // 4. Alice hangs up — BYE crosses ext→core through the proxy, 200
    //    crosses core→ext on the way back.
    const aliceByeTxn = aliceDialog.bye()
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
  },
)
  .describe(
    "Alice (registered on ext) places a call through the registrar " +
      "front proxy. The proxy forwards her INVITE to its hardcoded " +
      "coreDestination, where bobCore receives it. Full ext↔core call " +
      "lifecycle (INVITE/180/200/ACK/BYE/200) round-trips across the " +
      "proxy with `;net=` Via tagging steering responses back to ext.",
  )
  .runOn(["registrarFrontProxy"])
  .title("registrar: ext→core call (alice → proxy → bobCore@coreDestination)")
