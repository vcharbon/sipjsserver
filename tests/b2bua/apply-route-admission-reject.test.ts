/**
 * Admission gate for the main `applyRoute` path.
 *
 * If call-control returns a `routing.destination.host` that is neither an
 * IP literal nor matched by `workerAllowedTargetSuffixes`, applyRoute must
 * synthesize a 503 toward the upstream UAS and emit terminate effects —
 * without spawning a b-leg, without acquiring limiters, without making
 * call-control's `/call/failure` request.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { applyRoute } from "../../src/decision/apply/applyRoute.js"
import type { Call } from "../../src/call/CallModel.js"
import type { SipRequest, RemoteInfo } from "../../src/sip/types.js"
import type { ContactSpec } from "../../src/sip/generators.js"
import type { AppConfigData } from "../../src/config/AppConfig.js"
import type { CallDecisionEngine } from "../../src/decision/CallDecisionEngine.js"
import type { CallLimiter } from "../../src/call/CallLimiter.js"
import { hydrateRequest } from "../../src/sip/parsers/extract-fields.js"
import type { FeatureActivations } from "../../src/decision/schemas/features.js"

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

const cfg = (suffixes: ReadonlyArray<string>): AppConfigData =>
  ({
    workerAllowedTargetSuffixes: suffixes,
  } as AppConfigData)

const stubCallControl: CallDecisionEngine["Service"] = {
  // Should never be invoked when admission rejects.
  newCall: () => Effect.die("newCall should not be called on admission reject"),
  callFailure: () => Effect.die("callFailure should not be called on admission reject"),
  callRefer: () => Effect.die("callRefer should not be called on admission reject"),
} as unknown as CallDecisionEngine["Service"]

const stubLimiter: CallLimiter["Service"] = {
  checkAndIncrement: () => Effect.die("limiter should not be called on admission reject"),
  decrement: () => Effect.die("limiter should not be called on admission reject"),
} as unknown as CallLimiter["Service"]

describe("applyRoute admission gate", () => {
  it.effect("rejects non-IP non-suffixed destination with 503 + terminate effects, no limiter touched", () =>
    Effect.gen(function* () {
      const call = minimalCall()
      const req = minimalInvite()
      const result = yield* applyRoute({
        routing: {
          action: "route",
          destination: { host: "kindlab", port: 5060 },
          features: minimalFeatures(),
          // include call_limiter to prove we don't acquire it on reject
          call_limiter: [{ id: "global", limit: 100 }],
        },
        call,
        req,
        aLegContact,
        rinfo,
        nowMs: 1_700_000_000_000,
        config: cfg([".svc.cluster.local"]),
        callControl: stubCallControl,
        limiter: stubLimiter,
      })

      // 503 envelope back to upstream UAS source
      expect(result.effects.outbound.length).toBe(1)
      const env = result.effects.outbound[0]!
      expect(env.message.type).toBe("response")
      if (env.message.type === "response") {
        expect(env.message.status).toBe(503)
      }
      expect(env.destination).toEqual({ host: rinfo.address, port: rinfo.port })

      // terminate effects emitted (remove-call is part of the canonical set)
      expect(result.effects.critical.some((e) => e.type === "remove-call")).toBe(true)
      // span event flagged with admission_reject
      expect(
        result.spanEvents?.some(
          (e) =>
            e.name === "route_decision" &&
            e.attributes?.["route.reason"] === "admission_reject",
        ),
      ).toBe(true)
    }),
  )

  it.effect("IP literal is admitted regardless of suffix list", () =>
    Effect.gen(function* () {
      const call = minimalCall()
      const req = minimalInvite()
      // Use a stub callControl that won't be called since there's no limiter
      // and no failure path. createBLegFromRoute spawns the b-leg outbound.
      const result = yield* applyRoute({
        routing: {
          action: "route",
          destination: { host: "10.0.1.5", port: 5060 },
          features: minimalFeatures(),
        },
        call,
        req,
        aLegContact,
        rinfo,
        nowMs: 1_700_000_000_000,
        config: cfg([".svc.cluster.local"]),
        callControl: stubCallControl,
        limiter: stubLimiter,
      })

      // No 503: outbound has the b-leg INVITE, not a rejection.
      const responses = result.effects.outbound.filter((o) => o.message.type === "response")
      expect(responses.length).toBe(0)
      expect(
        result.spanEvents?.some(
          (e) =>
            e.name === "route_decision" &&
            e.attributes?.["route.action"] === "route",
        ),
      ).toBe(true)
    }),
  )
})
