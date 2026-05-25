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
| `rfc.cseq` | all | peer | shipped | (pending inventory) | — | CSeq monotonicity + method correlation. 481-aware suppression of unknown-dialog rejects. |
| `rfc.tags` | all | peer | shipped | (pending inventory) | — | To/From tag dialog identity. Per-Call-ID partition; same 481-aware suppression. |
| `rfc.branchPrefix` | all | peer | shipped | (pending inventory) | — | Via branch begins with `z9hG4bK`. |
| `rfc.contentLength` | all | peer | shipped | (pending inventory) | — | Header value matches actual body byte count. Raw-buffer check (parser already slices). |
| `rfc.callId` | all | peer | shipped | (pending inventory) | — | Call-ID consistency within a dialog. |
| `rfc.via` | all | peer | shipped | (pending inventory) | — | Via branch on responses. |
| `rfc.maxForwards` | all | peer | shipped | (pending inventory) | — | Max-Forwards presence + decrement. |
| `rfc.contentType` | all | peer | shipped | (pending inventory) | — | Content-Type present when body non-empty. |
| `rfc.contactPresence` | all | peer | shipped | (pending inventory) | — | Contact on dialog-establishing methods. |
| `rfc.noContactOnBye` | all | peer | shipped | (pending inventory) | — | BYE / CANCEL must not carry Contact. Precedent rule from [b9ae0ec6](#). |
| `rfc.toTagPresence` | all | peer | shipped | (pending inventory) | — | To-tag on responses with status > 100. |
| `rfc.dialogUri` | all | peer | shipped | (pending inventory) | — | In-dialog From URI stability. |
| `rfc.recordRoute` | all | peer | shipped | (pending inventory) | — | B2BUA must not Record-Route. |
| `rfc.cancelRequestUri` | all | peer | shipped | (pending inventory) | — | CANCEL Request-URI matches INVITE. |
| `rfc.cancelViaBranch` | all | peer | shipped | (pending inventory) | — | CANCEL Via branch matches INVITE. |
| `rfc.responseCorrelation` | all | peer | shipped | (pending inventory) | — | Response CSeq echoes a sent request. |
| `rfc.rackCorrelation` | all | peer | shipped | RFC3262-MUST-009 (partial — defines "matching PRACK") | — | PRACK RAck correlates with reliable 1xx. Phase-2 audit will confirm whether the rule also covers M-021 or whether a separate `rfc.prackOnReliable1xx` is needed. |
| `rfc.tagConsistency` | all | peer | shipped | (pending inventory) | — | UAS final-response tag consistency. |

## Shipped rules — cross-message (`cross`)

Source: [tests/harness/rules/rfc/cross-message-rules.ts](../../tests/harness/rules/rfc/cross-message-rules.ts).

| rule name | subject | kind | status | MUST-IDs covered | helper(s) used | notes |
|-----------|---------|------|--------|------------------|----------------|-------|
| `rfc.midDialogFromUri` | all | cross | shipped | (pending inventory) | `_dialog-model.ts` | In-dialog From/To URI stability per RFC 3261 §12.2.1.1. |
| `rfc.midDialogRoute` | all | cross | shipped | (pending inventory) | `_dialog-model.ts` | Route set application per §12.2.1.1 + §16.12 (loose + strict). |
| `rfc.sdpOriginContinuity` | all | cross | advisory | (pending inventory) | `_dialog-model.ts` (`parseSdpOrigin`) | RFC 4566 §5.2 / RFC 3264 §8. Advisory: transfer fixtures emit fresh `o=` per side. Phase 2 narrows subject or models origin replication. |
| `rfc.recordRoutePlacement` | all | cross | shipped | (pending inventory) | `_dialog-model.ts` | 100 Trying must not carry Record-Route; responses to in-dialog requests must not Record-Route per §12.2.2. |
| `rfc.rportEcho` | all | cross | advisory | (pending inventory) | `_dialog-model.ts` (`readRport`) | RFC 3581 §4. Advisory: loopback never NATs, so the response correctly omits `rport=`. Phase 2 narrows subject to `{proxy}` or models loopback. |
| `rfc.allowSupportedOnInvite` | all | cross | shipped | (pending inventory) | `_dialog-model.ts` | Allow / Supported on re-INVITE + 2xx INVITE. SHOULD-level (3261 §13.2.1, §20.37). |
| `rfc.proxy100TryingNotForwarded` | all | cross | shipped | (pending inventory) | `_dialog-model.ts` | Stateful proxy absorbs downstream 100 Trying per §16.7 step 5. |

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

_(empty — populated when [RFC3261.md](RFC3261.md) lands)_

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

_(empty — populated when [RFC3264.md](RFC3264.md) lands)_

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
