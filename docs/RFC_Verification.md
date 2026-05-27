# RFC Verification — process

How a SIP RFC obligation gets from "in the RFC" to "asserted by a green
`npm run test:fake` run". This doc is the source of truth for adding,
classifying, and exempting RFC-level rules in the audit framework.

Adjacent material — read these too:

- [docs/plan/extending-sip-rfc-test-temporal-jellyfish.md](plan/extending-sip-rfc-test-temporal-jellyfish.md)
  — the multi-phase plan this process implements. Phase status lives in
  that doc; this one stays scope-stable.
- [CONTEXT.md](../CONTEXT.md) §"RFC verification" — glossary
  (`UAC` / `UAS` / `A-leg` / `B-leg` / `B2BUA-as-UAS` / `B2BUA-as-UAC` /
  `MUST-ID` / `RFC exception ledger`).
- [docs/rfc/](rfc/) — per-RFC inventory tables + `_raw/` grep snapshots.
- [tests/harness/rules/rfc/](../tests/harness/rules/rfc/) — rule code,
  helpers, and the central `exceptions.ts` declaration file.

## Why this exists

Two motivations:

1. **Coverage we can argue about.** Before this process, there was no
   list of which RFC MUSTs the test suite enforced, which ones an
   architectural guarantee covered, and which ones nothing in the
   codebase checked. The inventory makes coverage gaps reviewable —
   every MUST in scope has a final classification, with a reason.
2. **Discipline at rule-add time.** A new rule that fires across
   existing fixtures has four possible explanations (real DUT bug, test
   fixture bug, validator bug, fixture-style flood). The process below
   picks one and applies the right remedy. The wrong remedy (a per-test
   silence-pad) is structurally inaccessible — see "Triage policy".

## Lifecycle of a MUST

```
extract → triage → assign subject → classify → implement or justify → land → ledger
```

Each step:

1. **Extract.** Run `grep -nE "MUST|MUST NOT|REQUIRED|SHALL" rfcNNNN.txt`
   against the IETF `.txt` source (see `docs/rfc/_raw/`). The raw grep
   output is checked in with a SHA-256 + capture date so future RFC
   revisions are diffable against today's snapshot.

2. **Triage.** For each hit, decide whether it is a normative obligation
   relevant to a SIP B2BUA on this codebase. Drop hits that are:
   - **restatement** — the same MUST said three different ways across
     sections. Pick the canonical one, cross-reference the rest by
     MUST-ID.
   - **out-of-scope** — auth/TLS/proxy-state obligations the deployment
     architecture explicitly delegates away (see CLAUDE.md "Not in
     production" + the B2BUA-internal trust model).
   - **definitional** — keywords appearing in BNF or RFC 2119
     boilerplate, not actual rules.

3. **Assign subject.** Tag the MUST with the role(s) it applies to:
   `uac` / `uas` / `proxy`. A B2BUA matches both `uac` and `uas` per
   call (A-leg as UAS, B-leg as UAC). Proxy-only MUSTs (e.g. §16
   forwarding rules) apply only to binds declaring `proxy` in their
   `roles` set.

4. **Classify.** Each surviving MUST gets one of three final-state
   classifications:

   - `will-implement` — Phase 2 will produce a named rule that asserts
     this MUST. The inventory row points at the planned rule.
   - `already-implemented` — an existing rule covers it (see [tests/harness/rules/rfc/starter-peer-rules.ts](../tests/harness/rules/rfc/starter-peer-rules.ts)
     and [cross-message-rules.ts](../tests/harness/rules/rfc/cross-message-rules.ts)).
     The inventory row points at the rule name. Phase 2 audits the
     rule to confirm it truly enforces the MUST (not "fires under the
     same conditions but for a different reason").
   - `justified-not-implemented` — no rule code will land; the
     inventory row carries one **justification taxonomy** keyword (see
     below) plus a one-line pointer at the file / ADR / test that
     stands in for the rule.

   **No bare `todo`.** Phase 1 review is the moment exclusions get
   accepted. Anything still ambiguous at PR time gets pulled into a
   follow-up discussion before that PR merges.

5. **Implement or justify.** Phase-2 rule landings are per RFC section
   (see plan). `justified-not-implemented` entries are settled at Phase
   1 review and not re-litigated at PR time — new justifications need
   a Rule Manifest edit in the same PR.

6. **Land.** A Phase-2 PR runs `npm run test:fake`; new violations get
   triaged (see "Triage policy"); the inventory row flips to
   `already-implemented`. CLAUDE.md gates apply: `tsc` + Effect plugin
   clean.

7. **Ledger.** End-of-run rendering of every suppression that fired
   (per-test exceptions + per-rule advisory downgrades). Surfaces what
   the suite is *not* enforcing.

## Justification taxonomy

`justified-not-implemented` rows in the inventory tables carry one of:

- `arch-guaranteed` — the message builder / parser structurally
  enforces the obligation. Example: outbound CSeq numbers come from a
  monotonic counter, not a free-form caller field.
- `parser-enforced` — the inbound message is rejected at parse time so
  the MUST is unobservable post-hoc. See [docs/adr/](adr/) for the
  parser's reject list.
- `transport-enforced` — handled by the transaction layer (retransmit,
  CANCEL absorption, branch generation).
- `unobservable-post-hoc` — needs a latency / perf budget, not a
  trace audit. The row cross-references the perf check that owns it.
- `out-of-scope` — B2BUA architectural exclusion. Examples: digest auth
  (trusted backbone), TCP transport (UDP-only deployment), DNS NAPTR
  resolution (workers see resolved addresses only).
- `restatement` — pointer to the canonical MUST-ID elsewhere in the
  same RFC. The pointer column carries `→ RFC3261-MUST-NNN`.

When in doubt, prefer `will-implement` over a borderline `arch-guaranteed`.
A rule that fires zero times in production is cheap; a missing rule
that lets a real bug ship is not.

## Severity model

Two tiers, decided per rule (not per finding):

- **deferred-fail** (default) — the rule's findings cause the test to
  fail at layer close. Use for rules whose violations are real
  obligations and whose findings, today, mean a real bug.
- **advisory** — `severityOverride: "advisory"` on the rule, with a
  mandatory `justification` string. The rule still runs, still records
  findings into the ledger, but does not fail the test. Reserve for
  rules whose findings reflect a *documented systemic false positive*
  — a fixture gap the inventory will narrow in Phase 2 — not "rules
  that fire too often, please be quiet".

Per-rule advisory is a rule-author statement ("this rule isn't
production-ready"); per-test exceptions (see below) are an
author-of-this-test statement about a specific fixture.

## Triage policy — what to do when a new rule fires

When a new MUST rule fires against existing tests, pick exactly one of:

| Cause | Remedy |
|-------|--------|
| Real DUT bug | Open a precursor plan (per CLAUDE.md test-strategy). Do **not** disable the failing test. The MUST rule landing waits on the precursor's fix. |
| Test fixture bug | Fix the fixture in the same PR as the rule. Rule + fixture fix ship together (precedent: `rfc.noContactOnBye` in [b9ae0ec6](https://github.com/anthropics/claude-code/commit/b9ae0ec6)). |
| Validator bug — the rule itself fires on legitimate SIP | Fix the validator. Real-world SIP includes retransmissions, late ACKs, B2BUA dual-leg topology, forked early dialogs, application-level 481-rejection of unknown-dialog probes. **The validator must handle these silently.** See `rfc.cseq` + `findLast(INVITE)` for ACK matching, and the 481-aware suppression in [starter-peer-rules.ts](../tests/harness/rules/rfc/starter-peer-rules.ts). |
| Genuine fixture-style flood — the rule is correct but fires widely across pre-existing fixtures whose authors had no reason to assert it | Ship as `severityOverride: "advisory"` with a `justification` string + tracked Phase-2 TODO. The ledger shows the advisory state globally. |

**What is structurally absent from the menu:** "add a per-test entry to
`RFC_EXCEPTIONS` because the rule is noisy on test X". Per-test
exceptions are reserved for fixtures that **deliberately send
something the SIP stack cannot legitimately handle** — a
malformed-on-purpose negative-case fixture whose whole point is to
stress the reject path. In that case the entry is tied to that
specific fixture's intent, with a written justification.

**Never declare a per-test exception in place of fixing the validator
or the fixture.** If a rule fires unexpectedly: fix the validator or
fix the fixture. Exceptions are a last resort for genuine *intentional*
per-test edge cases, not for shutting up a complaint.

### Every landed rule should demonstrably fire — when feasible

A rule with a positive-case fixture is more reviewable: the fixture
proves the rule isn't dead code, and a future refactor that breaks
the rule's check will turn the fixture from "expected violation" to
"no violation", causing the unit test to fail. **A Phase-2 PR that
lands a new `PeerAuditRule` / `CrossMessageAuditRule` SHOULD land a
positive-case fixture that triggers it.** The fixture is a fake-stack
scenario (`it.effect` + `testLayers.stacks.fake`) where a non-DUT
peer deliberately emits the message the rule is meant to catch, and
the rule's finding appears in the audit output.

Typical positive-case fixtures:

- **Bob mis-stamps a header** — fixture overrides Bob's outbound
  builder to violate the MUST, asserts the rule fires.
- **Alice sends an unexpected message in a context where the MUST
  forbids it** — e.g. reliable 1xx on a re-INVITE (To-tag present).
  Asserts the rule fires against Alice's bind.
- **DUT-targeted negative case** — when the rule's subject includes
  the DUT, the fixture deliberately misconfigures a backend rule to
  produce the violation. Confirms the DUT-audit invariant.

#### When a positive fixture is impractical

A rule that does not fire on any current fixture is **still
valuable**. The check runs against every audited bind on every test,
so any future code or fixture change that introduces the violation
surfaces immediately — the rule acts as a regression harness:
silent today, vocal the moment a regression appears.

When fabricating a positive case would require more code than the
rule itself (e.g. a peer harness that exists solely to emit one
malformed message and serves no other test), it is acceptable to
ship the rule without a positive fixture. The Rule Manifest's
`notes` column records the rule as `regression-only` and explains
why a positive case was skipped. Reviewers can still request one in
PR review.

Prefer the positive-coverage shape when the fabrication is cheap
and clarifies the rule's reach. Reach for "regression-only" only
when the alternative is meaningful boilerplate.

The B2BUA-call-control rule coverage report ([docs/rule-coverage-and-killing.md](rule-coverage-and-killing.md))
is a separate mechanism for a different rule registry. The RFC
verification context uses the "prefer positive coverage, accept
regression-only when fabrication is too costly" contract above.

### The DUT-audit invariant

The DUT bind is **always** audited for the messages it sends, in light
of the messages it received. Tests cannot exempt the DUT. The audit
framework refuses to start if a declared `peerBindKey` resolves to a
DUT-role bind — if the DUT is the violator, that is a real B2BUA bug
per the triage policy above, not a candidate for suppression.

## Per-test exceptions — the central file

All per-test rule exemptions live in
[tests/harness/rules/rfc/exceptions.ts](../tests/harness/rules/rfc/exceptions.ts).
Tests do **not** declare exemptions inline.

Entry shape (see the `RfcException` type for the canonical definition):

```ts
{
  testPath: "tests/scenarios/negative/bogus-tag-mismatch.test.ts",
  ruleName: "rfc.tags",                      // or "*" — see below
  peerBindKey: "10.10.0.5:5060",             // optional; omit → applies to every non-DUT peer in this test
  justification: "Fixture deliberately reuses the To-tag across two distinct dialogs to exercise the parser's reject path; the violation is the test's expected behaviour.",
}
```

Required reading:

- **`peerBindKey` may not resolve to a DUT bind.** Layer build throws
  if it does. The DUT-audit invariant is non-negotiable.
- **`justification` is mandatory** and surfaces in the ledger; one
  sentence on what the fixture is doing and why the violation is its
  intended behaviour.
- **`ruleName: "*"`** suppresses every rule for this test. Reserved for
  end-to-end negative-case fixtures whose entire premise is malformed
  SIP. Wildcard entries still require a `justification`.
- **No exemptions for "rule X fires too often on test Y".** That is a
  triage outcome, not an exception — see the triage table above.

## Exception ledger — reading guide

The ledger renders every suppression that fired during a run. Two
sources feed it:

1. **Per-rule advisory downgrades** — `severityOverride: "advisory"` on
   the rule plus a `justification`. The advisory map for cross-message
   rules lives in [tests/harness/rules/rfc/cross-message-rules.ts](../tests/harness/rules/rfc/cross-message-rules.ts)
   (`ADVISORY_OVERRIDES`). Global across all tests.
2. **Per-test exceptions** — entries in
   [tests/harness/rules/rfc/exceptions.ts](../tests/harness/rules/rfc/exceptions.ts).
   Scoped to one `testPath`.

In the live audit output today, suppressed findings are emitted with a
`[exception: <justification>] <original detail>` prefix (see
`scopedAudit` in [src/sip/SignalingNetwork.contracts.ts](../src/sip/SignalingNetwork.contracts.ts)).
The post-run renderer that emits
`test-results/rfc-exception-ledger.md` (matrix + per-test view) is the
remaining Phase-0 deliverable not yet built — when it lands it will
also cross-check:

- **declared-but-not-fired** → warning (`stale exception`).
- **actual suppression without matching declaration** → hard failure.
- **declared entry missing `justification`** → hard failure.

Until then, the in-line `[exception: …]` markers are the visible
record. Phase 2 PRs that add exception entries should still write
real justifications — the renderer is downstream of the file.

## Helper-extraction policy

RFC rules cluster around a handful of repeating mechanics: walking a
dialog's message stream, correlating an offer with its answer,
matching a response to its originating request, tracking the route
set, parsing SDP. The Rule Manifest's `helper(s) used` column makes
this clustering visible up-front so we don't write four
near-identical loops in four rule files.

Mandatory policy:

- **Before writing a Phase-2 rule**, check
  [tests/harness/rules/rfc/_dialog-model.ts](../tests/harness/rules/rfc/_dialog-model.ts)
  and any sibling `_*.ts` for existing primitives. Reuse first.
- **When two rules in the same PR would share more than ~20 lines** of
  walking / correlation logic, extract a `_*.ts` helper in the same
  PR instead. Helpers live next to the rules; they are not promoted
  to framework status until reused by a third rule.
- **Update the Rule Manifest's `helper(s) used` column in the same PR**
  — the manifest stays accurate for the next round.

Candidate helper families identified up-front (each lands when its
first consumer rule lands in Phase 2 — names are illustrative):

- `_offer-answer.ts` — extract offer/answer pairs across
  INVITE/200/ACK, UPDATE, or PRACK exchanges. Yields a typed
  `OfferAnswerPair` consumable by every RFC 3264 rule.
- `_dialog-iteration.ts` — typed walk of one dialog's ordered message
  stream with per-step state (already partially in `_dialog-model.ts`;
  promote re-usable iteration loop here).
- `_transaction-correlation.ts` — match a response to its originating
  request via Via branch + CSeq. Used by retransmission,
  response-correlation, and PRACK rules.
- `_sdp-parsing.ts` — strict-mode SDP parsing for body-dependent rules
  (currently inlined in `_dialog-model.ts:parseSdpOrigin`).

## Pilot scope and queueing the next RFC

Phase 1 pilot: **RFC 3261** (SIP), **RFC 3262** (PRACK / 100rel),
**RFC 3264** (Offer/Answer with SDP). Chosen because the existing
rules already touch all three and the B2BUA's call-control surface is
dominated by them.

Out-of-scope at pilot time — landed after the process is proven (see
plan Phase 3 §2 for the proposed order):

- RFC 3311 (UPDATE)
- RFC 3581 (rport)
- RFC 3515 (REFER)
- RFC 4566 (SDP grammar)
- RFC 4028 (session timers)
- RFC 6086 (INFO)
- RFC 6665 (SUBSCRIBE/NOTIFY)
- RFC 3428 (MESSAGE)
- RFC 5626 (outbound)

Each follows the same five-step lifecycle: extract → triage → assign
subject → classify → implement-or-justify. New RFCs land an entry in
this doc only if the pilot lessons-learned (see below) surface a
gap the current process doesn't cover.

### Requirement level

All `MUST` / `MUST NOT` / `REQUIRED` / `SHALL` in scope. `SHOULD`s only
when (a) a rule is already shipped that asserts one, (b) an interop
bug has been attributed to one, or (c) explicitly green-lit per rule.
The grep pattern in `_raw/` deliberately does **not** include `SHOULD`
— a SHOULD inclusion is a deliberate per-rule choice, not a default.

## Lessons-learned appendix

Per-RFC sections are appended once that RFC's last `will-implement`
row flips to `already-implemented`. A cross-RFC consolidation
("Cross-RFC consolidation (Phase 3)") follows the per-RFC sections
and feeds back into the process doc above. See plan §"Phase 3" for
the gating criteria.

Topics covered:

- Which MUST shapes were unexpectedly hostile to rule formulation.
- Which fixture rewrites were forced (and why).
- Which architectural guarantees absorbed entire sections.
- Which audit-framework limitations need addressing before the next
  RFC queues.
- Recurring rule-design footguns to avoid at authoring time.

### RFC 3261

24 rules landed (2 peer pre-pilot + 3 peer + 19 cross-message in
Phase 2). 4 shipped advisory. Inventory state at Phase-2 close:
0 `will-implement` rows remain.

**Hostile MUST shapes.** Three patterns surfaced that the process
doc's taxonomy didn't anticipate:

- **"The agent recognised X"** — `RFC3261-MUST-071` (§12.2.2 unknown
  dialog → 481) asserts an agent-internal state ("dialog known to
  me"), not anything in the wire trace. The shipped rule
  `rfc.unknownDialog481` is narrowed to the `slice.toTag === null`
  window, which makes it a projector-invariant tripwire rather than
  a real coverage check. *Process implication*: MUSTs that assert
  agent-internal recognition without a corresponding observable
  side-effect should classify as `unobservable-post-hoc`, not
  `will-implement`. Add at inventory time.
- **Timing-bounded MUSTs without `atMs`** — `RFC3261-MUST-095`
  (§16.2 proxy 100 Trying within 200ms) is unprovable from the
  current per-slot stream. The projector has `OrderedEntry.atMs`
  but `OrderedAgentEvent` (what rules see) does not.
  `rfc.proxy100WithinT100ms` ships advisory with the timing
  dimension dropped. *Process implication*: timing bounds in MUST
  text need an explicit decision at inventory time —
  enforceable (if `atMs` is plumbed), advisory-only (structural
  check minus the bound), or `unobservable-post-hoc`.
- **Parser-pre-empted MUSTs** — `RFC3261-MUST-045` (§9.1 CANCEL
  CSeq method must equal "CANCEL") is rejected by the strict
  parser at [src/sip/parsers/extract-fields.ts:530](../src/sip/parsers/extract-fields.ts#L530)
  before any rule sees the message. `rfc.cancelCseqMethod` ships as
  defense-in-depth for non-parser SipMessage construction paths,
  but the inventory row could have classified as `parser-enforced`
  instead. *Process implication*: the inventory taxonomy needs a
  sweep — some `already-implemented` MUSTs are actually
  `parser-enforced` riding along with zero coverage delta.

**Advisory drift.** Four rules shipped advisory because the B2BUA
worker's leg-rewriting + backend-driven response semantics confuse
a pure-UA heuristic. See justifications inline in
[tests/harness/rules/rfc/rfc3261-cross-message-rules.ts:1509](../tests/harness/rules/rfc/rfc3261-cross-message-rules.ts#L1509)
(`RFC3261_ADVISORY_OVERRIDES`): `rfc.optionsResponseEchoes`,
`rfc.cancelAfter1xx`, `rfc.noTarget404`, `rfc.proxy100WithinT100ms`.

**Forced fixture rewrite.** One: a stray decorative `tag=bob-tag`
on an outbound initial INVITE/BYE in
[tests/sip/transaction-layer-handles.test.ts](../tests/sip/transaction-layer-handles.test.ts)
flagged by `rfc.noToTagOnInitialRequest`. Fixed in the same PR
per the triage policy; the BYE side re-stamped once the rule was
narrowed to dialog-initiating methods only.

**Rule rewrites before landing.** Two rules — `rfc.unknownDialog481`
and `rfc.noByeOutsideOrEarlyDialog` — were rewritten to consume
`slice.{callId, fromTag, toTag}` directly instead of re-deriving
dialog identity inside the rule. Two more —
`rfc.noReInviteWhileInviteInProgress` and
`rfc.concurrentReInvite500or491` — were made retransmit-aware
(skip when a new INVITE's Via top-branch matches a known
in-progress branch, per RFC 3261 §17.1.1).

### RFC 3262

15 rules landed (1 peer + 14 cross-message). 3 shipped advisory.
Inventory state at close: 0 `will-implement` rows remain.

**Architectural absorbent: PRACK terminated per leg.** The B2BUA
worker terminates PRACK on each leg, so the reliable 1xx and its
matching PRACK live in *different* per-Call-ID slices after Call-ID
rewrite. Three rules trip on that legitimately:
`rfc.reliableNeedsClientOptIn`, `rfc.unmatchedPrackProxied`,
`rfc.prackOfferAnswerModel`. Justifications inline in
[tests/harness/rules/rfc/rfc3262-cross-message-rules.ts:1353](../tests/harness/rules/rfc/rfc3262-cross-message-rules.ts#L1353)
(`RFC3262_ADVISORY_OVERRIDES`).

**Helper extraction validated.** `rfc.prackOfferAnswerModel` was
the first cross-message rule that wanted SDP-body parsing; the
helper was *not* extracted in this batch (inline body-presence
heuristic, with the helper deferred to the RFC 3264 batch's
volume). Confirmed the manifest's "materialise on second consumer"
rule: extracting prematurely for one consumer would have been
churn.

### RFC 3264

11 rules landed (2 peer + 9 cross-message). 3 shipped advisory.
Inventory state at close: 0 `will-implement` rows remain. New
helper [tests/harness/rules/rfc/_offer-answer.ts](../tests/harness/rules/rfc/_offer-answer.ts)
shipped with 9 consumers.

**Architectural absorbent: cross-leg O/A correlation.** Three
rules ship advisory because per-slice tracking cannot see the
other leg's offer or answer after Call-ID rewrite:
`rfc.noNewOfferWhileOfferPending`, `rfc.directionPairValid`,
`rfc.zeroPortPropagation`. The third is also confounded by B2BUA
media anchoring (peer-side `port=0` becomes B2BUA-side anchored
RTP port). Justifications inline in
[tests/harness/rules/rfc/rfc3264-cross-message-rules.ts:623](../tests/harness/rules/rfc/rfc3264-cross-message-rules.ts#L623)
(`RFC3264_ADVISORY_OVERRIDES`).

**Content-Type gating discovered.** `rfc.sdpBodyParseable`
initially fired on every body. B2BUA emits non-SDP bodies (e.g.
`text/plain` INFO), so the rule was gated on
`Content-Type: application/sdp`. *Process implication*: any
body-shape MUST needs an explicit Content-Type gate at inventory
time — otherwise the rule is structurally wrong, not just noisy.

### Cross-RFC consolidation (Phase 3)

Five patterns cut across all three pilot RFCs. They feed back into
the process doc (above) and into Phase-3 follow-up work.

**1. Trust the projector — don't re-derive dialog identity.**
`tests/harness/projections.ts:projectPerDialog` partitions per
`(bindKey, callId, fromTag, toTag|null)`. Each `PerDialogSlice`
**is** a single dialog. Rules consume `slice.perAgent[].events`,
already scoped to that dialog. **The single biggest false-positive
source this pilot was redundant in-rule dialog tracking** — three
rules had to be rewritten or shipped advisory because of it. When
authoring a new rule, the first question is "does the projector
already answer this?" before any per-rule state.

**2. Architectural absorbents predict the advisory rate.** Ten
rules shipped advisory across the pilot — concentrated on three
B2BUA traits: leg-rewriting (different Call-ID per leg), PRACK
termination, and media anchoring. The pattern is consistent enough
to motivate a `subject: peerOnly` narrowing primitive — a rule
opts out of DUT audit while still auditing non-DUT peers. This
would lift many of today's advisories back to deferred-fail. It
needs a fresh ADR / precursor plan, not a mechanical Phase-3 fix.
The per-rule justifications in the three `*_ADVISORY_OVERRIDES`
maps each describe the specific B2BUA pattern that confuses the
heuristic — read them when scoping the architectural fix.

**3. Recurring rule-design footguns.** Document these so the next
round of rules avoids them at authoring time:

- **Re-deriving dialog identity** — see (1). Always prefer
  `slice.{callId, fromTag, toTag}` over in-slot tracking.
- **Treating INVITE retransmits as new transactions** — per
  RFC 3261 §17.1.1, INVITE retransmits reuse the Via top-branch.
  Rules tracking "in-progress branches" must skip same-branch
  re-entry. Two pilot rules had this bug
  (`rfc.noReInviteWhileInviteInProgress`,
  `rfc.concurrentReInvite500or491`).
- **Firing on non-dialog-initiating methods for "no To-tag on
  initial"** — `rfc.noToTagOnInitialRequest` initially fired on
  any first-event-per-Call-ID. BYE/ACK/UPDATE/INFO/PRACK/CANCEL
  are intrinsically in-dialog; firing on them is a fixture
  artifact. Narrowed to {INVITE, REGISTER, SUBSCRIBE, OPTIONS,
  REFER, MESSAGE, PUBLISH, NOTIFY}.
- **Not gating on Content-Type for SDP body rules** — see
  RFC 3264 above.

**4. Helper extraction policy validated.** Two helpers crossed
the policy's "materialise on second consumer" threshold cleanly
without speculation:

- [_transaction-correlation.ts](../tests/harness/rules/rfc/_transaction-correlation.ts)
  — first consumer `rfc.ackRequireSubsetOfInvite`; ended the
  pilot with 8 consumers.
- [_offer-answer.ts](../tests/harness/rules/rfc/_offer-answer.ts)
  — first consumer `rfc.noNewOfferWhileOfferPending`; ended with
  9 consumers.

`_sdp-parsing.ts` was on the candidate list but correctly **not**
extracted — rtpmap parsing folded into `_offer-answer.ts` (single
consumer). The candidate list was pruned. *Process implication*:
the "materialise on second consumer" rule held up; reviewers
should reject speculative helpers, not pre-empt them.

**5. Inventory taxonomy needs a sweep.** Three borderline
classifications surfaced this pilot:

- `parser-enforced` vs `already-implemented` — see RFC 3261
  M-045.
- `unobservable-post-hoc` for agent-internal-state MUSTs — see
  RFC 3261 M-071.
- timing-bounded MUSTs without `atMs` — see RFC 3261 M-095.

Next-RFC inventories should either tighten the taxonomy
(introduce explicit sub-cases for these) or treat them as known
edge cases when triaging. The process doc's "When in doubt,
prefer `will-implement`" guidance held — every borderline rule
shipped, even if advisory.

**6. Phase-3.5 candidates not landed in Phase 3.** Two items
identified but explicitly deferred:

- **`subject: peerOnly` narrowing primitive** — touches
  `SignalingNetwork.contracts.ts`, lifts ~10 advisory rules. New
  ADR + precursor plan. Frame as a precursor to the next big
  RFC batch rather than a Phase-3 sub-task.
- **`atMs` on `OrderedAgentEvent`** — would let timing-bounded
  MUSTs (M-095 and likely many in RFC 4028 session timers)
  ship as `deferred-fail` instead of advisory. Smaller change;
  same precursor-plan shape.
