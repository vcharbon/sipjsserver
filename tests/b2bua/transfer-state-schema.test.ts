/**
 * Schema round-trip tests for the transfer service slices (ADR-0016).
 *
 * Transfer state moved off the core `Call.transfer` field onto the transfer
 * callflow service's typed call-ext (`TransferCallExt`) slice in
 * referTransfer.ts, riding inside the generic `Call.ext` carry. Legs are
 * addressed by id (no per-leg ext). This test re-points to those schemas and
 * keeps locking the Schema shapes that REFER persistence depends on.
 */

import { describe, expect, test } from "vitest"
import { Schema } from "effect"
import { Call, randomInitialCSeq, type Leg } from "../../src/call/CallModel.js"
import {
  TransferCallExt,
  TransferPhase,
  encodeTransferCallExt,
} from "../../src/b2bua/rules/custom/referTransfer.js"

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

describe("TransferCallExt schema", () => {
  test("decodes a minimal transfer state", () => {
    const value = {
      phase: "refer-authorizing" as const,
      referrerLegId: "b-1",
      referToUri: "sip:charlie@192.0.2.30",
      startedAtMs: 1_700_000_000_000,
    }
    const decoded = Schema.decodeUnknownSync(TransferCallExt)(value)
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
    const decoded = Schema.decodeUnknownSync(TransferCallExt)(value)
    expect(decoded).toEqual(value)
  })

  test("cInitialSdp encodes to base64 at rest and re-decodes to bytes", () => {
    const sdp = new TextEncoder().encode("v=0\r\no=- 1 1 IN IP4 1.1.1.1\r\n")
    const encoded = encodeTransferCallExt({
      phase: "c-realigning",
      referrerLegId: "b-1",
      referToUri: "sip:c@example.com",
      cLegId: "b-2",
      startedAtMs: 1000,
      cInitialSdp: sdp,
    })
    expect(typeof (encoded as { cInitialSdp: unknown }).cInitialSdp).toBe("string")
    const reDecoded = Schema.decodeUnknownSync(TransferCallExt)(encoded)
    expect(reDecoded.cInitialSdp).toEqual(sdp)
  })
})

describe("transfer slice rides inside Call.ext", () => {
  test("roundtrips a call carrying the transfer slice in ext through JSON", () => {
    const call: typeof Call.Type = {
      ...baseCall(),
      ext: {
        transfer: encodeTransferCallExt({
          phase: "c-ringing",
          referrerLegId: "b-1",
          referToUri: "sip:charlie@192.0.2.30",
          cLegId: "b-2",
          referCSeq: 42,
          startedAtMs: 1_700_000_000_000,
        }),
      },
    }
    const json = Schema.encodeSync(CallJson)(call)
    const decoded = Schema.decodeUnknownSync(CallJson)(json)
    const slice = Schema.decodeUnknownSync(TransferCallExt)(decoded.ext!["transfer"])
    expect(slice.phase).toBe("c-ringing")
    expect(slice.cLegId).toBe("b-2")
  })

  test("roundtrips a call with no ext (no transfer) through JSON", () => {
    const call = baseCall()
    const json = Schema.encodeSync(CallJson)(call)
    const decoded = Schema.decodeUnknownSync(CallJson)(json)
    expect(decoded.ext).toBeUndefined()
  })
})
