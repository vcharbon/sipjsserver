---
name: sip-callflow-review
description: call flow review
---

As a SIP export, review in detail this SIP exchange and list all RFC violation. There are some expected proprietary X-* header sto be ignored but list all violation of SIP exchange, SDP offer  answer model from the point of view of each agent :
Make a list of actionable check the UAS or UAC should have done to detect the issue with the assocaited RFC including

RFC SIP 3261
SDP Offer/Answer Model (RFC 3264) 
PRACK and UPDATE related RC if used.

The B2B2UA is not simulating a real user agent. It is allowed to do forking toward upstream.
Ack is end to end by design.