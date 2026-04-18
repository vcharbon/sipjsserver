# B2BUA SIP Header Mapping Reference

This document describes exactly how each SIP header is handled at every hop through the B2BUA. Consult this before modifying any SIP message-building or relay logic.

## Terminology

| Term | Meaning |
|------|---------|
| **a-leg** | Alice -> B2BUA. B2BUA is UAS (received the INVITE). |
| **b-leg** | B2BUA -> Bob. B2BUA is UAC (sent the INVITE). |
| **fromTag** (on Leg) | The From tag used by whoever initiated the leg. a-leg: Alice's tag. b-leg: B2BUA's tag. |
| **dialog.toTag** | The tag the other side put in To when confirming the dialog. a-leg: B2BUA's tag. b-leg: Bob's tag. |

### Tag ownership cheat sheet

| Leg | `leg.fromTag` belongs to | `dialog.toTag` belongs to |
|-----|--------------------------|---------------------------|
| a-leg | Alice | B2BUA |
| b-leg | B2BUA | Bob |

When the B2BUA creates an **in-dialog request** (OPTIONS, BYE, etc.), From must carry the B2BUA's own tag and To must carry the remote party's tag:

| Direction | From tag = | To tag = |
|-----------|-----------|----------|
| B2BUA -> Alice | `aLeg.dialogs[0].toTag` | `aLeg.fromTag` |
| B2BUA -> Bob | `bLeg.fromTag` | `bLeg.dialogs[0].toTag` |

Notice the asymmetry: on the a-leg, B2BUA's tag is in `dialog.toTag` (B2BUA was the responder); on the b-leg, B2BUA's tag is in `leg.fromTag` (B2BUA was the initiator).

## Header-by-header behavior

### Via

**Inbound resolution:** The top Via of incoming responses carries custom params `;cr=<callRef>;lg=<legId>` used to resolve which call and leg the response belongs to. Parsed by `parseViaParams()`.

**Outbound stamping:** All outbound messages have their `__PLACEHOLDER__` Via replaced by `stampHeaders()` in SipRouter:
```
SIP/2.0/UDP <localIp>:<localPort>;branch=<newBranch>;cr=<callRef>;lg=<legId>
```

**Relay (b-leg response -> a-leg):** `relayResponse()` strips all b-leg Vias and restores the original a-leg Vias from `call.aLegVias` (stored at INVITE time). This is critical: Alice must see her own Vias, not the b-leg's.

### Contact

**Inbound resolution:** The Contact URI of incoming requests carries `;callRef=<callRef>;leg=<legId>` used to resolve which call/leg the request targets. Parsed by `parseUriParams()`.

**Outbound stamping:** All outbound messages have their `__PLACEHOLDER__` Contact replaced by `stampHeaders()`:
```
<sip:b2bua@<localIp>:<localPort>;callRef=<callRef>;leg=<legId>>
```

**Relay:** `relayResponse()` strips the b-leg Contact and inserts a `__PLACEHOLDER__` which SipRouter stamps with a-leg params.

### Call-ID

Each leg has an independent Call-ID. a-leg uses Alice's original Call-ID; b-leg uses a generated one (`{legNumber}-{aLegCallId}` in standalone mode, hash-derived in cluster mode).

**Relay:** `relayResponse()` replaces the b-leg Call-ID with `call.aLeg.callId`.

### From

**In generated requests (buildBye, buildOptions, buildAck, etc.):** Built from the function's `fromTag` parameter and `targetUri`. See "Known issues" below about the URI problem.

**Relay (b-leg response -> a-leg):** `relayResponse()` rewrites From with `call.aLegFrom` (the original From header Alice sent in her INVITE). This ensures Alice sees her own From tag echoed back, as required by RFC 3261.

**Stored at call creation:** `call.aLegFrom` is captured from the original INVITE in `SipRouter.handleInitialInvite`.

### To

**In generated requests:** Built from the function's `toTag` parameter and `targetUri`.

**Relay (b-leg response -> a-leg):** `relayResponse()` rewrites To with `call.aLegTo` (the original To URI from Alice's INVITE) plus the B2BUA's a-facing tag. Each distinct b-leg remote tag maps to a unique B2BUA-generated tag via `call.tagMap`. This ensures Alice never sees Bob's real tags — proper B2BUA behavior per RFC 3261.

**Tag mapping:** `call.tagMap` (array of `TagMapping { aTag, bLegId, bTag }`) tracks the bidirectional mapping between B2BUA-generated a-facing tags and Bob's real b-leg dialog tags. Handlers use `findByBTag()` when relaying responses (b→a) to look up the a-facing tag, and `findByATag()` when routing Alice's requests (a→b, e.g. PRACK) back to the correct b-leg dialog. In forking scenarios, each b-leg early dialog gets its own distinct a-facing tag.

**Stored at call creation:** `call.aLegTo` is captured from the original INVITE in `SipRouter.handleInitialInvite`.

### Record-Route

Only added to the initial b-leg INVITE (`buildBLegInvite`). Stamped with `callRef`/`leg` params like Contact.

### CSeq

- Each leg tracks its own CSeq sequence via `dialog.localCSeq`.
- `bumpLocalCSeq()` increments when sending in-dialog requests (OPTIONS, PRACK, re-INVITE).
- Responses echo the CSeq from the request they answer.
- CANCEL reuses the original INVITE's CSeq number.
- **re-INVITE CSeq rewriting:** When relaying a re-INVITE response, the B2BUA rewrites the CSeq number to match what the originator sent (stored in `PendingRequest.inboundCSeq`), since each leg uses independent CSeq sequences.

### CANCEL (RFC 3261 §9.1)

A CANCEL request must match three fields of the INVITE it is cancelling so that the downstream UAS (and any intermediate proxies) can correlate it to the outstanding INVITE transaction:

| Field | Source | Where stored |
|-------|--------|--------------|
| Request-URI | Must equal the INVITE's Request-URI | `leg.inviteRequestUri` — captured in `createBLegFromRoute` when the b-leg INVITE is built |
| Top Via `branch` | Must equal the INVITE's top Via branch | `leg.inviteBranch` — captured from `stampHeaders()`'s return value in `SipRouter.processResult` Phase A, persisted to the leg *before* any outbound send |
| CSeq number | Must equal the INVITE's CSeq number (method is `CANCEL`) | `leg.initialCSeq` |

The CANCEL's From tag, To (without tag), and Call-ID are inherited from the INVITE; CSeq method is `CANCEL`; Max-Forwards is fresh (70). `buildCancel()` in `MessageFactory` takes these five inputs and produces a standards-compliant CANCEL.

**Branch capture lifecycle.** `stampHeaders()` replaces the `__PLACEHOLDER__` Via with a freshly generated branch (or the caller-supplied `forceBranch`) and returns `{ message, branch }`. `processResult` runs in two phases so the branch can be persisted without violating the "state updates before sending" invariant:

1. **Phase A (stamp):** iterate `result.outbound`, stamp each message, and when the result is an outbound INVITE targeting a b-leg, store `branch` on the corresponding b-leg (`inviteBranch`) in a local `workingCall`.
2. Single `callState.update(callRef, () => workingCall)` persists the updated call (including any captured branches) before anything is sent.
3. **Phase B (send):** iterate the stamped messages and hand them to `TransactionLayer` — no further state mutation, no regex-parsing the Via back out of a sent message.

When a later CANCEL is sent for the same b-leg, `processResult` reads `leg.inviteBranch` and passes it as `forceBranch` to `stampHeaders`, reusing the exact value written on the wire during the original INVITE.

## Placeholder stamping pipeline

All `MessageFactory` functions return messages with `__PLACEHOLDER__` values for Via, Contact, and Record-Route. These are replaced by `SipRouter.stampHeaders()` just before sending, which encodes the callRef and leg identifier into the header params.

```
MessageFactory.build*()   →  message with __PLACEHOLDER__
  → SipRouter.stampHeaders()  →  Via/Contact/Record-Route filled with callRef;leg params
    → TransactionLayer.send()  →  wire
```

The leg identifier used for stamping is determined by `determineOutboundLeg()`:
- Responses to a-leg: `leg=a`
- Requests to b-leg: the b-leg's `legId` (e.g., `b-1`)

## b-leg INVITE header construction

`buildBLegInvite()` constructs the outgoing INVITE from the a-leg INVITE:

| Header | Source |
|--------|--------|
| Via | `__PLACEHOLDER__` |
| Record-Route | `__PLACEHOLDER__` |
| Max-Forwards | a-leg value minus 1 |
| From | a-leg From URI with tag replaced by `bLegFromTag` |
| To | a-leg To URI with tag stripped (new dialog, no tag yet) |
| Call-ID | new b-leg Call-ID |
| CSeq | copied from a-leg |
| Contact | `__PLACEHOLDER__` |
| Body/SDP | copied from a-leg |
| Passthrough | Allow, Supported, Require, User-Agent, P-Asserted-Identity, Privacy, etc. |

## Response relay summary

`relayResponse()` rewrites a b-leg response for the a-leg:

| Header | Action |
|--------|--------|
| Via | Replace all with `call.aLegVias` |
| From | Replace with `call.aLegFrom` (Alice's original) |
| To | Rewrite with `call.aLegTo` + B2BUA's a-facing tag from `call.tagMap` |
| Call-ID | Replace with `call.aLeg.callId` |
| Contact | Replace with `__PLACEHOLDER__` (stamped by SipRouter) |
| Content-Length | Recalculated |
| Everything else | Passed through (CSeq, Require, RSeq, body, etc.) |

## In-dialog re-INVITE relay

Re-INVITEs are relayed transparently in both directions (a→b and b→a) using `buildRelayedRequest("INVITE", ...)`. Header rewriting follows the same pattern as PRACK relay (tag resolution via `findByATag()`, passthrough headers, Via/Contact placeholders).

**Differences from other in-dialog relays (PRACK, BYE, etc.):**

1. **CSeq correlation via `PendingRequest`:** Each leg uses independent CSeq sequences. When a re-INVITE (or any transparently-relayed in-dialog request — OPTIONS, INFO, UPDATE, MESSAGE, PRACK) is relayed, a `PendingRequest` entry is stored on the target leg's dialog recording the outbound/inbound CSeq, the method, and the original request's Via/From/To/Call-ID headers. Responses are matched by `outboundCSeq`, relayed with the stored source-leg headers, and their CSeq is rewritten to the original `inboundCSeq`. The entry is removed on any final response.

2. **Direction-aware ACK:** `handleAck` checks `ctx.direction` — from-a relays to b-leg (same as initial INVITE), from-b relays to a-leg (only for b→a re-INVITE).

3. **Glare → 491:** If a re-INVITE arrives while one is already pending on either dialog of the b-leg or a-leg, the B2BUA responds 491 Request Pending. ACK for the 491 is absorbed by TransactionLayer (ACK for non-2xx).

4. **Response interception:** `tryHandleReInviteResponse()` runs before the existing provisional/200OK/error handlers and intercepts all responses belonging to a pending re-INVITE, preventing misidentification (e.g. re-INVITE 200 OK vs retransmitted initial 200 OK).

## Known issues and gaps

### 1. From/To URI separation in message builders

All message builder functions (`buildBye`, `buildOptions`, `buildAck`, `buildRelayedAck`, `buildRelayedPrack`, `buildRelayedRequest`, `buildRelayedBye`, `buildCancel`) accept:
- `toUri` — used for the To header and Request-URI
- `fromUri?` (optional) — used for the From header URI; defaults to `toUri` if not provided

To produce fully compliant From headers, pass the B2BUA's own URI:
```ts
const b2buaUri = `sip:b2bua@${config.sipLocalIp}:${config.sipLocalPort}`
buildBye(callId, fromTag, toTag, targetUri, cseq, b2buaUri)
```

Currently most call sites omit `fromUri` (using the default), which puts the target's URI in From. This is cosmetically incorrect but doesn't affect routing since tags are what matter for dialog matching.

### 2. Tag mapping (`call.tagMap`)

The B2BUA maintains a `TagMapping[]` array on the Call that maps between b-leg dialog tags and B2BUA-generated a-facing tags:

```ts
{ aTag: "b2bua-tag-for-alice", bLegId: "b-1", bTag: "fork1" }
```

**Created via `add-tag-mapping` primitive:** Emitted by `DialogRules.confirmDialogRule` and `CornerCaseRules.cancel200CrossingRule` (through the `confirmBridgedCall` composite), and by the `relayFirst18xTo180` policy module (which pre-seeds the mapping at 18x time so `confirmBridgedCall` can reuse the same `aTag` at 200 OK). `addTagMapping` is idempotent by `(bLegId, bTag)` — emitting it twice for the same b-leg/b-tag pair is a no-op.

**Used in:** `relay-prack` and `relay-reinvite` rules — Alice's PRACK/re-INVITE carries the a-facing tag; `findByATag()` reverse-looks up the b-leg dialog.

**Relayed via:** `relayResponse()` receives the pre-built To header (with aTag already attached) as the `aLegTo` parameter.

### 3. Tag helper functions (`b2buaTag` / `remoteTag`)

The meaning of `fromTag` and `dialog.toTag` flips between a-leg and b-leg. To prevent tag swap bugs, use the helpers in `CallModel.ts`:

```ts
b2buaTag(call, "a")     // → aLeg.dialogs[0].toTag  (B2BUA was UAS)
b2buaTag(call, "b-1")   // → bLeg.fromTag            (B2BUA was UAC)
remoteTag(call, "a")     // → aLeg.fromTag            (Alice's tag)
remoteTag(call, "b-1")   // → bLeg.dialogs[0].toTag   (Bob's tag)
```

These are used in keepalive, timeout, and BYE handlers for a-leg requests.
