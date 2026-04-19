/**
 * Schema roundtrip tests for TransferState and Call.transfer.
 *
 * Slice 3 of the REFER implementation: ensures the new optional transfer
 * field on Call encodes/decodes cleanly through Schema so it can survive
 * Redis persistence in later slices.
 */

import { describe, expect, test } from "vitest"
import { Schema } from "effect"
import {
  Call,
  TransferPhase,
  TransferState,
  randomInitialCSeq,
  type Leg,
} from "../../src/call/CallModel.js"

const CallJson = Schema.fromJsonString(Call)

// ── Fixtures ──────────────────────────────────────────────────────────────

const aLeg: Leg = {
  legId: "a",
  callId: "alice-call-id",
  fromTag: "alice-tag",
  source: { address: "192.0.2.10", port: 5060 },
  state: "confirmed",
  disposition: "bridged",
  dialogs: [
    {
      sip: {
        callId: "alice-call-id",
        localTag: "b2bua-a-tag",
        remoteTag: "alice-tag",
        localUri: "<sip:b2bua@10.0.0.1>",
        remoteUri: "<sip:alice@example.com>",
        remoteTarget: "sip:b2bua@10.0.0.1:5060",
        localCSeq: randomInitialCSeq(),
        routeSet: [],
      },
      ext: {
        remoteCSeq: 101,
        inboundPendingRequests: [],
      },
    },
  ],
}

const bLeg: Leg = {
  legId: "b-1",
  callId: "1-alice-call-id",
  fromTag: "b2bua-b-tag",
  source: { address: "192.0.2.20", port: 5060 },
  state: "confirmed",
  disposition: "bridged",
  dialogs: [
    {
      sip: {
        callId: "1-alice-call-id",
        localTag: "b2bua-b-tag",
        remoteTag: "bob-tag",
        localUri: "<sip:b2bua@10.0.0.1>",
        remoteUri: "<sip:target@example.com>",
        remoteTarget: "sip:bob@192.0.2.20:5060",
        localCSeq: randomInitialCSeq(),
        routeSet: [],
      },
      ext: {
        remoteCSeq: 1,
        inboundPendingRequests: [],
      },
    },
  ],
}

function baseCall(): typeof Call.Type {
  return {
    callRef: "alice-call-id|alice-tag",
    aLeg,
    bLegs: [bLeg],
    activePeer: { legA: "a", legB: "b-1" },
    limiterEntries: [],
    timers: [],
    cdrEvents: [],
    state: "active",
    createdAt: 1_700_000_000_000,
    aLegInvite: {
      uri: "sip:target@example.com",
      headers: [
        { name: "Via", value: "SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bK.alice" },
        { name: "From", value: "<sip:alice@example.com>;tag=alice-tag" },
        { name: "To", value: "<sip:target@example.com>" },
        { name: "CSeq", value: "1 INVITE" },
        { name: "Call-ID", value: aLeg.callId },
      ],
      body: new Uint8Array(),
    },
    tagMap: [{ aTag: "b2bua-a-tag", bLegId: "b-1", bTag: "bob-tag" }],
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("TransferPhase schema", () => {
  test("accepts all four phase literals", () => {
    for (const phase of [
      "refer-authorizing",
      "c-ringing",
      "c-realigning",
      "a-realigning",
    ] as const) {
      const decoded = Schema.decodeUnknownSync(TransferPhase)(phase)
      expect(decoded).toBe(phase)
    }
  })

  test("rejects unknown phase literals", () => {
    expect(() => Schema.decodeUnknownSync(TransferPhase)("bogus")).toThrow()
  })
})

describe("TransferState schema", () => {
  test("decodes a minimal transfer state", () => {
    const value = {
      phase: "refer-authorizing" as const,
      referrerLegId: "b-1",
      referToUri: "sip:charlie@192.0.2.30",
      startedAtMs: 1_700_000_000_000,
    }
    const decoded = Schema.decodeUnknownSync(TransferState)(value)
    expect(decoded).toEqual(value)
  })

  test("roundtrips a fully-populated transfer state", () => {
    const value = {
      phase: "c-ringing" as const,
      referrerLegId: "b-1",
      referToUri: "sip:charlie@192.0.2.30",
      effectiveReferToUri: "sip:charlie-rewrite@192.0.2.30",
      callbackContext: "opaque-blob",
      cLegId: "b-2",
      referCSeq: 42,
      startedAtMs: 1_700_000_000_000,
    }
    const decoded = Schema.decodeUnknownSync(TransferState)(value)
    expect(decoded).toEqual(value)
  })
})

describe("Call.transfer field", () => {
  test("roundtrips a call with transfer in c-ringing phase through JSON", () => {
    const call: typeof Call.Type = {
      ...baseCall(),
      transfer: {
        phase: "c-ringing",
        referrerLegId: "b-1",
        referToUri: "sip:charlie@192.0.2.30",
        cLegId: "b-2",
        referCSeq: 42,
        startedAtMs: 1_700_000_000_000,
      },
    }
    const json = Schema.encodeSync(CallJson)(call)
    const decoded = Schema.decodeUnknownSync(CallJson)(json)
    expect(decoded.transfer?.phase).toBe("c-ringing")
    expect(decoded.transfer?.cLegId).toBe("b-2")
    expect(decoded).toEqual(call)
  })

  test("roundtrips a call with transfer === null through JSON", () => {
    const call: typeof Call.Type = {
      ...baseCall(),
      transfer: null,
    }
    const json = Schema.encodeSync(CallJson)(call)
    const decoded = Schema.decodeUnknownSync(CallJson)(json)
    expect(decoded.transfer).toBeNull()
  })

  test("roundtrips a call with transfer omitted entirely (backwards compat)", () => {
    const call = baseCall()
    const json = Schema.encodeSync(CallJson)(call)
    const decoded = Schema.decodeUnknownSync(CallJson)(json)
    expect(decoded.transfer).toBeUndefined()
  })
})
