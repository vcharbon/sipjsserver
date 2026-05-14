# Promote-PEM-to-200 — SIP Call-Flow Anomaly Report

Aggregated review of 8 fake-clock B2BUA traces produced by the
`promote18xPemTo200` policy module
(`src/b2bua/rules/custom/promote18xPemTo200.ts`) under the
`tests/scenarios/promote-pem-to-200.ts` scenarios.

Review method: each trace was inspected against RFC 3261 (core SIP),
RFC 3264 (offer/answer model), RFC 3262 (PRACK), RFC 3311 (UPDATE),
RFC 3326 (Reason header), RFC 5009 (P-Early-Media), and the project's
B2BUA conventions documented in `docs/b2bua-sip-headers.md`.

All test runs are PASS; the findings here are protocol/convention
observations, not test failures.

## Summary

| # | Scenario                              | File                                                | Anomaly count | Severity |
|---|---------------------------------------|-----------------------------------------------------|---------------|----------|
| 1 | promote-pem-a-bye-during-window       | `promote-pem-a-bye-during-window.global.txt`        | 2 | minor |
| 2 | promote-pem-b-fails-post-promote      | `promote-pem-b-fails-post-promote.global.txt`       | 3 | major |
| 3 | promote-pem-forking-resync            | `promote-pem-forking-resync.global.txt`             | 3 | major |
| 4 | promote-pem-happy-no-resync           | `promote-pem-happy-no-resync.global.txt`            | 2 | minor |
| 5 | promote-pem-in-dialog-rejection       | `promote-pem-in-dialog-rejection.global.txt`        | 3 | minor |
| 6 | promote-pem-no-policy-control         | `promote-pem-no-policy-control.global.txt`          | 1 | minor |
| 7 | promote-pem-resync-failed-by-a        | `promote-pem-resync-failed-by-a.global.txt`         | 3 | major |
| 8 | promote-pem-resync-sdp-changed        | `promote-pem-resync-sdp-changed.global.txt`         | 2 | minor |

Severity legend: **clean** (no anomaly), **minor** (cosmetic / low-risk
non-conformance, e.g. missing recommended header), **major** (functional
gap in the rule code that may affect interop or downstream handling).

---

## 1. promote-pem-a-bye-during-window

Flow recap: Alice INVITE → 100 → b-leg INVITE → Bob 183+PEM → B2BUA
fabricates 200 OK to Alice → Alice ACK + BYE → 200 OK (BYE) to Alice +
CANCEL to Bob → Bob 200 (CANCEL) + 487 → B2BUA auto-ACKs 487.

### 1.1 [MINOR] Synthetic 200 OK to Alice lacks `Allow` / `Supported`
- **Location**: lines 107–115 (200 OK to alice after 183 promotion).
- **Leg / direction**: B2BUA → alice (a-leg UAS).
- **RFC**: RFC 3261 §13.3.1 / §20 — 200 OK to INVITE SHOULD advertise
  `Allow` so the caller knows in-dialog method support of the answering
  side; `Supported` is similarly recommended when extensions are used.
- **Observed**: The promoted 200 OK only carries Via / From / To /
  Call-ID / CSeq / Contact / Content-Type / Content-Length / body.
- **Expected**: At least `Allow: INVITE, ACK, CANCEL, BYE, OPTIONS,
  UPDATE, INFO, REFER, PRACK` to mirror Alice's own advertised set, so
  Alice's UA knows the synthetic 200 supports UPDATE/INFO before
  attempting them.
- **Investigation**: `promote183PemRule.handle()` in
  `src/b2bua/rules/custom/promote18xPemTo200.ts` — the
  `relay-to-peer` transform passes only `status`, `reason`,
  `headerUpdates`. Add `Allow`/`Supported` via `headerUpdates`.

### 1.2 [MINOR] Synthetic 200 OK lacks `Record-Route` echo (info only)
- **Location**: same 200 OK.
- **Leg / direction**: B2BUA → alice.
- **RFC**: RFC 3261 §16.6 — proxies on the path Record-Route the
  request and the UAS echoes them in the dialog-creating response.
- **Observed**: Alice did not Record-Route, so this is benign here, but
  the rule emits the 200 OK via `relay-to-peer` rather than the
  generic response generator that would echo any Record-Routes if
  present.
- **Status**: Not a violation in this trace; flagged only because the
  same rule would also drop Record-Route in a deployment with a proxy
  in front of Alice. Verify the `relay-to-peer` action retains
  Record-Route headers from the original request snapshot.

---

## 2. promote-pem-b-fails-post-promote

Flow recap: standard promotion to 200 OK to Alice → Alice ACK → Bob 503
→ B2BUA BYEs Alice. Bob's 503 is auto-ACKed by the transaction layer.

### 2.1 [MAJOR] BYE to Alice carries no `Reason` header
- **Location**: lines 157–164 (BYE Alice).
- **Leg / direction**: B2BUA → alice.
- **RFC**: RFC 3326 §2 — when a SIP element terminates a session
  because of a received SIP response status it SHOULD include a
  `Reason: SIP;cause=<status>;text="<phrase>"` header on the BYE so the
  remote endpoint can record/relay the original cause.
- **Observed**: BYE has no Reason. The rule's CDR records the reason,
  but it never reaches the wire.
- **Expected**: `Reason: SIP ;cause=503;text="Service Unavailable"` on
  the BYE.
- **Investigation**: `bFailsPostPromoteRule.handle()` builds the
  diagnostic Reason string (`reasonHeader(resp.status, resp.reason)`)
  but only attaches it to the CDR event. The `begin-termination` action
  emits BYEs without per-leg headers. The scenario code (lines 248–256
  of `promote-pem-to-200.ts`) explicitly comments: "wiring a Reason
  onto the wire is a follow-up." This is the documented gap. Either:
  (a) extend `begin-termination` to accept a `Reason` payload, or
  (b) replace the action with an explicit `destroy-leg` per leg that
  carries the header (the rule's own comment in
  `resyncReinviteResponseRule` already notes this idea).

### 2.2 [MAJOR] `Allow` not advertised on the promoted 200 OK
- **Location**: lines 107–115.
- **Same as 1.1** — re-flagged here because it is a cross-cutting
  policy bug. See the cross-cutting findings section for the root
  cause.

### 2.3 [MINOR] Promotion 200 OK strips `Supported: 100rel, timer,
replaces` even though Alice offered them
- **Location**: 183 from Bob did not carry `Supported` in this trace,
  so the relayed 200 OK has none. Alice originally sent `Supported:
  100rel, timer, replaces` in her INVITE (line 18); when promoting to
  200 OK the B2BUA's a-leg UAS response should echo back the subset of
  Supported extensions actually used (§20.37).
- **Investigation**: `promote183PemRule.handle()` — consider sourcing
  the 200 OK's `Supported` from the a-leg `Supported` intersection
  rather than from Bob's 183.

---

## 3. promote-pem-forking-resync

Flow recap: standard promotion → Alice ACK → Bob 200 OK with **same
toTag** as the 183 but different SDP → B2BUA ACK to Bob + re-INVITE to
Alice carrying new SDP → Alice 200 OK → B2BUA ACK to Alice → Alice BYE
→ relayed to Bob.

### 3.1 [MAJOR] Scenario name is misleading — no actual forking occurs
- **Location**: scenario `promote-pem-forking-resync` in
  `tests/scenarios/promote-pem-to-200.ts:401-456`.
- **Leg / dialog**: b-leg.
- **Observed**: Bob's 183 (line 84) uses `To;tag=vgut3p2b`. Bob's
  later 200 OK (line 148) uses the **same** `To;tag=vgut3p2b`. There
  is exactly one b-leg dialog from B2BUA's perspective; no second
  fork ever produces a competing toTag.
- **Expected**: The "forking" branch in
  `confirmAfterPromoteRule.handle()` (the code path where
  `findByBTag(...) === undefined` and the bTag of the winning 2xx
  differs from the seeded mapping, lines 286–302 of the rule) is
  **not exercised** by this trace.
- **Severity rationale**: Promoted to MAJOR because this is a
  test-coverage gap, not a runtime bug, but it conceals a code path
  the rule explicitly documents as load-bearing.
- **Investigation**: Augment the harness to emit a second response
  from a distinct toTag (or replace the 200 OK's toTag in the
  scenario), and re-run to validate the re-seed-under-winning-bTag
  branch.

### 3.2 [MAJOR] BYE relay path uses the **183-time** dialog tags toward
Bob, not the 200-OK dialog tags
- **Location**: line 261–267 (B2BUA → Bob BYE).
- **Leg / dialog**: b-leg.
- **Observed**: BYE carries `From: <sip:alice@test>;tag=k1oekplp` and
  `To: ...;tag=vgut3p2b`. The b-leg fromTag (B2BUA's) is `k1oekplp`,
  bound at INVITE time; the toTag `vgut3p2b` matches the only
  bob-side tag. This is **internally consistent** because Bob never
  forked — but on a real fork (see 3.1) the B2BUA would have to make
  sure the BYE targets the winning toTag, not the promoting toTag.
- **RFC**: RFC 3261 §12.2 — in-dialog requests use the established
  dialog identifiers (local tag, remote tag, Call-ID).
- **Investigation**: After 3.1 is fixed (real fork in trace), verify
  that `confirmAfterPromoteRule` actually destroys the losing fork
  and that the surviving b-leg dialog's `remoteTag` is the winning
  toTag. Currently the rule does emit `destroy-leg` for other
  forks (lines 311–316), but the test does not validate it.

### 3.3 [MINOR] Re-INVITE toward Alice lacks `Allow` / `Supported`
- **Location**: lines 184–192 (B2BUA → alice INVITE).
- **Leg / direction**: B2BUA → alice (a-leg, mid-dialog UAC).
- **RFC**: RFC 3261 §20.5 / §20.37 — re-INVITE SHOULD echo Allow and
  Supported.
- **Observed**: only `Content-Type: application/sdp` and body.
- **Investigation**: The framework's `send-reinvite` action probably
  builds the re-INVITE from the dialog's stored headers. Confirm
  whether Allow/Supported should be injected by the action or by the
  `confirmAfterPromoteRule.handle()` issuing the action.

---

## 4. promote-pem-happy-no-resync

Flow recap: standard promotion to 200 OK to Alice → Alice ACK → Bob
200 OK with **same SDP** → B2BUA ACK to Bob (no resync) → Alice BYE
after 1s → 200 (BYE).

### 4.1 [MINOR] Promoted 200 OK lacks `Allow` / `Supported`
- **Location**: lines 107–115. Same as 1.1.

### 4.2 [MINOR] B2BUA→Bob ACK for the 2xx has a fresh branch (correct
per RFC 3261 §17.1.1.2 / §13.2.2.4) but **lacks `Max-Forwards`** would
be a violation; verifying — line 174 shows `Max-Forwards: 70`,
**present**. No anomaly here, kept as a verification note.

---

## 5. promote-pem-in-dialog-rejection

Flow recap: standard promotion → Alice ACK → Alice UPDATE (while
window open) → B2BUA 491 → Alice INFO → B2BUA 488 → Bob 200 OK → ACK
to Bob → Alice BYE.

### 5.1 [MINOR] 491 for UPDATE is acceptable but non-standard
- **Location**: lines 158–164 (491 to UPDATE).
- **Leg / direction**: B2BUA → alice.
- **RFC**: RFC 3311 §5.2 lists 491 as a valid response when the UAS
  has a pending offer/answer transaction, but classic UPDATE
  collision handling uses 500 with `Retry-After`. 491 is
  semantically reserved for re-INVITE glare (RFC 3261 §14.1).
- **Observed**: UPDATE without SDP body → 491 Request Pending.
- **Expected (purist)**: 491 is fine if a re-INVITE is pending; here
  no re-INVITE is pending — the window-open state is internal to the
  B2BUA. A more standard rejection would be 500 with `Retry-After`,
  or 488 Not Acceptable Here if you treat the window as an
  unsupported state.
- **Investigation**: `rejectAReinviteUpdateRule.handle()` in
  `promote18xPemTo200.ts:451-457`. Decide policy: 491 (current) is
  pragmatic and signals "try later"; switching to 500+Retry-After
  is stricter RFC alignment.

### 5.2 [MINOR] 488 for INFO is semantically wrong
- **Location**: lines 186–194 (488 to INFO).
- **Leg / direction**: B2BUA → alice.
- **RFC**: RFC 3261 §21.4.26 — 488 Not Acceptable Here is reserved
  for offer/answer / codec issues. INFO (RFC 6086) does not carry
  SDP in this case; rejecting it with 488 misuses the status code.
- **Expected**: 403 Forbidden (during window), 500 Server Internal
  Error, or 488 only if the INFO body type is the actual complaint.
- **Observed**: All INFO are 488'd regardless of payload.
- **Investigation**: `rejectAOtherInDialogRule.handle()` —
  `promote18xPemTo200.ts:485-490`. Consider 403 with a `Warning`
  header explaining the window is open.

### 5.3 [MINOR] Both rejection responses lack a `Reason` /
`Warning` header
- **Location**: lines 158–164 (491) and 186–194 (488).
- **RFC**: RFC 3261 §20.43 (Warning) / RFC 3326 (Reason).
- **Observed**: Bare 491 / 488 with no diagnostic information.
- **Expected**: `Warning: 399 b2bua "Early-media window open"` or
  similar. Useful for downstream operators correlating Alice's UA
  retries.

---

## 6. promote-pem-no-policy-control

Flow recap: control scenario, no `promote-pem-to-200` strategy set.
183+PEM is relayed transparently to Alice (default path), then Bob
200, B2BUA ACK to Bob and 200 to Alice.

### 6.1 [MINOR] `P-Early-Media` header is relayed verbatim across the
B2BUA hop
- **Location**: line 113 (B2BUA → alice 183 carries `P-Early-Media:
  sendrecv`).
- **Leg / direction**: B2BUA → alice.
- **RFC**: RFC 5009 §3.2 — `P-Early-Media` is a *trust-domain*
  private extension; SIP elements at trust-domain boundaries SHOULD
  strip it. The B2BUA generally sits at such a boundary
  (Alice = external caller).
- **Observed**: Header passes through untouched on the 183.
- **Expected (purist)**: Strip on egress to Alice unless Alice is
  inside the trust domain.
- **Status**: The test explicitly asserts this passes through
  (`headerValue(msg, "p-early-media") !== undefined`) so it is the
  intended default-relay behaviour. Flagged for future policy
  consideration; not a bug.

---

## 7. promote-pem-resync-failed-by-a

Flow recap: standard promotion → Alice ACK → Bob 200 with different SDP
→ B2BUA ACK Bob + re-INVITE Alice → Alice 488 → B2BUA BYEs both legs.

### 7.1 [MAJOR] No visible ACK from B2BUA for Alice's 488 in the trace
- **Location**: between lines 208–219 (488 from Alice, then BYE from
  B2BUA at 222).
- **Leg / direction**: B2BUA → alice.
- **RFC**: RFC 3261 §17.1.1.3 — UAC must ACK every non-2xx final
  response on the same branch.
- **Observed**: The trace jumps directly from `488 Not Acceptable
  Here (INVITE)` to `BYE` with no intervening ACK.
- **Likely explanation**: The transaction layer's auto-ACK is sent
  but not captured in the *global* report (the scenario uses
  `alice.allowExtra("ACK")` exactly to absorb this auto-ACK on the
  endpoint side). This is then a **reporting / trace-completeness**
  defect, not a protocol defect.
- **Investigation**: Verify the auto-ACK is emitted by checking the
  per-endpoint trace file (Alice's view) or the transaction-layer
  log. If present, the *global* report's filtering should be relaxed
  to include transaction-layer auto-ACKs so reviewers do not have to
  reason about absent messages.

### 7.2 [MAJOR] BYE to Alice carries no `Reason` header diagnosing the
resync failure
- **Location**: lines 222–229 (B2BUA → alice BYE, CSeq 807002).
- **Leg / direction**: B2BUA → alice.
- **RFC**: RFC 3326 §2.
- **Observed**: BYE has no `Reason`. The rule
  (`resyncReinviteResponseRule.handle()`) computes
  `reasonHeader(resp.status, resp.reason)` but only stamps it on
  the CDR event, not the wire.
- **Investigation**: Same root cause as 2.1 — `begin-termination`
  cannot attach per-leg headers. The rule's own comment at
  `promote18xPemTo200.ts:415-417` explicitly acknowledges the gap.

### 7.3 [MAJOR] BYE to Bob carries no `Reason` header either
- **Location**: lines 244–253 (B2BUA → bob BYE, CSeq 7001).
- **Same RFC / root cause as 7.2.** Bob would benefit from knowing
  that the teardown was caused by Alice's 488, not by Alice hanging
  up.

---

## 8. promote-pem-resync-sdp-changed

Flow recap: standard promotion → Alice ACK → Bob 200 with different SDP
→ B2BUA ACK Bob + re-INVITE Alice → Alice 200 → ACK to Alice → Alice
INFO (relayed) → Alice BYE.

### 8.1 [MINOR] Re-INVITE to Alice lacks `Allow` / `Supported`
- **Location**: lines 184–192 (B2BUA → alice INVITE, CSeq 617001).
- **Same as 3.3.**

### 8.2 [MINOR] Promoted 200 OK lacks `Allow` / `Supported`
- **Location**: lines 107–115. Same as 1.1.

---

## Cross-cutting findings

The 8 traces share a small number of recurring deficiencies. Fixing
them at the source eliminates most per-scenario anomalies.

### CC-1 [MAJOR] `Reason` headers (RFC 3326) never reach the wire on
B2BUA-originated BYEs
Affected scenarios: **2 (b-fails-post-promote), 7 (resync-failed-by-a)**.

Both `bFailsPostPromoteRule` (3a) and the failure branch of
`resyncReinviteResponseRule` (3b) compute a `reasonHeader(...)` string
and stash it in the CDR event payload, but the actual BYE on the wire
is produced by the framework's `begin-termination` action, which has
no per-leg header injection point.

The rule code already comments on this gap (see
`promote18xPemTo200.ts:415-417` and the scenario comment at
`promote-pem-to-200.ts:248-256`). Recommended fixes, in increasing
order of invasiveness:
1. Extend the `begin-termination` action with an optional
   `byeHeaders: Map<LegId, HeaderUpdate>` payload.
2. Or: have the rule emit explicit `destroy-leg` actions for each leg
   with a Reason header, then `begin-termination` to clean up state
   only.
3. Or: add a generic `set-pending-bye-headers` action that the
   termination path consults when constructing the BYE.

### CC-2 [MINOR] B2BUA-originated INVITE responses and requests omit
`Allow` / `Supported`
Affected scenarios: **all 8**, in two flavours.

Flavour A — the synthetic 200 OK promoted from Bob's 183 (every
scenario where promotion fires, i.e. **1, 2, 3, 4, 5, 7, 8**) lacks
both headers. Alice cannot tell from the 200 OK whether the called
side supports UPDATE, REFER, or PRACK.

Flavour B — the B2BUA-originated resync re-INVITE on the a-leg
(scenarios **3, 7, 8**) lacks both headers. Mid-dialog UPDATE/INFO
detection on Alice's side is degraded.

Single root cause: the `relay-to-peer` and `send-reinvite` actions
build their outbound from a narrow set of inputs and do not auto-fill
recommended headers. Either:
- Add `Allow` / `Supported` defaults to the response/request
  builders for B2BUA-originated traffic, or
- Update both rule handlers in `promote18xPemTo200.ts` to push
  `Allow` and `Supported` via `headerUpdates` (for the 200 OK) and
  a corresponding mechanism for the re-INVITE.

### CC-3 [MAJOR] `forking-resync` scenario does not exercise the
rule's forking code path
Affected scenarios: **3 (forking-resync)**.

The scenario sends Bob's 183 and 200 OK from the **same** server
transaction with the **same** `To;tag`. The rule's defensive code at
`promote18xPemTo200.ts:286-302` — the path where the winning toTag
differs from the seeded mapping and the rule re-seeds under the
winning bTag while preserving the a-facing tag — is therefore dead in
the test suite.

Either the harness needs to be extended to support a true fork (two
distinct server-side responses, two distinct `To;tag` values from the
b-side), or the scenario should be renamed to
`promote-pem-sdp-change-same-fork` and a real `forking-*` scenario
added once the harness supports multi-fork b-leg.

### CC-4 [MINOR] In-dialog rejection responses (491 / 488) carry no
diagnostic context
Affected scenarios: **5 (in-dialog-rejection)**.

Both responses are valid in the most permissive reading of RFC 3261
/ RFC 3311, but neither carries a `Reason` or `Warning` header
explaining *why* the request was rejected during the promote window.
The fixes are local to `rejectAReinviteUpdateRule` and
`rejectAOtherInDialogRule` in `promote18xPemTo200.ts`. The choice
between 488 and 403 for INFO is also worth revisiting — 488 is
reserved for offer/answer compatibility issues.

### CC-5 [LOW] Global trace report appears to omit transaction-layer
auto-ACKs
Affected scenarios: **2, 7** (and any other trace where a non-2xx
final response is sent by the B2BUA to Alice or by Bob to the B2BUA).

In scenario 7 in particular, the auto-ACK for Alice's 488 is invisible
in the global report even though it must be emitted on the wire
(otherwise Alice's UA would retransmit the 488 per RFC 3261 §17.1.1.2
Timer G/H). The scenario relies on `alice.allowExtra("ACK")` to absorb
the auto-ACK — confirming the ACK *is* emitted, just not rendered.

Recommendation: include transaction-layer auto-ACKs in the global
trace renderer, or at minimum emit a stub line such as
`── [T+0.???s] B2BUA → alice ── ACK (auto, 488 INVITE)` so call-flow
reviewers do not have to interpret an apparent §17.1.1.3 violation.

### CC-6 [LOW] `P-Early-Media` leaks across the B2BUA trust boundary
in the no-policy-control path
Affected scenarios: **6 (no-policy-control)**.

The default 183 relay does not strip `P-Early-Media` (RFC 5009 §3.2).
This is intentional today (the scenario asserts pass-through) but
deserves an explicit policy decision documented either in
`docs/b2bua-sip-headers.md` or in the relay rule. If the B2BUA's
peering posture changes (e.g. Alice becomes an external untrusted
caller), this leak becomes a privacy issue.

---

## Verified clean

The following aspects were verified across all 8 traces and found
correctly implemented:

- **Branch handling**: Top Via branches are consistent within each
  client transaction; fresh branches are minted for 2xx ACKs (§13.2.2.4)
  and reused for non-2xx ACKs (§17.1.1.3).
- **CANCEL construction** (scenario 1): same Request-URI, same top
  Via (including branch), same CSeq number as the cancelled INVITE
  with method rewritten to CANCEL (RFC 3261 §9.1).
- **Tag ownership per leg**: From/To tags are correctly partitioned
  between Alice's tag (a-leg fromTag), the B2BUA's a-facing tag
  (a-leg dialog.toTag, used as From-tag of B2BUA-originated in-dialog
  requests toward Alice), the B2BUA's b-facing tag (b-leg fromTag),
  and Bob's tag (b-leg dialog.toTag). Tag mapping is preserved across
  the 183→200 OK promotion.
- **Call-ID per leg**: a-leg uses Alice's Call-ID verbatim; b-leg
  uses the `1-<aLegCallId>` form per
  `docs/b2bua-sip-headers.md` §Call-ID.
- **Via custom params**: `cr=<callRef>;lg=<legId>` (and `rport` on
  b-leg outbound) are stamped on every B2BUA-originated request /
  response Via. No placeholder leaks observed.
- **Contact URI params**: `callRef=...;leg=...` are stamped on every
  B2BUA-built Contact. Alice's in-dialog requests target the URI
  emitted in the synthetic 200 OK's Contact (target refresh per
  §12.2.1.1).
- **CSeq monotonicity per direction**: All B2BUA-originated requests
  toward each peer increment the per-direction CSeq counter
  monotonically; responses echo the request CSeq verbatim.
- **§13.2.2.4 ACK for 2xx**: end-to-end ACK design is honoured —
  Alice's ACK to the promoted 200 OK targets the B2BUA's Contact and
  the B2BUA absorbs it (no relay to Bob) per
  `absorbAAckDuringWindowRule`; the B2BUA's own ACK to Bob's 200 OK
  uses Bob's Contact and a fresh branch.
- **Suppression of post-promote 18x**: scenario set does not include a
  case where Bob emits a second 18x after the first 183+PEM, so
  `suppressPostPromote18xRule` is not exercised here. This is a
  coverage gap rather than a defect; flag for a future scenario.
- **REFER / transfer carve-out**: `transferPhase: null` in the rule
  match conditions correctly prevents these rules from colliding
  with the transfer lifecycle rules. Not exercised in these scenarios.
- **No `__PLACEHOLDER__` leakage**: every Via branch, callRef, leg id,
  tag and Call-ID is a concrete value.
