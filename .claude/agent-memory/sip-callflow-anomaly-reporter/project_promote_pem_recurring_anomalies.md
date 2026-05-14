---
name: promote-pem-to-200 recurring anomalies
description: Status of the cross-cutting deficiencies originally documented for promote18xPemTo200; most are now FIXED as of 2026-05-12
type: project
---

The `promote18xPemTo200` policy module
(`src/b2bua/rules/custom/promote18xPemTo200.ts`) had three recurring
issues in early call-flow traces. Status as of 2026-05-12:

1. **Reason header on B2BUA-originated BYEs — FIXED.** Both
   `bFailsPostPromoteRule` and `resyncReinviteResponseRule` failure
   branch now emit BYEs carrying
   `Reason: SIP ;cause=<status>;text="<phrase>"` on the wire.
   Verified in `promote-pem-b-fails-post-promote.global.txt`
   (line 166) and `promote-pem-resync-failed-by-a.global.txt`
   (lines 233, 258).

2. **Allow / Supported on synthetic 200 OK and resync re-INVITE —
   FIXED.** Both now carry
   `Allow: INVITE, ACK, CANCEL, BYE, OPTIONS, UPDATE, INFO, REFER,
   PRACK, MESSAGE, NOTIFY` and `Supported: timer, replaces`.

3. **forking-resync now actually forks — FIXED.** 183 carries
   `tag=fork-tag-promoting-1`; the winning 200 OK carries
   `tag=fork-tag-winning-2`. The B2BUA correctly re-seeds and the
   subsequent BYE toward Bob targets the winning tag.

**Remaining gaps** (these still appear in the latest traces and
should be reported):

- `P-Early-Media: sendrecv` leaks across the B2BUA hop in the
  `no-policy-control` default-relay path (RFC 5009 §3.2 trust-domain
  scope). Visible at `promote-pem-no-policy-control.global.txt:113`.
- 491 (UPDATE) and 488 (INFO) rejection responses during the
  promote window still carry no `Reason` / `Warning` header with
  diagnostic context.
- 488 for INFO is semantically a misuse of the status (488 is
  reserved for offer/answer issues; INFO has no SDP).
- The global trace report appears to relabel auto-ACKs in
  proxy+b2b mode as "B2BUA → bob" instead of routing them via the
  proxy hop (rendering artefact, not a protocol defect).

**How to apply:** When reviewing new promote-pem traces, expect the
historical "big three" to be clean. Focus on the four remaining
items above plus anything novel (proxy hop misbehaviours, dialog
identity drift on real forks, in-dialog ladder violations).
