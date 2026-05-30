# REFER rebuild — findings & RFC obligations

Working notes for a clean REFER blind-transfer (re)implementation. Findings only —
not a plan, not a code mirror. Verified by reading code, not summaries.

## What's broken in the current implementation (verified)

1. **Media-breaking offer/answer (RFC 3264).** Initial INVITE to the transfer
   target C carries HELD SDP (`buildHeldSdpFromProfile` → port 0, `a=inactive`).
   `transfer-c-200-initial` captures C's answer to that held offer into
   `cInitialSdp` (so it's an inactive/port-0 answer). The c-realign re-INVITE
   sends A's real SDP to C and C answers for real — **that real answer is
   discarded**; `transfer-c-realign-200` re-INVITEs A with the stale held
   `cInitialSdp`. Net: A negotiates inactive media → the transferred A↔C call has
   no audio. Tests pass only because fixtures are deterministic. This is the
   likely reason REFER never actually worked end to end.

2. **`clearCallExt` is a no-op.** `referTransfer.ts` returns
   `{ actions, clearCallExt: true }` at 5 sites; `Service.ts` never implements
   the flag (not in `ServiceHandleResult`, not in the minted wrapper). It
   typechecks because `Effect.sync` infers the wider object and extra props pass
   structural assignability. Effect: `call.ext["transfer"]` is never cleared →
   post-transfer re-INVITE from A hits `transfer-a-glare-reinvite` (phase still
   `a-realigning`) → 491; a second transfer never intercepts
   (`noTransferActive` stays false).

3. **Old system not removed (Option B not executed).** `Call.transfer`,
   `TransferState`, `TransferPhase` (CallModel), the `transferPhase` Match column +
   `transferPhaseMatch`/`Score` (RuleDefinition/Matcher), and
   `update-transfer`/`clear-transfer` + `executeUpdateTransfer` (RuleDefinition/
   ActionExecutor) all still exist as dead code. The codec DID drop
   `transferJson`/`transferIsNull`, so `Call.transfer` is now a field that
   silently won't replicate — a latent hazard.

4. **Gratuitous per-leg ext.** `TransferLegExt.role` (transferor/transferee/
   transfer-target) is not needed: the call-ext already carries `referrerLegId`
   and `cLegId`, and legs are addressed by id everywhere. Roles were added only
   to "exercise leg-ext." KISS: drop per-leg ext; address legs by id.

5. **Subscription-State semantics.** Success NOTIFY uses
   `terminated;reason=noresource` (RFC 3265 §3.2.4) which reads as failure. The
   referrer can't distinguish success from resource-exhaustion.

6. **B referrer leg dangling on success.** No BYE to B on the success path; relies
   on B hanging itself up. A buggy/silent B leaves a confirmed unpaired dialog.

## How the B2BUA actually handles media/SDP (verified — reuse, don't reinvent)

- **SDP is passed through transparently.** No offer/answer state machine on the
  dialog; bodies are opaque payload. A and the far end exchange media directly
  (c-line/port in their SDP). The B2BUA is NOT a media relay. → For transfer, A's
  SDP must reach C and C's SDP must reach A, unchanged, so they point media at
  each other.
- **`send-reinvite`** (ActionExecutor `executeSendReinvite`): B2BUA-originated
  re-INVITE on a leg's dialog; bumps CSeq via `generateInDialogRequest`, body via
  `bodyUpdate` ADT (`set`/`drop`), stores `pendingInviteTxn` for ACK CSeq
  (RFC 3261 §13.2.2.4). Response is NOT auto-relayed — the transfer rules own it.
- **`ack-leg`** sources ACK CSeq from `pendingInviteTxn`, caches `ackBranch`
  (§17.1.1.2). **`create-leg`** clones the A INVITE snapshot to a new b-leg with
  body/RURI/header ADT mutations + admission gate + no-answer timer.
  **`merge`/`split`** set `call.activePeer`. **`send-notify`** builds an in-dialog
  NOTIFY (fire-and-forget; no subscription state model). **`relay-to-peer`** does
  full transparent in-dialog relay (Via/Contact/CSeq/route-set + pending-request
  snapshot for response correlation). **`reinviteGlareRule`** → 491 when a
  re-INVITE is already pending on a dialog (`inboundPendingRequests`).
- SDP helpers: `extractCodecProfile`, `buildHeldSdpFromProfile`,
  `SdpAnswerFromOffer` (codec intersection, used by fake-PRACK). For blind
  transfer with passthrough media, NONE of the held-SDP machinery is needed.

## CORRECTION (scope) — the media bug is likely SURGICAL, not a redesign

Re-examination: the held-SDP-first INVITE to C, the c-realign/a-realign double
re-INVITE, "B BYEs itself", NOTIFY timing, and per-leg roles are DELIBERATE
decisions in docs/todos/REFERIMPL.md (D1–D7). They are not RFC bugs and must not
be unilaterally torn out.

The real RFC-3264 defect is narrow: the **a-realign re-INVITE to A reuses the
held-offer answer** (`cInitialSdp`, captured from C's 200 to the *held* initial
INVITE) instead of **C's answer to the c-realign re-INVITE** (the real-media
answer to A's real SDP offer). The c-realign answer is currently discarded.
The intended flow is sound IF a-realign offers C's c-realign answer to A:
  held INVITE→C (ring, no early media) → C ans1 (held)
  → re-INVITE C with A's real SDP → C ans2 (C's real media)   ← capture THIS
  → re-INVITE A with ans2 → A answers → merge.
So the minimal correct fix = capture C's c-realign 200 SDP and use it as the
a-realign offer to A; `cInitialSdp` (the held answer) is then unnecessary.

This respects the documented design and is a small diff. The wholesale redesign
below (drop held SDP / drop a phase / drop leg-ext / BYE-B / re-time NOTIFY) is
NOT warranted unless the owner explicitly wants RFC-5589 restructuring. Keep the
`clearCallExt` fix (genuine bug, already done). The Option-B dead-code removal is
a separate cleanliness item, not a runtime bug.

## (Superseded — for reference only) RFC-5589 redesign sketch

A↔B bridged (B2BUA mid-dialog, passthrough media). B REFERs A to C.

1. REFER from B (in-dialog, no Replaces) → 202 Accepted; implicit refer
   subscription (RFC 3515). Send NOTIFY `100 Trying`,
   `Subscription-State: active`. Authorize via `/call/refer`.
2. On allow: **INVITE C with A's real SDP offer** (A-leg's current negotiated
   SDP). No held SDP. (RFC 3264: a valid offer with A's real media.)
3. C 1xx → NOTIFY sipfrag (`active`). C 200 = **C's real answer**.
4. ACK C; confirm C dialog. **Re-INVITE A offering C's real answer SDP**
   (RFC 3264: re-offer in the established A dialog re-points A's media to C).
5. A 200 (answer) → ACK A. `merge(a, c)`. Send final NOTIFY
   `200 OK`, `Subscription-State: terminated` (success reason). Tear down B
   (BYE the referrer leg) — don't rely on B. Clear transfer state.
6. One offer/answer each direction; no double re-INVITE; no held SDP; no stale
   SDP. (Open question to settle while building: whether A's reused INVITE SDP is
   a valid fresh offer to C, or whether a 3PCC/offerless re-INVITE to A
   (RFC 3725 flow) is more robust when A's original SDP can't be replayed —
   decide against the actual relay/passthrough behavior, prefer the simplest
   correct path.)

### RFC rules the rebuild must honor (CLAUDE.md: list before coding)
- **RFC 3515** (REFER): in-dialog REFER → 202; implicit subscription; NOTIFY with
  `message/sipfrag` carrying the C-leg progress; `Subscription-State` active→
  terminated; only one REFER in flight (RFC 3261 §14.1 → 491 second REFER).
- **RFC 3265/6665**: `Subscription-State` header values + `reason`; terminate the
  subscription exactly once.
- **RFC 3420**: `message/sipfrag;version=2.0` NOTIFY bodies.
- **RFC 3264**: every INVITE/re-INVITE we originate is a valid offer; the peer's
  2xx is the answer; never present an answer as an offer; never re-offer while an
  answer is pending (glare → 491, RFC 3261 §14.1).
- **RFC 3261**: §12 dialog (Contact/Record-Route/route-set/CSeq), §13.2.2.4 ACK
  CSeq for 2xx, §17.1.1.2 ACK branch retransmit, §9.1 CANCEL Request-URI match,
  §14.1 re-INVITE glare 491. ACK is end-to-end by design (project invariant).
- **RFC 3262** (if reliable 1xx on the C leg): PRACK locally or relayed per the
  existing model; mirror `send-prack-to-leg` usage.
- **RFC 5589**: blind/unattended transfer — send the target the call directly;
  no consultation hold for blind; report transfer outcome via the subscription.
- **RFC 3891 (Replaces)**: attended transfer — out of scope v1 → 501.

## Service vs built-in (decision)
Keep transfer as a callflow service (ADR-0016 direction, PEM precedent) but
**call-ext only** — no per-leg ext. Seed (intercept) stays a built-in always-
active rule (it must run before the ext slice exists). Per-call state needed:
phase, referrerLegId, cLegId, referToUri/effective, referCSeq, startedAtMs,
lastCLegNotifiedStatus, and the captured **C real answer SDP** for the A re-offer.
`clearCallExt` must be implemented in `Service.ts` (or rules return a cleared
slice) so the service deactivates.
