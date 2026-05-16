/**
 * Invariant tests for `applyRoute`:
 *
 *   1. **Iff** a limiter INCR succeeded, exactly one matching DECR fires
 *      (whether via the terminate-flow path or via eager-DECR in an error
 *      path).
 *   2. **Eager-DECR on error**: any failure / defect after a successful
 *      INCR triggers DECR *immediately* — before the failure propagates
 *      out of `applyRoute`.
 *
 * Paths covered:
 *   - Path 2a — within-loop reject with a prior succeeded INCR.
 *               The rejected call carries `limiterEntries` so the soft
 *               effect chain emits decrement-limiter for the successful
 *               prior INCR. (terminateCallEffects + InvariantEnforcer
 *               filter on `incrementSucceeded !== false`.)
 *   - Path 2b — within-loop reject with NO prior INCR succeeded
 *               (fail-open admission would be tested similarly via the
 *               structural `incrementSucceeded: false` flag in T3/T4;
 *               this test focuses on the all-rejected case).
 *   - Path 3  — post-loop defect: a downstream limiter dies with a
 *               Cause defect after a successful INCR; `Effect.onExit`
 *               triggers `eagerDecrement` → DECR fires immediately for
 *               the prior successful INCR.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Stream } from "effect"
import type { AppConfigData } from "../../src/config/AppConfig.js"
import type { CallLimiter } from "../../src/call/CallLimiter.js"
import type { Call } from "../../src/call/CallModel.js"
import { applyRoute } from "../../src/decision/apply/applyRoute.js"
import type { CallDecisionEngine } from "../../src/decision/CallDecisionEngine.js"
import type { FeatureActivations } from "../../src/decision/schemas/features.js"
import { hydrateRequest } from "../../src/sip/parsers/extract-fields.js"
import type { ContactSpec } from "../../src/sip/generators.js"
import type { RemoteInfo, SipRequest } from "../../src/sip/types.js"

const rinfo: RemoteInfo = { address: "192.168.1.100", port: 5060 }

const minimalCall = (): Call => ({
  callRef: "call-1|alice-tag",
  aLeg: {
    legId: "a",
    callId: "call-1",
    fromTag: "alice-tag",
    source: rinfo,
    state: "early",
    disposition: "ringing",
    dialogs: [],
  },
  bLegs: [],
  activePeer: null,
  aLegInvite: {
    uri: "sip:bob@example.com",
    headers: [],
    body: new Uint8Array(),
  },
  tagMap: [],
  limiterEntries: [],
  timers: [],
  cdrEvents: [],
  state: "active",
  createdAt: 0,
})

const minimalInvite = (): SipRequest =>
  hydrateRequest({
    method: "INVITE",
    uri: "sip:bob@example.com",
    headers: [
      { name: "Via", value: "SIP/2.0/UDP 192.168.1.100:5060;branch=z9hG4bK-orig" },
      { name: "From", value: "<sip:alice@example.com>;tag=alice-tag" },
      { name: "To", value: "<sip:bob@example.com>" },
      { name: "Call-ID", value: "call-1" },
      { name: "CSeq", value: "1 INVITE" },
    ],
    body: new Uint8Array(),
    raw: Buffer.alloc(0),
  })

const minimalFeatures = (): FeatureActivations => ({
  platform: {
    maxDurationSec: 7200,
    keepalive: { type: "options", intervalSec: 900, timeoutSec: 10 } as FeatureActivations["platform"]["keepalive"],
  },
})

const aLegContact: ContactSpec = {
  uri: "<sip:b2bua@10.0.0.1:5060>",
}

const cfg = (overrides: Partial<AppConfigData> = {}): AppConfigData =>
  ({
    workerAllowedTargetSuffixes: ["example.com"],
    limiterDecrementTimeoutMs: 100,
    ...overrides,
  } as AppConfigData)

/**
 * Build a counting limiter stub whose `checkAndIncrement` returns either
 * Allowed/Rejected per id, or dies. INCRs and DECRs are recorded by id.
 */
function makeCountingLimiter(opts: {
  incr: Record<
    string,
    () => Effect.Effect<
      { _tag: "Allowed"; currentWindow: number } | { _tag: "Rejected" },
      never
    >
  >
}): {
  service: CallLimiter["Service"]
  incrementedIds: () => ReadonlyArray<string>
  decrementedIds: () => ReadonlyArray<string>
} {
  const incremented: string[] = []
  const decremented: string[] = []
  const service: CallLimiter["Service"] = {
    checkAndIncrement: (limiterId: string) => {
      const fn = opts.incr[limiterId]
      if (fn === undefined) {
        return Effect.die(`no behavior configured for limiterId=${limiterId}`)
      }
      return fn().pipe(
        Effect.tap((d) =>
          d._tag === "Allowed"
            ? Effect.sync(() => incremented.push(limiterId))
            : Effect.void,
        ),
      )
    },
    decrement: (limiterId: string) =>
      Effect.sync(() => {
        decremented.push(limiterId)
      }),
  } as unknown as CallLimiter["Service"]
  return {
    service,
    incrementedIds: () => incremented.slice(),
    decrementedIds: () => decremented.slice(),
  }
}

const noFailoverCallControl: CallDecisionEngine["Service"] = {
  newCall: () => Effect.die("newCall not used"),
  callFailure: () => Effect.die("callFailure not used in these tests"),
  callRefer: () => Effect.die("callRefer not used"),
} as unknown as CallDecisionEngine["Service"]

describe("applyRoute — INCR/DECR invariant (iff successful INCR ⇒ exactly one DECR)", () => {
  it.effect(
    "Path 2a — within-loop reject with prior successful INCR: prior DECR emitted via terminate effects",
    () =>
      Effect.gen(function* () {
        const counting = makeCountingLimiter({
          incr: {
            "lim-cap": () => Effect.succeed({ _tag: "Allowed" as const, currentWindow: 1000 }),
            "lim-hit": () => Effect.succeed({ _tag: "Rejected" as const }),
          },
        })
        const result = yield* applyRoute({
          routing: {
            action: "route",
            destination: { host: "carrier.example.com", port: 5060 },
            features: minimalFeatures(),
            call_limiter: [
              { id: "lim-cap", limit: 1000 },
              { id: "lim-hit", limit: 1 },
            ],
          },
          call: minimalCall(),
          req: minimalInvite(),
          aLegContact,
          rinfo,
          nowMs: 1_700_000_000_000,
          config: cfg(),
          callControl: noFailoverCallControl,
          limiter: counting.service,
        })

        // INCR for lim-cap; lim-hit rejected without incrementing.
        expect(counting.incrementedIds()).toEqual(["lim-cap"])

        // The rejection branch attaches limiterEntries so terminate
        // effects emit a decrement-limiter for the prior successful INCR.
        const decrEffects = result.effects.soft.filter(
          (s) => s.type === "decrement-limiter",
        )
        expect(decrEffects.length).toBe(1)
        expect(decrEffects[0]?.limiterId).toBe("lim-cap")
      }),
  )

  it.effect(
    "Path 2b — within-loop reject with NO prior successful INCR: no DECR emitted",
    () =>
      Effect.gen(function* () {
        const counting = makeCountingLimiter({
          incr: {
            "lim-hit": () => Effect.succeed({ _tag: "Rejected" as const }),
          },
        })
        const result = yield* applyRoute({
          routing: {
            action: "route",
            destination: { host: "carrier.example.com", port: 5060 },
            features: minimalFeatures(),
            call_limiter: [{ id: "lim-hit", limit: 1 }],
          },
          call: minimalCall(),
          req: minimalInvite(),
          aLegContact,
          rinfo,
          nowMs: 1_700_000_000_000,
          config: cfg(),
          callControl: noFailoverCallControl,
          limiter: counting.service,
        })

        expect(counting.incrementedIds()).toEqual([])
        const decrEffects = result.effects.soft.filter(
          (s) => s.type === "decrement-limiter",
        )
        expect(decrEffects.length).toBe(0)
      }),
  )

  it.effect(
    "Path 3 — defect after successful INCR: eager DECR fires via Effect.onExit",
    () =>
      Effect.gen(function* () {
        const counting = makeCountingLimiter({
          incr: {
            "lim-A": () => Effect.succeed({ _tag: "Allowed" as const, currentWindow: 1000 }),
            "lim-B": () => Effect.succeed({ _tag: "Allowed" as const, currentWindow: 1000 }),
            "lim-CRASH": () => Effect.die("simulated downstream defect"),
          },
        })
        const exit = yield* Effect.exit(
          applyRoute({
            routing: {
              action: "route",
              destination: { host: "carrier.example.com", port: 5060 },
              features: minimalFeatures(),
              call_limiter: [
                { id: "lim-A", limit: 1000 },
                { id: "lim-B", limit: 1000 },
                { id: "lim-CRASH", limit: 1000 },
              ],
            },
            call: minimalCall(),
            req: minimalInvite(),
            aLegContact,
            rinfo,
            nowMs: 1_700_000_000_000,
            config: cfg(),
            callControl: noFailoverCallControl,
            limiter: counting.service,
          }),
        )

        // The defect surfaced.
        expect(Exit.isFailure(exit)).toBe(true)

        // INCRs landed for lim-A and lim-B. lim-CRASH died before INCRing.
        expect(counting.incrementedIds()).toEqual(["lim-A", "lim-B"])

        // **Eager DECR fired for both successful INCRs** — this is the
        // strong guarantee: any error after a successful INCR triggers
        // an immediate matching DECR.
        expect(counting.decrementedIds().sort()).toEqual(["lim-A", "lim-B"])
      }),
  )
})

void Stream
