# SIP Call-Flow Anomaly Report — Aggregated (2026-04-14 run)

Generated: 2026-04-14
Source: 20 e2e call-flow captures under [test-results/fake-clock/*.global.txt](../../test-results/fake-clock/)
Method: `/sip-callflow-review` applied per file via 20 parallel `sip-callflow-anomaly-reporter` agents, aggregated by error id.

## Executive Summary

| Severity | Distinct error ids | Tests impacted (unique) |
|----------|-------------------:|------------------------:|
| CRITICAL | 2 | 2 |
| HIGH     | 9 | 8 |
| MEDIUM   | 10 | 10 |
| LOW      | 13 | 12 |

**Clean captures (no anomalies):** `basic-call`, `call-setup+alice-reinvite-fragment`, `call-setup+caller-bye`, `cancel`, `prack`, `record-route-basic`, `record-route-fake-rr`.

**Top-ranked anomalies by test count**

| Rank | Error id | Tests impacted | Severity |
|-----:|----------|---------------:|----------|
| 1 | `missing_contact_on_bye_b_leg` (aka `bye_missing_contact`, `bye_bleg_missing_contact`, `bye_to_b_leg_missing_contact`) | 6 | LOW |
| 2 | `sdp_offer_or_answer_version_not_incremented` | 3 | MEDIUM |
| 3 | `missing_ack_for_non_2xx_final` | 3 | HIGH |
| 4 | `duplicate_180_relayed` | 2 | MEDIUM |
| 5 | `bleg_initial_cseq_nonstandard_value` | 2 | LOW |

Captures that previously surfaced HIGH anomalies and now return CLEAN — confirming the H1/H2/H3 fixes held: `cancel`, `record-route-fake-rr`.

---

## CRITICAL (protocol-breaking)

### C1 · `upstream_uas_tag_forked` — RFC 3261 §12.1.1 / §13.2
On a forking downstream scenario the B2BUA advertised **two distinct UAS To-tags** to the same upstream server transaction (second 183 to alice carried a brand-new tag). A B2BUA-as-UAS must present a single local tag for the lifetime of a server transaction.

- Hop: `B2BUA → alice`
- **Tests:** `prack-forking`
- **Check:** UAS must pin one local tag per server transaction; keep a single early dialog upstream while the downstream forks.

### C2 · `ack_missing_sdp_answer_b_leg` (delayed-offer) — RFC 3261 §13.2.1 / RFC 3264 §5
On the b-leg delayed-offer path the B2BUA ACKed bob's 2xx with `Content-Length: 0` — bob's 200 OK carried the SDP offer but no answer came back in ACK. Media negotiation incomplete.

- Hop: `B2BUA → bob`
- **Tests:** `delayed-offer-failure`
- **Check:** UAC must place SDP answer in ACK whenever the 2xx contained the offer.

> Note — `delayed-offer-failure` was previously classified as a false positive for the a-leg symmetric case (see [sip-anomalies-aggregate.md](sip-anomalies-aggregate.md) C4). This run re-flags the **b-leg ACK** specifically as CRITICAL; that is a different hop from the earlier a-leg finding.

---

## HIGH (functional / interop bug)

### H1 · `missing_ack_for_non_2xx_final` — RFC 3261 §17.1.1.3
After receiving a non-2xx INVITE final response the B2BUA does not emit (or does not emit in time) the hop-by-hop ACK. Also surfaces as `ack_for_nonerror_delayed` / `missing_contact_on_b_leg_ack_non2xx` / `missing_ack_for_487`.

- **Tests:**
  - `call-reject` (403 from alice to inbound INVITE, ACK never appears)
  - `suppress-18x-failover-no-answer` (no ACK for 487 from bob1)
  - `suppress-18x-failover-reject` (ACK for 503 delayed ~1s until after call teardown)

### H2 · `stray_cancel_after_transaction_terminated` — RFC 3261 §9.1 / §16.8
During failover cleanup a redundant CANCEL is fired to a b-leg whose INVITE client transaction had already completed (either by an earlier CANCEL/487 pair, or after bob2 had already answered 2xx).

- Hop: `B2BUA → bob1`
- **Tests:** `suppress-18x-failover-no-answer`
- **Check:** UAC must not send CANCEL once a final response has been received on the INVITE transaction.

### H3 · `stray_ack_to_failed_b_leg` — RFC 3261 §17.1.1.3
An ACK for a non-2xx is re-emitted ~1s after the transaction layer has already ACKed the 486, reusing the original INVITE branch. Late/duplicate ACK from the cleanup path.

- Hop: `B2BUA → bob1`
- **Tests:** `failover-with-headers`
- **Check:** Cleanup path must not re-generate ACK once `TransactionLayer` has absorbed the non-2xx.

### H4 · `rseq_non_monotonic` — RFC 3262 §3
Successive reliable 1xx on the same upstream server transaction break the “RSeq MUST increment by exactly one” rule (observed jump 1 → 200 when forks switched).

- Hop: `B2BUA → alice`
- **Tests:** `prack-forking`

### H5 · `early_dialog_not_terminated` — RFC 3261 §13.3.1.4 / §15
When forked upstream dialogs exist, the losing early dialog is never terminated after the 2xx is emitted on the winning fork. Orphaned early dialog upstream.

- Hop: `B2BUA → alice`
- **Tests:** `prack-forking`

### H6 · `winning_fork_tag_mismatch` — RFC 3261 §13.2.2.4
200 OK delivered with a To-tag that differs from the most recent early dialog advertised upstream; UAC may reject as out-of-dialog.

- Hop: `B2BUA → alice`
- **Tests:** `prack-forking`

### H7 · `to_tag_mismatch_180_vs_200_after_failover` — RFC 3261 §12.1.1
Under the suppress-18x failover policy, the upstream 180 and 200 OK To-tags remain stable (OK), but the downstream b-leg UAS tag (bob2) is **different** from the upstream To-tag carried through 200 — legal for a B2BUA but notable, and the reviewer flagged the upstream continuity check in particular.

- Hop: `B2BUA → alice`
- **Tests:** `suppress-18x-failover-reject`

### H8 · `two_hundred_without_offer_or_answer` (suppress-18x-disabled) — RFC 3264 §5
2xx to offerless INVITE carried an SDP offer, but alice's ACK had no SDP answer. Media negotiation never completes end-to-end.

- Hop: `bob → B2BUA → alice`
- **Tests:** `suppress-18x-disabled`

### H9 · `aleg_offer_relayed_without_answer_collection` (delayed-offer a-leg) — RFC 3264 §5
B2BUA relayed bob's SDP as offer in 200 OK to alice, but alice's ACK had `Content-Length: 0` — no answer propagated back down. Companion to C2 on the a-leg direction.

- Hop: `B2BUA → alice` / `alice → B2BUA`
- **Tests:** `delayed-offer-failure`

---

## MEDIUM (correctness / best practice)

### M1 · `sdp_version_not_incremented` (offer or answer) — RFC 3264 §5–§8 / RFC 4566 §5.2
Re-INVITE offer or answer reuses the previous `o=` session/version field despite a changed `m=audio` port. B2BUA relays transparently.

- **Tests (3):**
  - `call-setup+bob-reinvite-fragment` (offer + answer both)
  - `call-setup+crossing-reinvite-fragment` (offer on a-leg re-INVITE)
  - (`call-setup+alice-reinvite-fragment` is reclassified CLEAN in this pass per commit `c34d34e`)

### M2 · `duplicate_180_relayed_upstream` — RFC 3261 §13.2 / §17.2.1
B2BUA relays both copies of a UAS-retransmitted 180 instead of absorbing the second.

- **Tests:** `suppress-18x-disabled`, `suppress-18x-failover-reject`

### M3 · `initial_invite_no_sdp_offer` (delayed-offer input pattern) — RFC 3261 §13.2.1 / RFC 3264 §5
Initial INVITE has `Content-Length: 0`; downstream flow then depends on 2xx carrying the offer and ACK the answer. Acceptable per spec but this pass flagged it as the **input condition** that couples with H8/H9/C2.

- **Tests:** `suppress-18x-disabled`, `delayed-offer-failure`, `explicit-route-call` (noted by reviewer)

### M4 · `bye_request_uri_not_remote_target` — RFC 3261 §12.2.1.1
In-dialog BYE Request-URI differs from the peer's Contact URI (B2BUA synthesised a `target@` user-part, and dropped `transport=udp`).

- Hop: `B2BUA → alice` BYE
- **Tests:** `call-setup+callee-bye`

### M5 · `cancel_after_2xx_on_peer_branch` (failover cleanup) — RFC 3261 §9.1 / §16.8
Parallel flavour of H2: a CANCEL fires to a b-leg that was already answered 2xx and then BYEd on the winning b-leg. Classified MEDIUM because it piggy-backs on the stray-CANCEL root cause and is only harmful if the peer still has state.

- **Tests:** `suppress-18x-failover-no-answer`

### M6 · `cseq_non_monotonic_bye_aleg` — RFC 3261 §12.2.1.1
B2BUA BYE on a-leg uses a CSeq value unrelated to the alice-initiated INVITE CSeq, because the B2BUA-as-UAC on a-leg seeds its own counter — acceptable but the reviewer flagged the unseeded jump as suspicious.

- **Tests:** `delayed-offer-failure`

### M7 · `prack_reroute_after_fork_switch` — RFC 3262 §4 / RFC 3261 §12
PRACK for the losing fork is forwarded downstream using the fork's b-leg tag; upstream early dialog has no corresponding confirmed state.

- **Tests:** `prack-forking`

### M8 · `missing_ack_for_487` (explicit) — RFC 3261 §17.1.1.3
Same family as H1, but called out separately because the missing ACK is specifically for a 487 on a failover-cancelled b-leg.

- **Tests:** `suppress-18x-failover-no-answer`

### M9 · `unsolicited_reinvite_481_instead_of_signal` — RFC 3261 §12.2.1
Out-of-dialog INVITE that already carries a To-tag was answered `481`. `481` is reserved for in-dialog requests not matching a dialog; an initial INVITE carrying a To-tag is malformed and warrants `400`/`403`.

- **Tests:** `indialog-unknown-reject`

### M10 · `contact_on_non_redirect_4xx` → reclassified MEDIUM because of policy implications
A 403 to a rejected INVITE carried a `Contact` header with `callRef`/`leg` params though no dialog is being created and it is not a redirect.

- **Tests:** `call-reject`

---

## LOW (hygiene / style)

### L1 · `missing_contact_on_bye_b_leg` — RFC 3261 §8.1.1.8 / §12.2.1.1
B2BUA-originated BYE requests do not carry a `Contact` header on the b-leg, denying the peer any chance of target refresh. Recommended (SHOULD) for mid-dialog requests.

- **Tests (6):**
  - `call-setup+bob-reinvite-fragment`
  - `explicit-route-call`
  - `indialog-unknown-reject`
  - `record-route-basic` (noted but not flagged as anomaly by that reviewer)
  - `suppress-18x-basic`
  - `suppress-18x-disabled`

### L2 · `bye_missing_transport_param` — RFC 3261 §19.1.1
`transport=udp` present in the peer's stored Contact is dropped when constructing the BYE Request-URI.

- **Tests:** `call-setup+callee-bye`

### L3 · `bleg_initial_cseq_nonstandard_value` — RFC 3261 §8.1.1.5
B-leg INVITE CSeq seeded at large random values (`1999000`, `1801000`, `1712000`, `1198000`, `1093000`, `1795000`, `864000`, `608000`…). Legal per spec but may surprise strict UASes / logs. Also surfaces as `cseq_not_monotonic_relay` when the jump between failover b-legs is non-adjacent.

- **Tests (2 explicitly called out this pass):**
  - `delayed-offer-failure`
  - `suppress-18x-failover-reject`

### L4 · `provisional_reliability_downgraded_silently` — RFC 3262 §3
Downstream 183 carried `Require: 100rel` + RSeq; policy absorbed the 100rel locally and relayed a plain 180 upstream with no `RSeq`/`Require`. Alice had `Supported: 100rel` — may or may not want the reliability end-to-end, but the downgrade is silent.

- **Tests:** `suppress-18x-basic`

### L5 · `duplicate_180_suppressed_without_trace` — RFC 3261 §16.7
Second unreliable 180 from bob is dropped by the suppress-18x policy but no spanEvent is emitted; non-observable under inspection.

- **Tests:** `suppress-18x-basic`

### L6 · `ack_missing_route_or_rr_consistency` — RFC 3261 §12.2.1.1
No `Route` header on ACK (accepted since no Record-Route was inserted upstream) — logged by reviewer for completeness.

- **Tests:** `explicit-route-call`

### L7 · `sdp_version_not_incremented_reinvite_offer_bleg_glare` — RFC 3264 §8
Glare / losing re-INVITE offer reuses session version with changed body — masked by 491, but flagged for hygiene.

- **Tests:** `call-setup+crossing-reinvite-fragment`

### L8 · `b2bua_sdp_passthrough_without_version_fix` — RFC 3264 §8
B2BUA relayed both offending SDP bodies unchanged instead of normalising `o=` version per leg. Design choice (we are not an SDP-aware intermediary) but called out.

- **Tests:** `call-setup+bob-reinvite-fragment`

### L9 · `uas_to_tag_mismatch_a_leg` (informational) — RFC 3261 §12.1.1
A-leg UAS To-tag (minted by B2BUA) differs from b-leg UAS tag (from bob). Expected for a B2BUA; flagged informational because stability across the a-leg dialog is the important property and was verified.

- **Tests:** `suppress-18x-disabled`

### L10 · `ack_missing_to_tag_consistency_check` — RFC 3261 §17.1.1.3
Late/stray ACK carries a To-tag from the already-failed response; companion to H3.

- **Tests:** `failover-with-headers`

### L11 · `bleg_from_tag_rewritten` (informational) — RFC 3261 §12.1.1 / §19.3
Normal B2BUA behaviour (fresh From-tag on b-leg), flagged for inventory so the dialog-continuity invariant is exercised in tests.

- **Tests:** `explicit-route-call`

### L12 · `missing_contact_on_b_leg_ack_non2xx` — RFC 3261 §17.1.1.3
Same family as H1 on the `suppress-18x-failover-reject` capture.

- **Tests:** `suppress-18x-failover-reject`

### L13 · `cseq_not_monotonic_relay` — RFC 3261 §8.1.1.5
Between the first and second b-legs the CSeq initial value jumps non-adjacently (`1515000 → 1801000`). Legal but non-deterministic seeding.

- **Tests:** `suppress-18x-failover-reject`

---

## Per-Test Index

| Test | Status | Worst severity | Anomaly count |
|------|--------|----------------|--------------:|
| basic-call | CLEAN | — | 0 |
| call-reject | ANOMALIES | HIGH | 2 |
| call-setup+alice-reinvite-fragment | CLEAN | — | 0 |
| call-setup+bob-reinvite-fragment | ANOMALIES | MEDIUM | 3 |
| call-setup+callee-bye | ANOMALIES | MEDIUM | 2 |
| call-setup+caller-bye | CLEAN | — | 0 |
| call-setup+crossing-reinvite-fragment | ANOMALIES | MEDIUM | 2 |
| cancel | CLEAN | — | 0 |
| delayed-offer-failure | ANOMALIES | **CRITICAL** | 4 |
| explicit-route-call | ANOMALIES | HIGH | 4 |
| failover-with-headers | ANOMALIES | HIGH | 2 |
| indialog-unknown-reject | ANOMALIES | LOW | 2 |
| prack | CLEAN | — | 0 |
| prack-forking | ANOMALIES | **CRITICAL** | 5 |
| record-route-basic | CLEAN | — | 0 |
| record-route-fake-rr | CLEAN | — | 0 |
| suppress-18x-basic | ANOMALIES | LOW | 3 |
| suppress-18x-disabled | ANOMALIES | HIGH | 5 |
| suppress-18x-failover-no-answer | ANOMALIES | HIGH | 3 |
| suppress-18x-failover-reject | ANOMALIES | HIGH | 5 |

---

## Recommended Follow-up Priority

1. **`prack-forking` CRITICAL tag-forking + early-dialog handling (C1, H4, H5, H6, M7).** Five distinct findings on one capture. The upstream UAS must present a single tag per server transaction, RSeq must be monotonic per dialog, and losing early dialogs must be explicitly terminated. Single biggest compliance gap in the suite.
2. **Delayed-offer ACK answer on b-leg (C2, H9).** `delayed-offer-failure` now reports a CRITICAL on the b-leg ACK (no SDP answer) in addition to the earlier a-leg finding. Decide between implementing delayed-offer correctly or rejecting early with 488/606.
3. **ACK-for-non-2xx during failover cleanup (H1, H3, M8, L10, L12).** Four different failover flows exhibit missing, late, or duplicate ACKs. Verify `TransactionLayer` is the single owner of ACK-for-non-2xx, and that cleanup paths do not re-issue ACK.
4. **Stray CANCEL after transaction termination (H2, M5).** Fix cleanup ordering in failover: do not emit CANCEL once a final response has been seen or the b-leg has been replaced.
5. **Duplicate 180 handling (M2).** Two tests (`suppress-18x-disabled`, `suppress-18x-failover-reject`) show the B2BUA relaying both copies of a retransmitted 180. Absorb the second at the relay rule.
6. **Missing `Contact` on b-leg in-dialog requests (L1).** Six tests share this LOW finding; batch-fix at the BYE/ACK builder.
7. **Delayed-offer input pattern (M3 + H8).** Several tests expose the same under-specified path: offerless INVITE → offer in 2xx → no answer in ACK. Consider a policy-level check that rejects delayed-offer if the upstream UAC never provides an SDP answer.
8. **SDP version discipline across re-INVITE (M1, L7, L8).** Reviewer-flagged as expected B2BUA passthrough; decide whether to normalise `o=` version per leg or explicitly document the SDP-unaware B2BUA contract.
9. **Request-URI and URI-parameter preservation on in-dialog BYE (M4, L2).** `call-setup+callee-bye` shows a synthesised user-part and a dropped `transport=udp`. Fix at the in-dialog request builder.
10. **Out-of-dialog INVITE carrying a To-tag — use 400/403 instead of 481 (M9).** Small, self-contained rule change.
11. **`Contact` on non-redirect 4xx (M10).** Omit `Contact` on non-2xx/non-3xx final responses unless dialog-forming.

---

*Source captures: [test-results/fake-clock/*.global.txt](../../test-results/fake-clock/) · Previous aggregate: [sip-anomalies-aggregate.md](sip-anomalies-aggregate.md) · Report format: one error id per section with aggregated test index.*
