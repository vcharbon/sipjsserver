/**
 * HA SUT scenario — long call that survives several B2BUA OPTIONS
 * keepalive cycles, then loses one leg (alice stops answering).
 * `keepaliveTimeoutRule` fires, the responsive peer (bob) gets a BYE,
 * and the call terminates.
 *
 * Why this scenario exists:
 *   - The termination path on a keepalive-timeout produces a different
 *     `byeDisposition` (`bye_timeout`) on the unresponsive leg than a
 *     normal BYE (`bye_received`). Tombstone propagation must be
 *     identical between the two paths — any divergence (e.g.
 *     `terminate-leg` skipping the cache write that armed the
 *     replication propagate entry) leaks state on the peer's
 *     `bak:{primary}:` partition.
 *   - The unresponsive leg's keepalive_timeout fires *while* the
 *     transaction layer is still retransmitting OPTIONS to it (Timer E).
 *     The `allowReemission` flag absorbs those retransmits cleanly so
 *     the only thing the trace sees is a single BYE on the responsive
 *     leg followed by call termination.
 *
 * Two calls are placed on two distinct workers (CALLID_TO_W1 → b2b-1,
 * CALLID_TO_W2 → b2b-2) using the pre-computed Call-IDs that
 * `two-calls-routed-to-two-workers` already exercises.
 *
 * Default fake-clock config: `keepaliveIntervalSec=900`,
 * `keepaliveTimeoutSec=10`.
 */

import { scenario } from "../../../src/test-harness/framework/dsl.js"
import type { ScenarioContext } from "../../../src/test-harness/framework/recorder.js"
import { sdpOffer, sdpAnswer } from "../../../src/test-harness/framework/helpers/sdp.js"
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
// Two healthy cycles before the failing one — enough to flush several
// generations of replicated state to the peer's `bak:{primary}:`
// partition before the deletion path runs.
const HEALTHY_CYCLES = 2
// keepaliveTimeoutSec=10 in the test config; pad slightly for
// scheduler skew under TestClock.
const KEEPALIVE_TIMEOUT_SETTLE_MS = 12_000

interface HaCallOpts {
  readonly aliceName: string
  readonly bobName: string
  readonly aliceHost: string
  readonly bobHost: string
  readonly callId: string
}

/**
 * Drive a long call on the HA SUT through `HEALTHY_CYCLES` successful
 * keepalive rounds, then a failing round where alice stops answering.
 * The B2BUA's keepalive-timeout rule terminates by sending BYE to bob.
 * No alice-side BYE is ever sent — the scenario opts out of the final
 * sweep at the outer scenario level.
 */
function haKeepaliveTimeoutBody(s: ScenarioContext, opts: HaCallOpts): void {
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

  // ── Healthy keepalive cycles — both legs reply 200 OK ──────────────────
  for (let i = 0; i < HEALTHY_CYCLES; i++) {
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

  // ── Failing cycle — alice stops answering ─────────────────────────────
  s.pause(KEEPALIVE_INTERVAL_MS)

  // Alice receives OPTIONS but does NOT reply. Timer E retransmits
  // until the keepalive_timeout fires; absorb the duplicates.
  aliceDialog.expect("OPTIONS", {
    timeout: 10_000,
    allowReemission: true,
    predicate: (msg) => msg.getHeader("via").length >= 2,
  })

  // Bob still answers — `absorb-options-200` cancels his keepalive_timeout.
  bobDialog
    .expect("OPTIONS", {
      timeout: 10_000,
      predicate: (msg) => msg.getHeader("via").length >= 2,
    })
    .reply(200)

  // ── Keepalive timeout → BYE to the responsive peer ────────────────────
  // After `keepaliveTimeoutSec` (10s default), `keepaliveTimeoutRule` fires
  // for the alice-leg timer: terminate-leg(alice, bye_timeout),
  // begin-termination → BYE to bob. The 12s settle window leaves ~2s for
  // BYE to land before the test step processes it; Timer E retransmits
  // the BYE during that gap, so allow re-emission to absorb duplicates
  // matched by branch.
  s.pause(KEEPALIVE_TIMEOUT_SETTLE_MS)
  bobDialog
    .expect("BYE", { timeout: 10_000, allowReemission: true })
    .reply(200)

  // Drain bob's 200 OK so the call reaches `terminated` and the CDR /
  // tombstone fan-out completes before the next sub-call starts.
  s.pause(1_000)
}

export const haKeepaliveTimeout = scenario("ha-keepalive-timeout", (s) => {
  // Settle: HealthProbe transitions both workers to `alive`.
  s.pause(5000)

  // Call 1 on b2b-1.
  haKeepaliveTimeoutBody(s, {
    aliceName: "alice-1",
    bobName: "bob-1",
    aliceHost: haAliceIp(1),
    bobHost: haBobIp(1),
    callId: CALLID_TO_W1,
  })

  // Call 2 on b2b-2.
  haKeepaliveTimeoutBody(s, {
    aliceName: "alice-2",
    bobName: "bob-2",
    aliceHost: haAliceIp(2),
    bobHost: haBobIp(2),
    callId: CALLID_TO_W2,
  })

  // Drain residue from the keepalive-timeout terminations before the
  // outer harness tears down. CDR / tombstone fan-out is in flight at
  // this point on both workers; without this pause, the scenario can
  // close its scope before the propagate write to the peer completes.
  s.pause(2_000)
})
  .runOn(["sipproxyHA"])
  .skipFinalSweep()
