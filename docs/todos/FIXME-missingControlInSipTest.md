## proxy+b2b/basic-call

Strict RFC violations
1. 🔴 Proxy forwarded a 100 Trying upstream — RFC 3261 §16.7 step 5

T+0.045  proxy → alice   100 Trying (INVITE)   ← MUST NOT happen
100 (Trying) is hop-by-hop. RFC 3261 §16.7 step 5: "Provisional responses other than 100 (Trying) MUST be forwarded upstream." The exclusion of 100 means a stateful proxy must absorb it. Worker-1's 100 was already telling the proxy "I have it"; alice should learn liveness only when worker-1 emits 180/183/2xx.

Effect: alice's transaction enters Proceeding twice (once on 100, again on 180), masks T1 retransmission semantics, and pollutes any UAC trying to use 100 as a debugging signal.

2. 🟠 rport not echoed back by UAS — RFC 3581 §4
Every response whose top Via was added by the proxy carries ;rport with no value:


worker-1 → proxy 100 Trying    Via: …:15060;branch=…;rport      ← must be ;rport=<srcPort>
worker-1 → proxy 180 Ringing   Via: …:15060;…;rport             ← idem
worker-1 → proxy 200 OK INVITE …;rport                          ← idem
worker-1 → proxy 200 OK BYE   …;rport                           ← idem
bob      → proxy 180 Ringing   Via: …:15060;…;rport             ← idem
bob      → proxy 200 OK INVITE …;rport
bob      → proxy 200 OK BYE   …;rport
RFC 3581 §4 (server side, MUST): "If this Via header field value contains an 'rport' parameter with no value, [the server] MUST set the value of the parameter to the source port of the request." Both worker-1 (leg-A UAS) and bob (leg-B UAS) skipped this. Harmless on loopback, fatal behind NAT.

3. 🟡 Record-Route present in 100 Trying — RFC 3261 §12.1.1 / §16.6

worker-1 → proxy   100 Trying  Record-Route: <sip:127.0.0.1:15060;…;lr>
proxy    → alice   100 Trying  Record-Route: <sip:127.0.0.1:15060;…;lr>
Record-Route only contributes to a route set when echoed in a dialog-creating response (1xx-with-tag or 2xx, RFC 3261 §12.1.1). 100 Trying has no to-tag and is not dialog-creating. Reflecting Record-Route there is vestigial, not strictly forbidden, but combined with violation #1 it leaks a Record-Route URI to alice in a message that, per the spec, alice should never have seen.

(If violation #1 is fixed, this becomes purely cosmetic on the worker→proxy hop.)

