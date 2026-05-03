# Fake-PRACK — test-harness limitations encountered

Issues surfaced while wiring up the eight `fake-prack` scenarios. Each entry
classifies the failure as **harness limitation** (the harness flagged
something that is not a real SIP/RTP problem) or **real SIP/RTP issue**
(the harness was right; the code or scenario was wrong).

The report exists so future work can decide whether to extend the harness
or simply opt out per-scenario.

---

## 1. OfferAnswerTracker: B2BUA-originated answers are invisible

**Classification:** Harness limitation.

**What happened:** Scenarios `fake-prack-update-happy` and
`fake-prack-update-codec-mismatch` failed with
`SDP offer from bob (CSeq=N UPDATE, port=…, nonce="…") was never answered — RFC 3264 §5`.

**Root cause:** The OfferAnswerTracker
([src/test-harness/framework/offer-answer-tracker.ts:38](../../src/test-harness/framework/offer-answer-tracker.ts#L38))
observes only **agent-outbound** messages — see
[src/test-harness/framework/interpreter.ts:920-922](../../src/test-harness/framework/interpreter.ts#L920-L922):

```ts
// Track SDP offer/answer on outbound messages (RFC 3264 §5).
const outboundOaSkip = (step.skipValidation ?? []).includes("offerAnswer")
const outboundOaErrors = state.offerAnswer.observe(msg, step.agent, index, outboundOaSkip)
```

When fake-PRACK fires, the B2BUA itself constructs and sends a 200 OK to bob's
UPDATE. That response never traverses any test agent's outbound, so the
tracker's `pending[]` list keeps bob's UPDATE offer marked as unanswered for
the entire scenario. At end-of-scenario the tracker reports it as dangling.

**Real SIP impact:** None. The wire-level exchange is RFC-3264-correct: the
B2BUA emits a syntactically valid SDP answer to bob's UPDATE, with codec
intersection from alice's INVITE and the offer's `a=x-offer-id` echoed.

**Workaround:** `skipValidation: ["offerAnswer"]` on bob's UPDATE send. This
is the right opt-out because the assertion the tracker would make
("bob's offer was answered by another agent") is structurally impossible
under fake-PRACK by design.

**Future harness work (out of scope here):** Extend the tracker to optionally
observe inbound messages (since bob's stack receives the B2BUA's answer on
inbound), or add a "B2BUA-as-answerer" observer fed from the production
call-state that records every locally-constructed response.

---

## 2. Skeleton-fit answer port breaks `port = offer.port + 1` convention

**Classification:** Harness limitation.

**What happened:** Strict-nonce match in OfferAnswerTracker emits
`SDP answer port X does not match offer port Y + 1 (nonce=…) — the answer
was not derived from the offer it claims to answer`
([offer-answer-tracker.ts:91-95](../../src/test-harness/framework/offer-answer-tracker.ts#L91-L95)).

**Root cause:** The harness's test fixtures
([src/test-harness/framework/helpers/sdp.ts](../../src/test-harness/framework/helpers/sdp.ts))
encode an "answer port = offer port + 1" convention:

```ts
// sdpAnswer derives derivedPort = port ?? parsed.port + 1
```

Fake-PRACK's skeleton-fit answer
([src/sip/SdpAnswerFromOffer.ts](../../src/sip/SdpAnswerFromOffer.ts))
deliberately uses **alice's port**, not `bob.port + 1`, so that bob's RTP
flows to alice (per the design — the user explicitly accepted bob seeing
RTP from alice during early dialog).

**Real SIP impact:** None. RFC 3264 says nothing about answer port being
derived from offer port — the answer port simply tells the offerer where
to send media. Setting it to alice's address is the *correct* behavior
for our use case.

**Workaround:** Subsumed by the `skipValidation: ["offerAnswer"]` opt-out
for fake-PRACK UPDATE sends.

---

## 3. Suppress-18x strips body before tracker can see "what alice received"

**Classification:** Mixed — both a tracker subtlety and a real-protocol
nuance.

**What happened:** In the delayed-offer fallback scenario, when bob sends
a 180 with SDP body, the body is stripped by `suppress-18x` before reaching
alice. But the OfferAnswerTracker observed bob's outbound 180-with-body
and registered an SDP offer that alice never sees. Then bob's later 200 OK
also carries SDP (different nonce) — registered as a second offer. Alice's
single ACK with one answer can't satisfy both.

**Root cause:** Tracker observes the wire as bob sent it, not as alice
received it. The B2BUA's body strip is invisible to the tracker.

**Real SIP impact:** Partial. There IS a real protocol concern — bob has
an open offer (his 180 SDP) that nobody answers in the wire-level view of
bob's stack. In practice bob's stack treats the 18x as informational and
focuses on the 200 OK exchange, but a strict reading of RFC 3264 would
say bob has two unanswered offers floating around.

**Workaround applied:** Restructured the delayed-offer scenario so bob
sends a bare 180 (no body); the offer comes only in 200 OK and the answer
in alice's ACK. This is the canonical RFC 3261 §13.2.2.4 / RFC 3264 §4
delayed-offer flow and avoids the dual-offer situation entirely.

---

## 4. Subsequent reliable-1xx on a NEW b-leg cannot PRACK (latent framework bug)

**Classification:** Real framework gap — preexisting, surfaced (but not
caused) by fake-PRACK.

**What happened:** In a forking scenario where bob1 sends 18x with 100rel
(processed normally) and bob2 then sends 18x with 100rel (suppressed
because `state.firstRelayed === true`), the B2BUA never sends PRACK to
bob2. Bob2 retransmits its 18x; eventually the call hangs and CANCEL is
spammed.

**Root cause:** `executeSendPrackToLeg`
([src/b2bua/rules/framework/ActionExecutor.ts:1287-1322](../../src/b2bua/rules/framework/ActionExecutor.ts#L1287-L1322))
requires the early dialog with `bTag` to already exist on the leg:

```ts
const dialog = leg.dialogs.find((d) => dialogIdentityTag(leg.legId, d) === bTag)
  ?? leg.dialogs[0]
if (dialog === undefined) return
```

The early dialog is normally created by `relayResponseMsg` when a 1xx
with To-tag is forwarded to the peer. When suppress-18x absorbs the 1xx
*without* relaying it, the dialog never gets created, and the falling-back
to `leg.dialogs[0]` returns `undefined` for a fresh leg. The PRACK action
silently no-ops.

**Real SIP impact:** Yes — bob2 retransmits forever, then CANCELs storm
the network. This is a real bug in the existing `relayFirst18xTo180`
policy, but it's invisible today because the existing scenario suite
doesn't exercise "subsequent reliable 18x on a new leg".

**Workaround applied:** v1 fake-PRACK scenarios avoid this case (forking
test simplified so bob2 uses unreliable provisional). The fix is a
follow-up: have suppress-18x emit a `create-early-dialog` action when it
suppresses a reliable 1xx, OR have `executeSendPrackToLeg` synthesize the
dialog from the response if missing.

---

## 5. MockServer coerced strategy literals to boolean `true`

**Classification:** Mock-server bug, not the harness or real SIP.

**What happened:** Wire schema was widened to accept
`relay_first_18x_to_180: "fake-prack"` (string literal) but the existing
mock at
[src/decision/adapters/http-reference/MockServer.ts:103,149,218](../../src/decision/adapters/http-reference/MockServer.ts)
short-circuited:

```ts
if (instruction.relay_first_18x_to_180) response.relay_first_18x_to_180 = true
```

Any truthy value collapsed to `true`, which the translator then mapped to
`drop-sdp`. Fake-PRACK never activated in tests until I fixed the mock to
pass the literal through.

**Real SIP impact:** None — production HTTP backends would not have this
bug. It was a test-fixture artefact.

**Workaround applied:** All three call sites in MockServer now pass the
raw `instruction.relay_first_18x_to_180` value through (boolean OR string).

---

## 6. RuleRegistry shadow-detector counts `filter` on every policy-module rule

**Classification:** Framework subtlety, not a real bug.

**What happened:** Adding a second rule that composes with `confirm-dialog`
(my `fake-prack-inject-cached-sdp-on-200`) tripped:

```
'force-tag-consistency' and 'fake-prack-inject-cached-sdp-on-200':
overlapping match, equal specificity
```

I expected the new rule's explicit `filter` to bump its specificity by 1
above force-tag-consistency. Standalone, it does (verified with a debug
test). But
[src/b2bua/rules/framework/RuleRegistry.ts:30-44](../../src/b2bua/rules/framework/RuleRegistry.ts#L30-L44)
injects the policy-module guard as a `filter` on EVERY rule in the module:

```ts
allRules.push({
  ...rule,
  alwaysActive: true,
  match: { ...rule.match, filter: guardedFilter as never },
})
```

So both `force-tag-consistency` (no original filter) and my new rule (own
filter, composed with the guard) end up with `filter` set → equal
specificity score → conflict.

**Real SIP impact:** None. This is a framework convention.

**Workaround applied:** Folded the SDP-injection logic into
`force-tag-consistency` instead of adding a parallel composer, since the
matcher's single-level composition model can't express two pre-actions
on the same base rule.

**Future framework work (out of scope):** Either expose the original
filter to the shadow detector, or allow multiple composers on the same
base rule.

---

## Summary

| # | Issue | Class | Workaround | Future fix? |
|---|---|---|---|---|
| 1 | OA tracker only sees agent-outbound | Harness | per-step `skipValidation` | Optional inbound observer |
| 2 | `port = offer.port + 1` convention | Harness | covered by #1 opt-out | Make convention soft |
| 3 | suppress-18x strips body invisibly | Mixed | restructure scenario to canonical flow | Tracker could see "as relayed" |
| 4 | reliable-1xx on new leg doesn't PRACK | Real | scenario uses unreliable on bob2 | Framework: synth early dialog |
| 5 | MockServer coerced strategies to `true` | Mock | fixed to pass-through | n/a |
| 6 | Shadow detector vs. policy guard filter | Framework | merge rules into one composer | Filter-aware shadow check |

Net: only #4 and #5 are real defects; #5 is fixed in this branch and #4
is a known limitation gated out of v1 scenarios. The rest are harness
trade-offs that the eight v1 scenarios accept via local opt-outs.
