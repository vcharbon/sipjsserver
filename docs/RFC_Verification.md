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

### Every landed rule must demonstrably fire

A rule that never fires is indistinguishable from no rule at all. **A
Phase-2 PR that lands a new `PeerAuditRule` / `CrossMessageAuditRule`
MUST also land a positive-case fixture that triggers it.** The fixture
is a fake-stack scenario (`it.effect` + `testLayers.stacks.fake`)
where a non-DUT peer deliberately emits the message the rule is meant
to catch, and the rule's finding appears in the audit output. The
fixture demonstrates the rule's "kill" coverage — if a future
refactor breaks the rule's check, this fixture's expected violation
disappears, and the test fails.

Typical positive-case fixtures:

- **Bob mis-stamps a header** — fixture overrides Bob's outbound
  builder to violate the MUST, asserts the rule fires.
- **Alice sends an unexpected message in a context where the MUST
  forbids it** — e.g. reliable 1xx on a re-INVITE (To-tag present).
  Asserts the rule fires against Alice's bind.
- **DUT-targeted negative case** — when the rule's subject includes
  the DUT, the fixture deliberately misconfigures a backend rule to
  produce the violation. Confirms the DUT-audit invariant.

Without this fixture the rule is dead code. The Rule Manifest's
`notes` column carries a pointer at the fixture path so reviewers can
trace each rule to its evidence-of-life.

The B2BUA-call-control rule coverage report ([docs/rule-coverage-and-killing.md](rule-coverage-and-killing.md))
is a separate mechanism for a different rule registry. The RFC
verification context uses the simpler "every rule needs a positive
fixture" contract above.

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

Empty at Phase 1 land. Phase 2 PRs append a section per RFC after that
RFC's last `will-implement` row flips to `already-implemented`. Likely
topics:

- Which MUST shapes were unexpectedly hostile to rule formulation.
- Which fixture rewrites were forced (and why).
- Which architectural guarantees absorbed entire sections.
- Which audit-framework limitations need addressing before the next
  RFC queues.

Phase 3 then writes the cross-RFC consolidation and queues the next
batch. See plan §"Phase 3" for the gating criteria.

### RFC 3261 — _(empty until Phase 2 completes)_

### RFC 3262 — _(empty until Phase 2 completes)_

### RFC 3264 — _(empty until Phase 2 completes)_
