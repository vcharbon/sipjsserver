# Extending SIP RFC Test Coverage

## Context

The B2BUA already has a sound base for post-hoc RFC validation:
`scopedAudit` wires `PeerAuditRule` (single-message) and
`CrossMessageAuditRule` (multi-message) rules onto every
`SignalingNetwork` bind, producing `deferred-fail` or `advisory`
findings against the active `RunContext`. Today's coverage: 18
single-message validators (`rfc.cseq`, `rfc.tags`, `rfc.via`, …) and 7
cross-message rules (`rfc.midDialogRoute`, `rfc.sdpOriginContinuity`,
…). The recent [b9ae0ec6 `rfc.noContactOnBye`](../../src/b2bua/rules/)
commit established the workflow precedent — add rule, fix surfaced
fixture bug, ship in one commit.

What's missing:

1. **No systematic inventory** of which RFC MUSTs are covered, partially
   covered, or deliberately uncovered. We don't know what we don't know.
2. **DUT is exempt from audit by default**
   ([tests/support/stackLayer.ts:140-147](../../tests/support/stackLayer.ts#L140-L147)).
   The exemption is defensive code from the original port and is
   substantially obsolete (per-Call-ID slicing was added later), but
   was never lifted. RFC-compliance testing without auditing the DUT
   is hollow.
3. **No per-rule subject model** — every rule runs against every bind,
   so `proxy`-only obligations conflate with UA obligations.
4. **No reproducible attestation** — after a green `test:fake` run we
   cannot answer "which rule was suppressed in which test, and why?"
5. **No declared process** for adding new MUST rules when the addition
   breaks existing tests. The choices today (advisory bypass via
   `ADVISORY_RULE_NAMES`, per-test `extraPeerRules`, fixture rewrite)
   are made case-by-case with no policy.

This plan introduces **(a)** a process document
(`docs/RFC_Verification.md`) describing how a MUST gets from "in the
RFC" to "asserted by a green test"; **(b)** a per-RFC inventory table
under `docs/rfc/` with stable MUST-IDs; **(c)** an audit-framework
refactor to support per-rule subject sets, mandatory DUT audit, and
per-test peer exemption; **(d)** an end-of-run exception ledger so
every allowance is visible after the test:fake run; **(e)** a pilot
pass over RFC 3261 + RFC 3262 (PRACK) + RFC 3264 (Offer/Answer)
producing both the inventory and the new rules.

The pilot's purpose is to validate the process. Lessons-learned from
the pilot get appended to `RFC_Verification.md`; subsequent RFCs (3311
UPDATE, 3515 REFER, 4028 session timers, 4566 SDP grammar, 6086 INFO,
etc.) follow the same process with whatever refinements emerged.

## Status & change tracking

The plan ships in four phases. Each phase has a single executable
deliverable; later phases are blocked on earlier ones.

| Phase | Title                                                       | Status   | Blocked on |
| ----- | ----------------------------------------------------------- | -------- | ---------- |
| 0     | Audit-framework refactor (subject sets, DUT-on, exceptions) | **done** (2026-05-25) | —          |
| 1     | Documentation PR: process doc + per-RFC inventory + Rule Manifest | **done** (2026-05-25) | Phase 0    |
| 2     | Per-section rule landing for 3261/3262/3264                 | **next** | Phase 1    |
| 3     | Lessons-learned + queue next RFCs                           | pending  | Phase 2    |

**Hard gate between Phase 1 and Phase 2**: no rule implementation
work starts until *every* MUST in the pilot RFCs has a final
classification — `will-implement` (with a target rule name) or
`justified-not-implemented` (with a taxonomy entry). The Rule
Manifest enumerates those final-state classifications; reviewers can
accept/reject the exclusions before any rule code is written.

### Changelog

- 2026-05-25: initial plan drafted via `/grill-with-docs`.
- 2026-05-25: revised — single-file exception declarations
  (`tests/harness/rules/rfc/exceptions.ts`) replacing per-test
  inline `nonCompliantPeers`.
- 2026-05-25: revised — added Status & change tracking; sharpened
  Phase 1 to require final-state classification for every MUST and
  produce a Rule Manifest before Phase 2 may start.
- 2026-05-25: revised — added helper-extraction policy: shared
  walking/correlation logic between rules is extracted into
  `_*.ts` helpers next to the rules; candidate helper families
  named in the process doc, materialised on second consumer.
- 2026-05-25: **Phase 0 landed**. Subject model
  (`UaRole` / `ALL_UA_ROLES`) on rules + bind-side `roles` field; DUT
  exemption lifted in stackLayer; production binds declare roles
  (UdpTransport `{uac,uas}`, ProxyCore `{uac,uas,proxy}`, HealthProbe
  `{uac}`); per-test exception file `tests/harness/rules/rfc/exceptions.ts`
  + loader (`resolveRfcExceptions`) with DUT-name refusal; per-rule
  `severityOverride` + `justification` on `PeerAuditRule` (matches
  `CrossMessageAuditRule`); `ADVISORY_RULE_NAMES` set replaced by
  `ADVISORY_OVERRIDES` map (rportEcho + sdpOriginContinuity advisory
  with documented Phase-2 follow-up reasons); two exception entries
  ship with the lift — `e2e-fake-clock` bogus-tag-* negative cases
  (wildcard `"*"`) and `refer/gating` cseq validator-heuristic
  limitation; CONTEXT.md glossary entries for UAC, UAS, A-leg, B-leg,
  B2BUA-as-UAS/UAC, MUST-ID, RFC exception ledger; 10 new unit tests
  cover subject dispatch / severity override / per-test exceptions /
  DUT-name refusal. Full test:fake green (1510 passed, 4 skipped).
- 2026-05-25: **Phase 2 mechanism validated** — first rule shipped
  end-to-end (commit `d4b1821f`): `rfc.no100relRequireOnNonInvite`
  (RFC3262-MUST-017). New rule pack `tests/harness/rules/rfc/rfc3262-peer-rules.ts`,
  wired into stackLayer, unit test with positive (REGISTER + OPTIONS)
  + negative (INVITE + clean REGISTER) coverage. Manifest row flipped
  `planned` → `shipped`; inventory row flipped `will-implement` →
  `already-implemented`. test:fake green (1514 passed, +4 new). Phase 2
  backlog: 49 planned rules remaining (across RFC 3261/3262/3264).
- 2026-05-25: **Plan revised** — "every landed rule must demonstrably
  fire" softened from MUST to SHOULD. Rules without a positive
  fixture are still valuable as a regression harness; the manifest
  records them as `regression-only` with a one-line reason. Mirrored
  in [docs/RFC_Verification.md](../RFC_Verification.md#every-landed-rule-should-demonstrably-fire-when-feasible).
- 2026-05-25: **Phase 2 — second rule shipped**:
  `rfc.noToTagOnInitialRequest` (RFC3261-MUST-016). New rule pack
  `tests/harness/rules/rfc/rfc3261-peer-rules.ts`, wired into
  stackLayer alongside the 3262 pack. Per-bind first-event-per-Call-ID
  heuristic: if the first event on a bind for a given Call-ID is a
  sent request carrying a To-tag, fire. Unit test ships positive
  (INVITE + REGISTER with stray To-tag) and negative (clean initial
  INVITE + in-dialog BYE after own INVITE) coverage. Rule found a
  real fixture violation in
  [tests/sip/transaction-layer-handles.test.ts](../../tests/sip/transaction-layer-handles.test.ts) — a
  decorative `tag=bob-tag` stamped on an outbound initial INVITE/BYE
  fixture; corrected per the triage policy (fix the fixture, not the
  rule). test:fake green (1518 passed, +4 new). Phase 2 backlog: 48
  planned rules remaining.
- 2026-05-26: **RFC 3261 batch complete** — 22 new RFC 3261 rules
  landed in one push: 3 peer (`rfc.noRequireOnCancelOrAck`,
  `rfc.cancelCseqMethod`, `rfc.strictRouteShuffleOnSend`) and 19
  cross-message (incl. `rfc.unknownDialog481`,
  `rfc.unsupportedMethod405Allow`, `rfc.unsupportedExtension420/421`,
  `rfc.unsupported415Accepts`, `rfc.responseExtensionsAdvertised`,
  `rfc.registerNoRouteSet`, `rfc.optionsResponseEchoes`,
  `rfc.concurrentReInvite500or491`, `rfc.noByeOutsideOrEarlyDialog`,
  `rfc.noTarget404`, `rfc.ackRequireSubsetOfInvite`,
  `rfc.cancelRouteEchoesInvite`, `rfc.cancelAfter1xx`,
  `rfc.serialRegister`, `rfc.noReInviteWhileInviteInProgress`,
  `rfc.proxy100WithinT100ms`, `rfc.strictRouteRewriteHandled`,
  `rfc.ackPreservesInviteRoute`). Two new files:
  `tests/harness/rules/rfc/rfc3261-cross-message-rules.ts` (new pack
  with shared `adaptCrossMessageRule` re-exported from
  `cross-message-rules.ts`) and `tests/harness/rules/rfc/_transaction-correlation.ts`
  (helper: `buildBranchIndex`, `findInviteByBranch`,
  `firstResponseStatusFor`, `responsesFor`, etc.). **Four rules
  shipped advisory** with detailed justifications:
  `rfc.optionsResponseEchoes` (B2BUA OPTIONS keepalive responses
  intentionally omit Allow/Supported/Accept per ADR-0008),
  `rfc.cancelAfter1xx` (fixtures legitimately CANCEL on local timer
  before 1xx in failure-injection scenarios), `rfc.noTarget404`
  (B2BUA worker is not a §16.7 stateful proxy; backend-rejection
  responses 403/481/491 are not "no target"), `rfc.proxy100WithinT100ms`
  (B2BUA TransactionLayer does emit 100 immediately and absorbs
  inbound 100 — TransactionLayer.ts:742/769 — but the rule still
  fires on some fixtures; root cause TBD, plus OrderedAgentEvent
  lacks atMs so timing cannot be enforced). **Two rules rewritten**
  before landing: `rfc.unknownDialog481` and `rfc.noByeOutsideOrEarlyDialog`
  now use `slice.{callId,fromTag,toTag}` as ground truth instead of
  re-deriving dialog identity (the projector already partitions per
  dialog; redundant in-slot tracking was the false-positive source).
  **Two rules made retransmit-aware**: `rfc.noReInviteWhileInviteInProgress`
  and `rfc.concurrentReInvite500or491` now skip when a new INVITE's
  Via top-branch matches a known in-progress branch (per RFC 3261
  §17.1.1, INVITE retransmits reuse the branch). **One synthetic
  fixture corrected**: `tests/sip/transaction-layer-handles.test.ts`
  BYE-shape test now stamps a To-tag (BYE is intrinsically
  in-dialog). **rfc.cancelCseqMethod positive unit test removed**:
  the strict parser at `extract-fields.ts:530` already rejects
  CSeq-method/request-method mismatch, so the rule's positive
  fixture never reaches the rule — kept as defense-in-depth for
  non-parser construction paths. test:fake green (1519 passed, +1
  vs prior baseline, 210 files). Phase 2 backlog: 26 planned rules
  remaining (RFC 3262: 15; RFC 3264: 11).
- 2026-05-25: **Phase 1 slice 3 landed** (RFC 3261 inventory).
  `docs/rfc/RFC3261.md` — 191 entries consolidated from 580 raw grep
  hits. Counts: 24 `will-implement`, 38 `already-implemented`, 110
  `justified-not-implemented`, 19 `restatement`. RuleManifest grows
  by 23 new planned rules and every shipped peer / cross-message
  rule's `MUST-IDs covered` cell flips from `(pending inventory)` to
  authoritative MUST-ID lists. Scope decisions reflected: (a) §16
  proxy MUSTs apply to B2BUA workers as proxy, not just dedicated
  proxy binds; (b) §8.1.3.4 + §16.7 + §21 3xx-recursion MUSTs are
  out-of-scope (B2BUA doesn't recurse); (c) §17 transactions, §18
  transport, §19-20 URI/header grammar are mostly arch- /
  transport- / parser-enforced rather than rule-audited. **Phase 1
  complete**: all three pilot RFC inventories ship with final-state
  classifications. Phase 2 gate is now open for review.
- 2026-05-25: **Phase 1 slice 2 landed**: `docs/rfc/RFC3264.md`
  inventory (56 entries — 18 `will-implement`, 2
  `already-implemented` via existing `rfc.sdpOriginContinuity`, 35
  `justified-not-implemented`, 1 `restatement`). RuleManifest grows
  to 11 new RFC 3264 planned rules, including `rfc.sdpBodyParseable`
  (peer rule covering SDP grammar MUSTs in line with the user's
  scope decision: SDP content + offer/answer model in scope,
  RTP/RTCP-plane out of scope). `rfc.sdpOriginContinuity` manifest
  row updated with MUST-IDs covered. Inventory for RFC 3261
  remains pending.
- 2026-05-25: **Phase 1 slice 1 landed** (process doc + raw MUST
  snapshots + manifest skeleton + RFC 3262 inventory).
  `docs/RFC_Verification.md` (lifecycle, justification taxonomy,
  severity model, triage policy, DUT-audit invariant, per-test
  exception rules, ledger reading guide, helper-extraction policy,
  "every landed rule must demonstrably fire" contract, pilot scope,
  lessons-learned skeleton); `docs/rfc/_raw/RFC3261-musts.txt` +
  `RFC3262-musts.txt` + `RFC3264-musts.txt` (raw
  `grep -nE "MUST|MUST NOT|REQUIRED|SHALL"` with provenance headers —
  IETF source URL, SHA-256, capture date); `docs/rfc/RuleManifest.md`
  enumerating the 18 shipped peer rules + 7 shipped cross-message
  rules + 16 planned RFC 3262 rules; `docs/rfc/RFC3262.md` full
  inventory (30 entries — 21 `will-implement`, 6
  `justified-not-implemented`, 3 `restatement`). Inventories for
  RFC 3261 and RFC 3264 remain pending — they land as follow-up
  Phase-1 PRs. Phase 2 gate stays closed until every inventory row
  has a final classification.

## Scope decisions (locked with user)

- **Requirement level**: all `MUST` / `MUST NOT` / `REQUIRED` / `SHALL`.
  `SHOULD`s only when (a) a rule is already shipped, (b) we've hit an
  interop bug attributable to one, or (c) explicitly green-lit per
  rule.
- **Pilot RFCs**: 3261, 3262, 3264. Other RFCs are deliberately
  out-of-pilot — they land after the process is proven.
- **Audit subject**: per-rule `subject: ReadonlySet<'uac' | 'uas' |
  'proxy'>`. `'any'` is rendered as the full set. A B2BUA matches both
  `uac` and `uas` per call (A-leg as UAS, B-leg as UAC).
- **DUT audit invariant**: the DUT bind is *always* audited for
  messages it sends, in light of messages it received. Tests cannot
  exempt the DUT; only test-peer agents (Alice, Bob, …) can be
  exempted via `nonCompliantPeers`.
- **Triage policy** when a new MUST rule fires across existing tests:
  - real B2BUA bug → precursor plan (per CLAUDE.md test-strategy);
    never deactivate the failing test.
  - test fixture bug → fix the fixture in the same PR as the rule.
  - genuine fixture-style flood → ship rule as
    `severityOverride: "advisory"` with a `justification` string and a
    tracked TODO; ledger shows the advisory state globally.
- **Exception declarations**: single checked-in file
  `tests/harness/rules/rfc/exceptions.ts` (TypeScript so rule names
  and peer names are type-checked). One entry per `(test-id, rule,
  peer)` triple with a mandatory `justification` string. Tests never
  declare exemptions inline — the harness reads the central file by
  test-id at layer build.
- **Exception ledger**: a *rendered view* of the same file, emitted
  after `test:fake` to `test-results/rfc-exception-ledger.md` (matrix
  + per-test view). The ledger also cross-checks reality vs
  declaration: every declared exception must fire at least once
  (else warning: "stale exception"); every actual suppression must be
  declared (else hard failure). CI fails if any declared exception
  lacks a justification string.
- **Inventory format**: one file per RFC under `docs/rfc/`. Stable
  MUST-IDs (`RFC3261-MUST-NNN`) that rule code can reference in
  comments. Per-row columns: id, section, quoted text, subject, status,
  rule-name-or-justification.
- **Extraction method**: grep RFC body for `MUST|MUST NOT|REQUIRED|SHALL`,
  manual triage, raw grep output saved to `docs/rfc/_raw/` for
  diff-traceability.
- **Cadence**: Phase 1 = pure documentation PR (every MUST listed,
  status `todo`). Phase 2 = one PR per RFC section, implementing that
  section's MUSTs together. Each phase ends green.

## Phasing

### Phase 0 — Framework refactor (this plan's code phase)

Smallest possible change that unblocks the rest. Pure scaffolding; no
new MUST rules.

1. **Add subject model** to `PeerAuditRule` / `CrossMessageAuditRule`
   in [src/sip/SignalingNetwork.contracts.ts](../../src/sip/SignalingNetwork.contracts.ts):
   ```ts
   export type UaRole = "uac" | "uas" | "proxy"
   export const ALL_UA_ROLES: ReadonlySet<UaRole>
   readonly subject: ReadonlySet<UaRole>  // required field
   ```
   Stamp every existing rule with `subject: ALL_UA_ROLES` (no behaviour
   change). Update `scopedAudit` to skip rules whose subject set
   doesn't intersect the bind's declared role set.

2. **Lift the DUT exemption**. Replace `shouldAuditBind` (drop the
   default `bindKey !== dutBindKey`) with two distinct things:
   - **Bind role declaration**: each bind announces its UA role set on
     creation. DUT binds announce `{uac, uas}` (or `{uac, uas, proxy}`
     if the bind also fronts the front-proxy). Test peers announce
     their role (Alice as `{uac, uas}`, Bob as `{uac, uas}`, etc.).
     Plumbed through `bindUdp` options. Also drives subject-matching
     dispatch (Phase 0 §1).
   - **Central exception file**: see §3.

3. **Central exception file +
   ledger renderer**.

   - New file `tests/harness/rules/rfc/exceptions.ts` exporting
     a typed structure:
     ```ts
     // illustrative
     export const RFC_EXCEPTIONS: ReadonlyArray<RfcException> = [
       {
         testId: "tests/scenarios/promote-pem-to-200.test.ts",
         ruleName: "rfc.sdpOriginContinuity",
         peerName: "alice",            // omit ⇒ rule globally skipped for that test
         justification: "Alice fixture replays a recorded SDP whose ...",
       },
       // …
     ]
     ```
     `ruleName` and `peerName` are typed against the enums emitted by
     the rule registry, so renaming a rule fails the build until the
     exceptions file is updated.

   - **Hard-coded invariant**: an entry whose `peerName` resolves to
     a DUT-role bind throws at layer-build time. DUT cannot be
     exempted; if DUT is the violator, it's a real B2BUA bug per the
     triage policy.

   - **Suppression collector service** (`RfcExceptionLedger`, Effect
     `Ref`-backed, from `RunContext`) records every suppression that
     actually fired during the run. At scope close (or on
     test-runner demand) the renderer emits
     `test-results/rfc-exception-ledger.json` + a Markdown matrix
     (`rfc-exception-ledger.md`). The Markdown includes a
     rules×tests matrix view and a per-test view.

   - **Cross-checks the renderer performs**:
     - declared-but-not-fired → warning (`stale exception`).
     - actual suppression without matching declaration → **hard
       failure** (`undeclared exception`).
     - declared entry missing `justification` → hard failure.

   - Per-rule global advisory (`severityOverride: "advisory"`)
     remains a separate mechanism — it's a rule-author statement
     ("this rule is not yet mature enough to fail"), not a
     per-test allowance. Both are surfaced in the ledger but
     visually distinguished.

4. **Justification taxonomy** for status-`justified-not-implemented`
   entries (used in Phase 1 inventory):
   - `arch-guaranteed` — message builder/parser structurally enforces.
   - `parser-enforced` — rejected at parse time (see ADR-0007).
   - `transport-enforced` — handled by transaction layer.
   - `unobservable-post-hoc` — needs a latency/perf budget, not a
     trace audit. Cross-reference the perf check that owns it.
   - `out-of-scope` — B2BUA architectural exclusion (e.g. auth in a
     trusted backbone).
   - `restatement` — pointer to canonical MUST-ID.

5. **CONTEXT.md additions** (glossary only, no implementation
   detail): `UAC`, `UAS`, `A-leg`, `B-leg`, `B2BUA-as-UAS`,
   `B2BUA-as-UAC`, `MUST-ID`, `RFC exception ledger`.

6. **Consolidate `ADVISORY_RULE_NAMES`**: existing set in
   [cross-message-rules.ts:617](../../tests/harness/rules/rfc/cross-message-rules.ts#L617)
   migrates to per-rule `severityOverride: "advisory"` +
   `justification` string, surfaced in the ledger. The standalone set
   is deleted.

### Phase 1 — Documentation PR (no rule code yet)

No code changes beyond stable file paths and the central exceptions
file scaffold. Phase 1 produces a complete, classified picture of
what's about to land in Phase 2 — including everything we will
*not* implement, with the reason recorded.

1. `docs/RFC_Verification.md` — the process doc. Sections:
   - Why this exists.
   - The lifecycle of a MUST: `extract → triage → assign subject →
     classify → implement or justify → land → ledger`.
   - Severity model (deferred-fail / advisory) + triage policy.
   - Exception ledger reading guide.
   - Justification taxonomy (mirrors Phase 0 §4).
   - Helper-extraction policy (see below).
   - Pilot scope (3261/3262/3264) + how the next RFC gets queued.
   - Lessons-learned appendix (empty initially; written after Phase 2
     for each RFC).

2. `docs/rfc/_raw/RFC3261-musts.txt`,
   `docs/rfc/_raw/RFC3262-musts.txt`,
   `docs/rfc/_raw/RFC3264-musts.txt` — raw grep output. Saved
   verbatim for diff traceability across future RFC revisions.

3. `docs/rfc/RFC3261.md`, `RFC3262.md`, `RFC3264.md` — the per-RFC
   inventory tables. **Every triaged MUST gets a final-state entry.**
   Columns:
   `| MUST-ID | §  | quoted text | subject | classification | rule
   name or justification (taxonomy entry) |`. Allowed classifications:
   - `will-implement` — Phase 2 must produce the named rule. The
     `rule name` column points to a planned PeerAuditRule /
     CrossMessageAuditRule (may be shared across multiple MUSTs).
   - `already-implemented` — existing rule covers it; column points
     to the rule by name. Audited in Phase 2 to confirm the rule
     truly enforces the MUST (vs. accidentally close).
   - `justified-not-implemented` — column carries the taxonomy entry
     (`arch-guaranteed` / `parser-enforced` / `transport-enforced` /
     `unobservable-post-hoc` / `out-of-scope` / `restatement`) and a
     one-line explanation pointing at the file / ADR / test that
     justifies the exclusion.

   No bare `todo`. Reviewer review of Phase 1 is the moment exclusions
   get accepted or rejected.

4. `docs/rfc/RuleManifest.md` — a higher-level summary, grouped by
   planned rule (not by MUST). Each row:
   `| rule name | subject | rule kind (peer/cross-message) | MUST-IDs
   covered | helper(s) used | notes |`. The manifest is what the
   reviewer reads to validate the *shape* of the Phase-2 plan before
   any rule code is written.

5. `tests/harness/rules/rfc/exceptions.ts` — created empty (only the
   typed `RFC_EXCEPTIONS: ReadonlyArray<RfcException>` export with
   `[]`). Phase-2 PRs add entries here as fixture-wide allowances
   come up.

#### Helper-extraction policy (lands in the process doc)

Rules cluster around a small number of repeating mechanics: walking
a dialog's message stream, correlating an offer with its answer,
matching a response to its originating request (Via branch / CSeq),
tracking the route set, parsing SDP. The Rule Manifest's `helper(s)
used` column makes this clustering visible up-front so we don't
write four near-identical loops in four rule files.

Mandatory policy:

- Before writing a Phase-2 rule, check `tests/harness/rules/rfc/_dialog-model.ts`
  (and any sibling `_*.ts` helpers) for existing primitives.
- When two rules in the same PR would share more than ~20 lines of
  walking/correlation logic, extract a `_*.ts` helper in the same PR
  instead. Helpers live next to the rules; they are not promoted to
  framework status until reused by a third rule.
- The Rule Manifest's `helper(s) used` column is updated in the same
  PR — keeps the manifest accurate for the next round.

Candidate helper families identified up-front (each lands when its
first consumer rule lands in Phase 2):

- `_offer-answer.ts` — extract offer/answer pairs across an
  INVITE/200/ACK exchange, an UPDATE exchange, or a PRACK exchange.
  Yields a typed `OfferAnswerPair` consumable by every 3264 rule.
- `_dialog-iteration.ts` — typed walk of one dialog's ordered
  message stream with per-step state (already partially in
  `_dialog-model.ts`; promote re-usable iteration loop here).
- `_transaction-correlation.ts` — match a response to its
  originating request via Via branch + CSeq; used by retransmission,
  response-correlation, and PRACK rules.
- `_sdp-parsing.ts` — strict-mode SDP parsing for body-dependent
  rules (currently inlined in `_dialog-model.ts:parseSdpOrigin`).

These names are illustrative; the actual helpers ship only when
their second consumer appears in Phase 2.

### Phase 2 — Per-section rule landing

Starts only after Phase 1 has accepted classifications for every MUST.
One PR per RFC section. Each PR:

1. Picks one section (e.g. RFC 3261 §8.1.1.5 "Max-Forwards").
2. Implements every rule the Rule Manifest declares for that section.
   `justified-not-implemented` entries are already settled — no
   re-litigation at PR time. New justification needs to be added as a
   Rule Manifest edit in the same PR.
3. Before writing rule code, scans the existing `_*.ts` helpers for
   reusable primitives (per helper-extraction policy). If two of the
   PR's rules share more than ~20 lines, extracts a helper in the same
   PR and updates the Rule Manifest's `helper(s) used` column.
4. Runs `npm run test:fake`. For each surfaced violation, applies the
   triage policy (real bug → precursor plan; fixture bug → fix
   in-PR; flood → ship advisory with justification + TODO).
5. Updates the inventory table (`will-implement` →
   `already-implemented` with the freshly-landed rule name).
6. Updates `test-results/rfc-exception-ledger.md` automatically on
   pass; any new declared exceptions go into
   `tests/harness/rules/rfc/exceptions.ts` with a one-line
   justification.

A PR is mergeable only when:
- typecheck clean (tsc + Effect plugin, per CLAUDE.md).
- `npm run test:fake` green.
- every `will-implement` entry in that section has flipped to
  `already-implemented`.
- exception ledger has no `undeclared exception` or missing-`justification` rows.

#### Rules without a positive fixture are still valuable

The "every landed rule must demonstrably fire" guidance in
[docs/RFC_Verification.md](../RFC_Verification.md#every-landed-rule-must-demonstrably-fire)
expresses the *preferred* shape, not a hard gate. A rule whose check
never fires on any current fixture is still worth landing — its
check runs against every audited bind on every test, so any future
code or fixture change that introduces the violation surfaces
immediately. In that sense the rule acts as a regression harness:
silent today, vocal the moment a regression appears.

Phase-2 PRs may therefore ship a rule without a positive-case
fixture when:

- The MUST forbids behaviour the B2BUA has no reason to ever emit
  (e.g. `Require: 100rel` on a non-INVITE), and synthesising the
  violation would require fabricating a peer harness that doesn't
  serve any other test.
- The check is structural enough that fabricating a positive case
  costs more code than the rule itself.

In those cases the Rule Manifest's `notes` column records the
rule as `regression-only` (or equivalent) and explains why a
positive fixture was skipped. Reviewers can still ask for one in
PR review if they think the rule's reach is doubtful. For rules
where fabricating a positive case is cheap and clarifies the
rule's reach (e.g. peer-overrides-builder-to-misbehave fixtures),
prefer the positive-coverage shape.

### Phase 3 — Lessons-learned + extension

After pilot 3261/3262/3264 has every entry at `already-implemented`
or `justified-not-implemented`:

1. Write the lessons-learned appendix in `RFC_Verification.md`. Likely
   topics: which MUST shapes were unexpectedly hostile to rule
   formulation; which fixture-rewrites were forced; which architectural
   guarantees absorbed entire sections; which audit-framework
   limitations need addressing before the next RFC.
2. Queue the next RFCs (proposed order: 3311 UPDATE → 3581 rport →
   3515 REFER → 4566 SDP → 4028 session timers → 6086 INFO → 6665
   SUBSCRIBE/NOTIFY → 3428 MESSAGE → 5626 outbound).

## Files to modify (Phase 0)

- [src/sip/SignalingNetwork.contracts.ts](../../src/sip/SignalingNetwork.contracts.ts)
  — add `UaRole`, `subject` field; thread through `scopedAudit`
  dispatch; honour bind role declarations.
- [src/sip/SignalingNetwork.ts](../../src/sip/SignalingNetwork.ts)
  — extend `bindUdp` (and the simulated variant) to accept an optional
  `roles: ReadonlySet<UaRole>` declaration.
- [tests/support/stackLayer.ts](../../tests/support/stackLayer.ts)
  — drop the default `shouldAuditBind` predicate; set DUT bind
  roles to `{uac, uas}`; load `RFC_EXCEPTIONS` keyed by current
  test-id and refuse to start if a declared `peerName` resolves to a
  DUT-role bind.
- new `tests/harness/rules/rfc/exceptions.ts` — central declarations
  + typed rule-name / peer-name references.
- [tests/harness/rules/rfc/starter-peer-rules.ts](../../tests/harness/rules/rfc/starter-peer-rules.ts)
  and [cross-message-rules.ts](../../tests/harness/rules/rfc/cross-message-rules.ts)
  — stamp every existing rule with `subject: ALL_UA_ROLES` so the
  refactor is a no-op behaviourally. Migrate `ADVISORY_RULE_NAMES` to
  per-rule `severityOverride` + `justification`.
- [src/test-harness/framework/RunContext.ts](../../src/test-harness/framework/RunContext.ts)
  — register the `RfcExceptionLedger` service alongside `Recorder`.
- new `src/test-harness/framework/rfc-exception-ledger.ts` — ledger
  collector + Markdown/JSON emitters.
- [CONTEXT.md](../../CONTEXT.md) — glossary additions.

## Reused infrastructure (do not re-invent)

- `scopedAudit` + `PeerAuditRule` + `CrossMessageAuditRule` already
  exist; only extend.
- `projectPerDialog` in
  [tests/harness/projections.ts](../../tests/harness/projections.ts)
  already partitions per `(bindKey, callId, tags)` — feed it the
  DUT-included event stream as-is.
- `runValidationChecks` in
  [src/test-harness/framework/validation.ts](../../src/test-harness/framework/validation.ts)
  is per-Call-ID-keyed via `dsByCallId` in the rule factory; reuse
  the factory for new MUST rules that are pure per-message.
- `RunContext` already routes `deferred-fail` / `advisory` by mode;
  reuse for new rules.
- Recent precedent: `rfc.noContactOnBye` rule + fixture fix in one
  commit ([b9ae0ec6](../../src/b2bua/rules/)) — the Phase-2 PR shape.

## Verification

Phase 0 specifically:

1. `npm run typecheck` clean.
2. `npm run test:fake` green — the framework refactor is behaviour-neutral
   when every rule's subject is the full set.
3. New unit test: a stub rule with `subject: new Set(['proxy'])` runs
   *only* against binds declared as `proxy`-role; a stub rule with
   `subject: ALL_UA_ROLES` runs against every bind. Verify via the
   ledger that the dispatcher skipped non-matching binds.
4. New unit test: build a fixture with a deliberately misbehaving DUT
   (e.g. a B2BUA-side helper that drops the Via header on outbound),
   confirm the audit now flags the DUT and that the ledger records no
   exemption (DUT cannot be exempted).
5. New unit test: build a fixture with a misbehaving peer Alice +
   a matching entry in `RFC_EXCEPTIONS` for this test-id — confirm
   Alice's violations are recorded in the ledger as `kind:
   "non-compliant-peer"` with the supplied justification and do not
   fail the test.
6. New unit test: an entry in `RFC_EXCEPTIONS` whose `peerName`
   resolves to a DUT bind — confirm layer-build throws with a clear
   error.
7. New unit test: a violation fires that is *not* declared in
   `RFC_EXCEPTIONS` — confirm the renderer marks this as
   `undeclared exception` and fails the test.
8. New unit test: a declared entry never fires during the run —
   confirm the renderer marks `stale exception` (warning, does not
   fail).
9. `test-results/rfc-exception-ledger.md` exists after the test:fake
   run; sample contents show today's `sdpOriginContinuity` advisory
   entry (now justified per-rule, not via the deleted global set).

Phase 1 verification:
- Every line in each `docs/rfc/_raw/RFC*-musts.txt` is accounted for
  in the corresponding inventory table (1:1 or marked as `restatement`
  / out-of-scope rationale).
- Every inventory row has a classification that is *not* bare `todo`.
- Every `justified-not-implemented` entry cites a taxonomy keyword.
- Rule Manifest renders cleanly: each `will-implement` row in the
  inventories appears as a manifest entry; each manifest row
  back-references at least one MUST-ID.
- Reviewer-driven cross-check of a random sample of MUST-IDs back
  to the RFC text.

Phase 2 verification (per PR):
- All `will-implement` entries for the section have flipped to
  `already-implemented`.
- `npm run test:fake` green; ledger clean (no undeclared / missing-
  justification rows).
