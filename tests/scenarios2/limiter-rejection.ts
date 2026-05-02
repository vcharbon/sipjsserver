/**
 * Limiter rejection (drive-only port for the new harness).
 *
 * Same flow as [tests/scenarios/limiter-rejection.ts]:
 *   - alice1 → INVITE → bob1 answers (slot consumed)
 *   - alice2 → INVITE → 486 Busy Here (slot taken)
 *   - alice1 hangs up (slot freed)
 *   - alice3 → INVITE → bob3 answers (slot reused)
 *
 * The script parameterizes from the ServiceCase: three alices in
 * order (alice1, alice2, alice3) and two legs (bob1 on 5666, bob3 on
 * 5667). alice2's leg is intentionally absent because the call is
 * limiter-rejected before any leg is reached.
 */

import { scenario, parallel } from "../../src/test-harness/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../../src/test-harness/framework/helpers/sdp.js"
import { LabelRegistry, type ScenarioBuildResult, type ScenarioScript } from "../harness/runner.js"

const LIMITER_ID = "test-limiter"

const limiterInstruction = JSON.stringify({
  action: "route",
  call_limiter: [{ id: LIMITER_ID, limit: 1 }],
})

// alice3 routes to bob3 on port 5667; same limiter id.
const limiterInstruction3 = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: 5667 },
  call_limiter: [{ id: LIMITER_ID, limit: 1 }],
})

export const limiterRejection: ScenarioScript = (sc) => {
  const labels = new LabelRegistry()
  if (sc.alices.length < 3) {
    throw new Error("limiter-rejection: ServiceCase needs at least 3 alices")
  }
  const alice1 = sc.alices[0]!
  const alice2 = sc.alices[1]!
  const alice3 = sc.alices[2]!
  const bob1 = sc.legs.find((l) => l.name === "bob1")
  const bob3 = sc.legs.find((l) => l.name === "bob3")
  if (!bob1 || !bob3) {
    throw new Error("limiter-rejection: ServiceCase needs legs named 'bob1' and 'bob3'")
  }

  // ── Sub-scenario A: alice1 → bob1 establishes, then alice1 hangs up.
  const acceptedCall = scenario("accepted-call", (s) => {
    const a = s.agent(alice1.name, { uri: alice1.content.fromUri })
    const b = s.agent(bob1.name, { uri: `sip:${bob1.name}@test`, port: 5666 })

    const { dialog: aDialog, transaction: aInviteTxn } = a.invite(alice1.content.requestUri, {
      body: sdpOffer(),
      headers: { "X-Api-Call": limiterInstruction },
      skipValidation: ["offerAnswer"],
    })
    labels.set(aInviteTxn.expect(100).id, "alice1.expect100")
    const { dialog: bDialog, transaction: bInviteTxn } = b.receiveInitialInvite()
    bInviteTxn.reply(180)
    labels.set(aInviteTxn.expect(180).id, "alice1.expect180")
    bInviteTxn.reply(200, { body: sdpAnswer() })
    labels.set(aInviteTxn.expect(200).id, "alice1.expect200")
    aDialog.ack()
    bDialog.expect("ACK")
    // Hold open while alice2's call gets rejected.
    s.pause(3000)
    const aByeTxn = aDialog.bye()
    const bByeTxn = bDialog.expect("BYE")
    bByeTxn.reply(200)
    aByeTxn.expect(200)
  })

  // ── Sub-scenario B: alice2 → 486 Busy Here (limiter rejects).
  const rejectedCall = scenario("rejected-call", (s) => {
    const a = s.agent(alice2.name, { uri: alice2.content.fromUri })
    s.pause(1000)
    const { dialog: aDialog, transaction: aInviteTxn } = a.invite(alice2.content.requestUri, {
      body: sdpOffer(),
      headers: { "X-Api-Call": limiterInstruction },
      skipValidation: ["offerAnswer"],
    })
    labels.set(aInviteTxn.expect(100).id, "alice2.expect100")
    const reject486 = aInviteTxn.expect(486, {
      predicate: (msg) => msg.type === "response" && msg.reason === "Busy Here",
    })
    labels.set(reject486.id, "alice2.expect486")
    aDialog.ack()
  })

  // ── Sub-scenario C: alice3 → bob3 establishes after alice1's BYE.
  const postHangupCall = scenario("post-hangup-call", (s) => {
    const a = s.agent(alice3.name, { uri: alice3.content.fromUri })
    const b = s.agent(bob3.name, { uri: `sip:${bob3.name}@test`, port: 5667 })
    s.pause(5000)
    const { dialog: aDialog, transaction: aInviteTxn } = a.invite(alice3.content.requestUri, {
      body: sdpOffer(),
      headers: { "X-Api-Call": limiterInstruction3 },
      skipValidation: ["offerAnswer"],
    })
    labels.set(aInviteTxn.expect(100).id, "alice3.expect100")
    const { dialog: bDialog, transaction: bInviteTxn } = b.receiveInitialInvite()
    bInviteTxn.reply(180)
    labels.set(aInviteTxn.expect(180).id, "alice3.expect180")
    bInviteTxn.reply(200, { body: sdpAnswer() })
    labels.set(aInviteTxn.expect(200).id, "alice3.expect200")
    aDialog.ack()
    bDialog.expect("ACK")
    s.pause(500)
    const aByeTxn = aDialog.bye()
    const bByeTxn = bDialog.expect("BYE")
    bByeTxn.reply(200)
    aByeTxn.expect(200)
  })

  const composable = parallel(
    "limiter-rejection",
    acceptedCall,
    rejectedCall,
    postHangupCall,
  )
  return { scenario: composable, labels }
}
