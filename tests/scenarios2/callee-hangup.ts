/**
 * Callee-hangup (drive-only port for the new harness).
 *
 * Same flow as [tests/scenarios/bye-directions.ts] calleeHangup:
 *   alice INVITE → bob 180/200 → alice ACK → bob BYE → alice 200.
 *
 * Confirms the harness handles BYE in the reverse direction (callee
 * → caller).
 */

import { scenario } from "../../src/test-harness/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../../src/test-harness/framework/helpers/sdp.js"
import { LabelRegistry, type ScenarioBuildResult, type ScenarioScript } from "../harness/runner.js"

export const calleeHangup: ScenarioScript = (sc) => {
  const labels = new LabelRegistry()
  const alice = sc.alices[0]!
  const leg = sc.legs[0]!

  const composable = scenario("callee-hangup", (s) => {
    const a = s.agent(alice.name, { uri: alice.content.fromUri })
    const b = s.agent(leg.name, { uri: `sip:${leg.name}@test`, port: 5666 })

    const { dialog: aDialog, transaction: aInviteTxn } = a.invite(alice.content.requestUri, {
      body: sdpOffer(),
    })
    labels.set(aInviteTxn.expect(100).id, "alice.expect100")
    const { dialog: bDialog, transaction: bInviteTxn } = b.receiveInitialInvite()
    bInviteTxn.reply(180)
    labels.set(aInviteTxn.expect(180).id, "alice.expect180")
    bInviteTxn.reply(200, { body: sdpAnswer() })
    labels.set(aInviteTxn.expect(200).id, "alice.expect200")
    aDialog.ack()
    bDialog.expect("ACK")

    // Callee initiates BYE.
    const bByeTxn = bDialog.bye()
    const aByeTxn = aDialog.expect("BYE")
    aByeTxn.reply(200)
    bByeTxn.expect(200)
  })

  return { scenario: composable, labels }
}
