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
| `rfc.noToTagOnInitialRequest` | all | peer | shipped | RFC3261-MUST-016 | — | First-event-per-Call-ID rule: dialog-less initial request must not carry To-tag. Positive coverage: [unit/rfc3261-peer-rules.test.ts](../../tests/harness/rules/rfc/unit/rfc3261-peer-rules.test.ts) (INVITE-with-tag + REGISTER-with-tag positive; clean-INVITE + in-dialog BYE negative). |
| `rfc.noRequireOnCancelOrAck` | all | peer | shipped | RFC3261-MUST-034 | — | CANCEL or ACK-for-non-2xx must not carry Require/Proxy-Require. Positive coverage (CANCEL only): [unit/rfc3261-peer-rules.test.ts](../../tests/harness/rules/rfc/unit/rfc3261-peer-rules.test.ts); ACK-for-non-2xx branch is regression-only (peer-harness setup cost > rule). RFC3261-MUST-034 also covers RFC3261-MUST-047 restatement. |
| `rfc.cancelCseqMethod` | all | peer | shipped | RFC3261-MUST-045 | — | Sent CANCEL: CSeq method part MUST be CANCEL. Regression-only — strict parser (`extract-fields.ts`) already rejects any message where request method ≠ CSeq method; this rule is defense-in-depth for non-parser SipMessage construction paths. CSeq number-equality covered by `rfc.cseq`. |
| `rfc.strictRouteShuffleOnSend` | proxy | peer | shipped | RFC3261-MUST-113 | `_dialog-model.ts` | Regression-only — single-message peer rule cannot prove pre-swap state; surfaces 'strict-route still topmost on outbound' as a structural indicator. |

## Shipped rules — cross-message (`cross`)

Source: [tests/harness/rules/rfc/cross-message-rules.ts](../../tests/harness/rules/rfc/cross-message-rules.ts).
Plus: [tests/harness/rules/rfc/rfc3261-cross-message-rules.ts](../../tests/harness/rules/rfc/rfc3261-cross-message-rules.ts).
Plus: [tests/harness/rules/rfc/rfc3262-cross-message-rules.ts](../../tests/harness/rules/rfc/rfc3262-cross-message-rules.ts).

| rule name | subject | kind | status | MUST-IDs covered | helper(s) used | notes |
|-----------|---------|------|--------|------------------|----------------|-------|
| `rfc.midDialogFromUri` | all | cross | shipped | RFC3261-MUST-066 | `_dialog-model.ts` | In-dialog From/To URI stability per RFC 3261 §12.2.1.1. |
| `rfc.midDialogRoute` | all | cross | shipped | RFC3261-MUST-068 | `_dialog-model.ts` | Route set application per §12.2.1.1 + §16.12 (loose + strict). |
| `rfc.sdpOriginContinuity` | all | cross | advisory | RFC3264-MUST-039, RFC3264-MUST-040 | `_dialog-model.ts` (`parseSdpOrigin`) | RFC 4566 §5.2 / RFC 3264 §8. Advisory: transfer fixtures emit fresh `o=` per side. Phase 2 narrows subject or models origin replication. |
| `rfc.recordRoutePlacement` | all | cross | shipped | RFC3261-MUST-061 (Record-Route on dialog-establishing 2xx) | `_dialog-model.ts` | 100 Trying must not carry Record-Route; responses to in-dialog requests must not Record-Route per §12.2.2. |
| `rfc.rportEcho` | all | cross | advisory | (RFC 3581 — out of pilot) | `_dialog-model.ts` (`readRport`) | RFC 3581 §4. Advisory: loopback never NATs, so the response correctly omits `rport=`. Phase 2 narrows subject to `{proxy}` or models loopback. |
| `rfc.allowSupportedOnInvite` | all | cross | shipped | RFC3261-MUST-088, RFC3261-MUST-165 | `_dialog-model.ts` | Allow / Supported on re-INVITE + 2xx INVITE. SHOULD-level (3261 §13.2.1, §20.37). |
| `rfc.proxy100TryingNotForwarded` | all | cross | shipped | RFC3261-MUST-127 | `_dialog-model.ts` | Stateful proxy absorbs downstream 100 Trying per §16.7 step 5. |
| `rfc.unknownDialog481` | uas | cross | shipped | RFC3261-MUST-071 | `_dialog-model.ts` | Regression-only — complements 481-aware suppression in `rfc.cseq`/`rfc.tags` by asserting the response shape; positive fixture would require fabricating a stale BYE no current scenario emits. |
| `rfc.unsupportedMethod405Allow` | uas | cross | shipped | RFC3261-MUST-030 | `_dialog-model.ts` | Regression-only — no current fixture emits an unrecognised method; rule acts as a tripwire if a fabricated peer ever does. |
| `rfc.unsupportedExtension420` | uas | cross | shipped | RFC3261-MUST-033 | `_dialog-model.ts` | Regression-only — no current fixture emits Require with a fabricated option tag; rule acts as a tripwire. |
| `rfc.unsupported415Accepts` | uas | cross | shipped | RFC3261-MUST-036 | `_dialog-model.ts` | Sent 415 must include Accept/Accept-Encoding/Accept-Language. Regression-only — no current fixture sends 415. Also covers RFC3261-MUST-180 restatement. |
| `rfc.responseExtensionsAdvertised` | uas | cross | shipped | RFC3261-MUST-037 | `_dialog-model.ts` | Regression-only — current fixtures emit Supported in 2xx via the message builder; rule trips if an unadvertised extension ever appears. |
| `rfc.registerNoRouteSet` | uac | cross | shipped | RFC3261-MUST-051, RFC3261-MUST-052 | `_dialog-model.ts` | regression-only — observable half (Route-absence on REGISTER); the no-dialog half is arch-guaranteed |
| `rfc.optionsResponseEchoes` | uas | cross | advisory | RFC3261-MUST-059 | `_dialog-model.ts` | Advisory — B2BUA emits OPTIONS keepalive 200 responses (ADR-0008 two-tier OPTIONS) that intentionally omit Allow/Supported/Accept (transport probes, not §11.2 capability discovery). Advisory until subject narrows to genuine capability OPTIONS or probe responses opt in. |
| `rfc.concurrentReInvite500or491` | uas | cross | shipped | RFC3261-MUST-086 | `_dialog-model.ts` | regression-only — no current fixture races two re-INVITEs into the same dialog |
| `rfc.noByeOutsideOrEarlyDialog` | uac, uas | cross | shipped | RFC3261-MUST-089 | `_dialog-model.ts` | regression-only — no current fixture violates the BYE preconditions; rule trips if a callee ever sends BYE on early dialog |
| `rfc.noTarget404` | proxy | cross | advisory | RFC3261-MUST-105 | `_dialog-model.ts` | Advisory — rule authored for genuine §16.7 stateful proxies. B2BUA worker (classified `proxy` for subject dispatch) terminates each leg as UAC/UAS and may legitimately respond 403/481/491 without forwarding when the backend decision rejects the call — these are not 'no target' outcomes. Advisory until subject narrows to a dedicated proxy bind. |
| `rfc.unsupportedExtension421` | uas | cross | shipped | RFC3261-MUST-182 | `_dialog-model.ts` | regression-only — no current fixture sends a 421; rule trips if a 421 is ever emitted without Require. Also covers RFC3261-MUST-181 restatement. |
| `rfc.ackRequireSubsetOfInvite` | uac | cross | shipped | RFC3261-MUST-035 | `_transaction-correlation.ts` | regression-only — no current fixture stamps mismatched Require on ACK; rule trips if it ever happens. |
| `rfc.cancelRouteEchoesInvite` | uac | cross | shipped | RFC3261-MUST-046 | `_transaction-correlation.ts` | regression-only — no current fixture mismatches CANCEL Route vs INVITE Route; rule trips on Route divergence. |
| `rfc.cancelAfter1xx` | uac | cross | advisory | RFC3261-MUST-048 | `_transaction-correlation.ts` | Advisory — several fixtures legitimately fire CANCEL on a UAC-local timer before receiving the first 1xx (transient failure injection, glare). Advisory until per-fixture annotation distinguishes 'spec-required wait' from 'fixture-driven race'. |
| `rfc.serialRegister` | uac | cross | shipped | RFC3261-MUST-054 | `_transaction-correlation.ts` | regression-only — no current fixture races concurrent REGISTERs with different Contacts for the same AOR. |
| `rfc.noReInviteWhileInviteInProgress` | uac | cross | shipped | RFC3261-MUST-083 (covers RFC3261-MUST-084 restatement) | `_transaction-correlation.ts` | regression-only — no current fixture races re-INVITEs. Also covers RFC3261-MUST-084 restatement. |
| `rfc.proxy100WithinT100ms` | proxy | cross | advisory | RFC3261-MUST-095 | `_transaction-correlation.ts` | Advisory — B2BUA TransactionLayer DOES emit 100 Trying immediately on inbound INVITE (TransactionLayer.ts:742) and absorbs inbound 100 (line 769) so no relay; rule still fires on some fixtures (heuristic bug in branch lookup vs projector bucket migration, OR a code path bypassing TransactionLayer). OrderedAgentEvent also lacks atMs so 200ms bound cannot be enforced. Advisory until either the bypass is found or the rule heuristic is corrected. |
| `rfc.strictRouteRewriteHandled` | proxy | cross | shipped | RFC3261-MUST-100 | `_transaction-correlation.ts` | regression-only — current fixtures use loose routing; rule trips if a strict-route inbound request is observed and the §16.4 swap isn't applied. |
| `rfc.ackPreservesInviteRoute` | uac | cross | shipped | RFC3261-MUST-145 | `_transaction-correlation.ts` | regression-only — no current fixture mismatches ACK/INVITE Route values; rule trips on Route divergence. |
| `rfc.requireReliable1xxOnRequire` | uas | cross | shipped | RFC3262-MUST-001, RFC3262-MUST-002 | `_dialog-model.ts` | regression-only — no current fixture INVITEs with Require:100rel against a non-supporting UAS; rule trips if reliable 1xx contract is violated. Covers both MUST-001 (must send reliable) and MUST-002 (must 420 if unsupported). |
| `rfc.reliableNeedsClientOptIn` | uas | cross | advisory | RFC3262-MUST-004 | `_dialog-model.ts` | Advisory — B2BUA emits reliable 18x on one leg when PRACK is terminated at the B2BUA; the downstream INVITE the rule sees may lack Supported:100rel even though the upstream INVITE opted in (B2BUA negotiates 100rel internally). Advisory until subject narrows to non-DUT peer binds or rule models the B2BUA's PRACK-termination policy. |
| `rfc.noReliable1xxOnInDialog` | uas, proxy | cross | shipped | RFC3262-MUST-005 | `_dialog-model.ts` | regression-only — Phase 1 scope decision originally requested a positive fixture (Bob sending reliable 18x on a re-INVITE); deferred until cross-message rule unit-test infrastructure exists. The deferred-fail path is exercised in full-stack tests that include re-INVITE flows; no current fixture violates this MUST. |
| `rfc.unmatchedPrackProxied` | proxy | cross | advisory | RFC3262-MUST-006 | `_dialog-model.ts` | Advisory — B2BUA worker terminates PRACK per leg (not a strict §3 proxy). PRACK from peer arrives in dialog A's slice but the triggering reliable 1xx was emitted on dialog B's leg (different Call-ID after the worker's leg rewrite), so the PRACK appears "unmatched" per-slice. Advisory until subject narrows to a dedicated proxy bind or the rule correlates across leg-mate slices. |
| `rfc.prackResponseSemantics` | uas | cross | shipped | RFC3262-MUST-009, RFC3262-MUST-010 | `_dialog-model.ts` | regression-only — current PRACK flows correctly trigger 2xx / 481; rule trips on mismatched response. |
| `rfc.serialReliable1xx` | uas | cross | shipped | RFC3262-MUST-012 | `_dialog-model.ts` | regression-only — current PRACK flows wait between reliable 1xx; rule trips on race. |
| `rfc.rseqMonotonic` | uas | cross | shipped | RFC3262-MUST-013 | `_dialog-model.ts` | regression-only — current RSeq emission is contiguous; rule trips on gaps or backwards moves. |
| `rfc.delay2xxOnUnackedReliable1xxWithSdp` | uas | cross | shipped | RFC3262-MUST-014 | `_dialog-model.ts` | regression-only — current PRACK flows wait for PRACK before 2xx; rule trips on premature 2xx. Also covers RFC3262-MUST-028 restatement. |
| `rfc.prackAcceptedAfterFinal` | uas | cross | shipped | RFC3262-MUST-015 | `_dialog-model.ts` | regression-only — current PRACK flows accept late PRACKs; rule trips on rejection. |
| `rfc.noNewReliable1xxAfterFinal` | uas | cross | shipped | RFC3262-MUST-016 | `_dialog-model.ts` | regression-only — current flows stop emitting 18x after final; rule trips on stray reliable 18x post-final. |
| `rfc.uacIgnore100rel100Trying` | uac | cross | shipped | RFC3262-MUST-019 | `_dialog-model.ts` | regression-only — no current fixture has a peer send 100-Trying-with-Require:100rel; rule trips if UAC ever PRACKs such a malformed 100. |
| `rfc.prackOnReliable1xx` | uac | cross | shipped | RFC3262-MUST-021 | `_transaction-correlation.ts` | regression-only — current UAC flows PRACK every reliable 1xx; rule trips on missed PRACK. Complement to existing `rfc.rackCorrelation` (peer-rule on PRACK→1xx match). |
| `rfc.uacRseqStrictness` | uac | cross | shipped | RFC3262-MUST-024 | `_dialog-model.ts` | regression-only — current UAC flows respect in-order RSeq; rule trips on out-of-order PRACK. |
| `rfc.prackOfferAnswerModel` | uac, uas | cross | advisory | RFC3262-MUST-025, RFC3262-MUST-026, RFC3262-MUST-027 | — | Advisory — B2BUA terminates PRACK per leg; reliable-1xx-with-offer body lives on one leg's slice while the PRACK-with-answer body lives on the other leg's slice (different Call-ID after the worker's leg rewrite). The body-presence heuristic fires because both halves of the O/A round are not visible per-slice. Advisory until the planned `_offer-answer.ts` helper models cross-leg PRACK O/A OR subject narrows to non-DUT peer binds. Covers M-025/-026/-027. |

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

Zero planned rules remain — all RFC 3261 MUSTs in pilot scope are either
`already-implemented` or classified `justified-not-implemented` /
`restatement`. Inventory: [RFC3261.md](RFC3261.md). Sixty-two
`already-implemented` MUSTs are covered by the shipped peer +
cross-message rules above.

### RFC 3262

One planned rule covers 1 `will-implement` MUST. Inventory:
[RFC3262.md](RFC3262.md).

| rule name | subject | kind | status | MUST-IDs covered | helper(s) used | notes |
|-----------|---------|------|--------|------------------|----------------|-------|
| `rfc.no100relRequireOnNonInvite` | uac | peer | shipped | RFC3262-MUST-017 | — | Sent request inspection: any non-INVITE carrying `Require:100rel` is a violation. Positive coverage: [unit/rfc3262-peer-rules.test.ts](../../tests/harness/rules/rfc/unit/rfc3262-peer-rules.test.ts) (REGISTER + OPTIONS positive cases; INVITE + clean-REGISTER negative cases). |
| `rfc.reliable1xxHeaders` | uas | peer | shipped | RFC3262-MUST-003, RFC3262-MUST-007, RFC3262-MUST-008 | — | Sent 1xx checks: 100 must omit RSeq/Require:100rel; reliable 1xx with Require:100rel must carry RSeq in [1, 2^31-1]. Positive coverage: [unit/rfc3262-peer-rules.test.ts](../../tests/harness/rules/rfc/unit/rfc3262-peer-rules.test.ts) (180 reliable without RSeq positive). |

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
| [`_transaction-correlation.ts`](../../tests/harness/rules/rfc/_transaction-correlation.ts) | Per-top-Via-branch index of sent/received × request/response messages on one agent's stream; convenience lookups for INVITE-by-branch, first-response status, final-response presence, and option-tag splitting | `rfc.ackRequireSubsetOfInvite` |

### Candidate helpers (illustrative; land with first consumer)

| helper (planned name) | covers | likely first consumer |
|------------------------|--------|------------------------|
| `_offer-answer.ts` | Offer/answer pair extraction across INVITE/200/ACK, UPDATE, PRACK | first RFC 3264 cross-message rule |
| `_dialog-iteration.ts` | Typed dialog walk with per-step state | second cross-message rule duplicating `_dialog-model.ts`'s loop shape |
| `_sdp-parsing.ts` | Strict-mode SDP parsing for body-dependent rules | second SDP rule beyond `rfc.sdpOriginContinuity` |

Names are illustrative — actual file names are decided when the
helper's second consumer materialises.
