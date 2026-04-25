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

## Cluster routing via technical headers

In cluster mode the main process is a thin **Dispatcher** that owns the UDP socket and shards each packet to one of N worker child processes by hashing the SIP Call-ID. Workers parse, run rules, and produce outbound buffers that the dispatcher then puts back on the wire. Three layers of B2BUA-stamped technical headers carry the identity information needed to make this routing deterministic and parse-free at the dispatcher hop.

| Carrier | Param | Set by | Read by | Resolves |
|---------|-------|--------|---------|----------|
| `Call-ID` header | (whole value) | a-leg: Alice; b-leg: B2BUA via `generateBLegCallId` | Dispatcher byte-scan (`extractCallIdFromBuffer`) → `fnv1a(callId) % N` | which **worker process** |
| Top `Via` of responses | `;cr=<callRef>;lg=<legId>` | `legStackIdentity` (every outbound request) | Worker — `parseViaParams` / `resolveFromResponse` | which **call + leg** the response belongs to |
| Request-URI / `Contact` of in-dialog requests | `;callRef=<callRef>;leg=<legId>` | `legStackIdentity` (every outbound `Contact`; peers target-refresh and use it as Request-URI) | Worker — `parseUriParams` / `resolveFromRequest` | which **call + leg** the in-dialog request targets |
| Top `Via` + `Contact` | `;em=1` / `;emerg=1` | `legStackIdentity` when `call.emergency` | Dispatcher byte-scan (`bufferHasEmergencyMarker`) | overload-protection class (Tier 1/2 — see [overload-protection.md](overload-protection.md)) |
| Top `Via` of every request | `;branch=<z9hG4bK…>` | `legStackIdentity` (mints fresh) or `forceBranch` (replay) | UAS for transaction matching (RFC 3261 §17.2.3); B2BUA caches it on `InviteClientTransactionHandle` for CANCEL / ACK-for-2xx | the **transaction** |

### Worker affinity

The dispatcher's hash routes by Call-ID, but a B2BUA call has **two** Call-IDs (one per leg). To keep both legs on the same worker, the b-leg Call-ID is **mined** rather than randomly generated:

```ts
generateBLegCallId(legNumber, workerIndex, totalWorkers, localHost)
//   tries `${legNumber}-${counter}-${localHost}` until
//   fnv1a(candidate) % totalWorkers === workerIndex
```

Average ~2-4 attempts for N=4-8 workers. The result: every packet of either leg of a given call lands on the same worker, so call state, timers, and tag mappings never need to migrate.

### Routing diagram

```
Alice                      Dispatcher (main)                     Worker k                       Bob
  │                              │                                  │                            │
  │  INVITE                      │                                  │                            │
  │  Call-ID: alice-xyz          │                                  │                            │
  │ ───────────────────────────► │                                  │                            │
  │                              │ extractCallIdFromBuffer (byte    │                            │
  │                              │   scan, no SIP parse)            │                            │
  │                              │ k = fnv1a("alice-xyz") % N       │                            │
  │                              │ classifyPacket (em? toTag?)      │                            │
  │                              │ ── IPC (raw Buffer) ───────────► │                            │
  │                              │                                  │ resolveFromRequest:        │
  │                              │                                  │   no callRef in R-URI      │
  │                              │                                  │   → INITIAL INVITE         │
  │                              │                                  │ create call, callRef=X     │
  │                              │                                  │ generateBLegCallId →       │
  │                              │                                  │   "1-42-h"  (hashes to k)  │
  │                              │                                  │ legStackIdentity(call,b-1):│
  │                              │                                  │   Via: ...;branch=z9..;    │
  │                              │                                  │     cr=X;lg=b-1            │
  │                              │                                  │   Contact: <sip:b2bua@h:p; │
  │                              │                                  │     callRef=X;leg=b-1>     │
  │                              │ ◄─ IPC "send" ───────────────── │                            │
  │                              │      (raw Buffer)                │                            │
  │                              │ ─────────────────────────────────────────────────► INVITE    │
  │                              │                                  │                            │
  │                              │                                  │            200 OK          │
  │                              │                                  │            Call-ID: 1-42-h │
  │                              │                                  │            Via: ...;cr=X;  │
  │                              │                                  │              lg=b-1        │
  │                              │ ◄────────────────────────────────────────────────────────────│
  │                              │ k' = fnv1a("1-42-h") % N == k    │                            │
  │                              │ ── IPC ────────────────────────► │                            │
  │                              │                                  │ resolveFromResponse:       │
  │                              │                                  │   Via.cr=X, Via.lg=b-1     │
  │                              │                                  │ checkout(X) → run rules    │
  │                              │                                  │ generateRelayedResponse →  │
  │                              │                                  │   a-leg 200 OK             │
  │                              │ ◄─ IPC "send" ─────────────────  │                            │
  │ ◄─────────────────────────── │                                  │                            │
  │                              │                                  │                            │
  │                              │                                  │            BYE             │
  │                              │                                  │            R-URI: sip:b2bua│
  │                              │                                  │             @h:p;callRef=X;│
  │                              │                                  │             leg=b-1        │
  │                              │                                  │            Call-ID: 1-42-h │
  │                              │ ◄────────────────────────────────────────────────────────────│
  │                              │ k = fnv1a("1-42-h") % N          │                            │
  │                              │ ── IPC ────────────────────────► │                            │
  │                              │                                  │ resolveFromRequest:        │
  │                              │                                  │   R-URI.callRef=X,leg=b-1  │
  │                              │                                  │ no dialog-key lookup       │
  │                              │                                  │   needed                   │
```

### Why each header is load-bearing

- **Call-ID — process-level routing.** The dispatcher must shard *before* parsing (a full SIP parse per packet would cap throughput). A byte-scan for `\r\nCall-ID:` (or compact `\r\ni:`) plus FNV-1a is a few hundred nanoseconds per packet. Mining the b-leg Call-ID guarantees the b→a return path lands on the same worker as the original a-leg.
- **Via `cr` / `lg` — response → call/leg resolution at the worker.** Response routing per RFC 3261 §18.1.2 is by branch, but the B2BUA needs *call+leg* identity, not just transaction identity (e.g. to pick the right b-leg dialog for forking). Stamping `cr` and `lg` in the top Via lets the worker resolve straight off `parsed.via.params` without consulting any in-memory map keyed by branch.
- **Contact `callRef` / `leg` — in-dialog request resolution at the worker.** A peer's in-dialog request (BYE, re-INVITE, NOTIFY, …) has its Request-URI set to whatever the B2BUA put in `Contact` on the dialog-creating 2xx (RFC 3261 §12.2.1.1 / §20.10). Embedding `callRef`/`leg` in the Contact URI means the worker resolves the request without a dialog-key (Call-ID + From-tag + To-tag) lookup — even after worker restart, before Redis-backed dialog state is hydrated.
- **`em` / `emerg` — overload-protection classification at the dispatcher.** The dispatcher classifies packets into `emergency` / `inDialog` / `normalNewCall` queues by a byte-scan that recognises the `Resource-Priority` / `;em=1` / `;emerg=1` markers without parsing. Emergency calls are drained first and never silently dropped (Tier 2 in [overload-protection.md](overload-protection.md)).
- **`branch` — transaction matching, RFC 3261 §17.2.3.** Distinct from the routing role of `cr`/`lg`: `branch` matches a response back to the client transaction it answers, and a CANCEL / ACK-for-2xx must echo (or in the ACK-for-2xx case, *not* echo, but cache its own) the right value (see "Branch capture lifecycle" above).

### URL-encoding

`callRef` / `leg` values can contain `;`, `=`, `@`, or whitespace — characters that would corrupt Via/URI parsing if emitted verbatim. `legStackIdentity` runs `encodeURIComponent` before stamping, and `resolveFromRequest` / `resolveFromResponse` run `decodeURIComponent` after parsing, so values round-trip safely.

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
