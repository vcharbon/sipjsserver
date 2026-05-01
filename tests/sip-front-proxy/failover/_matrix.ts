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

import { scenario, type ComposableScenario } from "../../fullcall/framework/dsl.js"
import { K8S_PROXY_ADDR, k8sWorkerId } from "../../support/k8sFakeStack.js"
import { sdpAnswer, sdpOffer } from "../../fullcall/helpers/sdp.js"
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

    const inviteHeaders = {
      "X-Api-Call": JSON.stringify({
        action: "route",
        destination: { host: BOB_HOST, port: BOB_PORT },
        new_ruri: `sip:bob@${BOB_HOST}:${BOB_PORT}`,
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

    // ── First switch: kill the primary ─────────────────────────────
    s.cluster.kill(W1)
    s.pause(50)

    if (c.switchPattern === "double") {
      // Slice 4b-ii follow-up. Until per-worker scopes + respawn
      // land, the matrix's double-switch column treats this as a
      // single-switch with a noted gap so the file scaffolding
      // (HTML/txt reports, name conventions) is in place ahead of
      // time.
      throw new Error(
        `buildFailoverScenario: double-switch pattern requires cluster.respawn() — pending slice 4b-ii.`
      )
    }

    // ── Single-switch: exercise the chosen method post-failover ─────

    if (c.method === "BYE") {
      // BYE alice→bob OR bob→alice; both terminate the call.
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
      // Transparent in-dialog request: send → relay → 200, then BYE.
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
      // Always tear down via alice-BYE for predictability.
      const aliceByeTxn = aliceDialog.bye()
      const bobByeTxn = bobDialog.expect("BYE")
      bobByeTxn.reply(200)
      aliceByeTxn.expect(200)
    } else {
      throw new Error(
        `buildFailoverScenario: method "${c.method}" not yet wired — see slice 4b-iii follow-up`
      )
    }

    // Routing-decision proof: every post-kill in-dialog request
    // routed via the cookie was promoted to decode_forward_backup.
    s.cluster.expectRoutedTo(W2, { decision: "decode_forward_backup" })

    // Single-owner invariant.
    s.cluster.expectCallStateOn(W2, {
      partition: "pri",
      owner: W2,
      present: false,
    })
  })
    .runOn(["k8sFailover"])
    .skipFinalSweep()
}
