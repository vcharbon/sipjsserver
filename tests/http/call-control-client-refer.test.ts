/**
 * Tests for the /call/refer HTTP contract:
 * - Schema roundtrip for CallReferRequest / CallReferResponse.
 * - X-Api-Call driven mock behaviour (reject-403, http-500, http-timeout).
 * - CallControlClient.callRefer wired through the in-process mock layer.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import {
  CallReferAllowResponse,
  CallReferRejectResponse,
  CallReferRequest,
  CallReferResponse,
  type CallReferRequest as CallReferRequestType,
} from "../../src/http/CallControlSchemas.js"
import { mockCallReferBehavior } from "../../src/http/MockCallControlServer.js"
import { CallControlClient } from "../../src/http/CallControlClient.js"
import { MockCallControlLayer } from "../e2e/framework/MockCallControlLayer.js"

// ── Schema roundtrip ─────────────────────────────────────────────────────────

describe("CallReferRequest schema", () => {
  it("roundtrips a minimal payload", () => {
    const payload = {
      call_id: "abc123@proxy",
      dialog_id: "abc123@proxy;to-tag=xyz;from-tag=abc",
      refer_to: "sip:charlie@192.0.2.30",
    }
    const decoded = Schema.decodeUnknownSync(CallReferRequest)(payload)
    const encoded = Schema.encodeUnknownSync(CallReferRequest)(decoded)
    expect(encoded).toEqual(payload)
  })

  it("roundtrips full payload with headers and referred_by", () => {
    const payload = {
      call_id: "abc123@proxy",
      dialog_id: "abc123@proxy;to-tag=xyz;from-tag=abc",
      refer_to: "sip:charlie@192.0.2.30",
      referred_by: "<sip:alice@example.com>",
      callback_context: '{"ticket":"T1"}',
      sip_headers: {
        "X-Api-Call": '{"refer_key":"refer-reject-403"}',
        "X-Trace": "1-abc",
      },
    }
    const decoded = Schema.decodeUnknownSync(CallReferRequest)(payload)
    const encoded = Schema.encodeUnknownSync(CallReferRequest)(decoded)
    expect(encoded).toEqual(payload)
  })
})

describe("CallReferAllowResponse schema", () => {
  it("requires destination and action=allow", () => {
    expect(() =>
      Schema.decodeUnknownSync(CallReferAllowResponse)({ action: "allow" })
    ).toThrow()
  })

  it("roundtrips the superset fields", () => {
    const payload = {
      action: "allow" as const,
      destination: { host: "10.0.1.20", port: 5060, transport: "udp" as const },
      new_refer_to: "sip:c@10.0.1.20",
      update_headers: { "X-Transfer": "blind", "P-Drop": null },
      no_answer_timeout_sec: 30,
      call_limiter: [{ id: "trunk:A", limit: 100 }],
      callback_context: '{"transfer":"blind"}',
      relay_first_18x_to_180: true,
    }
    const decoded = Schema.decodeUnknownSync(CallReferAllowResponse)(payload)
    const encoded = Schema.encodeUnknownSync(CallReferAllowResponse)(decoded)
    expect(encoded).toEqual(payload)
  })
})

describe("CallReferRejectResponse schema", () => {
  it("roundtrips reject with code and reason", () => {
    const payload = {
      action: "reject" as const,
      reject_code: 603,
      reject_reason: "Declined",
    }
    const decoded = Schema.decodeUnknownSync(CallReferRejectResponse)(payload)
    const encoded = Schema.encodeUnknownSync(CallReferRejectResponse)(decoded)
    expect(encoded).toEqual(payload)
  })
})

describe("CallReferResponse union", () => {
  it("accepts either allow or reject", () => {
    const allow = {
      action: "allow" as const,
      destination: { host: "10.0.1.20" },
    }
    const reject = { action: "reject" as const, reject_code: 403 }
    expect(() => Schema.decodeUnknownSync(CallReferResponse)(allow)).not.toThrow()
    expect(() => Schema.decodeUnknownSync(CallReferResponse)(reject)).not.toThrow()
  })
})

// ── mockCallReferBehavior (pure) ─────────────────────────────────────────────

const baseReq: CallReferRequestType = {
  call_id: "abc123@proxy",
  dialog_id: "abc123@proxy;to-tag=xyz;from-tag=abc",
  refer_to: "sip:charlie@192.0.2.30",
}

function withApiCall(instruction: Record<string, unknown>): CallReferRequestType {
  return {
    ...baseReq,
    sip_headers: { "X-Api-Call": JSON.stringify(instruction) },
  }
}

describe("mockCallReferBehavior", () => {
  it("defaults to reject 603 when no X-Api-Call is set", () => {
    const behavior = mockCallReferBehavior(baseReq)
    expect(behavior.type).toBe("respond")
    if (behavior.type !== "respond") throw new Error("unreachable")
    expect(behavior.body).toEqual({
      action: "reject",
      reject_code: 603,
      reject_reason: "Declined",
    })
  })

  it("refer-reject-403 → reject 403", () => {
    const behavior = mockCallReferBehavior(withApiCall({ refer_key: "refer-reject-403" }))
    expect(behavior).toEqual({
      type: "respond",
      body: { action: "reject", reject_code: 403, reject_reason: "Forbidden" },
    })
  })

  it("refer-reject-403 honours overridden reject_code/reason", () => {
    const behavior = mockCallReferBehavior(
      withApiCall({
        refer_key: "refer-reject-403",
        reject_code: 488,
        reject_reason: "Not Acceptable Here",
      })
    )
    expect(behavior).toEqual({
      type: "respond",
      body: { action: "reject", reject_code: 488, reject_reason: "Not Acceptable Here" },
    })
  })

  it("refer-http-500 → http500 sentinel", () => {
    const behavior = mockCallReferBehavior(withApiCall({ refer_key: "refer-http-500" }))
    expect(behavior).toEqual({ type: "http500" })
  })

  it("refer-http-timeout → hang sentinel", () => {
    const behavior = mockCallReferBehavior(withApiCall({ refer_key: "refer-http-timeout" }))
    expect(behavior).toEqual({ type: "hang" })
  })

  it("unknown refer_key defaults to reject 603", () => {
    const behavior = mockCallReferBehavior(withApiCall({ refer_key: "wat" }))
    expect(behavior).toEqual({
      type: "respond",
      body: { action: "reject", reject_code: 603, reject_reason: "Declined" },
    })
  })

  it("throws on invalid X-Api-Call JSON", () => {
    const req: CallReferRequestType = {
      ...baseReq,
      sip_headers: { "X-Api-Call": "{ not json" },
    }
    expect(() => mockCallReferBehavior(req)).toThrow()
  })
})

// ── CallControlClient.callRefer through the in-process mock layer ────────────

const layer = MockCallControlLayer

describe("CallControlClient.callRefer (mock layer)", () => {
  it.effect("returns the reject response for refer-reject-403", () =>
    Effect.gen(function* () {
      const client = yield* CallControlClient
      const resp = yield* client.callRefer(withApiCall({ refer_key: "refer-reject-403" }))
      expect(resp).toEqual({
        action: "reject",
        reject_code: 403,
        reject_reason: "Forbidden",
      })
    }).pipe(Effect.provide(layer))
  )

  it.effect("fails with CallControlError for refer-http-500", () =>
    Effect.gen(function* () {
      const client = yield* CallControlClient
      const exit = yield* Effect.exit(
        client.callRefer(withApiCall({ refer_key: "refer-http-500" }))
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }).pipe(Effect.provide(layer))
  )

  it.live("hangs indefinitely for refer-http-timeout (live clock)", () =>
    Effect.gen(function* () {
      const client = yield* CallControlClient
      const result = yield* client
        .callRefer(withApiCall({ refer_key: "refer-http-timeout" }))
        .pipe(Effect.timeoutOption("50 millis"))
      expect(result._tag).toBe("None")
    }).pipe(Effect.provide(layer))
  )

  it.effect("default (no X-Api-Call) → reject 603", () =>
    Effect.gen(function* () {
      const client = yield* CallControlClient
      const resp = yield* client.callRefer(baseReq)
      expect(resp).toEqual({
        action: "reject",
        reject_code: 603,
        reject_reason: "Declined",
      })
    }).pipe(Effect.provide(layer))
  )
})
