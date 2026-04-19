# FIXME — RFC findings from `refer-gating-second-refer-c-realigning` callflow review

Source: `/sip-callflow-review` on the global trace of the `refer-gating-second-refer-c-realigning` scenario (32 passed / 0 failed).
Scope: B2BUA compliance + test-peer (bob/charlie) correctness. Proprietary `X-*` headers ignored. End-to-end ACK is by design.

Items are ordered by priority.

---

## P1 — Real B2BUA bug

### [ ] V3. Duplicate Via branch on two different ACKs to charlie
- **RFC 3261 §8.1.1.7, §17.1.1.3, §13.2.2.4**
- Both ACKs to charlie on the same dialog use `branch=z9hG4bK025ce1479d4f44e8`:
  - `T+0.166` — ACK for CSeq `392000` (first 200 OK)
  - `T+0.226` — ACK for CSeq `392001` (realigning 200 OK)
- Branch MUST be unique across space and time. Each ACK-for-2xx is its own client transaction.
- **Action**: generate a fresh `z9hG4bK…` branch for every outbound request, including each ACK-for-2xx. Audit the ACK-emit path on B-leg retargets / re-INVITEs.

---

## P2 — Test-peer SDP behavior that can mask real bugs

### [ ] V1. Charlie answers a port-0 + `a=inactive` offer with port 20001 + `a=sendrecv`
- **RFC 3264 §5.1 / §6 / §6.1**
- Offer from B2BUA: `m=audio 0 RTP/AVP 8 18 101` + `a=inactive`.
- Answer from charlie: `m=audio 20001 RTP/AVP 8 101` + `a=sendrecv`.
- Rules broken:
  - If offered port is 0, answer port MUST be 0 for that m-line.
  - `a=inactive` in offer ⇒ answer MUST be `a=inactive`.
- **Action**: fix the test UAS (sipp scenario or mock peer) to mirror port-0 and direction attributes. Otherwise realignment tests pass for the wrong reasons.

### [ ] V5. B2BUA "parking" offer is semantically ambiguous
- **RFC 3264 §5.1 vs §8.4**
- Initial INVITE to charlie mixes `c=IN IP4 0.0.0.0`, `m=audio 0`, and `a=inactive`.
- Port 0 means *remove the m-line*; `a=inactive` means *no RTP on a live stream*. Combining the two is contradictory.
- **Action**: pick exactly one semantic per park/hold flow:
  - stream remove → `m=audio 0 …` (no direction attr needed), or
  - stream hold/park → non-zero port + `a=inactive` (or `a=sendonly`).
- V1 and V5 feed each other — fix V5 and V1 becomes unambiguous to assert.

---

## P3 — Spec-hygiene / interop risk

### [ ] V4. `491 Request Pending` used to reject a second REFER
- **RFC 3261 §14.2** scopes 491 to INVITE offer/answer contention.
- RFC 3515 / RFC 6665 permit multiple concurrent REFER subscriptions.
- **Action**: replace 491 on REFER-gating with one of:
  - accept with 202 and track a second subscription, or
  - `500 Server Internal Error` + `Retry-After` (RFC 3261 §20.33) for "try again later" gating, or
  - `400 Bad Request` + `Warning` if the gating is a permanent policy.

### [ ] V6. SDP `o=` session-id changes across re-INVITE on the same leg
- **RFC 4566 §5.2, RFC 3264 §8**
- On leg B-2: initial offer `o=b2bua 0 0 IN IP4 0.0.0.0`; realigning re-INVITE `o=test 1 1 IN IP4 127.0.0.1`.
- Changing `<username, session-id>` signals a new SDP session; peers may tear down media.
- **Action**: keep B2BUA's `o=` username + session-id stable per leg; bump only the version on each offer/answer.

---

## P4 — Hygiene / consistency

### [ ] V2. Bob's in-dialog REFER uses `From: <sip:bob@test>` instead of the dialog's local URI
- **RFC 3261 §12.2.1.1**
- Dialog local URI on B-1 (bob's side) is `sip:+1234@127.0.0.1:15066`; only tags come from dialog state but URIs must also match stored local/remote URIs.
- Functionally harmless (dialog matching is Call-ID + tags) but non-compliant.
- **Action**: fix the test peer (sipp scenario) to preserve dialog URIs on in-dialog REFERs.

### [ ] V7. Inconsistent Contact on ACK across legs
- `ACK B2BUA → bob` carries a Contact; `ACK B2BUA → charlie` and `ACK B2BUA → alice` do not.
- Legal either way (target-refresh on ACK is optional), but the inconsistency suggests divergent code paths.
- **Action**: pick one policy for Contact-on-ACK and apply it uniformly across legs.

---

## Checklist reference (for future review / test assertions)

### Charlie (UAS, offer/answer)
- [ ] port 0 in offer ⇒ port 0 in answer (RFC 3264 §5.1, §6)
- [ ] mirror direction attribute: inactive→inactive, sendonly→recvonly, recvonly→sendonly (RFC 3264 §6.1)
- [ ] answer codecs ⊆ offered codecs (RFC 3264 §6)

### Bob (in-dialog UAC)
- [ ] From URI = dialog local URI, To URI = dialog remote URI (RFC 3261 §12.2.1.1)
- [ ] CSeq strictly greater than last local CSeq (RFC 3261 §8.1.1.5)

### B2BUA (UAC on outbound requests)
- [ ] fresh `z9hG4bK…` branch on every request, including each ACK-for-2xx (RFC 3261 §8.1.1.7, §17.1.1.3)
- [ ] park/hold offer uses one consistent semantic (RFC 3264 §5.1 vs §8.4)
- [ ] `o=` username + session-id stable per leg; bump version only (RFC 4566 §5.2)

### B2BUA (UAS for REFER)
- [ ] 491 reserved for INVITE offer/answer contention (RFC 3261 §14.2)
- [ ] final NOTIFY carries `Subscription-State: terminated` + sipfrag (RFC 3515 §2.4.5, RFC 6665 §4.1.3)

PRACK / UPDATE: not exercised in this flow — no RFC 3262 / RFC 3311 items.
