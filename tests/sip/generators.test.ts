/**
 * Unit tests for src/sip/generators.ts — the "correct-by-default"
 * message-construction primitives.
 */

import { describe, expect, test } from "vitest"
import {
  _generateAckForNon2xx,
  extractNonStructuralHeaders,
  generateAckFor2xx,
  generateCancel,
  generateInDialogRequest,
  generateOutOfDialogRequest,
  generateResponse,
  type ContactSpec,
  type ViaSpec,
} from "../../src/sip/generators.js"
import type { StackDialog } from "../../src/sip/Dialog.js"
import type { InviteClientTransactionHandle } from "../../src/sip/TransactionLayer.js"
import { getHeader, getHeaders } from "../../src/sip/MessageHelpers.js"
import { serialize } from "../../src/sip/Serializer.js"
import type { SipHeader, SipRequest } from "../../src/sip/types.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VIA: ViaSpec = {
  localIp: "10.0.0.1",
  localPort: 5060,
  transport: "UDP",
  branch: "z9hG4bKtest00000000",
}

const CONTACT: ContactSpec = {
  user: "b2bua",
  host: "10.0.0.1",
  port: 5060,
}

const VIA_WITH_PARAMS: ViaSpec = {
  ...VIA,
  customParams: { cr: "cref1", lg: "a" },
}

const CONTACT_WITH_PARAMS: ContactSpec = {
  ...CONTACT,
  uriParams: { callRef: "cref1", leg: "a" },
}

const DIALOG: StackDialog = {
  callId: "call-bleg-1",
  localTag: "b2bua-local",
  remoteTag: "bob-remote",
  localUri: "sip:b2bua@10.0.0.1:5060",
  remoteUri: "sip:bob@192.0.2.20:5060",
  remoteTarget: "sip:bob@192.0.2.20:5060",
  localCSeq: 100,
  routeSet: [],
}

const SDP_BODY = new TextEncoder().encode(
  [
    "v=0",
    "o=- 0 0 IN IP4 10.0.0.1",
    "s=-",
    "c=IN IP4 10.0.0.1",
    "t=0 0",
    "m=audio 20000 RTP/AVP 8",
    "a=rtpmap:8 PCMA/8000",
    "",
  ].join("\r\n"),
)

function makeALegInvite(): SipRequest {
  return {
    type: "request",
    method: "INVITE",
    uri: "sip:bob@biloxi.example.com",
    version: "SIP/2.0",
    headers: [
      { name: "Via", value: "SIP/2.0/UDP atlanta.example.com:5060;branch=z9hG4bKalice" },
      { name: "Max-Forwards", value: "70" },
      { name: "From", value: '"Alice" <sip:alice@atlanta.example.com>;tag=alice-tag' },
      { name: "To", value: "<sip:bob@biloxi.example.com>" },
      { name: "Call-ID", value: "call-aleg-1" },
      { name: "CSeq", value: "1 INVITE" },
      { name: "Contact", value: "<sip:alice@atlanta.example.com:5060>" },
      { name: "Allow", value: "INVITE, ACK, CANCEL, BYE, OPTIONS" },
      { name: "Supported", value: "replaces, 100rel" },
      { name: "P-Asserted-Identity", value: "<sip:alice@atlanta.example.com>" },
      { name: "Content-Type", value: "application/sdp" },
      { name: "Content-Length", value: String(SDP_BODY.byteLength) },
    ],
    body: SDP_BODY,
    raw: Buffer.alloc(0),
  }
}

function inviteHandle(): InviteClientTransactionHandle {
  // The handle's originalInvite mirrors what TransactionLayer would stash —
  // an already-stamped outbound INVITE whose CSeq and Via are load-bearing
  // for CANCEL / ACK-for-2xx.
  const invite: SipRequest = {
    type: "request",
    method: "INVITE",
    uri: "sip:bob@192.0.2.20:5060",
    version: "SIP/2.0",
    headers: [
      { name: "Via", value: "SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bKinvite123;cr=cref1;lg=b-1" },
      { name: "Max-Forwards", value: "70" },
      { name: "From", value: "<sip:b2bua@10.0.0.1:5060>;tag=b2bua-local" },
      { name: "To", value: "<sip:bob@192.0.2.20:5060>" },
      { name: "Call-ID", value: "call-bleg-1" },
      { name: "CSeq", value: "42 INVITE" },
      { name: "Contact", value: "<sip:b2bua@10.0.0.1:5060;callRef=cref1;leg=b-1>" },
      { name: "Content-Length", value: "0" },
    ],
    body: new Uint8Array(0),
    raw: Buffer.alloc(0),
  }
  return {
    kind: "invite",
    branch: "z9hG4bKinvite123",
    originalInvite: invite,
    destination: { host: "192.0.2.20", port: 5060 },
  }
}

// ---------------------------------------------------------------------------
// extractNonStructuralHeaders
// ---------------------------------------------------------------------------

describe("extractNonStructuralHeaders", () => {
  test("keeps transparent headers and drops the full structural set", () => {
    const aLeg = makeALegInvite()
    const kept = extractNonStructuralHeaders(aLeg)
    const names = kept.map((h) => h.name.toLowerCase()).sort()
    expect(names).toEqual(["allow", "p-asserted-identity", "supported"])
  })

  test("preserves header order among non-structural headers", () => {
    const aLeg = makeALegInvite()
    const kept = extractNonStructuralHeaders(aLeg)
    expect(kept.map((h) => h.name)).toEqual(["Allow", "Supported", "P-Asserted-Identity"])
  })
})

// ---------------------------------------------------------------------------
// generateOutOfDialogRequest
// ---------------------------------------------------------------------------

describe("generateOutOfDialogRequest", () => {
  test("builds an initial INVITE with concrete Via/Contact, default Max-Forwards, and Content-Length", () => {
    const req = generateOutOfDialogRequest("INVITE", {
      requestUri: "sip:bob@biloxi.example.com",
      callId: "call-bleg-1",
      fromUri: "sip:b2bua@10.0.0.1:5060",
      fromTag: "b2bua-local",
      toUri: "sip:bob@biloxi.example.com",
      cseq: 1,
      via: VIA_WITH_PARAMS,
      contact: CONTACT_WITH_PARAMS,
      body: SDP_BODY,
    })

    expect(req.type).toBe("request")
    expect(req.method).toBe("INVITE")
    expect(req.uri).toBe("sip:bob@biloxi.example.com")
    expect(getHeader(req.headers, "Via")).toBe(
      "SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bKtest00000000;cr=cref1;lg=a",
    )
    expect(getHeader(req.headers, "Contact")).toBe(
      "<sip:b2bua@10.0.0.1:5060;callRef=cref1;leg=a>",
    )
    expect(getHeader(req.headers, "Max-Forwards")).toBe("70")
    expect(getHeader(req.headers, "From")).toBe("<sip:b2bua@10.0.0.1:5060>;tag=b2bua-local")
    expect(getHeader(req.headers, "To")).toBe("<sip:bob@biloxi.example.com>")
    expect(getHeader(req.headers, "Call-ID")).toBe("call-bleg-1")
    expect(getHeader(req.headers, "CSeq")).toBe("1 INVITE")
    expect(getHeader(req.headers, "Content-Type")).toBe("application/sdp")
    expect(getHeader(req.headers, "Content-Length")).toBe(String(SDP_BODY.byteLength))
    expect(req.body).toEqual(SDP_BODY)
  })

  test("passes extraHeaders through verbatim (transparent-header flow)", () => {
    const aLeg = makeALegInvite()
    const transparent = extractNonStructuralHeaders(aLeg)
    const req = generateOutOfDialogRequest("INVITE", {
      requestUri: "sip:bob@biloxi.example.com",
      callId: "call-bleg-1",
      fromUri: "sip:b2bua@10.0.0.1:5060",
      fromTag: "b2bua-local",
      toUri: "sip:bob@biloxi.example.com",
      cseq: 1,
      via: VIA,
      contact: CONTACT,
      extraHeaders: transparent,
      body: aLeg.body,
    })
    expect(getHeader(req.headers, "Allow")).toBe("INVITE, ACK, CANCEL, BYE, OPTIONS")
    expect(getHeader(req.headers, "Supported")).toBe("replaces, 100rel")
    expect(getHeader(req.headers, "P-Asserted-Identity")).toBe("<sip:alice@atlanta.example.com>")
  })

  test("omits Content-Type when body is empty and sets Content-Length:0", () => {
    const req = generateOutOfDialogRequest("OPTIONS", {
      requestUri: "sip:bob@biloxi.example.com",
      callId: "cid",
      fromUri: "sip:b2bua@10.0.0.1:5060",
      fromTag: "ft",
      toUri: "sip:bob@biloxi.example.com",
      cseq: 1,
      via: VIA,
      contact: CONTACT,
    })
    expect(getHeader(req.headers, "Content-Type")).toBeUndefined()
    expect(getHeader(req.headers, "Content-Length")).toBe("0")
  })

  test("honours caller-provided Max-Forwards", () => {
    const req = generateOutOfDialogRequest("INVITE", {
      requestUri: "sip:x@y",
      callId: "cid",
      fromUri: "sip:a@b",
      fromTag: "ft",
      toUri: "sip:x@y",
      cseq: 1,
      via: VIA,
      contact: CONTACT,
      maxForwards: 42,
    })
    expect(getHeader(req.headers, "Max-Forwards")).toBe("42")
  })

  test("preserves caller-supplied name-addr (display name) in From without double-wrapping", () => {
    const req = generateOutOfDialogRequest("INVITE", {
      requestUri: "sip:bob@biloxi.example.com",
      callId: "cid",
      fromUri: '"Alice" <sip:alice@atlanta.example.com>',
      fromTag: "alice-tag",
      toUri: "sip:bob@biloxi.example.com",
      cseq: 1,
      via: VIA,
      contact: CONTACT,
    })
    expect(getHeader(req.headers, "From")).toBe(
      '"Alice" <sip:alice@atlanta.example.com>;tag=alice-tag',
    )
  })
})

// ---------------------------------------------------------------------------
// generateInDialogRequest
// ---------------------------------------------------------------------------

describe("generateInDialogRequest", () => {
  test("bumps CSeq, uses remote-target as Request-URI, swaps From/To tags", () => {
    const { request, dialog: next } = generateInDialogRequest("BYE", DIALOG, {
      via: VIA_WITH_PARAMS,
      contact: CONTACT_WITH_PARAMS,
    })
    expect(request.method).toBe("BYE")
    expect(request.uri).toBe("sip:bob@192.0.2.20:5060")
    expect(getHeader(request.headers, "CSeq")).toBe("101 BYE")
    expect(next.localCSeq).toBe(101)
    expect(getHeader(request.headers, "From")).toBe(
      "<sip:b2bua@10.0.0.1:5060>;tag=b2bua-local",
    )
    expect(getHeader(request.headers, "To")).toBe(
      "<sip:bob@192.0.2.20:5060>;tag=bob-remote",
    )
    expect(getHeader(request.headers, "Call-ID")).toBe("call-bleg-1")
  })

  test("emits one Route header per route-set entry, in order", () => {
    const dialog: StackDialog = {
      ...DIALOG,
      routeSet: [
        "<sip:proxy1.example.com;lr>",
        "<sip:proxy2.example.com;lr>",
      ],
    }
    const { request } = generateInDialogRequest("BYE", dialog, {
      via: VIA,
      contact: CONTACT,
    })
    const routes = getHeaders(request.headers, "Route")
    expect(routes).toEqual([
      "<sip:proxy1.example.com;lr>",
      "<sip:proxy2.example.com;lr>",
    ])
  })

  test("adds RAck on PRACK", () => {
    const { request } = generateInDialogRequest("PRACK", DIALOG, {
      via: VIA,
      contact: CONTACT,
      rack: "1 101 INVITE",
    })
    expect(request.method).toBe("PRACK")
    expect(getHeader(request.headers, "RAck")).toBe("1 101 INVITE")
  })

  test("adds Event and Subscription-State on NOTIFY", () => {
    const body = new TextEncoder().encode("SIP/2.0 180 Ringing\r\n")
    const { request } = generateInDialogRequest("NOTIFY", DIALOG, {
      via: VIA,
      contact: CONTACT,
      event: "refer",
      subscriptionState: "active;expires=60",
      contentType: "message/sipfrag;version=2.0",
      body,
    })
    expect(getHeader(request.headers, "Event")).toBe("refer")
    expect(getHeader(request.headers, "Subscription-State")).toBe("active;expires=60")
    expect(getHeader(request.headers, "Content-Type")).toBe("message/sipfrag;version=2.0")
  })

  test("type-level: method cannot be 'ACK' (compile-time guarantee)", () => {
    // @ts-expect-error — ACK is not a valid in-dialog method (RFC 3261 §17.1.1.3)
    generateInDialogRequest("ACK", DIALOG, { via: VIA, contact: CONTACT })
  })
})

// ---------------------------------------------------------------------------
// generateAckFor2xx
// ---------------------------------------------------------------------------

describe("generateAckFor2xx", () => {
  test("reads CSeq number from the INVITE handle, not the dialog's localCSeq", () => {
    // Simulate the PRACK-between-INVITE-and-2xx foot-gun: dialog has moved
    // past the INVITE CSeq. The ACK must still carry the INVITE's number.
    const dialog: StackDialog = { ...DIALOG, localCSeq: 999 }
    const ack = generateAckFor2xx(inviteHandle(), dialog, {
      via: { ...VIA, branch: "z9hG4bKackbranch" },
    })
    expect(ack.method).toBe("ACK")
    expect(getHeader(ack.headers, "CSeq")).toBe("42 ACK")
    // New Via branch — ACK for 2xx is its own hop (§13.2.2.4).
    expect(getHeader(ack.headers, "Via")).toContain("branch=z9hG4bKackbranch")
  })

  test("Request-URI is the dialog's remote target; Route headers come from the route set", () => {
    const dialog: StackDialog = {
      ...DIALOG,
      remoteTarget: "sip:bob-contact@192.0.2.99:5060",
      routeSet: ["<sip:proxy.example.com;lr>"],
    }
    const ack = generateAckFor2xx(inviteHandle(), dialog, { via: VIA })
    expect(ack.uri).toBe("sip:bob-contact@192.0.2.99:5060")
    expect(getHeaders(ack.headers, "Route")).toEqual(["<sip:proxy.example.com;lr>"])
  })

  test("carries SDP body through when provided (re-offer inside ACK)", () => {
    const ack = generateAckFor2xx(inviteHandle(), DIALOG, {
      via: VIA,
      body: SDP_BODY,
    })
    expect(getHeader(ack.headers, "Content-Type")).toBe("application/sdp")
    expect(getHeader(ack.headers, "Content-Length")).toBe(String(SDP_BODY.byteLength))
    expect(ack.body).toEqual(SDP_BODY)
  })
})

// ---------------------------------------------------------------------------
// generateCancel
// ---------------------------------------------------------------------------

describe("generateCancel", () => {
  test("reuses the INVITE's topmost Via verbatim (same branch — RFC 3261 §9.1)", () => {
    const cancel = generateCancel(inviteHandle())
    expect(cancel.method).toBe("CANCEL")
    expect(getHeader(cancel.headers, "Via")).toBe(
      "SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bKinvite123;cr=cref1;lg=b-1",
    )
  })

  test("mirrors Request-URI, Call-ID, From, To and CSeq number from the INVITE", () => {
    const cancel = generateCancel(inviteHandle())
    expect(cancel.uri).toBe("sip:bob@192.0.2.20:5060")
    expect(getHeader(cancel.headers, "Call-ID")).toBe("call-bleg-1")
    expect(getHeader(cancel.headers, "From")).toBe(
      "<sip:b2bua@10.0.0.1:5060>;tag=b2bua-local",
    )
    expect(getHeader(cancel.headers, "To")).toBe("<sip:bob@192.0.2.20:5060>")
    expect(getHeader(cancel.headers, "CSeq")).toBe("42 CANCEL")
    expect(getHeader(cancel.headers, "Content-Length")).toBe("0")
  })
})

// ---------------------------------------------------------------------------
// generateResponse
// ---------------------------------------------------------------------------

describe("generateResponse", () => {
  test("echoes Via / From / To / Call-ID / CSeq from the request", () => {
    const req = makeALegInvite()
    const resp = generateResponse(req, 100, "Trying")
    expect(getHeader(resp.headers, "Via")).toBe(getHeader(req.headers, "Via"))
    expect(getHeader(resp.headers, "From")).toBe(getHeader(req.headers, "From"))
    expect(getHeader(resp.headers, "To")).toBe(getHeader(req.headers, "To"))
    expect(getHeader(resp.headers, "Call-ID")).toBe(getHeader(req.headers, "Call-ID"))
    expect(getHeader(resp.headers, "CSeq")).toBe(getHeader(req.headers, "CSeq"))
  })

  test("adds the caller-provided To-tag when status > 100 and the request lacks one", () => {
    const req = makeALegInvite()
    const resp = generateResponse(req, 180, "Ringing", { toTag: "b2bua-uas-tag" })
    expect(getHeader(resp.headers, "To")).toBe(
      "<sip:bob@biloxi.example.com>;tag=b2bua-uas-tag",
    )
  })

  test("does NOT add a tag on 100 Trying even when one is provided", () => {
    const req = makeALegInvite()
    const resp = generateResponse(req, 100, "Trying", { toTag: "should-be-ignored" })
    expect(getHeader(resp.headers, "To")).toBe("<sip:bob@biloxi.example.com>")
  })

  test("preserves an already-present To-tag (pins consistency within the txn)", () => {
    const req = makeALegInvite()
    const headersWithTag: SipHeader[] = req.headers.map((h) =>
      h.name === "To" ? { ...h, value: "<sip:bob@biloxi.example.com>;tag=existing" } : h,
    )
    const reqWithTag = { ...req, headers: headersWithTag }
    const resp = generateResponse(reqWithTag, 200, "OK", {
      toTag: "different",
      contact: CONTACT,
    })
    expect(getHeader(resp.headers, "To")).toBe("<sip:bob@biloxi.example.com>;tag=existing")
  })

  test("emits Contact when opts.contact is provided (required on 2xx to dialog-creating requests)", () => {
    const req = makeALegInvite()
    const resp = generateResponse(req, 200, "OK", {
      toTag: "b2bua-uas-tag",
      contact: CONTACT_WITH_PARAMS,
    })
    expect(getHeader(resp.headers, "Contact")).toBe(
      "<sip:b2bua@10.0.0.1:5060;callRef=cref1;leg=a>",
    )
  })

  test("omits Contact when not provided (e.g. 4xx/5xx rejections)", () => {
    const req = makeALegInvite()
    const resp = generateResponse(req, 486, "Busy Here", { toTag: "b2bua-uas-tag" })
    expect(getHeader(resp.headers, "Contact")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// _generateAckForNon2xx
// ---------------------------------------------------------------------------

describe("_generateAckForNon2xx", () => {
  test("reuses the INVITE's topmost Via (same branch) and copies final response From/To", () => {
    const handle = inviteHandle()
    const final487 = generateResponse(handle.originalInvite, 487, "Request Terminated", { toTag: "uas-tag" })
    const ack = _generateAckForNon2xx(handle.originalInvite, final487)
    expect(ack.method).toBe("ACK")
    expect(ack.uri).toBe("sip:bob@192.0.2.20:5060")
    expect(getHeader(ack.headers, "Via")).toBe(getHeader(handle.originalInvite.headers, "Via"))
    expect(getHeader(ack.headers, "From")).toBe(getHeader(final487.headers, "From"))
    expect(getHeader(ack.headers, "To")).toBe(getHeader(final487.headers, "To"))
    expect(getHeader(ack.headers, "Call-ID")).toBe("call-bleg-1")
    expect(getHeader(ack.headers, "CSeq")).toBe("42 ACK")
  })
})

describe("in-dialog BYE omits Contact (RFC 3261 §15)", () => {
  test("no Contact header on BYE", () => {
    const { request } = generateInDialogRequest("BYE", DIALOG, {
      via: VIA,
      contact: CONTACT,
    })
    expect(getHeader(request.headers, "Contact")).toBeUndefined()
  })
})
