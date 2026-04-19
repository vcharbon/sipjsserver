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

The in-dialog generator reads From/To straight off `StackDialog.localUri` / `StackDialog.remoteUri` / `localTag` / `remoteTag`, so handlers never pass raw tag strings — they just hand the dialog to `generateInDialogRequest`.

## Message construction model

All outbound SIP messages are produced by the pure generators in [src/sip/generators.ts](src/sip/generators.ts). Every returned message is immediately sendable — no sentinels, no post-processing, no router-side stamping.

| Generator | Use |
|-----------|-----|
| `generateOutOfDialogRequest` | Initial INVITE, standalone OPTIONS, REGISTER, etc. |
| `generateInDialogRequest` | BYE, re-INVITE, PRACK, NOTIFY, INFO, UPDATE, MESSAGE — reads `StackDialog` for Call-ID / CSeq / Request-URI / tags / route set |
| `generateAckFor2xx` | ACK for a 2xx response (RFC 3261 §13.2.2.4 — CSeq sourced from the original INVITE, not the dialog) |
| `generateCancel` | CANCEL for an outstanding INVITE (RFC 3261 §9.1 — branch echoed verbatim from the INVITE's top Via) |
| `generateResponse` | Response that echoes a request's Via / From / To / Call-ID / CSeq |
| `generateRelayedResponse` | B2BUA-side rebuild of a response from snapshotted peer-facing values (Vias, From, To, Call-ID, CSeq) |
| `_generateAckForNon2xx` | Stack-internal auto-ACK for non-2xx final responses (invoked only by `TransactionLayer`) |

The B2BUA tells each generator which local identity to embed in Via and Contact by passing `ViaSpec` + `ContactSpec`:

```ts
// ViaSpec carries branch + custom Via params (cr, lg, em).
// ContactSpec carries host / port + URI params (callRef, leg, emerg).
const { via, contact, branch } = legStackIdentity(call, legId, config)
```

[legStackIdentity](src/b2bua/stack-identity.ts) is the single helper that materialises both specs with the call's `callRef`, the leg's `legId`, and the local IP/port from config. It mints a fresh `branch` by default; callers pass a `forceBranch` to replay a prior branch (see "Branch capture" below).

## Header-by-header behavior

### Via

**Inbound resolution:** The top Via of incoming responses carries custom params `;cr=<callRef>;lg=<legId>` used to resolve which call and leg the response belongs to. Parsed by `parseViaParams()`.

**Outbound construction:** Every outbound request/response is built with a `ViaSpec` produced by `legStackIdentity`. The generator emits exactly one Via line:

```
SIP/2.0/UDP <localIp>:<localPort>;branch=<branch>;cr=<callRef>;lg=<legId>
```

Emergency calls add `;em=1`.

**Relay (b-leg response → a-leg):** `generateRelayedResponse` replaces every Via with the snapshot captured when the a-leg request was first received (`aLegInvite.headers` for initial INVITE responses; `PendingRequest.sourceVias` for transparent in-dialog relays). This guarantees Alice sees her own Vias, not the b-leg's.

### Contact

**Inbound resolution:** The Contact URI of incoming requests carries `;callRef=<callRef>;leg=<legId>` used to resolve which call/leg the request targets. Parsed by `parseUriParams()`.

**Outbound construction:** The `ContactSpec` from `legStackIdentity` is serialised as:

```
<sip:b2bua@<localIp>:<localPort>;callRef=<callRef>;leg=<legId>>
```

Emergency calls add `;emerg=1`. `generateInDialogRequest` omits Contact for BYE (RFC 3261 §15.1 — BYE terminates the dialog; target-refresh is meaningless).

**Relay:** When relaying a 2xx on a dialog-creating hop, `generateRelayedResponse` emits the B2BUA's own Contact (built with `legStackIdentity` for the target leg) so the peer target-refreshes to us, not the far side (RFC 3261 §20.10).

### Call-ID

Each leg has an independent Call-ID. a-leg uses Alice's original Call-ID; b-leg uses a generated one (`{legNumber}-{aLegCallId}` in standalone mode, hash-derived in cluster mode).

**Relay:** `generateRelayedResponse` is called with `targetLeg.callId`, restoring the a-leg Call-ID on b→a hops.

### From

**In-dialog requests:** `generateInDialogRequest` emits `From: <dialog.localUri>;tag=<dialog.localTag>`. Nothing else to configure — there is no separate URI parameter, and no default-from-toUri quirk.

**Out-of-dialog requests:** `generateOutOfDialogRequest` takes `fromUri` + `fromTag` explicitly.

**Relay (b-leg response → a-leg):** `generateRelayedResponse` uses the From extracted from `call.aLegInvite.headers` (the original From header Alice sent). Ensures Alice sees her own From tag echoed back (RFC 3261 §8.2.6.2).

**Stored at call creation:** `call.aLegInvite` (the full original INVITE) is captured in `SipRouter.handleInitialInvite`. From is read on demand via `getHeader(call.aLegInvite.headers, "from")`.

### To

**In-dialog requests:** `generateInDialogRequest` emits `To: <dialog.remoteUri>;tag=<dialog.remoteTag>`.

**Out-of-dialog requests:** `generateOutOfDialogRequest` takes `toUri` (+ optional `toTag` for mid-dialog targets).

**Relay (b-leg response → a-leg):** `generateRelayedResponse` uses the original a-leg To URI (from `call.aLegInvite`) plus the B2BUA's a-facing tag. Each distinct b-leg remote tag maps to a unique B2BUA-generated tag via `call.tagMap`. Alice never sees Bob's real tags — proper B2BUA behavior per RFC 3261.

**Tag mapping:** `call.tagMap` (array of `TagMapping { aTag, bLegId, bTag }`) tracks the bidirectional mapping between B2BUA-generated a-facing tags and Bob's real b-leg dialog tags. Handlers use `findByBTag()` when relaying responses (b→a) to look up the a-facing tag, and `findByATag()` when routing Alice's requests (a→b, e.g. PRACK) back to the correct b-leg dialog. In forking scenarios, each b-leg early dialog gets its own distinct a-facing tag.

### Record-Route

Added by `generateResponse` by echoing every Record-Route from the request it answers (RFC 3261 §16.6). `generateRelayedResponse` does not emit Record-Route — the stack-owned Contact carries the B2BUA's identity instead.

### CSeq

- `StackDialog.localCSeq` tracks the last sequence number sent on the dialog.
- `generateInDialogRequest` auto-bumps: default `cseq = dialog.localCSeq + 1`, and the generator returns `{ request, dialog }` where the returned dialog has `localCSeq` set to the used value. Callers persist the updated dialog — no separate `bumpLocalCSeq()` step.
- An explicit `cseq` override is used by B2BUA relay paths that must mirror the inbound CSeq (e.g. transparent re-INVITE / PRACK / OPTIONS relay where the peer may have skipped sequence numbers).
- Responses echo the CSeq from the request they answer.
- CANCEL reuses the original INVITE's CSeq number (read off `inviteTxn.originalInvite`).
- `generateAckFor2xx` uses the INVITE's CSeq (not `dialog.localCSeq`, which may have been bumped by a PRACK in between).
- **re-INVITE CSeq rewriting:** When relaying a re-INVITE response, the B2BUA rewrites the CSeq number to match what the originator sent (stored in `PendingRequest.inboundCSeq`), since each leg uses independent CSeq sequences.

### CANCEL (RFC 3261 §9.1)

A CANCEL request must match three fields of the INVITE it is cancelling so that the downstream UAS (and any intermediate proxies) can correlate it to the outstanding INVITE transaction:

| Field | Source |
|-------|--------|
| Request-URI | `inviteTxn.originalInvite.uri` |
| Top Via (including `branch`) | `inviteTxn.originalInvite`'s topmost Via — echoed verbatim |
| CSeq number | `inviteTxn.originalInvite`'s CSeq number (method rewritten to `CANCEL`) |

From, To (with To-tag stripped), Call-ID are inherited from the INVITE; Max-Forwards is fresh (70). `generateCancel(inviteTxn)` does all of this — it takes a single argument and reads every required field off the cached original INVITE.

**Branch capture lifecycle.** The `InviteClientTransactionHandle` returned by `TransactionLayer.sendInvite()` carries the exact INVITE used on the wire (`originalInvite`), the top Via's `branch`, and the destination. The handle is cached on:

- `leg.pendingInviteTxn` for the initial INVITE
- `dialog.ext.pendingInviteTxn` for re-INVITEs

When the handler later needs to send CANCEL or ACK-for-2xx, it picks the right handle and hands it to `generateCancel` / `generateAckFor2xx`. No Via-branch parsing, no second-phase persistence dance — the branch travels with the handle.

**ACK-for-2xx branch caching.** ACK for 2xx is its own hop (RFC 3261 §17.1.1.2 — new branch) but the B2BUA must retransmit the **same** ACK verbatim on 2xx retransmits. `dialog.ext.ackBranch` caches the branch from the first ACK; subsequent retransmits pass it to `legStackIdentity(..., forceBranch)` so every retransmit lands with the identical top Via.

## Response relay summary

`generateRelayedResponse` rewrites a b-leg response for the a-leg (or vice versa). Inputs come from a snapshot — typically `call.aLegInvite` for initial-INVITE-path responses, or a matching `PendingRequest` entry for transparent in-dialog relays:

| Header | Source |
|--------|--------|
| Via | `aLegPendingVias ?? getHeaders(call.aLegInvite.headers, "via")` (or `pending.sourceVias`) |
| From | `getHeader(call.aLegInvite.headers, "from")` (or `pending.sourceFrom`) |
| To | original a-leg To URI + B2BUA's a-facing tag from `call.tagMap` (or `pending.sourceTo`) |
| Call-ID | `targetLeg.callId` (or `pending.sourceCallId`) |
| CSeq | rewritten to match the originator's sequence number + method |
| Contact | B2BUA's own `ContactSpec` from `legStackIdentity(call, targetLegId, config)` |
| Non-structural headers | Carried through via `extractNonStructuralHeaders(resp)` (Allow, Supported, Require, RSeq, P-Asserted-Identity, etc.) |
| Content-Length | Recalculated by the generator |

## b-leg INVITE header construction

The initial b-leg INVITE is produced by `generateOutOfDialogRequest("INVITE", ...)` inside the initial-INVITE handler. Inputs are derived from the a-leg INVITE plus the routing decision:

| Field | Source |
|-------|--------|
| Via | `ViaSpec` from `legStackIdentity(call, bLegId, config)` — fresh branch captured on the returned `InviteClientTransactionHandle` |
| Max-Forwards | a-leg value minus 1 |
| From | a-leg From URI with tag replaced by a freshly minted b-leg `fromTag` |
| To | a-leg To URI with tag stripped (new dialog, no remote tag yet) |
| Call-ID | freshly generated b-leg Call-ID |
| CSeq | copied from a-leg INVITE |
| Contact | `ContactSpec` from `legStackIdentity` (embeds `callRef`/`leg` URI params) |
| Body/SDP | copied from a-leg INVITE |
| Passthrough | Allow, Supported, Require, User-Agent, P-Asserted-Identity, Privacy, etc. — injected via `extraHeaders` |

## In-dialog re-INVITE relay

Re-INVITEs are relayed transparently in both directions (a→b and b→a) using `generateInDialogRequest("INVITE", dialog, opts)` with the target leg's dialog. Request/response correlation across the independent CSeq sequences is tracked by `PendingRequest` entries on the source dialog.

**Mechanics:**

1. **CSeq correlation via `PendingRequest`:** Each leg uses independent CSeq sequences. When a re-INVITE (or any transparently-relayed in-dialog request — OPTIONS, INFO, UPDATE, MESSAGE, PRACK) is relayed, a `PendingRequest` entry is stored on the target leg's dialog recording the outbound/inbound CSeq, the method, and the original request's Via/From/To/Call-ID headers. Responses are matched by `outboundCSeq`, relayed with the stored source-leg headers, and their CSeq is rewritten to the original `inboundCSeq`. The entry is removed on any final response.

2. **Direction-aware ACK:** `handleAck` checks `ctx.direction` — from-a relays to b-leg (same as initial INVITE), from-b relays to a-leg (only for b→a re-INVITE).

3. **Glare → 491:** If a re-INVITE arrives while one is already pending on either dialog of the b-leg or a-leg, the B2BUA responds 491 Request Pending. ACK for the 491 is absorbed by `TransactionLayer` (ACK for non-2xx).

4. **Response interception:** `tryHandleReInviteResponse()` runs before the existing provisional/200OK/error handlers and intercepts all responses belonging to a pending re-INVITE, preventing misidentification (e.g. re-INVITE 200 OK vs retransmitted initial 200 OK).

## Known issues and gaps

### Tag mapping (`call.tagMap`)

The B2BUA maintains a `TagMapping[]` array on the Call that maps between b-leg dialog tags and B2BUA-generated a-facing tags:

```ts
{ aTag: "b2bua-tag-for-alice", bLegId: "b-1", bTag: "fork1" }
```

**Created via `add-tag-mapping` primitive:** Emitted by `DialogRules.confirmDialogRule` and `CornerCaseRules.cancel200CrossingRule` (through the `confirmBridgedCall` composite), and by the `relayFirst18xTo180` policy module (which pre-seeds the mapping at 18x time so `confirmBridgedCall` can reuse the same `aTag` at 200 OK). `addTagMapping` is idempotent by `(bLegId, bTag)` — emitting it twice for the same b-leg/b-tag pair is a no-op.

**Used in:** `relay-prack` and `relay-reinvite` rules — Alice's PRACK/re-INVITE carries the a-facing tag; `findByATag()` reverse-looks up the b-leg dialog.

**Relayed via:** `generateRelayedResponse` receives the pre-built To header (with aTag already attached) as the `to` parameter.

### Tag helper functions (`b2buaTag` / `remoteTag`)

The meaning of `fromTag` and `dialog.toTag` flips between a-leg and b-leg. To prevent tag swap bugs, use the helpers in `CallModel.ts`:

```ts
b2buaTag(call, "a")     // → aLeg.dialogs[0].toTag  (B2BUA was UAS)
b2buaTag(call, "b-1")   // → bLeg.fromTag            (B2BUA was UAC)
remoteTag(call, "a")     // → aLeg.fromTag            (Alice's tag)
remoteTag(call, "b-1")   // → bLeg.dialogs[0].toTag   (Bob's tag)
```

These are used in keepalive, timeout, and BYE handlers for a-leg requests.
