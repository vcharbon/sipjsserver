/**
 * CANCEL (drive-only port for the new harness).
 *
 * Same flow as [tests/scenarios/cancel.ts]:
 *   INVITE → 100 → 180 → CANCEL → 200(CANCEL) → 487
 *
 * Single alice + single leg ServiceCase. Drives only — no inline
 * checks. Slice 4 vertical confirming the harness handles the
 * CANCEL transaction shape.
 */

import { scenario } from "../fullcall/framework/dsl.js"
import { sdpOffer } from "../fullcall/helpers/sdp.js"
import { LabelRegistry, type ScenarioBuildResult, type ScenarioScript } from "../harness/runner.js"

export const cancelCall: ScenarioScript = (sc) => {
  const labels = new LabelRegistry()
  const alice = sc.alices[0]!
  const leg = sc.legs[0]!

  const composable = scenario("cancel", (s) => {
    const a = s.agent(alice.name, { uri: alice.content.fromUri })
    const b = s.agent(leg.name, { uri: `sip:${leg.name}@test`, port: 5666 })

    // Bob will receive ACK for the 487 (RFC 3261 §17.1.1.3 auto-ACK).
    b.allowExtra("ACK")

    const { transaction: aInviteTxn } = a.invite(alice.content.requestUri, {
      body: sdpOffer(),
      skipValidation: ["offerAnswer"],
    })
    labels.set(aInviteTxn.expect(100).id, "alice.expect100")

    const { transaction: bInviteTxn } = b.receiveInitialInvite()
    bInviteTxn.reply(180)
    labels.set(aInviteTxn.expect(180).id, "alice.expect180")

    const aCancelTxn = aInviteTxn.cancel()
    labels.set(aCancelTxn.expect(200).id, "alice.expectCancel200")
    labels.set(aInviteTxn.expect(487).id, "alice.expect487")

    const bCancelTxn = bInviteTxn.expectCancel()
    bCancelTxn.reply(200)
    bInviteTxn.reply(487)
  })

  return { scenario: composable, labels }
}
