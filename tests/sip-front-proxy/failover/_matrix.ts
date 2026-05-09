/**
 * Shared scenario builder for the slice-4b failover matrix.
 *
 * Each matrix file (`<method>-<initiator>-<pattern>.test.ts`) imports
 * `buildFailoverScenario` and parameterises its three axes:
 *
 *   - `method` — the in-dialog SIP method exercised post-failover
 *     (BYE / INFO / UPDATE / MESSAGE / re-INVITE / PRACK).
 *   - `initiator` — which party drives the in-dialog request
 *     (alice = a-leg / bob = b-leg).
 *   - `switchPattern` — single (kill primary once) or double (kill,
 *     respawn, kill backup); double-switch lands once slice 4b-ii
 *     wires per-worker scopes + `cluster.respawn`.
 *
 * The builder produces a `ComposableScenario` that runs on the
 * `k8sFailover` SUT. The single-switch path is fully implemented
 * here; double-switch is a stub today — the test files import the
 * builder unchanged, so flipping one bit per matrix entry (the
 * `switchPattern` param) advances each scenario from "skip" to "run".
 */

import { scenario, type ComposableScenario } from "../../../src/test-harness/framework/dsl.js"
import { K8S_PROXY_ADDR, k8sWorkerId } from "../../support/k8sFakeStack.js"
import { sdpAnswer, sdpOffer } from "../../../src/test-harness/framework/helpers/sdp.js"
import { CALLID_TO_W1 } from "../../scenarios/ha/two-calls-routed-to-two-workers.js"

export type Method = "BYE" | "INFO" | "UPDATE" | "MESSAGE" | "REINVITE" | "PRACK"
export type Initiator = "alice" | "bob"
export type SwitchPattern = "single" | "double"

export interface MatrixCase {
  readonly method: Method
  readonly initiator: Initiator
  readonly switchPattern: SwitchPattern
}

const ALICE_HOST = "10.30.0.1"
const BOB_HOST = "10.40.0.1"
const BOB_PORT = 5060

const W1 = k8sWorkerId(1) as unknown as string
const W2 = k8sWorkerId(2) as unknown as string

const dtmfBody = new TextEncoder().encode("Signal=5\r\nDuration=160\r\n")
const messageBody = new TextEncoder().encode("hello after failover\r\n")
const sdpUpdateBody = new TextEncoder().encode(
  "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nc=IN IP4 0.0.0.0\r\nt=0 0\r\nm=audio 9999 RTP/AVP 0\r\n"
)

/**
 * Per-method send config for transparent in-dialog relays. Keeps the
 * payload-specific Content-Type / body co-located with the method
 * dispatch in the matrix builder.
 */
function transparentMethodConfig(
  method: "INFO" | "UPDATE" | "MESSAGE"
): { body: Uint8Array; overrides: { headers: Record<string, string> } } {
  switch (method) {
    case "INFO":
      return {
        body: dtmfBody,
        overrides: { headers: { "Content-Type": "application/dtmf-relay" } },
      }
    case "UPDATE":
      return {
        body: sdpUpdateBody,
        overrides: { headers: { "Content-Type": "application/sdp" } },
      }
    case "MESSAGE":
      return {
        body: messageBody,
        overrides: { headers: { "Content-Type": "text/plain" } },
      }
  }
}

/** Produce a scenario name the harness uses for trace + report grouping. */
export function matrixName(c: MatrixCase): string {
  return `${c.method.toLowerCase()}-${c.initiator}-${c.switchPattern}`
}

export function buildFailoverScenario(c: MatrixCase): ComposableScenario {
  return scenario(matrixName(c), (s) => {
    // OPTIONS keepalive needs ~2 ticks (≥ 4s) per worker to flip
    // both from `unknown` → `alive`. The LB fresh-pod guard
    // defaults to 20s past `firstSeenAtMs` (auto-stamped at t=0
    // by the SUT layer). Pausing 25s clears both windows so the
    // post-kill routing decision is driven by registry health
    // alone, not by the conntrack-stale guard.
    s.pause(25_000)

    const alice = s.agent("alice", {
      uri: "sip:alice@test",
      ip: ALICE_HOST,
      callId: CALLID_TO_W1,
    })
    const bob = s.agent("bob", {
      uri: "sip:bob@test",
      ip: BOB_HOST,
      port: BOB_PORT,
    })

    // Per-scenario limiter id, so the matrix runs in parallel without
    // counter cross-talk. limit=1 lets the post-teardown
    // `expectLimiterCount(0)` distinguish "decremented properly" from
    // "leaked" definitively.
    const limiterId = `matrix-${matrixName(c)}`
    const inviteHeaders = {
      "X-Api-Call": JSON.stringify({
        action: "route",
        destination: { host: BOB_HOST, port: BOB_PORT },
        new_ruri: `sip:bob@${BOB_HOST}:${BOB_PORT}`,
        call_limiter: [{ id: limiterId, limit: 1 }],
      }),
    }

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      `sip:+1234@${K8S_PROXY_ADDR.host}:${K8S_PROXY_ADDR.port}`,
      { body: sdpOffer(), headers: inviteHeaders },
    )
    aliceInviteTxn.expect(100)
    const { dialog: bobDialog, transaction: bobInviteTxn } =
      bob.receiveInitialInvite()
    bobInviteTxn.reply(180)
    aliceInviteTxn.expect(180)
    bobInviteTxn.reply(200, { body: sdpAnswer() })
    aliceInviteTxn.expect(200)
    aliceDialog.ack()
    bobDialog.expect("ACK")

    // Replication settle — let ReplPuller drain b2b-1's propagate
    // set into bak:b2b-1: on b2b-2 before the kill.
    s.pause(1_000)
    s.cluster.expectCallStateOn(W1, { partition: "pri", owner: W1 })
    s.cluster.expectReplicatedTo(W2, { primary: W1 })
    s.cluster.expectCallStateOn(W2, {
      partition: "pri",
      owner: W2,
      present: false,
    })
    // Slice 3 — limiter accounting checkpoints. This INVITE is the
    // single increment for the call's lifetime; nothing else should
    // touch the counter until the BYE teardown.
    s.cluster.expectLimiterCount(limiterId, 1)

    // ── First switch: kill the primary ─────────────────────────────
    s.cluster.kill(W1)
    s.pause(50)

    // ── Method (post-first-kill) — routes to backup via cookie ─────
    //
    // For BYE the method IS the teardown; for non-BYE we run the
    // method first, then BYE-teardown later. Both routes traverse
    // the proxy with `decode_forward_backup` because the cookie's
    // primary (b2b-1) is now dead.
    if (c.method === "BYE") {
      if (c.initiator === "alice") {
        const aliceByeTxn = aliceDialog.bye()
        const bobByeTxn = bobDialog.expect("BYE")
        bobByeTxn.reply(200)
        aliceByeTxn.expect(200)
      } else {
        const bobByeTxn = bobDialog.bye()
        const aliceByeTxn = aliceDialog.expect("BYE")
        aliceByeTxn.reply(200)
        bobByeTxn.expect(200)
      }
    } else if (
      c.method === "INFO" ||
      c.method === "UPDATE" ||
      c.method === "MESSAGE"
    ) {
      const cfg = transparentMethodConfig(c.method)
      if (c.initiator === "alice") {
        const txn = aliceDialog.send(c.method, cfg)
        bobDialog.expect(c.method).reply(200)
        txn.expect(200)
      } else {
        const txn = bobDialog.send(c.method, cfg)
        aliceDialog.expect(c.method).reply(200)
        txn.expect(200)
      }
    } else if (c.method === "REINVITE") {
      // Delayed-offer re-INVITE: alice sends INVITE without body,
      // bob replies 200 with offer, alice ACKs with answer. Mirrors
      // `aliceReInviteFragment` in tests/scenarios/reinvite.ts.
      if (c.initiator === "alice") {
        const txn = aliceDialog.send("INVITE")
        txn.expect(100)
        bobDialog
          .expect("INVITE")
          .reply(200, { overrides: { body: sdpOffer(undefined, 30001) } })
        txn.expect(200)
        aliceDialog.ack({
          build: () => ({ body: sdpAnswer(undefined, { port: 30001 }) }),
        })
        bobDialog.expect("ACK")
      } else {
        const txn = bobDialog.send("INVITE")
        txn.expect(100)
        aliceDialog
          .expect("INVITE")
          .reply(200, { overrides: { body: sdpOffer(undefined, 30001) } })
        txn.expect(200)
        bobDialog.ack({
          build: () => ({ body: sdpAnswer(undefined, { port: 30001 }) }),
        })
        aliceDialog.expect("ACK")
      }
    } else if (c.method === "PRACK") {
      throw new Error(
        `buildFailoverScenario: method "PRACK" deferred — needs Require:100rel setup during INVITE`
      )
    } else {
      throw new Error(
        `buildFailoverScenario: method "${c.method}" not yet wired — see slice 4b-iii follow-up`
      )
    }

    // Drain in-flight responses (e.g. bob's 200 OK to a backup-relayed BYE
    // that needs to land on b2b-2 to drive the call to "terminated" and
    // fire write-cdr). `.skipFinalSweep()` below disables the implicit
    // 24h end-of-scenario advance, so without an explicit pump here the
    // last reply sits in the simulated network queue and the call leaks.
    s.pause(100)

    // Routing-decision proof: the method (or BYE) above was
    // promoted to decode_forward_backup because b2b-1 is dead.
    s.cluster.expectRoutedTo(W2, { decision: "decode_forward_backup" })

    // ── Double-switch: respawn primary, kill backup ────────────────
    //
    // Sequence runs whether the call is still alive (non-BYE method)
    // or already terminated (BYE method). It exercises the
    // per-worker scope close + rebuild + ReadyGate reverse-drain
    // pipeline regardless. For the still-alive call, the
    // post-respawn `pri:b2b-1:` partition reflects b2b-2's
    // bak:b2b-1: state recovered via ReadyGate.
    if (c.switchPattern === "double") {
      s.cluster.respawn(W1)
      // Allow ReplPuller to apply b2b-2's reverse-propagate entries
      // and HealthProbe to flip W1 back to alive.
      s.pause(5_000)
      s.cluster.kill(W2)
      s.pause(50)
    }

    // ── Teardown: BYE alice (skipped if BYE was the method) ────────
    if (c.method !== "BYE") {
      const aliceByeTxn = aliceDialog.bye()
      const bobByeTxn = bobDialog.expect("BYE")
      bobByeTxn.reply(200)
      aliceByeTxn.expect(200)
      // Drain bob's 200 OK back through the active worker so the call
      // reaches "terminated" and write-cdr fires before scope close.
      // `.skipFinalSweep()` disables the implicit 24h end-of-scenario
      // advance, so without this pump the response sits in the simulated
      // network queue and the call leaks (no CDR emitted).
      s.pause(100)
    }

    // Single-owner invariant.
    s.cluster.expectCallStateOn(W2, {
      partition: "pri",
      owner: W2,
      present: false,
    })

    // Slice 3 — limiter terminator. After the BYE drain, the
    // cluster-shared counter must be back at zero regardless of which
    // worker handled the BYE. Catches: backup-served BYEs that
    // forget to emit `decrement-limiter`, switchback BYEs that
    // decrement the wrong window, and any in-dialog method that
    // erroneously increments.
    s.cluster.expectLimiterCount(limiterId, 0)
  })
    .runOn(["k8sFailover"])
    .skipFinalSweep()
}
