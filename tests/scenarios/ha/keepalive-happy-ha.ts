/**
 * HA SUT scenario — long call with B2BUA OPTIONS keepalive succeeding
 * across multiple cycles, run twice with deterministic worker placement
 * (one call on b2b-1, one on b2b-2). Replication is wired via the
 * shared `PeerFabric.simulatedBuilt` in the SUT layer, so every state
 * mutation is mirrored to the peer's `bak:{primary}:` partition and
 * the eventual deletion writes a tombstone that propagates to the peer
 * as well.
 *
 * Why this scenario exists:
 *   - The tombstone path on call termination is sensitive to the prior
 *     replicated state. A long call that has been flushed to the
 *     backup multiple times (every keepalive cycle bumps `_topology.gen`
 *     via `flushToRedis`) gives the deletion path a non-trivial peer
 *     state to overwrite. If the tombstone is dropped, mis-stamped
 *     (`callGen <= last seen`), or arrives without the in-dialog
 *     handlers having drained their replicated index entries, the
 *     scenario surfaces it as either an undeliverable packet or as an
 *     unexpected message in the trace.
 *   - Both directions of the BYE path (alice-initiated forward
 *     in-dialog, bob-initiated cookie-decode) are exercised in one
 *     scenario, mirroring `two-calls-routed-to-two-workers`.
 *
 * Each call walks 3 keepalive cycles (3 × 15 min) where alice and bob
 * both reply 200 OK to the B2BUA-originated OPTIONS. With
 * `b2bOutboundProxy` set on each worker (default for `sipproxyHA`),
 * the keepalive OPTIONS travel via the proxy on both legs, so the Via
 * count assertion (≥ 2) catches a regression to worker-direct routing.
 *
 * Default fake-clock config: `keepaliveIntervalSec=900`,
 * `keepaliveTimeoutSec=10`. TestClock advances instantly.
 */

import { scenario } from "../../../src/test-harness/framework/dsl.js"
import type {
  DialogRef,
  ScenarioContext,
} from "../../../src/test-harness/framework/recorder.js"
import { sdpOffer, sdpAnswer } from "../../../src/test-harness/framework/helpers/sdp.js"
import type { SipMessage } from "../../../src/sip/types.js"
import {
  HA_PROXY_ADDR,
  haAliceIp,
  haBobIp,
} from "../../support/proxyB2bFakeStack.js"
import {
  CALLID_TO_W1,
  CALLID_TO_W2,
} from "./two-calls-routed-to-two-workers.js"

const KEEPALIVE_INTERVAL_MS = 900_000
const KEEPALIVE_CYCLES = 3

const viaCount = (msg: SipMessage): number =>
  msg.headers.filter((h) => h.name.toLowerCase() === "via").length

interface HaCallOpts {
  readonly aliceName: string
  readonly bobName: string
  readonly aliceHost: string
  readonly bobHost: string
  readonly callId: string
  readonly byeFrom: "alice" | "bob"
}

/**
 * Drive a single HA call through `KEEPALIVE_CYCLES` keepalive rounds
 * before BYE. Returns nothing — every assertion is a DSL expectation.
 */
function haKeepaliveCallBody(s: ScenarioContext, opts: HaCallOpts): void {
  const alice = s.agent(opts.aliceName, {
    uri: `sip:${opts.aliceName}@test`,
    ip: opts.aliceHost,
    callId: opts.callId,
  })
  const bob = s.agent(opts.bobName, {
    uri: `sip:${opts.bobName}@test`,
    ip: opts.bobHost,
    port: 5060,
  })

  const inviteHeaders = {
    "X-Api-Call": JSON.stringify({
      action: "route",
      destination: { host: opts.bobHost, port: 5060 },
      new_ruri: `sip:${opts.bobName}@${opts.bobHost}:5060`,
    }),
  }

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
    `sip:+1234@${HA_PROXY_ADDR.host}:${HA_PROXY_ADDR.port}`,
    { body: sdpOffer(), headers: inviteHeaders },
  )
  aliceInviteTxn.expect(100)

  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()
  bobInviteTxn.reply(180)
  aliceInviteTxn.expect(180)

  bobInviteTxn.reply(200, { body: sdpAnswer() })
  aliceInviteTxn.expect(200)
  aliceDialog.ack()
  bobDialog.expect("ACK")

  // ── Keepalive cycles — both legs reply 200 OK every time ───────────────
  // OPTIONS travels via the proxy on both legs (b2bOutboundProxy is set),
  // so the Via count is ≥ 2 (proxy + worker stamp).
  for (let i = 0; i < KEEPALIVE_CYCLES; i++) {
    s.pause(KEEPALIVE_INTERVAL_MS)
    aliceDialog
      .expect("OPTIONS", {
        predicate: (msg) => msg.type === "request" && viaCount(msg) >= 2,
      })
      .reply(200)
    bobDialog
      .expect("OPTIONS", {
        predicate: (msg) => msg.type === "request" && viaCount(msg) >= 2,
      })
      .reply(200)
  }

  // ── Teardown — exercises both directions across the two calls ─────────
  hangup(s, aliceDialog, bobDialog, opts.byeFrom)
}

function hangup(
  s: ScenarioContext,
  aliceDialog: DialogRef,
  bobDialog: DialogRef,
  byeFrom: "alice" | "bob",
): void {
  if (byeFrom === "alice") {
    const aliceByeTxn = aliceDialog.bye()
    bobDialog.expect("BYE").reply(200)
    aliceByeTxn.expect(200)
  } else {
    const bobByeTxn = bobDialog.bye()
    aliceDialog.expect("BYE").reply(200)
    bobByeTxn.expect(200)
  }
  // Drain b-leg's 200 OK so the call reaches `terminated` and write-cdr
  // fires before the next sub-call's INVITE (or the outer scenario's
  // closing scope). Same rationale as `basicCallBody`.
  s.pause(1_000)
}

export const haKeepaliveHappy = scenario("ha-keepalive-happy", (s) => {
  // Settle: workers are admitted as `unknown`. HealthProbe's 2s ticker
  // flips them to `alive` after the first 200 OK to OPTIONS — same
  // pause shape as `two-calls-routed-to-two-workers`.
  s.pause(5000)

  // Call 1 — lands on b2b-1 via HRW (CALLID_TO_W1). Alice initiates BYE
  // (forward in-dialog path through the proxy).
  haKeepaliveCallBody(s, {
    aliceName: "alice-1",
    bobName: "bob-1",
    aliceHost: haAliceIp(1),
    bobHost: haBobIp(1),
    callId: CALLID_TO_W1,
    byeFrom: "alice",
  })

  // Call 2 — lands on b2b-2 via HRW (CALLID_TO_W2). Bob initiates BYE
  // (cookie-decode in-dialog path through the proxy).
  haKeepaliveCallBody(s, {
    aliceName: "alice-2",
    bobName: "bob-2",
    aliceHost: haAliceIp(2),
    bobHost: haBobIp(2),
    callId: CALLID_TO_W2,
    byeFrom: "bob",
  })
})
  .runOn(["sipproxyHA"])
  // Same rationale as `two-calls-routed-to-two-workers`: under sipproxyHA
  // the OPTIONS health probe runs every 2s, so the 24h end-of-scenario
  // sweep would amplify any transient binding window into a flood of
  // undeliverable entries; verifyCleanState's CallState/TimerService
  // handles only see the primary worker's services.
  .skipFinalSweep()
