/**
 * basic-call (drive-only port for the new harness).
 *
 * The script receives a ServiceCase and parameterizes the scenario
 * agents/URIs from it. `.expect()` is wait-only — every inline
 * validation has been moved into the rule packs (see tests/harness/rules).
 *
 * Labels attached to specific expects/sends propagate into the
 * CallRecording so service-case rules can identify the messages they
 * need to check.
 */

import { scenario } from "../fullcall/framework/dsl.js"
import { sdpAnswer, sdpOffer } from "../fullcall/helpers/sdp.js"
import { LabelRegistry, type ScenarioBuildResult, type ScenarioScript } from "../harness/runner.js"

export const basicCall: ScenarioScript = (sc) => {
  const labels = new LabelRegistry()
  const alice = sc.alices[0]!
  const leg = sc.legs[0]!

  const composable = scenario("basic-call", (s) => {
    const a = s.agent(alice.name, { uri: alice.content.fromUri })
    const b = s.agent(leg.name, { uri: `sip:${leg.name}@test`, port: 5666 })

    const { dialog: aDialog, transaction: aInviteTxn } = a.invite(alice.content.requestUri, {
      body: sdpOffer(),
    })
    labels.set(aInviteTxn.expect(100).id, "alice.expect100")

    const { dialog: bDialog, transaction: bInviteTxn } = b.receiveInitialInvite()
    // No label-on-expect helper today; we attach via the ref produced by
    // `receiveInitialInvite`. The recorder mints the ref when expect() is
    // called inside the helper, so the label refers to the inbound INVITE.
    // (Index lookups in extractRecordings are by stepIndex; LabelRegistry
    // maps refId → label, and runner.ts joins them.)

    const ringRef = bInviteTxn.reply(180)
    labels.set(ringRef.id, "bob1.send180")

    labels.set(aInviteTxn.expect(180).id, "alice.expect180")

    const okRef = bInviteTxn.reply(200, { body: sdpAnswer() })
    labels.set(okRef.id, "bob1.send200")

    labels.set(aInviteTxn.expect(200).id, "alice.expect200")

    aDialog.ack()
    bDialog.expect("ACK")

    s.pause(1000)

    const aByeTxn = aDialog.bye()
    const bByeTxn = bDialog.expect("BYE")
    bByeTxn.reply(200)
    aByeTxn.expect(200)
  })

  const out: ScenarioBuildResult = { scenario: composable, labels }
  return out
}
