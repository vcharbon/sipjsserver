---
name: global trace report omits transaction-layer auto-ACKs
description: The .global.txt call-flow renderer hides transaction-layer auto-ACKs for non-2xx final responses
type: reference
---

The `test-results/fake-clock/.../<scenario>.global.txt` reports do not
render auto-ACKs emitted by the transaction layer for non-2xx final
responses (RFC 3261 §17.1.1.3). This makes some traces look like they
are missing an ACK between a non-2xx final response and a follow-up
BYE.

How to recognise: scenario file uses `alice.allowExtra("ACK")` or
`bob.allowExtra("ACK")` to absorb the unrendered ACK on the endpoint
side. The auto-ACK is happening on the wire; it just isn't in the
global report.

How to apply: when reviewing a global trace, do NOT report the missing
auto-ACK as a §17.1.1.3 violation. Note it as a trace-presentation
defect, not a protocol defect. The per-endpoint trace files (if
generated) should show the ACK.

Affected examples in the promote-pem suite:
- `promote-pem-b-fails-post-promote.global.txt` — auto-ACK for Bob's
  503 not shown.
- `promote-pem-resync-failed-by-a.global.txt` — auto-ACK for Alice's
  488 to the resync re-INVITE not shown.
