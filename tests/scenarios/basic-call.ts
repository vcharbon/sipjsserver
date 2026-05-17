/**
 * Basic call scenario: INVITE → 100 → 180 → 200 → ACK → pause → BYE → 200
 *
 * Exposed in two forms:
 *
 *   - `basicCall` — the original scenario (alice + bob hardcoded, alice
 *     sends BYE). Default-args path of the new builder. Existing tests
 *     import this and see no behavior change.
 *
 *   - `basicCallBody(s, opts?)` — the same body factored into a helper
 *     that an outer `scenario(...)` block can call multiple times to
 *     compose several calls in one scenario, each with its own agents,
 *     proxy address, Call-ID, and BYE direction. Used by the HA SUT's
 *     `two-calls-routed-to-two-workers` scenario.
 */
import { scenario } from "../../src/test-harness/framework/dsl.js"
import type { DialogRef, ScenarioContext } from "../../src/test-harness/framework/recorder.js"
import { sdpOffer, sdpAnswer } from "../../src/test-harness/framework/helpers/sdp.js"
import type { SipHeader } from "../../src/sip/types.js"
import type { K8sKillTiming } from "../../src/test-harness/framework/types.js"

/**
 * Mid-establishment kill spec: inject a ring pause between 180 and 200
 * and tear down a worker partway through it. Used by failover scenarios
 * that exercise the establishment window the current chaos suite does
 * not reach (no pause between 180 and 200 means no realistic chaos
 * window mid-ring). The shape supports a single timing tier today
 * ("mid-ring"); see `withRingAndKill` for the composable matrix form
 * that extends to PRACK / 100rel tiers without touching call-sites.
 */
export interface RingKillSpec {
  /** Offset from the start of the ring at which `s.cluster.kill` fires. Must be < `ringMs`. */
  readonly atRingOffsetMs: number
  /** Worker ordinal to kill (e.g. `"b2b-1"`). The caller resolves primary/backup from the Call-ID. */
  readonly worker: string
  /** Optional per-phase timing knobs passed through to `s.cluster.kill`. */
  readonly timing?: K8sKillTiming
  /** Optional hook fired immediately before the kill (e.g. replication-state assertions). */
  readonly beforeKill?: (s: ScenarioContext) => void
  /** Optional hook fired immediately after the kill (e.g. settle pause, registry assertions). */
  readonly afterKill?: (s: ScenarioContext) => void
}

function getHeaderValue(headers: ReadonlyArray<SipHeader>, name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value
}

export interface BasicCallOpts {
  /** Logical agent name for the caller. Default: `"alice"`. */
  readonly aliceName?: string
  /** Logical agent name for the callee. Default: `"bob"`. */
  readonly bobName?: string
  /**
   * Bind IP for the caller agent. Default: `127.0.0.1` (legacy
   * single-host shape). HA scenarios pass `10.30.0.x` (alice subnet).
   */
  readonly aliceHost?: string
  /**
   * Bind IP for the callee agent. Default: `127.0.0.1`. HA scenarios
   * pass `10.40.0.x` (bob subnet). The mock CallDecisionEngine will
   * route the B-leg here when the caller sends an `X-Api-Call` header
   * naming this destination.
   */
  readonly bobHost?: string
  /** Bob's UDP bind port. Default: `5666` (matches the MockCallControlServer). */
  readonly bobPort?: number
  /**
   * Proxy / B2BUA ingress that the caller sends its initial INVITE to.
   * Default: `127.0.0.1:15060`. HA scenarios pass `10.10.0.1:15060`.
   */
  readonly proxyHost?: string
  readonly proxyPort?: number
  /**
   * Pre-assigned Call-ID. When set, steers HRW routing on the proxy to
   * a specific worker. Default: framework-generated random Call-ID.
   */
  readonly callId?: string
  /**
   * Who hangs up the call. `"alice"` (default, current behavior) sends
   * a BYE through the forward A-leg → B-leg path. `"bob"` sends BYE
   * back from the B-leg, exercising the proxy's stickiness-cookie
   * decode path on the way back to alice.
   */
  readonly byeFrom?: "alice" | "bob"
  /**
   * Ring duration: pause between 180 Ringing and 200 OK. Default `0`
   * preserves the original back-to-back shape and leaves every existing
   * call-site unchanged. Pass a positive value (e.g. `10_000`) to
   * simulate a realistic ring window the chaos suite can crash into.
   */
  readonly ringMs?: number
  /**
   * When set, inject a `s.cluster.kill(...)` call partway through the
   * ring pause. Ignored unless `ringMs > killSpec.atRingOffsetMs`. See
   * `RingKillSpec` for the contract.
   */
  readonly killSpec?: RingKillSpec
}

const DEFAULTS: Required<Omit<BasicCallOpts, "callId" | "killSpec">> = {
  aliceName: "alice",
  bobName: "bob",
  aliceHost: "127.0.0.1",
  bobHost: "127.0.0.1",
  bobPort: 5666,
  proxyHost: "127.0.0.1",
  proxyPort: 15060,
  byeFrom: "alice",
  ringMs: 0,
}

/**
 * Body of a basic call. Pulls every previously-hardcoded value (host,
 * port, Call-ID, BYE direction) out as opts. Default-args produce the
 * original scenario unchanged.
 */
export function basicCallBody(s: ScenarioContext, opts: BasicCallOpts = {}): void {
  const aliceName = opts.aliceName ?? DEFAULTS.aliceName
  const bobName = opts.bobName ?? DEFAULTS.bobName
  const aliceHost = opts.aliceHost ?? DEFAULTS.aliceHost
  const bobHost = opts.bobHost ?? DEFAULTS.bobHost
  const bobPort = opts.bobPort ?? DEFAULTS.bobPort
  const proxyHost = opts.proxyHost ?? DEFAULTS.proxyHost
  const proxyPort = opts.proxyPort ?? DEFAULTS.proxyPort
  const byeFrom = opts.byeFrom ?? DEFAULTS.byeFrom

  const aliceCfg: Parameters<ScenarioContext["agent"]>[1] = {
    uri: `sip:${aliceName}@test`,
    ...(aliceHost !== "127.0.0.1" ? { ip: aliceHost } : {}),
    ...(opts.callId !== undefined ? { callId: opts.callId } : {}),
  }
  const bobCfg: Parameters<ScenarioContext["agent"]>[1] = {
    uri: `sip:${bobName}@test`,
    port: bobPort,
    ...(bobHost !== "127.0.0.1" ? { ip: bobHost } : {}),
  }

  const alice = s.agent(aliceName, aliceCfg)
  const bob = s.agent(bobName, bobCfg)

  // Alice sends INVITE to the SUT ingress. The B-leg destination is
  // carried via X-Api-Call so the mock CallDecisionEngine routes Bob's
  // leg to `bobHost:bobPort` (else it defaults to 127.0.0.1:5666).
  const inviteHeaders =
    bobHost === DEFAULTS.bobHost && bobPort === DEFAULTS.bobPort
      ? undefined
      : {
          "X-Api-Call": JSON.stringify({
            action: "route",
            destination: { host: bobHost, port: bobPort },
            new_ruri: `sip:${bobName}@${bobHost}:${bobPort}`,
          }),
        }

  const inviteOpts: Parameters<typeof alice.invite>[1] = {
    body: sdpOffer(),
    ...(inviteHeaders !== undefined ? { headers: inviteHeaders } : {}),
  }

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
    `sip:+1234@${proxyHost}:${proxyPort}`,
    inviteOpts,
  )

  // Alice receives 100 Trying from the SUT
  aliceInviteTxn.expect(100)

  // Bob receives the INVITE — verify Max-Forwards decremented at least
  // once. b2bonly: 70→69 at the worker; proxy+b2b: 70→69→68 (proxy + worker).
  // Either way the value the peer sees must be strictly less than 70.
  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite({
    predicate: (msg) => {
      const mf = getHeaderValue(msg.headers, "max-forwards")
      const n = mf !== undefined ? Number.parseInt(mf, 10) : NaN
      return Number.isFinite(n) && n < 70
    },
  })

  // Bob → 180 Ringing
  bobInviteTxn.reply(180)
  aliceInviteTxn.expect(180)

  // Optional ring window + mid-ring kill. `ringMs === 0` (default)
  // preserves today's back-to-back 180→200 shape exactly. When set,
  // bob holds the call in early-dialog state for `ringMs` of virtual
  // time. If `killSpec` is set, fire `s.cluster.kill(...)` at the
  // requested offset; the pre/post hooks let the caller assert on
  // replication state or routing decisions inline.
  const ringMs = opts.ringMs ?? DEFAULTS.ringMs
  if (ringMs > 0) {
    const killSpec = opts.killSpec
    if (killSpec !== undefined && killSpec.atRingOffsetMs < ringMs) {
      s.pause(killSpec.atRingOffsetMs)
      killSpec.beforeKill?.(s)
      s.cluster.kill(killSpec.worker, killSpec.timing)
      killSpec.afterKill?.(s)
      s.pause(ringMs - killSpec.atRingOffsetMs)
    } else {
      s.pause(ringMs)
    }
  }

  // Bob → 200 OK with SDP answer
  bobInviteTxn.reply(200, { body: sdpAnswer() })
  aliceInviteTxn.expect(200)

  // ACK end-to-end (may carry SDP)
  aliceDialog.ack()
  bobDialog.expect("ACK")

  // Call established — pause briefly before hangup
  s.pause(1000)

  // Hangup direction
  if (byeFrom === "alice") {
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
  // Drain the b-leg's 200 OK so the call reaches "terminated" and
  // write-cdr fires before scope close. Cheap under TestClock; required
  // when the enclosing scenario uses `.skipFinalSweep()` (the implicit
  // 24h end-of-scenario advance is the only thing that drains it
  // otherwise). 1s covers the cookie-decode path through the proxy that
  // adds an extra hop on top of direct b-leg replies.
  s.pause(1_000)
}

/**
 * Original `basicCall` scenario — preserved for existing imports.
 * `basicCallBody` with default opts produces the exact same body.
 */
export const basicCall = scenario("basic-call", (s) => {
  basicCallBody(s)
}).title("basic call")

// ---------------------------------------------------------------------------
// Split form — establish-only / bye-only halves
// ---------------------------------------------------------------------------
//
// Slice B′ — replication-gap diagnostic test composes 40 calls in two
// phases: establish all of them, settle replication, kill a worker,
// then run BYE on subsets at different times. `basicCallBody` is
// monolithic (INVITE → … → BYE inline). The two helpers below split
// that body so a scenario can drive the lifecycle phases independently.
// Both helpers accept the same `BasicCallOpts` shape; the establish
// side returns dialog handles the BYE side consumes.

export interface EstablishedCall {
  readonly aliceDialog: DialogRef
  readonly bobDialog: DialogRef
}

/**
 * Drive INVITE → 100 → 180 → 200 → ACK without sending BYE. Returns
 * the alice/bob dialog handles so a later `byeCallBody` call can tear
 * the call down. No post-establish pause — the caller drives settle
 * timing.
 */
export function establishCallBody(
  s: ScenarioContext,
  opts: BasicCallOpts = {}
): EstablishedCall {
  const aliceName = opts.aliceName ?? DEFAULTS.aliceName
  const bobName = opts.bobName ?? DEFAULTS.bobName
  const aliceHost = opts.aliceHost ?? DEFAULTS.aliceHost
  const bobHost = opts.bobHost ?? DEFAULTS.bobHost
  const bobPort = opts.bobPort ?? DEFAULTS.bobPort
  const proxyHost = opts.proxyHost ?? DEFAULTS.proxyHost
  const proxyPort = opts.proxyPort ?? DEFAULTS.proxyPort

  const aliceCfg: Parameters<ScenarioContext["agent"]>[1] = {
    uri: `sip:${aliceName}@test`,
    ...(aliceHost !== "127.0.0.1" ? { ip: aliceHost } : {}),
    ...(opts.callId !== undefined ? { callId: opts.callId } : {}),
  }
  const bobCfg: Parameters<ScenarioContext["agent"]>[1] = {
    uri: `sip:${bobName}@test`,
    port: bobPort,
    ...(bobHost !== "127.0.0.1" ? { ip: bobHost } : {}),
  }

  const alice = s.agent(aliceName, aliceCfg)
  const bob = s.agent(bobName, bobCfg)
  // Tolerate keepalive OPTIONS the b2bua may inject while the call is
  // in the established window. The split form's primary use is
  // multi-call diagnostic scenarios with long settle phases between
  // establish and BYE; without these, keepalive OPTIONS arriving at
  // alice/bob mid-pause would surface as "unexpected" failures.
  alice.allowExtra("OPTIONS")
  bob.allowExtra("OPTIONS")

  const inviteHeaders =
    bobHost === DEFAULTS.bobHost && bobPort === DEFAULTS.bobPort
      ? undefined
      : {
          "X-Api-Call": JSON.stringify({
            action: "route",
            destination: { host: bobHost, port: bobPort },
            new_ruri: `sip:${bobName}@${bobHost}:${bobPort}`,
          }),
        }

  const inviteOpts: Parameters<typeof alice.invite>[1] = {
    body: sdpOffer(),
    ...(inviteHeaders !== undefined ? { headers: inviteHeaders } : {}),
  }

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
    `sip:+1234@${proxyHost}:${proxyPort}`,
    inviteOpts,
  )

  aliceInviteTxn.expect(100)
  const { dialog: bobDialog, transaction: bobInviteTxn } =
    bob.receiveInitialInvite({
      predicate: (msg) => {
        const mf = getHeaderValue(msg.headers, "max-forwards")
        const n = mf !== undefined ? Number.parseInt(mf, 10) : NaN
        return Number.isFinite(n) && n < 70
      },
    })
  bobInviteTxn.reply(180)
  aliceInviteTxn.expect(180)
  bobInviteTxn.reply(200, { body: sdpAnswer() })
  aliceInviteTxn.expect(200)
  aliceDialog.ack()
  bobDialog.expect("ACK")

  return { aliceDialog, bobDialog }
}

/**
 * Tear down a previously-established call with a BYE round-trip from
 * the configured side. Mirrors `basicCallBody`'s BYE branch but works
 * on dialog handles a prior `establishCallBody` returned.
 */
export function byeCallBody(
  call: EstablishedCall,
  opts: { byeFrom?: "alice" | "bob" } = {}
): void {
  const byeFrom = opts.byeFrom ?? "alice"
  if (byeFrom === "alice") {
    const aliceByeTxn = call.aliceDialog.bye()
    const bobByeTxn = call.bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
  } else {
    const bobByeTxn = call.bobDialog.bye()
    const aliceByeTxn = call.aliceDialog.expect("BYE")
    aliceByeTxn.reply(200)
    bobByeTxn.expect(200)
  }
}
