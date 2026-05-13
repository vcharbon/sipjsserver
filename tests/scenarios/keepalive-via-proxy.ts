/**
 * keepalive-via-proxy — regression guard for the k8s endurance bug
 * where in-dialog keepalive OPTIONS bypassed the front-proxy and every
 * long-hold call was torn down by `keepaliveTimeoutRule` after 15 min.
 *
 * Two scenarios:
 *
 * Both scenarios target the `proxy+b2b` SUT only — that topology
 * mirrors the k8s deployment (one worker behind the front-proxy) where
 * the bug surfaced. `sipproxyHA` adds multi-worker HealthProbe timing
 * that the other keepalive scenarios deliberately avoid; extending
 * here is a follow-up once the probe pacing is generalised.
 *
 *   1. `keepaliveViaProxy` — happy path. With `b2bOutboundProxy` set
 *      (default for `proxy+b2b`), the b-leg INVITE
 *      traverses the proxy, the proxy Record-Routes, b-leg routeSet
 *      gets populated, and subsequent in-dialog OPTIONS flow back
 *      through the proxy. Bob's incoming OPTIONS therefore carries ≥2
 *      Via headers (proxy + worker). a-leg is symmetric.
 *
 *   2. `keepaliveMissingOutboundProxyRegressionGuard` — bug-presence
 *      doc. Built with `simulateMissingOutboundProxy: true`, so the
 *      worker config has no `b2bOutboundProxy`. The b-leg INVITE goes
 *      worker-direct to Bob; Bob's 200 OK has no Record-Route; b-leg
 *      routeSet stays empty; the keepalive OPTIONS therefore goes
 *      worker-direct to Bob and arrives with exactly **one** Via
 *      header. This is the failure mode observed in the k8s endurance
 *      run before the helm fix (`B2B_OUTBOUND_PROXY=sip-front-proxy:5060`).
 *      The scenario ASSERTS that one-Via shape so any future change
 *      that routes b-leg in-dialog requests via a configured outbound
 *      proxy regardless of routeSet content flips this scenario red
 *      and forces a re-evaluation. The a-leg side still routes via
 *      the proxy because the inbound INVITE's Record-Route populates
 *      the a-leg routeSet — that distinction is part of the assertion.
 */

import { scenario } from "../../src/test-harness/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../../src/test-harness/framework/helpers/sdp.js"

const KEEPALIVE_INTERVAL_MS = 900_000

export const keepaliveViaProxy = scenario("keepalive-via-proxy", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
    "sip:+1234@127.0.0.1:15060",
    { body: sdpOffer() },
  )
  aliceInviteTxn.expect(100)

  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()
  bobInviteTxn.reply(180)
  aliceInviteTxn.expect(180)
  bobInviteTxn.reply(200, { body: sdpAnswer() })
  aliceInviteTxn.expect(200)
  aliceDialog.ack()
  bobDialog.expect("ACK")

  // Two keepalive cycles — the second confirms the timer rescheduled
  // after a successful round-trip on the first.
  for (let i = 0; i < 2; i++) {
    s.pause(KEEPALIVE_INTERVAL_MS)

    aliceDialog
      .expect("OPTIONS", {
        predicate: (msg) => msg.getHeader("via").length >= 2,
      })
      .reply(200)
    bobDialog
      .expect("OPTIONS", {
        predicate: (msg) => msg.getHeader("via").length >= 2,
      })
      .reply(200)
  }

  // Teardown — also exercises in-dialog BYE going via the proxy.
  const aliceByeTxn = aliceDialog.bye()
  bobDialog.expect("BYE").reply(200)
  aliceByeTxn.expect(200)
}).runOn(["proxy+b2b"]).title("keepalive: in-dialog OPTIONS travels via proxy on both legs (regression for k8s endurance)")

export const keepaliveMissingOutboundProxyRegressionGuard = scenario(
  "keepalive-missing-outbound-proxy-regression-guard",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15060",
      { body: sdpOffer() },
    )
    aliceInviteTxn.expect(100)

    const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()
    bobInviteTxn.reply(180)
    aliceInviteTxn.expect(180)
    bobInviteTxn.reply(200, { body: sdpAnswer() })
    aliceInviteTxn.expect(200)
    aliceDialog.ack()
    bobDialog.expect("ACK")

    s.pause(KEEPALIVE_INTERVAL_MS)

    // a-leg still routes via the proxy because the inbound INVITE's
    // Record-Route populated the a-leg routeSet — independent of the
    // missing b-leg outbound proxy config.
    aliceDialog
      .expect("OPTIONS", {
        predicate: (msg) => msg.getHeader("via").length >= 2,
      })
      .reply(200)
    // b-leg is the bug surface: with `b2bOutboundProxy` unset and Bob
    // not Record-Routing, the b-leg routeSet is empty and the keepalive
    // OPTIONS lands worker-direct on Bob with exactly one Via.
    bobDialog
      .expect("OPTIONS", {
        predicate: (msg) => msg.getHeader("via").length === 1,
      })
      .reply(200)

    const aliceByeTxn = aliceDialog.bye()
    bobDialog.expect("BYE").reply(200)
    aliceByeTxn.expect(200)
  },
).runOn(["proxy+b2b"]).title("keepalive: missing B2B_OUTBOUND_PROXY → b-leg OPTIONS goes worker-direct (bug-presence guard)")
