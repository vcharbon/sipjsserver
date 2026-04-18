# Surprises & Time Wasters — REFER Slice 5 Session

Session focus: implement slice 5 of REFER blind transfer (allow path up to final NOTIFY, no re-INVITEs).
Outcomes: 5 new e2e scenarios, 4 new C-leg rules, 3 framework touch-points. All tests green on commit `81d4fd9`.

Below: every thing that caused friction during the work, grouped by category. Each item lists a proposed fix, the reason it bit, and a priority grounded in how much time/confusion it actually cost in this session (not theoretical).

Priority scale:
- **P1** — Caused a real bug, a test re-run, or >10 minutes of code archaeology.
- **P2** — Slowed me down but I recovered from context alone. Would bite any future rule author.
- **P3** — Cosmetic / ergonomic. Worth fixing but didn't block this slice.

---

## 1. `create-leg.updateBody` was declared on the RuleAction type but ignored by `executeCreateLeg` — P1

**What happened**

The `create-leg` RuleAction in [src/b2bua/rules/framework/RuleDefinition.ts](../../src/b2bua/rules/framework/RuleDefinition.ts) exposed an `updateBody?: string | null` field. Grepping for its use in [src/b2bua/rules/framework/ActionExecutor.ts](../../src/b2bua/rules/framework/ActionExecutor.ts) returned *nothing*. I had to:

1. Realize from the allow-path rule that I needed to substitute A's SDP with a held SDP on the C INVITE.
2. Reach for `updateBody` in the type.
3. Grep for its runtime handling.
4. Discover the field was a landmine: typed but silently dropped.
5. Wire the pass-through into `executeCreateLeg` (5 lines).

**Why it bit**

TypeScript accepted my action without complaint. At runtime the body would have been A's original SDP, not the held SDP — the C leg would advertise live media, C would accept it, and A↔C media would start "working" in a broken way (A still streaming to B). The bug would have been invisible until SDP negotiation integration tests.

**Fix**

- Add a comment on every `RuleAction` field variant that is *declared but not yet implemented*: `// @unimplemented — slice N wiring`.
- Better: never merge an unused union field. If `updateBody` isn't read anywhere, the type shouldn't have it. Prefer a compile error over a runtime no-op.
- Add an ActionExecutor coverage test that asserts each field of each variant is read somewhere (grep-based suffices).

---

## 2. `confirm-dialog` action secretly rewrites the **other** leg's dialog — P1

**What happened**

The default `confirm-dialog` action, used across ~15 rules for A↔B bridging, does more than confirm the source-leg dialog: it also creates a tag-mapping entry and rewrites the peer leg's dialog so the A↔B dialog pair stays coherent. Nothing in the action's docstring on [RuleDefinition.ts](../../src/b2bua/rules/framework/RuleDefinition.ts) mentions this.

For slice 5 I need the C leg's INVITE→200 confirmed (so ACK has a toTag), but I must *not* rewrite A's dialog (would break A↔B). I only discovered the peer-sync side effect by reading `executeConfirmDialog` end-to-end, then had to design a `skipPeerSync?: boolean` escape hatch.

**Why it bit**

- ~15 minutes of code archaeology.
- The action's type/name lied about its scope.
- If I had just used the default, A↔B would have quietly desynchronized mid-transfer, a bug *very* hard to localize during integration testing.

**Fix**

- Split `confirm-dialog` into two actions:
  - `confirm-source-dialog` — does exactly the one-leg update, nothing more.
  - `confirm-bridged-dialog` — explicitly named for the A↔B pair case; contains the peer rewrite.
- Or, rename the existing action `confirm-dialog-and-peer-sync` and introduce the slimmer variant for C-leg use.
- Document every action's full side-effect surface in the action's comment block, not just its happy-path intent.

---

## 3. Refer-To header value was used verbatim as Request-URI — P1

**What happened**

The Refer-To header arrives as a name-addr: `<sip:charlie@127.0.0.1:5667>`. I plumbed it directly into `create-leg.newRuri`. `buildBLegInvite` uses `overrideUri ?? aLeg.uri` verbatim. The outbound INVITE would have had `<sip:...>` as its Request-URI. C UAS would have rejected 400.

Only caught it because I happened to read `buildBLegInvite` carefully during the ACK-timeout bug investigation. I then had to add `extractNameAddrUri(rawReferTo)` at the rule level.

**Why it bit**

- Would have shipped broken slice 5 if I had stopped reading too soon.
- The `newRuri` field has no type-level contract that it's a bare URI, not a name-addr.
- Name-addr vs bare-URI is a classic SIP trap — every codebase rediscovers it.

**Fix**

- Strongly-type: `type BareSipUri = string & { readonly __brand: "bare-uri" }` and require construction via `toBareUri(nameAddrOrBare)`.
- Or, make `newRuri`'s runtime code auto-normalize via `extractNameAddrUri` so it's robust to both formats.
- Add a unit test in `MessageFactory` for `buildBLegInvite` that passes a name-addr override and asserts angle-bracket stripping.

---

## 4. TransactionLayer auto-ACKs non-2xx, but the test DSL doesn't mention it — P1

**What happened**

My first run of the 486 and 603 scenarios failed with "Unexpected message received by charlie: ACK". The failure was long after the NOTIFY assertion, buried in the teardown step. Took one test re-run to realize the B2BUA (acting as UAC on C) auto-generated an ACK for the non-2xx response, and charlie (UAS) saw it on the wire.

The [recorder.ts](../../tests/e2e/framework/recorder.ts) docs for `receiveInitialInvite()` return `expectAck()`, but nothing explains that *non-2xx* replies also produce an ACK.

**Why it bit**

- ~10 minutes: diagnose → fix → re-run.
- Easy to miss when the rejection test's mental model is "charlie hangs up, done".

**Fix**

- Add a note to the `UasInviteTransaction.reply()` docstring: *"For non-2xx status codes, the transaction layer auto-generates an ACK. Call `.expectAck()` to consume it, or use `allowExtra('ACK')`."*
- Offer a one-shot `replyAndExpectAck(status, opts?)` convenience method.

---

## 5. The rule inventory in REFERIMPL.md references a `sourceLeg:` match kind that doesn't exist — P2

**What happened**

Lines 104–112 of [docs/todos/REFERIMPL.md](REFERIMPL.md) specify matches like `sourceLeg:"c"`. The actual Matcher supports `direction:"from-a"|"from-b"|"from-any"|"self"` — no "c" discriminator. I had to invent `filter: isCLegResponse` to disambiguate C from B on `direction:"from-b"` responses.

**Why it bit**

- Three times I looked at the plan, tried to translate `sourceLeg:"c"`, realized it wasn't a real match field, and went back to writing a predicate.
- The plan misled future slice authors too: slice 6+ will need the same invention.

**Fix**

- Update REFERIMPL.md so every rule row uses match fields that actually exist.
- Or, add a `sourceLegRole:` match field (C-leg / A-leg / B-leg) backed by `call.transfer?.cLegId`. Keeps the plan language valid and avoids re-inventing `isCLegResponse` in every slice.

---

## 6. Matcher specificity model is underexplained; `defaultPriority` is mostly decorative — P2

**What happened**

The rule header convention says `defaultPriority: PRIO_C_LEG_ANSWER_INITIAL = 140`. In practice, because the Matcher ranks by **strict specificity** (singleton 2, array 1, filter +1), `defaultPriority` only tiebreaks equally-specific rules. For my C-leg response rule (cseqMethod:INVITE=2 + statusClass:2xx=2 + transferPhase=2 + direction=2 + filter=1 = 9) vs `confirm-dialog` in DialogRules (spec ~5), priority doesn't matter — specificity already wins.

I wasted ~15 minutes assigning careful priority values and checking they didn't collide with DialogRules' defaults, only to realize priority was load-bearing on none of this.

**Why it bit**

- The convention pushes you to think in priorities. The reality is specificity-first. The two mental models fight.
- Naming `defaultPriority` suggests importance it doesn't have.

**Fix**

- Rename `defaultPriority` → `tiebreaker` and document that it's only read when specificities tie.
- Add a dev script `npm run rule-specificity-report` that prints the specificity score of every rule, so new authors can eyeball "my rule beats the default relay rule" without hand-computation.
- Strongly consider dropping `PRIO_*` constants entirely — they're noise.

---

## 7. No helper for "establish A↔B confirmed call" — copy-pasted 9 lines × 5 scenarios — P2

**What happened**

Every scenario in [tests/e2e/scenarios/refer-allow.ts](../../tests/e2e/scenarios/refer-allow.ts) and [refer-reject.ts](../../tests/e2e/scenarios/refer-reject.ts) starts with the same 9-line boilerplate: alice.invite → expect 100 → bob.receiveInitialInvite → reply 180 → expect 180 → reply 200 + sdpAnswer → expect 200 → alice.ack → bob.expect ACK. Copy-pasted 10 times across the two scenario files.

**Why it bit**

- Each copy is another place a future framework change will have to ripple through.
- Introduces bugs-via-typo (easy to forget the `sdpAnswer` body on a reply 200 OK).

**Fix**

- Add `establishABCall(s, { aliceUri, bobUri, bobPort, aliceTargetUri })` helper in [tests/e2e/helpers/](../../tests/e2e/helpers/) that returns `{ alice, bob, aliceDialog, bobDialog, aliceInviteTxn, bobInviteTxn }`.
- Follow up with `teardownABCall(alice, bob, aliceDialog, bobDialog, initiator)`.

---

## 8. X-Api-Call mechanism is ad-hoc — no schema, no type safety — P2

**What happened**

Both `/call/new` and `/call/refer` mocks read `X-Api-Call` from `sip_headers`, parse it as JSON, and branch on string keys like `refer-reject-403`, `refer-allow-c`. Keys live in comments, not in a schema. Return-shape for each key is assembled as `Record<string, unknown>` and cast to the typed response via `as CallReferResponseType`. If I write a bad instruction, TypeScript can't catch it and the mock silently returns garbage.

**Why it bit**

- Had to grep [MockCallControlServer.ts](../../src/http/MockCallControlServer.ts) for `refer_key` vs `action` repeatedly while drafting scenarios.
- The X-Api-Call "grammar" is discoverable only by reading the server code.

**Fix**

- Define Effect Schema(s) for the X-Api-Call envelope per endpoint. Decode inside the mock, surface decode errors as 400.
- Export the schemas so test scenarios can construct instructions type-safely: `xApiAllowC({ destination: {...}, no_answer_timeout_sec: 5 })` becomes statically typed.
- Document the grammar in a dedicated section of `docs/sip-call-control.yaml` or a new `docs/x-api-call.md`.

---

## 9. `flushIndexReport` + `afterAll` boilerplate duplicated in every test file — P3

**What happened**

Every new e2e test file needs:

```ts
const OUTPUT_DIR = "test-results/fake-clock"
afterAll(() => { flushIndexReport(OUTPUT_DIR) })
```

Writing it for [c-leg-lifecycle.test.ts](../../tests/e2e/refer/c-leg-lifecycle.test.ts) I copied from [reject.test.ts](../../tests/e2e/refer/reject.test.ts) without thinking. Any rename of the output dir constant ripples N places.

**Fix**

- `createSimulatedRunner({ outputDir, ... })` returns a tuple `[run, flushOnExit]` or registers the afterAll hook internally.
- Or export a `setupE2EReporting(OUTPUT_DIR)` that does the afterAll wiring.

---

## 10. Timer ID string format is magic and scattered — P3

**What happened**

Every rule cancelling a timer uses `` `refer_subscription_expiry-${ctx.callRef}` `` or `` `no-answer-${ctx.callRef}-${cLegId}` ``. The *correct* format is implicit in how TimerService assembles the IDs at creation time. I had to grep TimerService to confirm I wasn't typo-ing the cancel target.

**Why it bit**

- Every new rule that cancels a timer re-discovers the format.
- A format change breaks silently (cancel-miss means the timer fires anyway; the rule path that should short-circuit the timer's effect instead races with it).

**Fix**

- Helper `timerId("refer_subscription_expiry", callRef)` and `timerId("no_answer", callRef, legId)` with overloads, used by both creation and cancellation sites.
- Or: `cancel-timer` takes `{ timerType, legId? }` and the executor computes the id.

---

## 11. `Effect.gen(function* () { ... return {actions, state} })` for non-effectful handles is noise — P3

**What happened**

Many of my new rules wrap a pure action-list construction in `Effect.gen(function* () { ... })` because that's the pattern in the defaults. But if the handle does no `yield*` effects, `Effect.succeed({ actions, state })` would suffice and save a wrapper. The default rules mix both styles without apparent rationale.

**Why it bit**

- Minor cognitive cost writing the wrapper.
- Inconsistency makes reviewers wonder "is there an effectful thing I'm missing?"

**Fix**

- Document in [docs/AdvancedCallModel.md](../AdvancedCallModel.md) or CLAUDE.md: use `Effect.succeed` for pure action handles, `Effect.gen` only when yielding effects. Add a lint rule if feasible.

---

## 12. Filter predicates receive any `RuleContext` but most rules only want SIP events — P3

**What happened**

My `isCLegResponse` filter had to defensively check `ctx.event.type !== "sip"` and `msg.type !== "response"` even though the rule's `kind:"response"` already narrows this at the Matcher level. TypeScript doesn't know that.

**Fix**

- Type-specialize `Match.filter` per `kind`: e.g., `kind:"response"` → `filter?: (ctx: ResponseRuleContext) => boolean`. Matcher already knows the kind before calling filter.

---

## 13. Orphan-leg teardown behavior is unspecified — `allowExtra("BYE")` as safety net — P3

**What happened**

After slice 5's happy-path scenario terminates A↔B via a normal BYE sequence, the C leg is still in "confirmed" state. Does `begin-termination` BYE it? Does the happy path rely on B's BYE cascading? I don't know without reading `begin-termination` end-to-end, so I punted with `charlie.allowExtra("BYE")`.

**Why it bit**

- Silently broad — any stray charlie-bound message (CANCEL, INFO, etc.) would also be absorbed, masking regressions.

**Fix**

- Document the orphan-leg teardown guarantees in [docs/AdvancedCallModel.md](../AdvancedCallModel.md). Ideally: "at call termination, every non-terminated leg receives a BYE (confirmed) or CANCEL (trying/early)."
- Once documented, rewrite slice-5 tests to *assert* the expected teardown messages instead of tolerating them.

---

## 14. REFERIMPL.md conflates `sourceLeg` (match) with `transfer.cLegId` (runtime) — P3

**What happened**

The plan writes "Regime 1 (phases `refer-authorizing`, `c-ringing`): **fully transparent A↔B relay**..." but the actual mechanism requires inspecting `call.transfer?.cLegId` vs `ctx.sourceLeg.legId` at match time. This is not a static match kind but a runtime filter. The plan's wording implies static matching that doesn't exist. Future slice authors will re-translate.

**Fix**

- Rewrite Section "Rule inventory" using the real match-kind vocabulary.
- Or, actually add a `sourceLegRole` match kind (cf. item #5).

---

## Summary table

| # | Surprise | Priority |
|---|----------|----------|
| 1 | `create-leg.updateBody` typed but unimplemented | P1 |
| 2 | `confirm-dialog` hidden peer-sync side effect | P1 |
| 3 | `newRuri` treated Refer-To name-addr verbatim | P1 |
| 4 | Auto-ACK on non-2xx undocumented in test DSL | P1 |
| 5 | Plan's `sourceLeg:"c"` match field doesn't exist | P2 |
| 6 | `defaultPriority` is decorative; specificity wins | P2 |
| 7 | No `establishABCall` helper | P2 |
| 8 | X-Api-Call ad-hoc, no schema | P2 |
| 9 | `flushIndexReport` boilerplate duplicated | P3 |
| 10 | Magic timer ID strings | P3 |
| 11 | `Effect.gen` wrapper noise for pure handles | P3 |
| 12 | Filter predicates loosely typed | P3 |
| 13 | Orphan-leg teardown unspecified | P3 |
| 14 | Plan/code vocabulary drift | P3 |

**Hot takes (pushy):**

- **#2 (confirm-dialog peer-sync)** is my biggest complaint. It's a booby-trap. A "primitive" named `confirm-dialog` that silently touches two legs violates least-surprise. Every rule author who wants to confirm a C/D/E leg will walk into this trap. Fix it before more REFER slices land.
- **#1 (unimplemented action fields)** is a type-safety failure the codebase shouldn't accept. If a union variant's field is read nowhere, the type shouldn't declare it. "Reserve slots for future slices" is an anti-pattern — add the field when you add the handling.
- **#3 (name-addr vs bare-URI)** will bite again. Name-addr appears in From, To, Contact, Refer-To, Refer-To URIs with embedded Replaces, Route sets… Every generic URI slot in a RuleAction or MessageFactory helper should be type-branded.
- **#5, #6, #14** together tell me the rule framework's *authoring* documentation is out of sync with its *runtime* behavior. A new rule author has to read the source to know what their rule really does. Before slice 6, spend an afternoon writing "Rule Authoring Handbook" with real worked examples.
