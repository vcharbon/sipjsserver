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

Each leg has an independent Call-ID. a-leg uses Alice's original Call-ID; b-leg uses a generated one (`{legNumber}-{aLegCallId}-{localHost}` via [generateBLegCallId](src/b2bua/HashUtils.ts)).

**Relay:** `generateRelayedResponse` is called with `targetLeg.callId`, restoring the a-leg Call-ID on b→a hops.

**Historical note (cluster mode, deleted in PR6):** the legacy in-process `Dispatcher` byte-scanned `Call-ID` and ran `fnv1a(callId) % N` to pick a worker child process, so the b-leg Call-ID had to be **mined** (rejection-sampled) until it hashed to the same worker as the a-leg. That requirement is gone: the standalone SIP front proxy lives outside the worker pod entirely (see "Front-proxy stickiness" below), the b-leg never traverses the proxy (the worker is the b-leg UAC and talks to Bob directly), and `generateBLegCallId` is now a plain generator with no hash constraint.

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

## Front-proxy stickiness and worker-side technical headers

The B2BUA worker no longer owns the UDP socket. A standalone, stateless **SIP front proxy** (`src/sip-front-proxy/`, deployed as a K8s `Deployment` separate from the worker `StatefulSet`) sits between Alice and the workers, distributes initial INVITEs across the worker pool, and keeps in-dialog traffic pinned to the same worker via an HMAC-signed cookie inserted in `Record-Route`. The legacy in-process `cluster.fork()` Dispatcher (Call-ID byte-scan + `fnv1a % N` IPC sharding) was deleted in PR6; see [docs/sip-front-proxy/resilience-model.md](sip-front-proxy/resilience-model.md) and [docs/todos/SIP-Front-Proxy.md](todos/SIP-Front-Proxy.md) for the full architecture.

**Two routing concerns, two distinct mechanisms:**

1. **Proxy → worker routing** uses headers the **proxy** owns: a Record-Route URI param the proxy inserts and consumes. The worker doesn't see or care about it (it's stripped from the request before forwarding per RFC 3261 §16.4).
2. **Worker-internal call+leg resolution** uses headers the **worker** owns: `cr` / `lg` on Via, `callRef` / `leg` on Contact. These are unchanged from cluster mode — they identify which `(call, leg)` an inbound message belongs to AT THE WORKER. The proxy is transparent to them.

| Carrier | Param | Set by | Read by | Resolves |
|---------|-------|--------|---------|----------|
| `Record-Route` URI | `;w=<workerId>;v=1;kid=<kid>;sig=<128-bit base64url HMAC>;lr` | **SIP front proxy** on every dialog-creating request (INVITE, SUBSCRIBE) — `legStackIdentity` does NOT touch this | **SIP front proxy** on every in-dialog request (the cookie is now in the top `Route`); decoded by `LoadBalancer.decodeStickiness` after stripping the Route per §16.4 | which **worker pod** an in-dialog request must reach |
| Top `Via` of responses | `;cr=<callRef>;lg=<legId>` | `legStackIdentity` (every outbound request from the worker) | Worker — `parseViaParams` / `resolveFromResponse` | which **call + leg** an inbound response belongs to |
| Request-URI / `Contact` of in-dialog requests | `;callRef=<callRef>;leg=<legId>` | `legStackIdentity` (every outbound `Contact`; peers target-refresh and use it as Request-URI) | Worker — `parseUriParams` / `resolveFromRequest` | which **call + leg** an inbound in-dialog request targets |
| Top `Via` + `Contact` | `;em=1` / `;emerg=1` | `legStackIdentity` when `call.emergency` | Worker `OverloadController` (Tier 1/2 — see [overload-protection.md](overload-protection.md)) | overload-protection class. *(Used to be byte-scanned at the cluster Dispatcher; with the Dispatcher gone the proxy ingress has no overload brake in Phase 1 — the worker's OverloadController is the only enforcement point.)* |
| Top `Via` of every request | `;branch=<z9hG4bK…>` | `legStackIdentity` (mints fresh) or `forceBranch` (replay); the proxy adds its own top `Via` with its own branch on top | UAS for transaction matching (RFC 3261 §17.2.3); B2BUA caches the worker-side branch on `InviteClientTransactionHandle` for CANCEL / ACK-for-2xx; the proxy uses its OWN branch only to recognise its own Via for popping on responses | the **transaction** (worker side) and the **proxy hop** (proxy side) — the two are independent |

### Worker selection — rendezvous HRW (initial INVITEs only)

The proxy's `LoadBalancerStrategy.selectForNewDialog` runs **rendezvous (HRW) hashing** over `(callId, [worker_id_0, …, worker_id_N])`:

```ts
rendezvousSelect(callId, workers)
//   for each worker, hash(callId + ":" + worker.id) → uint64 (top 8 bytes of SHA-1)
//   pick the max
//   filter out health !== 'alive' before selecting
```

Why HRW and not `fnv1a(callId) % N` (the old cluster scheme)? **Membership-change cost.** Modular hashing re-shards `~(N-1)/N` of keys when N changes (every key potentially moves). HRW moves only `~1/N`. Adding or draining a worker mid-load doesn't re-shard existing dialogs (they're already pinned by stickiness cookie — see below) and only `~1/N` of NEW dialogs land on the new worker. Validated by `tests/sip-front-proxy/load-balancer/{distribution,add-remove-resharding}.test.ts`.

### In-dialog stickiness — HMAC-signed Record-Route cookie

When the proxy forwards an initial INVITE, it inserts a Record-Route pointing at itself with URI params encoding the chosen worker:

```
Record-Route: <sip:proxy.host:5060;w=b2bua-worker-0;v=1;kid=k1;sig=AQIDBAUGBwgJCgsMDQ4PEA;lr>
```

- `w` — worker pod name (StatefulSet ordinal — D3).
- `v` — cookie format version (currently `1`).
- `kid` — HMAC key id (first 16 hex chars of `SHA-1(keyBytes)`, generated automatically per [HmacKeyProvider](src/sip-front-proxy/security/HmacKeyProvider.ts)).
- `sig` — HMAC-SHA256 over `utf8("v=1|w=" + workerId + "|c=" + callId)`, **truncated to the first 16 bytes** (128 bits per RFC 4868 §2.6) and base64url-encoded.

When Alice (or anyone in the dialog) sends an in-dialog request, RFC 3261 §12.2.1.1 puts the proxy's Record-Route into her `Route` header. The proxy:

1. Strips the top `Route` per §16.4 (it's pointing at itself).
2. Decodes the URI params via `LoadBalancer.decodeStickiness`.
3. Verifies the `sig` against `(current, previous)` keys (`HmacKeyProvider.verifyTruncated` — NFR-8 1h overlap during rotation).
4. Resolves `w` to a `WorkerEntry` via `WorkerRegistry.resolve`.
5. Forwards to that worker's address.

**ACK on 2xx and CANCEL exempt from drain-grace fallback** (D5 / RFC 3261 §13.2.2.4 + §9.1 + §16.10): they always reach the original worker regardless of the worker's current health, because only that worker holds the INVITE transaction. Other in-dialog requests fall back via `selectForNewDialog` once a draining worker has been past `drainGracePolicyMs` (default 5s).

### CANCEL correlation — Call-ID + CSeq number

CANCEL gets special handling: per RFC 3261 §9.1 the UAC reuses the INVITE's top-Via branch verbatim on CANCEL, but the proxy can't use the *upstream* branch as a routing key because it's not unique across worker rebalances. Instead the proxy keeps a small TTL'd LRU keyed on **`(Call-ID, CSeq number)`** — the §9.1-canonical pair the UAC mirrors — that maps INVITE → chosen worker. CANCEL lookups hit that LRU and route to the same worker as the INVITE, even if the worker pool changed since. Validated by `tests/sip-front-proxy/load-balancer/cancel-keyed-by-callid-cseq.test.ts`.

### Worker identity stability — K8s StatefulSet pod ordinals

`workerId = pod.metadata.name` (D3). The worker is a `StatefulSet` (NOT a `Deployment`) so pod names are stable ordinals (`b2bua-worker-0`, `b2bua-worker-1`) that survive pod restarts. A `Deployment`'s randomly-suffixed pod names would invalidate every stickiness cookie on every restart. The proxy's `WorkerRegistry.kubernetesStatefulSet` impl (PR5) tracks `(id, address)` as one unit and emits `address_changed` when the same `id` rebinds to a new podIP — preserving in-dialog routing across pod reschedules.

### Routing diagram

Both legs traverse the proxy. The proxy is the *only* edge that external peers (Alice on a-leg, Bob on b-leg) ever see. This survives worker failure: an in-dialog request from Bob (or Alice) reaches the proxy regardless of the originating worker's health, so the proxy can re-route to drain-grace or fail cleanly rather than leaving the peer hanging on a dead worker socket. It also gives a single observability/policy choke point on both legs.

How the b-leg is routed through the proxy: the worker is configured with `b2bOutboundProxy = <proxy-addr>`. On every B-leg dialog-creating outbound (initial INVITE, REFER, etc.) the worker pre-loads `Route: <sip:proxy.host:5060;lr;outbound>` and addresses the packet to the proxy (top-Route, RFC 3261 §16.12). The proxy strips the top Route (§16.4), recognizes the `;outbound` marker, identifies the source worker by `(srcIp, srcPort) → WorkerRegistry`, and inserts its own Record-Route with the *source* worker encoded in the cookie — symmetric to a-leg, but the resolution target is the worker that issued the call, not one selected via HRW. Bob's responses are routed by Via popping (no special path); Bob's in-dialog requests carry `Route: <sip:proxy;w=<source-worker>;…;lr>` and decode back to that worker, exactly like Alice's do on a-leg.

```
Alice                     SIP front proxy                  Worker (b2bua-worker-k)               Bob
  │                              │                                  │                              │
  │  INVITE                      │                                  │                              │
  │  Call-ID: alice-xyz          │                                  │                              │
  │  no Route (no prior dialog)  │                                  │                              │
  │ ───────────────────────────► │                                  │                              │
  │                              │ parse                            │                              │
  │                              │ no top-Route at us → §16.5/.6:   │                              │
  │                              │   selectForNewDialog:            │                              │
  │                              │     w = rendezvous(callId,       │                              │
  │                              │         [w-0,w-1,...]_{alive})   │                              │
  │                              │   encodeStickiness:              │                              │
  │                              │     sig = HMAC(v=1|w=…|c=…)[:16] │                              │
  │                              │   insert Record-Route:           │                              │
  │                              │     <sip:proxy:5060;w=…;v=1;     │                              │
  │                              │      kid=…;sig=…;lr>             │                              │
  │                              │   push own Via with new branch   │                              │
  │                              │   remember (callId,cseq)→addr    │                              │
  │                              │     in CancelBranchLru           │                              │
  │                              │ ─────────────────────────────────►                              │
  │                              │                                  │ resolveFromRequest:          │
  │                              │                                  │   no callRef in R-URI →      │
  │                              │                                  │     INITIAL INVITE           │
  │                              │                                  │ create call, callRef=X       │
  │                              │                                  │ generateBLegCallId →         │
  │                              │                                  │   "1-alice-xyz-h" (any value)│
  │                              │                                  │ legStackIdentity(call,b-1):  │
  │                              │                                  │   Via: ...;branch=z9..;      │
  │                              │                                  │     cr=X;lg=b-1              │
  │                              │                                  │   Contact: <sip:b2bua@h:p;   │
  │                              │                                  │     callRef=X;leg=b-1>       │
  │                              │                                  │ pre-load Route header:       │
  │                              │                                  │   Route: <sip:proxy:5060;    │
  │                              │                                  │     lr;outbound>             │
  │                              │                                  │ send packet to proxy:5060    │
  │                              │ ◄─────────────────────────────── │                              │
  │                              │ strip top-Route (;outbound) §16.4│                              │
  │                              │ source = (workerIp,workerPort)   │                              │
  │                              │ → registry.lookupByAddress       │                              │
  │                              │ → originatingWorker = w-k        │                              │
  │                              │ encodeStickiness(w-k, req):      │                              │
  │                              │   sig = HMAC(v=1|w=k|c=1-…)[:16] │                              │
  │                              │ insert Record-Route:             │                              │
  │                              │   <sip:proxy:5060;w=k;v=1;       │                              │
  │                              │    kid=…;sig=…;lr>               │                              │
  │                              │ push own top-Via (proxy branch)  │                              │
  │                              │ ─────────────────────────────────────────────────────► INVITE   │
  │                              │                                  │                              │
  │                              │ ◄─────────────────────────────────────────────────── 200 OK     │
  │                              │ pop our top Via; forward by next │                              │
  │                              │ Via (= worker)                   │                              │
  │                              │ ─────────────────────────────────►                              │
  │                              │                                  │ resolveFromResponse:         │
  │                              │                                  │   Via.cr=X, Via.lg=b-1       │
  │                              │                                  │ b-leg dialog routeSet =      │
  │                              │                                  │   [<sip:proxy;w=k;…;lr>]     │
  │                              │                                  │   (reversed from 200 OK R-R) │
  │                              │                                  │ checkout(X) → run rules      │
  │                              │                                  │ generateRelayedResponse:     │
  │                              │                                  │   a-leg 200 OK with          │
  │                              │                                  │   Record-Route echoed back   │
  │                              │                                  │   verbatim (RFC §12.1.1)     │
  │                              │ ◄─────────────────────────────── │                              │
  │                              │ pop our top Via;                 │                              │
  │                              │ forward by next Via              │                              │
  │ ◄─────────────────────────── │                                  │                              │
  │                              │                                  │                              │
  │  ACK                         │                                  │                              │
  │  Route: <sip:proxy:5060;w=…  │                                  │                              │
  │   v=1;kid=…;sig=…;lr>        │                                  │                              │
  │ ───────────────────────────► │                                  │                              │
  │                              │ strip top-Route per §16.4        │                              │
  │                              │ decodeStickiness:                │                              │
  │                              │   verify sig (current OR prev    │                              │
  │                              │     kid for NFR-8 rotation)      │                              │
  │                              │   resolve w → registry entry     │                              │
  │                              │   ACK exempt from drain-grace —  │                              │
  │                              │   always to original worker      │                              │
  │                              │ ─────────────────────────────────►                              │
  │                              │                                  │ resolveFromRequest:          │
  │                              │                                  │   R-URI.callRef=X,leg=a      │
  │                              │                                  │   (or via dialog-key lookup) │
  │                              │                                  │ b-leg ACK uses dialog        │
  │                              │                                  │ routeSet → Route header at   │
  │                              │                                  │ top → packet to proxy:5060   │
  │                              │ ◄─────────────────────────────── │                              │
  │                              │ strip top-Route per §16.4        │                              │
  │                              │ decode → forward to Bob          │                              │
  │                              │ ─────────────────────────────────────────────────────► ACK      │
  │                              │                                  │                              │
  │  BYE  (same Route header)    │                                  │                              │
  │ ───────────────────────────► │                                  │                              │
  │                              │ same dance: strip, decode,       │                              │
  │                              │ verify, resolve w, forward       │                              │
  │                              │ ─────────────────────────────────►                              │
  │                              │                                  │ b-leg BYE: same routeSet →   │
  │                              │                                  │ Route to proxy → forward     │
  │                              │ ◄─────────────────────────────── │                              │
  │                              │ ─────────────────────────────────────────────────────► BYE      │
  │                              │                                  │                              │
  │                              │ ── Bob-initiated BYE (alt) ──    │                              │
  │                              │ ◄────────────────────────────────────────────────── BYE         │
  │                              │   Route: <sip:proxy;w=k;…;lr>    │                              │
  │                              │   (Bob's UAS-side routeSet)      │                              │
  │                              │ strip, decode → w=k → forward    │                              │
  │                              │ ─────────────────────────────────►                              │
```

### Why each header is load-bearing

- **`Record-Route ;w/v/kid/sig` — proxy-side stickiness.** Without the cookie, every in-dialog request from Alice would re-shard via `selectForNewDialog`, defeating the worker's in-memory call state. The HMAC defends against Alice (or any in-path attacker) forging a `;w=` to attack a specific worker — invalid `sig` is rejected with `403 Forbidden` and counted as `sip_routing_hmac_failure_total{reason=mismatch}`. The 128-bit truncation is the standard short-token tradeoff (RFC 4868 §2.6); attacker forgery budget is negligible while the cookie shrinks to ~22 base64url chars.
- **Via `cr` / `lg` — response → call/leg resolution at the worker.** Response routing per RFC 3261 §18.1.2 is by branch, but the worker needs *call+leg* identity, not just transaction identity (e.g. to pick the right b-leg dialog for forking). Stamping `cr` and `lg` in the top Via lets the worker resolve straight off `parsed.via.params` without consulting any in-memory map keyed by branch.
- **Contact `callRef` / `leg` — in-dialog request resolution at the worker.** A peer's in-dialog request (BYE, re-INVITE, NOTIFY, …) has its Request-URI set to whatever the B2BUA put in `Contact` on the dialog-creating 2xx (RFC 3261 §12.2.1.1 / §20.10). Embedding `callRef`/`leg` in the Contact URI means the worker resolves the request without a dialog-key (Call-ID + From-tag + To-tag) lookup — even after worker restart, before Redis-backed dialog state is hydrated.
- **`em` / `emerg` — overload-protection classification at the worker.** The worker's `OverloadController` (Tier 1/2 in [overload-protection.md](overload-protection.md)) reads these to drain emergency calls first and never silently drop them. The cluster-mode dispatcher used to byte-scan the same markers before parsing; with the dispatcher deleted, emergency classification is worker-only in Phase 1. The proxy's own ingress has no overload brake (D7).
- **`branch` — transaction matching, RFC 3261 §17.2.3.** Distinct from the routing role of `cr`/`lg`: `branch` matches a response back to the client transaction it answers, and a CANCEL / ACK-for-2xx must echo (or in the ACK-for-2xx case, *not* echo, but cache its own) the right value (see "Branch capture lifecycle" above). The proxy adds its own top `Via` with its own branch on top — **independent** of the worker's branch — purely to recognise its own Via on responses (RFC 3261 §16.7.3 pop-by-Via).

### URL-encoding

`callRef` / `leg` values can contain `;`, `=`, `@`, or whitespace — characters that would corrupt Via/URI parsing if emitted verbatim. `legStackIdentity` runs `encodeURIComponent` before stamping, and `resolveFromRequest` / `resolveFromResponse` run `decodeURIComponent` after parsing, so values round-trip safely.

The proxy's `;w=` / `;kid=` are constrained by `WorkerId` (K8s pod-name charset, no special chars) and the kid generator (16 hex chars), so neither needs escaping. `;sig=` is base64url, also URL-safe.

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
