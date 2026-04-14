# SIP Call-Flow Anomaly Report — Aggregated

Generated: 2026-04-14
Source: 20 e2e call-flow captures under `test-results/fake-clock/*.global.txt`
Method: `/sip-callflow-review` applied per file via `sip-callflow-anomaly-reporter` agents, then aggregated by error type.

## Executive Summary

| Severity | Distinct error types | Tests impacted (unique) |
|----------|---------------------:|------------------------:|
| CRITICAL | 4 | 5 |
| HIGH     | 9 | 7 |
| MEDIUM   | 8 | 11 |
| LOW      | 9 | 14 |

**Clean captures (no anomalies):** `basic-call`, `call-setup+crossing-reinvite-fragment`, `indialog-unknown-reject`.

**Hottest anomalies (by test count):**
1. `bye_missing_contact` — 5 tests
2. `missing_allow_header` — 8 tests
3. `missing_supported_header` — 8 tests
4. `missing_ack_for_non_2xx_final` — 3 tests (all failover flows)
5. `cseq_non_standard_initial_value_b_leg` — 3 tests

---

## CRITICAL (protocol-breaking)

### C1 · `prack_rack_cseq_mismatch` — RFC 3262 §7.2
Relayed PRACK carries `RAck: <rseq> <a-leg-CSeq> INVITE` instead of the **b-leg** INVITE CSeq of the provisional being acked. Bob will not match any outstanding reliable 1xx and will retransmit until Timer G/H.

- Hop: `B2BUA → bob` PRACK
- **Tests:**
  - `prack-forking` (both fork1 and fork2 PRACKs — `RAck: 1 1 INVITE` / `RAck: 200 1 INVITE` while b-leg CSeq was `1350000`)

### C2 · `prack_200_cseq_not_echoed` — RFC 3261 §8.2.6.1 / §17.2.1
`200 OK (PRACK)` sent upstream carries a CSeq number that does not echo the PRACK request (shows `CSeq: 1 PRACK` while the PRACK had `CSeq: 2|3 PRACK`). Breaks the PRACK transaction match at the UAC.

- Hop: `B2BUA → alice` 200 OK (PRACK)
- **Tests:**
  - `prack`
  - `prack-forking`

### C3 · `missing_ack_for_non_2xx_final` — RFC 3261 §17.1.1.3
After receiving a non-2xx INVITE final response, the B2BUA does **not** emit a hop-by-hop ACK to the UAS before tearing down / failing over. INVITE server transaction at bob stays in Completed awaiting Timer H; protocol compliance broken, but test capture may hide the ACK if absorbed by `TransactionLayer`. Worth confirming whether ACK is actually emitted on wire.

- Hop: `B2BUA → bob*` (losing b-leg)
- **Tests:**
  - `suppress-18x-failover-no-answer` (487 Request Terminated)
  - `suppress-18x-failover-reject` (503 Service Unavailable)
  - `failover-with-headers` (486 Busy Here)

### C4 · `delayed_offer_answer_broken` — RFC 3264 §5 / RFC 3261 §13.2.1
**Status: FALSE POSITIVE — reclassified.** Re-reading the capture: the B2BUA
transparently relays bob's 200 OK SDP offer to alice and transparently relays
alice's empty ACK to bob. The missing SDP answer originates at alice, which the
scenario (`delayed-offer-failure`) deliberately exercises as a misbehaving UAC
so bob can tear down the call. No B2BUA bug; capture is correct.

---

## HIGH (functional / interop bug)

### H1 · `to_tag_mismatch_180_vs_487` — RFC 3261 §12.1.1 / §17.2.1 — **FIXED**
Within the same UAS transaction on the a-leg, the UAS-generated To-tag changes between the 180 provisional and the 487 final, breaking dialog identity.

**Fix:** `TransactionLayer` now pins a `uasToTag` on the server INVITE transaction on the first outbound response >100 and reuses it for `build487` when synthesizing the 487 in response to CANCEL. Framework check `tagConsistency` flags a fresh To-tag on any final response that does not match a prior provisional's tag.

- Hop: `B2BUA → alice` 180 vs 487
- **Tests:** `cancel`

### H2 · `cancel_200_tag_inconsistent` — RFC 3261 §9.2 / §12.1.1 — **FIXED**
`200 OK (CANCEL)` uses a third distinct To-tag on the same Call-ID, different from both the 180 tag and the 487 tag.

**Fix:** CANCEL handler in `TransactionLayer` passes the pinned `uasToTag` to `build200Ok` (stripping Contact as before). Same framework check covers this since CANCEL reuses the INVITE's Via branch.

- Hop: `B2BUA → alice` 200 OK CANCEL
- **Tests:** `cancel`

### H3 · `record_route_dropped_b_leg` — RFC 3261 §12.1.2, §12.2.1.1 — **FIXED**
Downstream sends `Record-Route: <sip:fake-proxy@…;lr>` in 180/200; B2BUA never builds a route set. Subsequent b-leg ACK/BYE are sent directly to Contact with no Route header, bypassing the loose router.

**Fix:** `executeConfirmDialog` now captures the Record-Route list (reversed) into `Dialog.routeSet`. A shared `applyRouteSet` helper inserts the Route headers on every outbound b-leg in-dialog request (ACK, BYE, re-INVITE, PRACK, OPTIONS, INFO/UPDATE, and termination BYEs) and rewrites the destination to the first route URI when it carries `;lr` (loose routing). A-leg path is untouched. The `record-route-fake-rr` scenario now asserts the Route header is present on the ACK and BYE received by bob.

- Hop: `B2BUA → bob` ACK, BYE
- **Tests:** `record-route-fake-rr`

### H4 · `sdp_version_regression` — RFC 3264 §5, §8
Session version in `o=` goes backward across successive answers (`2 2` → `1 1`) on the same dialog, breaking offer/answer state machine at the peer.

- Hop: `bob → B2BUA` 200 OK (reINVITE) → relayed `B2BUA → alice`
- **Tests:** `call-setup+alice-reinvite-fragment`

### H5 · `reliable_1xx_not_pracked_by_b2bua` / `require_100rel_dropped` — RFC 3262 §3, §4
Bob sends a reliable 183 (`Require: 100rel`, `RSeq: 1`). B2BUA does not send PRACK toward bob, and at the same time strips `Require: 100rel` when relaying the 183 downgraded to 180 toward alice. Neither leg receives/produces a valid PRACK → bob retransmits until Timer exhausts.

- Hops: `bob ↔ B2BUA` (missing PRACK); `B2BUA → alice` (downgrade without negotiation)
- **Tests:** `suppress-18x-basic`

### H6 · `sdp_answer_discarded_early_media` — RFC 3264 §5–6
Reliable 183 carried an SDP answer (early media); relayed 180 has `Content-Length: 0`. Offerer never receives the answer.

- Hop: `B2BUA → alice`
- **Tests:** `suppress-18x-basic`

### H7 · `duplicate_180_retransmit_from_uas` — RFC 3261 §13.3.1.1 / RFC 3262 §3
Winning b-leg sends two identical 180s (same branch, same To-tag, no `RSeq` / no `Require:100rel`). Non-reliable provisional retransmissions are not defined outside 100rel; B2BUA should absorb the second.

- Hop: `bob2 → B2BUA`
- **Tests:** `suppress-18x-failover-reject`

### H8 · `bye_request_uri_not_remote_target` — RFC 3261 §12.2.1.1
In-dialog BYE toward alice has `Request-URI: sip:target@127.0.0.1:15661`; alice's Contact from initial INVITE was `sip:127.0.0.1:15661` (no user). B2BUA injected a synthetic user part.

- Hop: `B2BUA → alice` BYE
- **Tests:** `delayed-offer-failure`

### H9 · `missing_allow_on_invite_or_2xx` (escalated) — RFC 3261 §13.2.1 / §20.5
Called out specifically as HIGH by one reviewer because it breaks `OPTIONS`-less capability discovery during an active dialog. See `allow_supported_missing` aggregate in LOW for the full test list.

- **Tests (escalated):** `call-setup+caller-bye`

---

## MEDIUM (correctness / best practice)

### M1 · `bye_missing_contact` (in-dialog BYE) — RFC 3261 §8.1.1.8 / §12.2.1.1
B2BUA-originated BYE requests do not carry a Contact header, denying the peer any chance of target refresh. Recommended (SHOULD) for mid-dialog requests.

- **Tests (5):**
  - `call-setup+bob-reinvite-fragment`
  - `record-route-basic`
  - `record-route-fake-rr`
  - `suppress-18x-failover-no-answer`
  - `suppress-18x-failover-reject`

### M2 · `sdp_version_not_incremented` — RFC 3264 §8
Answer carries same `o=` version as prior answer despite changed media (port 20000 → 30000).

- **Tests:** `call-setup+alice-reinvite-fragment`

### M3 · `sdp_retransmitted_in_2xx_after_reliable_183` — RFC 3264 §5 / RFC 3262 §5
Identical SDP answer delivered in reliable 183 and again in 200 OK. Per §5 of RFC 3262, 2xx after a reliable 1xx must not repeat the same offer/answer.

- **Tests:** `prack`

### M4 · `duplicate_180_relayed` — RFC 3261 §17.2.1
B2BUA forwards both copies of a UAS-retransmitted 180 instead of absorbing.

- **Tests:** `suppress-18x-disabled`

### M5 · `record_route_absent_on_dialog_establishment` — RFC 3261 §16.6 / §12.1
No Record-Route inserted on any leg, despite test name implying RR behavior. Acceptable for a pure B2BUA but notable when the test intent is path preservation.

- **Tests:** `record-route-basic`

### M6 · `missing_allow_header` (INVITE / 2xx) — RFC 3261 §13.2.1 / §20.5
INVITE and 2xx responses lack `Allow`, preventing peer from discovering supported methods.

- **Tests (8):**
  - `explicit-route-call`
  - `failover-with-headers`
  - `call-reject`
  - `call-setup+alice-reinvite-fragment`
  - `call-setup+bob-reinvite-fragment`
  - `call-setup+caller-bye` (HIGH for this one — see H9)
  - `delayed-offer-failure`
  - `record-route-basic`

### M7 · `missing_supported_header` — RFC 3261 §20.37
No `Supported` on any INVITE/2xx → option-tag negotiation (timer, 100rel, path…) impossible.

- **Tests (8):**
  - same list as M6

### M8 · `to_tag_fabricated_on_a_leg_without_upstream_anchor` — RFC 3261 §12.1
On failover, B2BUA fabricates an a-leg To-tag (`212uz1z7`) that never appeared on the b-leg. Internally consistent on the a-leg but cannot be correlated to any real UAS dialog in the call tree.

- **Tests:** `suppress-18x-failover-reject`

---

## LOW (hygiene / style)

### L1 · `missing_server_header` — RFC 3261 §20.35
- **Tests:** `call-reject`

### L2 · `missing_date_header` — RFC 3261 §20.17
- **Tests:** `call-reject`

### L3 · `missing_contact_on_100_trying` — RFC 3261 §8.2.6 (informational only)
100 Trying without Contact is permitted; flagged only for inventory.
- **Tests:** `call-reject`, `suppress-18x-failover-reject`

### L4 · `header_order_style_content_type_before_from` — RFC 3261 §7.3.1
`Content-Type` appears before `From/To/Call-ID/CSeq` in some 200 OK responses. Allowed but atypical.
- **Tests:** `call-setup+caller-bye`, `suppress-18x-basic`, `suppress-18x-disabled`

### L5 · `cseq_non_standard_initial_value_b_leg` — RFC 3261 §8.1.1.5
b-leg INVITE CSeq seeded at large random value (e.g. `608000`, `175000`, `759000`, `864000`…). Legal per spec but may surprise strict UASes / logs.
- **Tests:** `explicit-route-call`, `record-route-fake-rr`, `call-setup+bob-reinvite-fragment`, `suppress-18x-disabled`

### L6 · `request_uri_user_added_on_in_dialog_bye` — RFC 3261 §12.2.1.1
Remote-target Contact had no user part; B2BUA synthesised `target@…` when targeting the in-dialog BYE.
- **Tests:** `call-setup+callee-bye`

### L7 · `no_provisional_before_failover_180` — RFC 3261 §13.3.1.1
After the first 18x is suppressed/absorbed, alice receives nothing until the winning b-leg rings. Acceptable if within Timer B but observable as silence.
- **Tests:** `failover-with-headers`

### L8 · `contact_in_bye_request` — RFC 3261 §8.1.1.8
Contact included on BYE where it is neither required nor harmful; inconsistent with other BYE hops that omit it.
- **Tests:** `explicit-route-call`

### L9 · `max_forwards_on_ack_for_2xx_reset_to_70` — RFC 3261 §8.1.1.6
B2BUA-originated ACK for 2xx uses `Max-Forwards: 70` rather than decrementing; acceptable since ACK for 2xx is a new UAC transaction but flagged for symmetry with other relayed requests.
- **Tests:** `failover-with-headers`, `suppress-18x-disabled`

---

## Per-Test Index

| Test | Status | Worst severity |
|------|--------|----------------|
| basic-call | CLEAN | — |
| call-reject | ANOMALIES | MEDIUM |
| call-setup+alice-reinvite-fragment | ANOMALIES | HIGH |
| call-setup+bob-reinvite-fragment | ANOMALIES | MEDIUM |
| call-setup+callee-bye | ANOMALIES | LOW |
| call-setup+caller-bye | ANOMALIES | HIGH |
| call-setup+crossing-reinvite-fragment | CLEAN | — |
| cancel | ANOMALIES | HIGH |
| delayed-offer-failure | ANOMALIES | **CRITICAL** |
| explicit-route-call | ANOMALIES | MEDIUM |
| failover-with-headers | ANOMALIES | **CRITICAL** |
| indialog-unknown-reject | CLEAN | — |
| prack | ANOMALIES | **CRITICAL** |
| prack-forking | ANOMALIES | **CRITICAL** |
| record-route-basic | ANOMALIES | MEDIUM |
| record-route-fake-rr | ANOMALIES | HIGH |
| suppress-18x-basic | ANOMALIES | HIGH |
| suppress-18x-disabled | ANOMALIES | MEDIUM |
| suppress-18x-failover-no-answer | ANOMALIES | **CRITICAL** |
| suppress-18x-failover-reject | ANOMALIES | HIGH |

---

## Recommended Follow-up Priority

1. **PRACK handling (C1, C2)** — `prack` and `prack-forking` carry two distinct CRITICAL bugs in response construction. Investigate CSeq propagation for PRACK in the relay path (likely in rules handling reliable-provisional relay and in 200/PRACK synthesis).
2. **ACK for non-2xx across failover (C3)** — three separate failover flows show missing hop-by-hop ACK in the capture. Confirm whether the capture simply drops absorbed ACKs, or if `TransactionLayer` is not emitting them before the b-leg is replaced.
3. **Delayed-offer path (C4)** — `delayed-offer-failure` shows the offer/answer inversion on both legs. Either implement delayed-offer correctly, or reject the call early with 488/606.
4. **CANCEL tag consistency (H1, H2)** — single test (`cancel`) but protocol-breaking. Check UAS-tag generation on the a-leg across 180/487/200-CANCEL.
5. **Record-Route/route-set construction (H3)** — only exercised by `record-route-fake-rr`; B2BUA is currently ignoring upstream Record-Route entirely.
6. **Reliable 1xx handling (H5, H6)** — `suppress-18x-basic` reveals a protocol hole when the suppression policy drops `Require:100rel` and the SDP without acting on the reliability.
7. **SDP version discipline (H4, M2)** — reINVITE handler should manage the `o=` version field.
8. **In-dialog BYE Contact (M1)** — consistent pattern across 5 tests; fix once at the BYE-builder.
9. **Allow/Supported hygiene (M6, M7)** — batch fix at `MessageFactory`.

---

*Source captures: `/home/vince/sipjsserver/test-results/fake-clock/*.global.txt` · Report format: one file per error with aggregated test index.*
