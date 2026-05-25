# Rule Manifest

Higher-level summary of every RFC rule that lands (or already lives) in
[tests/harness/rules/rfc/](../../tests/harness/rules/rfc/), grouped by
**rule** (not by MUST). This is the document a reviewer reads to
validate the *shape* of Phase 2 before any new rule code is written.

Companion docs:

- [docs/RFC_Verification.md](../RFC_Verification.md) — the process
  this manifest implements.
- Per-RFC inventories — [RFC3261.md](RFC3261.md), [RFC3262.md](RFC3262.md),
  [RFC3264.md](RFC3264.md). Each row in those tables back-references a
  manifest entry by rule name.

## How to read this file

Each row covers one named rule. Columns:

| column | meaning |
|--------|---------|
| **rule name** | Exact `PeerAuditRule.name` / `CrossMessageAuditRule.name`. Stable; referenced by inventory rows. |
| **subject** | UA role set the rule asserts against. `all` = `{uac, uas, proxy}` (`ALL_UA_ROLES`). |
| **kind** | `peer` (single-message, per-bind) / `cross` (multi-message, layer-close). |
| **status** | `shipped` / `planned` (= `will-implement`) / `advisory` (`severityOverride: "advisory"` today). |
| **MUST-IDs covered** | Comma-separated list of `RFCNNNN-MUST-NNN` IDs from the inventories. `(pending inventory)` until the corresponding inventory lands. |
| **helper(s) used** | `_*.ts` files this rule depends on. `—` if the rule is self-contained. |
| **notes** | Advisory-state reasoning, narrowing target, planned removal, etc. |

Every `MUST-IDs covered` entry MUST appear in at least one inventory
row; every inventory row classified `already-implemented` /
`will-implement` MUST appear in the `MUST-IDs covered` column of
exactly one manifest row.

The manifest is mutable. Each Phase-2 PR updates affected rows in the
same commit that lands the rule — when a `planned` row's first
`MUST-IDs covered` entry flips to `already-implemented` in the
inventory, the manifest row flips to `shipped`.

## Shipped rules — single-message (`peer`)

Source: [tests/harness/rules/rfc/starter-peer-rules.ts](../../tests/harness/rules/rfc/starter-peer-rules.ts).
All rules use `subject: ALL_UA_ROLES` today; Phase-2 inventories will
narrow proxy-only or UAS-only rules where the MUST is role-specific.

| rule name | subject | kind | status | MUST-IDs covered | helper(s) used | notes |
|-----------|---------|------|--------|------------------|----------------|-------|
| `rfc.cseq` | all | peer | shipped | RFC3261-MUST-019, RFC3261-MUST-053, RFC3261-MUST-067, RFC3261-MUST-078, RFC3261-MUST-144 | — | CSeq monotonicity + method correlation. 481-aware suppression of unknown-dialog rejects. |
| `rfc.tags` | all | peer | shipped | RFC3261-MUST-017, RFC3261-MUST-041, RFC3261-MUST-066, RFC3261-MUST-130 | — | To/From tag dialog identity. Per-Call-ID partition; same 481-aware suppression. |
| `rfc.branchPrefix` | all | peer | shipped | RFC3261-MUST-021 | — | Via branch begins with `z9hG4bK` (folded with `rfc.via`). |
| `rfc.contentLength` | all | peer | shipped | RFC3261-MUST-119, RFC3261-MUST-158, RFC3261-MUST-169 | — | Header value matches actual body byte count. Raw-buffer check (parser already slices). |
| `rfc.callId` | all | peer | shipped | RFC3261-MUST-018, RFC3261-MUST-040, RFC3261-MUST-067 | — | Call-ID consistency within a dialog + uniqueness (unobservable side folded). |
| `rfc.via` | all | peer | shipped | RFC3261-MUST-021, RFC3261-MUST-040, RFC3261-MUST-117, RFC3261-MUST-125, RFC3261-MUST-133, RFC3261-MUST-142, RFC3261-MUST-144, RFC3261-MUST-153, RFC3261-MUST-156 | — | Via branch + sent-by + received parameter on responses. |
| `rfc.maxForwards` | all | peer | shipped | RFC3261-MUST-020, RFC3261-MUST-098, RFC3261-MUST-108 | — | Max-Forwards presence + decrement + zero-handling at proxy. |
| `rfc.contentType` | all | peer | shipped | RFC3261-MUST-009, RFC3261-MUST-170 | — | Content-Type present when body non-empty + Content-Encoding rules. |
| `rfc.contactPresence` | all | peer | shipped | RFC3261-MUST-022, RFC3261-MUST-061 | — | Contact on dialog-establishing methods. |
| `rfc.noContactOnBye` | all | peer | shipped | (derived — Contact-presence semantics on BYE/CANCEL) | — | BYE / CANCEL must not carry Contact. Precedent rule from [b9ae0ec6](#). |
| `rfc.toTagPresence` | all | peer | shipped | RFC3261-MUST-041 | — | To-tag on responses with status > 100. |
| `rfc.dialogUri` | all | peer | shipped | RFC3261-MUST-066 | — | In-dialog From URI stability. |
| `rfc.recordRoute` | all | peer | shipped | RFC3261-MUST-109 (B2BUA-flavor: must NOT Record-Route) | — | B2BUA must not Record-Route — opposite obligation to a generic proxy. |
| `rfc.cancelRequestUri` | all | peer | shipped | RFC3261-MUST-044 | — | CANCEL Request-URI matches INVITE. |
| `rfc.cancelViaBranch` | all | peer | shipped | RFC3261-MUST-044 | — | CANCEL Via branch matches INVITE. |
| `rfc.responseCorrelation` | all | peer | shipped | RFC3261-MUST-038, RFC3261-MUST-040, RFC3261-MUST-078, RFC3261-MUST-144 | — | Response CSeq echoes a sent request. |
| `rfc.rackCorrelation` | all | peer | shipped | RFC3262-MUST-009 (partial — defines "matching PRACK") | — | PRACK RAck correlates with reliable 1xx. Phase-2 audit will confirm whether the rule also covers M-021 or whether a separate `rfc.prackOnReliable1xx` is needed. |
| `rfc.tagConsistency` | all | peer | shipped | RFC3261-MUST-041, RFC3261-MUST-130 | — | UAS final-response tag consistency. |

## Shipped rules — cross-message (`cross`)

Source: [tests/harness/rules/rfc/cross-message-rules.ts](../../tests/harness/rules/rfc/cross-message-rules.ts).

| rule name | subject | kind | status | MUST-IDs covered | helper(s) used | notes |
|-----------|---------|------|--------|------------------|----------------|-------|
| `rfc.midDialogFromUri` | all | cross | shipped | RFC3261-MUST-066 | `_dialog-model.ts` | In-dialog From/To URI stability per RFC 3261 §12.2.1.1. |
| `rfc.midDialogRoute` | all | cross | shipped | RFC3261-MUST-068 | `_dialog-model.ts` | Route set application per §12.2.1.1 + §16.12 (loose + strict). |
| `rfc.sdpOriginContinuity` | all | cross | advisory | RFC3264-MUST-039, RFC3264-MUST-040 | `_dialog-model.ts` (`parseSdpOrigin`) | RFC 4566 §5.2 / RFC 3264 §8. Advisory: transfer fixtures emit fresh `o=` per side. Phase 2 narrows subject or models origin replication. |
| `rfc.recordRoutePlacement` | all | cross | shipped | RFC3261-MUST-061 (Record-Route on dialog-establishing 2xx) | `_dialog-model.ts` | 100 Trying must not carry Record-Route; responses to in-dialog requests must not Record-Route per §12.2.2. |
| `rfc.rportEcho` | all | cross | advisory | (RFC 3581 — out of pilot) | `_dialog-model.ts` (`readRport`) | RFC 3581 §4. Advisory: loopback never NATs, so the response correctly omits `rport=`. Phase 2 narrows subject to `{proxy}` or models loopback. |
| `rfc.allowSupportedOnInvite` | all | cross | shipped | RFC3261-MUST-088, RFC3261-MUST-165 | `_dialog-model.ts` | Allow / Supported on re-INVITE + 2xx INVITE. SHOULD-level (3261 §13.2.1, §20.37). |
| `rfc.proxy100TryingNotForwarded` | all | cross | shipped | RFC3261-MUST-127 | `_dialog-model.ts` | Stateful proxy absorbs downstream 100 Trying per §16.7 step 5. |

### Already-asserted-elsewhere

These obligations are enforced but not via `PeerAuditRule` /
`CrossMessageAuditRule`. Inventory rows classified
`already-implemented` may point here instead of at a rule name.

| asserted by | what it covers | source |
|-------------|----------------|--------|
| `OfferAnswerTracker` (interpreter) | Offer/answer model state-machine enforcement (RFC 3264). `runValidationChecks` carries an `"offerAnswer"` no-op entry only so `skipValidation: ["offerAnswer"]` typechecks. | [src/test-harness/framework/validation.ts:811-813](../../src/test-harness/framework/validation.ts#L811-L813) |
| Custom parser reject paths | Inbound messages violating grammatical MUSTs are rejected at parse time; the MUST becomes unobservable post-hoc. | [src/sip/parsers/custom/](../../src/sip/parsers/custom/), ADR-0007 |
| Transaction layer | CANCEL absorption, retransmission, branch generation. | (B2BUA call-control core) |
| Message builder | Outbound CSeq monotonicity, branch uniqueness, From-tag stability per dialog. | (B2BUA call-control core) |

Inventory rows pointing here use the `arch-guaranteed` /
`parser-enforced` / `transport-enforced` taxonomy keyword (see
[RFC_Verification.md](../RFC_Verification.md) §"Justification taxonomy").

## Planned rules

Filled in as the per-RFC inventories land. The shape of this section
will match "Shipped rules" above — one row per planned `PeerAuditRule`
or `CrossMessageAuditRule`, with the `MUST-IDs covered` column
authoritative for the Phase-2 work.

### RFC 3261

Twenty-three planned rules cover 24 `will-implement` MUSTs (one rule
covers two adjacent MUSTs). Inventory: [RFC3261.md](RFC3261.md).
Thirty-eight more `already-implemented` MUSTs are covered by the
shipped peer + cross-message rules above (their MUST-IDs columns
have been flipped).

| rule name | subject | kind | status | MUST-IDs covered | helper(s) used | notes |
|-----------|---------|------|--------|------------------|----------------|-------|
| `rfc.noToTagOnInitialRequest` | uac | peer | planned | RFC3261-MUST-016 | — | Sent request inspection: dialog-less initial request must not carry To-tag. Positive fixture: Alice's builder stamps a To-tag on an INVITE. |
| `rfc.unsupportedMethod405Allow` | uas | cross | planned | RFC3261-MUST-030 | `_dialog-model.ts` | Received unrecognised method → 405 response carrying Allow header listing supported methods. Positive fixture: peer sends fictional `BANANA` method. |
| `rfc.unsupportedExtension420` | uas | cross | planned | RFC3261-MUST-033 | `_dialog-model.ts` | Received Require with unknown option tag → 420 response carrying Unsupported header listing the rejected tags. Positive fixture: Alice INVITE with `Require: fictional`. |
| `rfc.noRequireOnCancelOrAck` | uac, uas | peer | planned | RFC3261-MUST-034 (covers RFC3261-MUST-047 restatement) | — | Sent CANCEL or ACK (non-2xx) must not carry Require / Proxy-Require. Positive fixture: Alice CANCEL with Require:100rel. |
| `rfc.ackRequireSubsetOfInvite` | uac | cross | planned | RFC3261-MUST-035 | planned `_transaction-correlation.ts` | ACK to 2xx INVITE's Require values are a subset of the INVITE's. Positive fixture: Alice ACK adds a Require tag absent from INVITE. |
| `rfc.unsupported415Accepts` | uas | cross | planned | RFC3261-MUST-036 (covers RFC3261-MUST-180 restatement) | `_dialog-model.ts` | 415 response carries Accept / Accept-Encoding / Accept-Language as appropriate. Positive fixture: Alice INVITE with unsupported `Content-Type: application/foo`. |
| `rfc.responseExtensionsAdvertised` | uas | cross | planned | RFC3261-MUST-037 | `_dialog-model.ts` | Extensions applied in response are listed in Supported (or Require if required); MUST NOT apply extensions outside the Supported list. Positive fixture: response adds an extension header without advertising it. |
| `rfc.cancelCseqMethod` | uac | peer | planned | RFC3261-MUST-045 | — | Sent CANCEL's CSeq method must be CANCEL and CSeq number must equal the INVITE's. Positive fixture: Alice CANCEL with `CSeq: N INVITE`. |
| `rfc.cancelRouteEchoesInvite` | uac | cross | planned | RFC3261-MUST-046 | planned `_transaction-correlation.ts` | If INVITE had a Route header, CANCEL carries the same Route values. Positive fixture: INVITE with Route, CANCEL omits Route. |
| `rfc.cancelAfter1xx` | uac | cross | planned | RFC3261-MUST-048 | planned `_transaction-correlation.ts` | Sent CANCEL must follow a received 1xx for the same INVITE branch. Positive fixture: Alice sends CANCEL immediately after INVITE without waiting for 100. |
| `rfc.registerNoRouteSet` | uac | cross | planned | RFC3261-MUST-051, RFC3261-MUST-052 | `_dialog-model.ts` | Sent REGISTER carries no Route header and forms no dialog/route set. Positive fixture: REGISTER with a Route header. |
| `rfc.serialRegister` | uac | cross | planned | RFC3261-MUST-054 | planned `_transaction-correlation.ts` | No new REGISTER with new Contact until prior REGISTER receives a final response. Positive fixture: REGISTER, immediate new REGISTER with different Contact. |
| `rfc.optionsResponseEchoes` | uas | cross | planned | RFC3261-MUST-059 | `_dialog-model.ts` | Received OPTIONS → 200 OK with Allow + Supported + Accept matching what an INVITE response would carry. Positive fixture: OPTIONS-with-Allow vs INVITE-with-Allow comparison. |
| `rfc.unknownDialog481` | uas | cross | planned | RFC3261-MUST-071 | `_dialog-model.ts` | Received in-dialog request with no matching local dialog → 481 response. Already-suppressed pattern in `rfc.cseq`/`rfc.tags`; this rule asserts the *response* shape (complement). Positive fixture: stale BYE for a torn-down dialog. |
| `rfc.noReInviteWhileInviteInProgress` | uac | cross | planned | RFC3261-MUST-083 (covers RFC3261-MUST-084 restatement) | planned `_transaction-correlation.ts` | UAC must not issue a new in-dialog INVITE while a prior INVITE transaction is unterminated. Positive fixture: re-INVITE while client transaction still in "Proceeding". |
| `rfc.concurrentReInvite500or491` | uas | cross | planned | RFC3261-MUST-086 | `_dialog-model.ts` | Received concurrent in-dialog INVITE → 500 (with Retry-After) or 491 (Request Pending). Positive fixture: two near-simultaneous re-INVITEs into the same dialog. |
| `rfc.noByeOutsideOrEarlyDialog` | uac, uas | cross | planned | RFC3261-MUST-089 | `_dialog-model.ts` | BYE forbidden outside dialog; callee-side BYE forbidden on confirmed dialog before ACK; callee BYE forbidden on early dialog (use CANCEL or 4xx instead). Positive fixture: callee sends BYE on an early dialog. |
| `rfc.proxy100WithinT100ms` | proxy | cross | planned | RFC3261-MUST-095 | planned `_transaction-correlation.ts` | Stateful proxy sends 100 Trying for INVITE within 200ms of receipt (when relaying). Positive fixture: proxy harness slows the 100 emission past the bound. |
| `rfc.strictRouteRewriteHandled` | proxy | cross | planned | RFC3261-MUST-100 | planned `_transaction-correlation.ts` | When received request has strict-route topmost Route, outgoing request shows the §16.4 swap (Request-URI ← last Route URI). Positive fixture: proxy receives strict-route, audit observes outbound without the swap. |
| `rfc.noTarget404` | proxy | cross | planned | RFC3261-MUST-105 | `_dialog-model.ts` | If proxy/SipRouter cannot resolve a target → 404 (Not Found). Positive fixture: backend HTTP returns "no target", audit observes anything other than 404. |
| `rfc.strictRouteShuffleOnSend` | proxy | peer | planned | RFC3261-MUST-113 | — | When forwarding to a Route set whose first URI lacks `;lr`, observe the request-URI / Route swap (§16.6 step 6.b). Peer rule on sent requests at proxy bind. Positive fixture: builder emits no-swap form. |
| `rfc.ackPreservesInviteRoute` | uac | cross | planned | RFC3261-MUST-145 | planned `_transaction-correlation.ts` | ACK to non-2xx INVITE carries the same Route headers as the INVITE. Positive fixture: Alice ACK omits an INVITE Route. |
| `rfc.unsupportedExtension421` | uas | cross | planned | RFC3261-MUST-182 (covers RFC3261-MUST-181 restatement) | `_dialog-model.ts` | 421 (Extension Required) response carries a Require header listing the required extensions. Positive fixture: response emits 421 without Require. |

### RFC 3262

Sixteen planned rules cover 21 `will-implement` MUSTs. Inventory:
[RFC3262.md](RFC3262.md).

| rule name | subject | kind | status | MUST-IDs covered | helper(s) used | notes |
|-----------|---------|------|--------|------------------|----------------|-------|
| `rfc.requireReliable1xxOnRequire` | uas | cross | planned | RFC3262-MUST-001, RFC3262-MUST-002 | `_dialog-model.ts` | INVITE with `Require:100rel` → either every non-100 1xx is reliable OR a 420 with `Unsupported:100rel` is sent. Positive fixture: Alice INVITE with Require, Bob sends plain 180. |
| `rfc.reliable1xxHeaders` | uas | peer | planned | RFC3262-MUST-003, RFC3262-MUST-007, RFC3262-MUST-008 | — | Sent 1xx response checks: status==100 → no `RSeq`/`Require:100rel`; status 101-199 reliable → both present + RSeq in `[1, 2^31-1]`. Positive fixture: peer overrides 180 builder to omit RSeq. |
| `rfc.reliableNeedsClientOptIn` | uas | cross | planned | RFC3262-MUST-004 | `_dialog-model.ts` | If sent 1xx is reliable, the matching inbound INVITE must carry `Supported:100rel` or `Require:100rel`. Positive fixture: Bob sends reliable 180 to an INVITE with neither header. |
| `rfc.noReliable1xxOnInDialog` | uas, proxy | cross | planned | RFC3262-MUST-005 | `_dialog-model.ts` | Reliable 1xx forbidden when request carries To-tag (re-INVITE / mid-dialog). **Positive fixture lands with this PR**: Bob emits reliable 18x on a re-INVITE so the rule's deferred-fail path is exercised. |
| `rfc.unmatchedPrackProxied` | proxy | cross | planned | RFC3262-MUST-006 | `_dialog-model.ts` | A PRACK arriving at a proxy bind that does not correlate with a sent reliable 1xx must appear on the proxy's outbound side (forwarded, not absorbed). Positive fixture: synthetic stale PRACK. |
| `rfc.prackResponseSemantics` | uas | cross | planned | RFC3262-MUST-009, RFC3262-MUST-010 | `_dialog-model.ts` | Received PRACK → 481 if no matching unacked RSeq; 2xx otherwise. Positive fixture: Alice emits PRACK with bogus RAck → expect Bob's 481. |
| `rfc.serialReliable1xx` | uas | cross | planned | RFC3262-MUST-012 | `_dialog-model.ts` | Same dialog cannot emit second reliable 1xx before the first is PRACKed. Positive fixture: Bob sends 180,180 reliably back-to-back without waiting. |
| `rfc.rseqMonotonic` | uas | cross | planned | RFC3262-MUST-013 | `_dialog-model.ts` | Subsequent reliable 1xx RSeq = prior + 1; never wraps. Positive fixture: Bob sends 180/RSeq=5 then 183/RSeq=7. |
| `rfc.delay2xxOnUnackedReliable1xxWithSdp` | uas | cross | planned | RFC3262-MUST-014 (and restatement M-028) | `_dialog-model.ts`, planned `_offer-answer.ts` | If a reliable 1xx carrying SDP is unacked, no 2xx final until PRACK arrives. Positive fixture: Bob sends 183-with-SDP reliably, then 200 INVITE without waiting for PRACK. |
| `rfc.prackAcceptedAfterFinal` | uas | cross | planned | RFC3262-MUST-015 | `_dialog-model.ts` | PRACK arriving after the final response still draws a 2xx. Positive fixture: Alice delays PRACK until after 200 INVITE. |
| `rfc.noNewReliable1xxAfterFinal` | uas | cross | planned | RFC3262-MUST-016 | `_dialog-model.ts` | No new reliable 1xx (i.e. unseen RSeq) after a final response was sent on this INVITE. Positive fixture: Bob sends 200 then a fresh reliable 199. |
| `rfc.no100relRequireOnNonInvite` | uac | peer | planned | RFC3262-MUST-017 | — | Sent request inspection: any non-INVITE carrying `Require:100rel` is a violation. Positive fixture: Alice REGISTER with Require:100rel. |
| `rfc.uacIgnore100rel100Trying` | uac | cross | planned | RFC3262-MUST-019 | `_dialog-model.ts` | If a 100 (Trying) carried `Require:100rel`, no PRACK should reference it. Positive fixture: Bob sends bogus 100 with Require:100rel; Alice must not PRACK. |
| `rfc.prackOnReliable1xx` | uac | cross | planned | RFC3262-MUST-021 | planned `_transaction-correlation.ts` | Every received reliable 1xx (status 101-199 with `Require:100rel`) draws a matching outbound PRACK. Complement to existing `rfc.rackCorrelation`. Positive fixture: Bob sends reliable 180, Alice harness intentionally skips PRACK. |
| `rfc.uacRseqStrictness` | uac | cross | planned | RFC3262-MUST-024 | `_dialog-model.ts` | UAC PRACKs only the in-order RSeq; out-of-order reliable 1xx must not yield a PRACK. Positive fixture: Bob sends 180/RSeq=5 then 181/RSeq=7 (skip 6); Alice must PRACK only the 180. |
| `rfc.prackOfferAnswerModel` | uac, uas | cross | planned | RFC3262-MUST-025, RFC3262-MUST-026, RFC3262-MUST-027 | planned `_offer-answer.ts` | Consolidated O/A walker for the PRACK-flavored exchanges (offer-in-1xx → answer-in-PRACK → answer-in-2xx-PRACK). First consumer of `_offer-answer.ts`; second consumer expected to be RFC 3264 main O/A rule. Positive fixtures: three sub-scenarios, one per MUST. |

### RFC 3264

Eleven planned rules cover 18 `will-implement` MUSTs. Inventory:
[RFC3264.md](RFC3264.md). Two more `already-implemented` MUSTs
(RFC3264-MUST-039 / -040) are covered by the existing
`rfc.sdpOriginContinuity` (advisory).

| rule name | subject | kind | status | MUST-IDs covered | helper(s) used | notes |
|-----------|---------|------|--------|------------------|----------------|-------|
| `rfc.noNewOfferWhileOfferPending` | uac, uas | cross | planned | RFC3264-MUST-001, RFC3264-MUST-002 | planned `_offer-answer.ts` | Glare prevention: outbound offer forbidden while own prior offer is unanswered OR while a received offer is unanswered. Positive fixture: Bob sends UPDATE-with-SDP while INVITE offer is still pending. |
| `rfc.sdpBodyParseable` | uac, uas | peer | planned | RFC3264-MUST-003, RFC3264-MUST-004, RFC3264-MUST-005, RFC3264-MUST-006, RFC3264-MUST-012, RFC3264-MUST-027 | — | Peer rule that strict-parses every sent SDP body: valid RFC 4566 + 3264 SDP, exactly one session description, o= session-id and version fit signed-int64, initial version < 2^62-1, ptime > 0, c=/port present. Positive fixture: peer overrides SDP builder to emit ptime=0. |
| `rfc.answerMLineCountMatchesOffer` | uas | cross | planned | RFC3264-MUST-018 | planned `_offer-answer.ts` | First answer's m= count equals offer's m= count. Positive fixture: Bob's 200 OK drops an offered video stream from the m= list. |
| `rfc.answerTLineEqualsOffer` | uas | cross | planned | RFC3264-MUST-019 | planned `_offer-answer.ts` | Answer's t= line bytes equal the offer's t= bytes. Positive fixture: Bob emits `t=0 60` against offer `t=0 0`. |
| `rfc.answerMediaTypeMatchesOffer` | uas | cross | planned | RFC3264-MUST-022 | planned `_offer-answer.ts` | Per-stream-index pairing: the answer's m= media type matches the offer's m= media type (audio↔audio, video↔video); unicast/multicast preserved. Positive fixture: Bob's answer swaps audio/video order. |
| `rfc.directionPairValid` | uas | cross | planned | RFC3264-MUST-023 | planned `_offer-answer.ts` | sendonly→{recvonly, inactive}; recvonly→{sendonly, inactive}; inactive→inactive. Positive fixture: Bob answers a `sendonly` stream with `sendonly`. |
| `rfc.rejectedStreamMinimalAnswer` | uas | cross | planned | RFC3264-MUST-021 | planned `_offer-answer.ts` | Rejected stream slot has port=0 + at least one media format listed. Positive fixture: Bob's answer for a rejected stream omits all media format tokens. |
| `rfc.reOfferMLineCountMonotonic` | uac | cross | planned | RFC3264-MUST-042, RFC3264-MUST-043 | planned `_offer-answer.ts` | Across same-session re-offers: m= count never decreases; deleted streams keep their slot (port=0, not removed); new m= lines appear *below* existing ones. Positive fixture: re-INVITE removes one m= line entirely. |
| `rfc.zeroPortPropagation` | uas | cross | planned | RFC3264-MUST-044 | planned `_offer-answer.ts` | If offer's m= line has port=0, answer's corresponding m= line MUST have port=0. Positive fixture: Bob's answer assigns a non-zero port to a disabled offered stream. |
| `rfc.payloadTypeMappingStable` | uac, uas | cross | planned | RFC3264-MUST-047 | planned `_offer-answer.ts`, planned `_sdp-parsing.ts` | Dynamic payload-type → codec mapping (via `a=rtpmap`) MUST NOT change across SDP versions in the same session. Positive fixture: re-offer rebinds payload type 100 from `opus/48000` to `G722/8000`. |
| `rfc.c0PortNonZero` | uac | peer | planned | RFC3264-MUST-051 | — | Narrow legacy hold idiom: an SDP whose `c=` is `0.0.0.0` MUST NOT also have `m=… 0 …`. Positive fixture: fixture builder produces `c=0.0.0.0` + `m=audio 0 …`. |

## Helpers

Promoted to a `_*.ts` file when two rules in the same PR would share
more than ~20 lines of walking / correlation logic. See
[RFC_Verification.md](../RFC_Verification.md) §"Helper-extraction
policy" for the contract.

### Shipped helpers

| helper | covers | first consumer |
|--------|--------|---------------|
| [`_dialog-model.ts`](../../tests/harness/rules/rfc/_dialog-model.ts) | Dialog-model walk, route-set tracking, SDP origin parsing, rport reader | `rfc.midDialogFromUri` / `rfc.midDialogRoute` |

### Candidate helpers (illustrative; land with first consumer)

| helper (planned name) | covers | likely first consumer |
|------------------------|--------|------------------------|
| `_offer-answer.ts` | Offer/answer pair extraction across INVITE/200/ACK, UPDATE, PRACK | first RFC 3264 cross-message rule |
| `_dialog-iteration.ts` | Typed dialog walk with per-step state | second cross-message rule duplicating `_dialog-model.ts`'s loop shape |
| `_transaction-correlation.ts` | Response → request match via Via branch + CSeq | first retransmission / PRACK rule beyond `rfc.rackCorrelation` |
| `_sdp-parsing.ts` | Strict-mode SDP parsing for body-dependent rules | second SDP rule beyond `rfc.sdpOriginContinuity` |

Names are illustrative — actual file names are decided when the
helper's second consumer materialises.
