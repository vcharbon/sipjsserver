# Surprises & Time Wasters — Type-Narrowed RuleContext Session

**Session focus:** lift the runtime invariants the parser/transaction-layer/dispatcher already enforce into the type system, so rule handlers can stop re-checking them. Three PRs landed (`f5dc42b`, `77cec4f`, `845ad78`) plus one followup (`25de99f`) — parser tightening, 100 Trying absorption, generic `RuleContext<TMatch>`, `defineRule` factory, full TransferRules.ts rewrite, sweep of Dialog/CornerCase/Failure rules, and the missed custom/relayFirst18xTo180.

Below: every friction point that bit during the work, with proposed fixes and priorities grounded in real time/confusion cost in this session.

**Priority scale**
- **P1** — Caused a real bug, a missed file, or >10 minutes of archaeology / iteration.
- **P2** — Slowed me down but I recovered from context. Would bite any future contributor.
- **P3** — Cosmetic / process. Worth fixing but didn't block this work.

---

## 1. CLAUDE.md does not list `src/b2bua/rules/custom/` as a place rules live — P1

**What happened**

The plan agent + my own scoping listed PR3's targets as "DialogRules + FailureRules + CornerCaseRules" — all under `src/b2bua/rules/defaults/`. I shipped PR3, ran tests green, declared done. The user immediately caught that `src/b2bua/rules/custom/relayFirst18xTo180.ts` had the *exact same* `(ctx.event as Extract<…>).message as SipResponse` cast pattern and `resp.parsed?.to?.tag ?? ""` defaults — left untouched because the survey only walked `defaults/`.

This required a follow-up commit (`25de99f`) and erodes confidence that the rules tree is fully consistent.

**Why it bit**

[CLAUDE.md](../../CLAUDE.md) and [docs/AdvancedCallModel.md](../AdvancedCallModel.md) describe the rule framework but don't enumerate *where rules live*. A grep for `RuleDefinition<` finds them, but my plan was based on an Explore-agent survey that only walked the obvious directory. There is no canonical "rule-tree map" anywhere a future refactor can trust.

**Fix**

- Add to [CLAUDE.md](../../CLAUDE.md): a single short section "Where rules live" listing both `src/b2bua/rules/defaults/` (built-in always-active) and `src/b2bua/rules/custom/` (per-call PolicyModule activation), with a one-line rule on when to put a rule in which.
- In [docs/rule-extension-guide.md](../rule-extension-guide.md), at the top, link the same map.
- Better: a tiny `src/b2bua/rules/index.ts` that re-exports every rule registry, so `grep "RuleDefinition\|defineRule"` is no longer the system of record for "what rules exist".

---

## 2. `MatchFilter` signature is wide-only — half the type narrowing payoff is lost in filters — P1 — **RESOLVED**

> **Status:** Fixed. `MatchFilter<M extends Match = Match>` is now generic, each
> Match interface declares its `filter?:` per-shape (`MatchFilter<RequestMatch>`,
> etc.), and 11 filter sites in TransferRules/CornerCaseRules/DialogRules
> dropped their redundant `event.type !== "sip"` / `message.type` guards. The
> matcher casts to the wide form at its single invocation site
> ([Matcher.ts:157](../../src/b2bua/rules/framework/Matcher.ts#L157)); the
> RuleRegistry policy-guard composer also casts at its framework boundary.
> Filters now see `RuleContext<RequestMatch>` (or the appropriate per-shape
> form), matching handler ergonomics for everything except literal-match
> narrowing (`method: "REFER"` etc.) — deferred until a real filter needs it.



**What happened**

`RuleContext<TMatch>` and `defineRule({...})` give handler bodies fully narrowed `event.message`, `direction`, `sourceDialog`, `call.transfer`. But `MatchFilter` is declared as `(ctx: RuleContext) => boolean` — the *wide* form. So every filter that accesses `event.message` still has to write:

```ts
filter: (ctx) => {
  if (ctx.event.type !== "sip" || ctx.event.message.type !== "response") return false
  return findPendingRequest(ctx.sourceDialog!, ctx.event.message.parsed.cseq.seq) !== undefined
}
```

The handler body for the same rule needs none of those guards. So filters and handlers have asymmetric ergonomics — exactly the friction the refactor was supposed to eliminate. I left the filter guards in PR2/PR3 with a comment explaining why; that explanation will need to be re-given to every future rule author.

**Why it bit**

The matcher invokes filters with the wide `RuleContext` because filters run *during* candidate ranking, before the rule is selected. But the matcher knows `match.kind` at filter-call time — it could trivially narrow the context before calling the filter. The wide-only signature is a self-imposed constraint, not a runtime requirement.

**Fix**

- Make `MatchFilter` generic: `type MatchFilter<M extends Match = Match> = (ctx: RuleContext<M>) => boolean`
- In each `RequestMatch` / `ResponseMatch` / etc., the `filter` field becomes `MatchFilter<this>`-shaped via a small TS trick (or a hand-rolled `RequestMatchFilter = MatchFilter<RequestMatch>`).
- Update the matcher's filter invocation site — at runtime no change; the cast is type-only.
- Sweep TransferRules / DialogRules / CornerCaseRules filters — drop the `if (ctx.event.type !== "sip")` lines that PR2/PR3 left in place.

This is the natural follow-up to PR1-3 and the next-most-impactful improvement on this axis.

---

## 3. `defineRule` infers `TState` from `init` body shape, not from `stateSchema` — P2 — **RESOLVED**

> **Status:** Fixed via `NoInfer<TState>`. `init`'s return type, `handle`'s
> `state` parameter, and `RuleHandleResult`'s state field in
> [RuleDefinition.ts:794-820](../../src/b2bua/rules/framework/RuleDefinition.ts#L794-L820)
> are now wrapped in `NoInfer<>`, so `stateSchema: Schema.Schema<TState>` is the
> sole inference site. The three `init: (): PolicyState => ({...})` workarounds
> in [relayFirst18xTo180.ts](../../src/b2bua/rules/custom/relayFirst18xTo180.ts)
> were dropped to plain `init: () => ({...})` and still typecheck;
> `state.storedATag` access in `forceTagConsistency` is correctly typed without
> the explicit return-type annotation. One-keyword fix; no API surface change.



**What happened**

In [src/b2bua/rules/custom/relayFirst18xTo180.ts](../../src/b2bua/rules/custom/relayFirst18xTo180.ts), `PolicyState` is `{ firstRelayed: boolean; storedATag?: string }`. The first attempt:

```ts
const suppress18x = defineRule({
  ...
  stateSchema: PolicyState,            // schema-typed: { firstRelayed; storedATag? }
  init: () => ({ firstRelayed: false }), // narrower object literal
  handle: (_, state) => {
    state.storedATag                    // ❌ Property 'storedATag' does not exist on type '{ firstRelayed: boolean; }'
  }
})
```

TS bound `TState` from the *narrower* `init` return shape, not from the schema. The fix `init: (): PolicyState => ({...})` is non-obvious and not documented anywhere.

I worked around it twice — once by writing explicit `defineRule<TMatch, TState, TParams>` generics (verbose, kills the inference value), once by annotating `init`'s return type. Both work; neither is intuitive.

**Why it bit**

Effect-style factories like this typically give the schema-typed `TState` priority over the init shape — the schema is the contract, init is just a constructor. Letting init's structural type win is a TS inference quirk, but `defineRule`'s API surface should be designed around it.

**Fix (one of)**

- **Recommended**: In `defineRule`, change the parameter order so `stateSchema` is inferred first. Effect Schema has `Schema.Type<typeof PolicyState>` — we can require `init` to return *exactly* `Schema.Type<TStateSchema>`, which forces TState to come from the schema.
- **Alternative**: Add a JSDoc note on `defineRule` explicitly recommending `init: (): MyState => ({...})` whenever `MyState` has optional fields, with a short rationale.
- **Alternative**: Ship a `defineRuleWithState<TState>` wrapper that takes TState as the only generic and infers the rest.

---

## 4. `Call.transfer` is `TransferState | null | undefined` — three-state nullability complicated `TransferFor<M>` — P2

**What happened**

[CallModel.ts:615](../../src/call/CallModel.ts#L615) declares `transfer: Schema.optional(Schema.NullOr(TransferState))`, which TypeScript renders as `transfer?: TransferState | null | undefined`. Three states for "no transfer":
- `undefined` — field absent (initial state)
- `null` — explicitly cleared (post-`clear-transfer`)
- `TransferState` — active

In `TransferFor<M>` (the conditional type that narrows `call.transfer` from `match.transferPhase`), I had to handle `null | undefined` for `transferPhase: null` AND for the wide `M = Match` case. The conditional became:

```ts
M extends { readonly transferPhase: null } ? null | undefined :
M extends { readonly transferPhase: ReadonlyArray<infer Q> }
  ? Q extends TransferPhase
    ? Omit<TransferState, "phase"> & { readonly phase: Q }
    : TransferState | null | undefined  // fallback for malformed array
  : TransferState | null | undefined
```

Every rule body that destructures `transfer.cLegId` needed neither — but the conditional types had to keep all three for soundness.

**Why it bit**

The `null` value is a Redis round-trip artifact (JSON serialization of `undefined`). At the schema level we could just use `Schema.optional(TransferState)` and treat `clear-transfer` as "set to undefined", letting Redis serialization handle it (Effect Schema knows how). The triple-state buys nothing semantically and bleeds complexity into every consumer.

**Fix**

- Audit `Schema.optional(Schema.NullOr(...))` across [CallModel.ts](../../src/call/CallModel.ts) — if the `null` doesn't carry distinct meaning from `undefined`, collapse to `Schema.optional(...)`.
- Document the convention in [docs/CallModel.md](../CallModel.md): "two-state nullable fields use `Schema.optional` only; if you need `null` to mean something different from `undefined`, document the distinction at the field site."
- Once `Call.transfer` is two-state, simplify `TransferFor<M>` in [RuleDefinition.ts](../../src/b2bua/rules/framework/RuleDefinition.ts).

---

## 5. `exactOptionalPropertyTypes: true` makes `CallFor<M>` non-trivially distinct from `Call` — P2

**What happened**

When I first wrote `CallFor<M> = Omit<Call, "transfer" | "state"> & { readonly transfer: TransferFor<M>; readonly state: CallStateFor<M> }`, TS rejected assignments of plain `Call` to `CallFor<Match>`:

```
Property 'transfer' is optional in type 'Call' but required in type 'CallFor<Match>'.
```

`Call.transfer` is declared `transfer?: TransferState | null` (with `?`). My replacement made it `readonly transfer: TransferState | null | undefined` — same value space, but **required** instead of optional. With `exactOptionalPropertyTypes: true`, those two are not assignable to each other.

I worked around it with a tuple-wrap guard: `[Match] extends [M] ? Call : NarrowedCall<M>` — when `M = Match` (wide), `CallFor` reduces back to `Call` exactly, preserving the optional marker.

**Why it bit**

`exactOptionalPropertyTypes: true` is a strict-mode footgun that makes `T?` and `T | undefined` distinct types. The tuple-wrap is a TS idiom but unfamiliar. A future contributor adding a new `*For<M>` derivation will hit the same wall and may not know the trick.

**Fix**

- Add a JSDoc comment on the `[Match] extends [M] ? Wide : Narrowed` pattern in [RuleDefinition.ts](../../src/b2bua/rules/framework/RuleDefinition.ts), explaining: "tuple-wrap forces non-distribution; the wide case must reduce to the original type to preserve `T?` optionality under `exactOptionalPropertyTypes: true`."
- Add a `// @ts-expect-error` test that asserts `CallFor<Match>` IS `Call` (not just structurally equivalent) — would catch a future regression where someone "simplifies" away the tuple-wrap.

---

## 6. Duplicate "B2BUA message" type — `TransactionEvent.message` and `CallEvent.message` declared independently — P2

**What happened**

Both [TransactionLayer.ts:36](../../src/sip/TransactionLayer.ts#L36) and [SipRouter.ts:49](../../src/sip/SipRouter.ts#L49) declare a `message:` field on their event union — originally both typed `SipMessage`. To migrate to the new `B2BUAMessage = SipRequest | SipResponseTagged` post-100-absorption, I had to update *both* files independently, in lockstep. If a future change to one is forgotten, the type leak is silent (one side will widen back to `SipMessage`).

There is no single "what message type does the B2BUA see post-stack" type that both layers reference.

**Why it bit**

Classic DRY: two layers, two definitions, two places to update. I caught it because I was actively refactoring; a maintenance-mode contributor wouldn't.

**Fix**

- Promote `B2BUAMessage` (already in [src/sip/types.ts](../../src/sip/types.ts)) to the canonical "post-stack message" type.
- Have `TransactionEvent.message: B2BUAMessage` and `CallEvent.message: B2BUAMessage` — both reference the same alias.
- A grep for `message:.*SipMessage` in `src/sip/` and `src/b2bua/` should return zero hits if anything besides the alias declaration uses the wide `SipMessage`.

---

## 7. Effect v4 API renames are not in any reachable cheatsheet — P2

**What happened**

While writing [tests/sip/transaction-layer-100-absorb.test.ts](../../tests/sip/transaction-layer-100-absorb.test.ts) I burned cycles on three Effect v4 API drifts:

1. `Effect.fork` exists in source but is **not exported** in the npm `effect` package — only `Effect.forkChild`, `Effect.forkScoped`, `Effect.forkDetach`. I had to discover this with `node -e "console.log(typeof effect.Effect.fork)"`.
2. `Stream.runCollect` returns `Array<A>` in v4, not `Chunk<A>`. My first attempt imported `Chunk` and used `Chunk.size` / `Chunk.getUnsafe` — both errored at runtime.
3. `Chunk.unsafeGet` was renamed to `Chunk.getUnsafe`. The error was clear (`Chunk.unsafeGet is not a function`) but cost an iteration anyway.

Total cost: ~4 test re-runs and a `node -e` exploration to discover the right API surface.

**Why it bit**

The `effect` skill at [/.claude/skills/effect/](file:///.claude/skills/effect/) describes idiomatic v4 patterns but doesn't list the v3→v4 renames. The user's CLAUDE.md memory mentions `Effect.result` API renames but not these.

**Fix**

- Extend the `effect` skill with an "API drift cheatsheet" section listing the v3→v4 renames I hit (and others — `Chunk.unsafeGet`→`getUnsafe`, `Effect.fork` not in npm, `Stream.runCollect` returns Array). This is the kind of knowledge a model needs front-loaded; it's too small to derive from source on demand.
- Or add a top-of-skill warning: "v4 renames many `unsafe*` to `*Unsafe`. When in doubt, `node -e \"console.log(Object.keys(<Module>))\"`."

---

## 8. `@effect/vitest`'s `it.scoped` deprecation message misleads — P3

**What happened**

I wrote `it.scoped(...)` thinking it was the right wrapper for an Effect test that needed a layer scope. Got:

```
test.scoped() is deprecated and will be removed in future versions. Please use test.override() instead.
Error: No test found in suite ...
```

The deprecation says use `test.override()` — but `test.override()` is for parameter overrides, not for scoped Effects. The actual answer was `it.effect(...)` (which I was already using elsewhere). 5 minutes of confused reading until I checked another test file.

**Fix**

- Not in our control (upstream `@effect/vitest`), but worth a note in the `effect` skill: "`it.scoped` is deprecated and the deprecation message is wrong — use `it.effect(...)` for Effect-returning tests."

---

## 9. No focused TransactionLayer test stack helper — every direct test re-derives the layer composition — P2

**What happened**

[tests/sip/transaction-layer-100-absorb.test.ts](../../tests/sip/transaction-layer-100-absorb.test.ts) needed a TransactionLayer with: SignalingNetwork.simulated + AppConfig + MetricsRegistry + UdpTransport + OverloadController + SipParser + TransactionLayer. The composition is non-obvious (`Layer.provideMerge` order matters), and my first attempt failed with "SipParser not found" because I had it at the wrong layer level.

The existing [tests/sip/UdpTransport-brake.test.ts](../../tests/sip/UdpTransport-brake.test.ts) and [transaction-layer-handles.test.ts](../../tests/sip/transaction-layer-handles.test.ts) build their own bespoke layer stacks too. There's no `txnLayerOnlyStack(opts)` helper alongside `fakeStackLayer` (which provides the *full* B2BUA stack — overkill for a focused TransactionLayer behavior test).

**Fix**

- Add `tests/support/txnStack.ts` exporting a minimal `txnLayerStack(opts)` that composes only what's needed to bind a `TransactionLayer` on a simulated network.
- Document in [tests/support/fakeStack.ts](../../tests/support/fakeStack.ts) header which level of fixture to reach for: `txnLayerStack` (just txn) → `udpTransportStack` (just udp) → `fakeStackLayer` (full B2BUA).

---

## 10. IDE diagnostics persist across edits and conflict with `tsc --noEmit` truth — P3

**What happened**

Multiple times during the parser tightening, the IDE's `<ide_diagnostics>` block reported errors on lines I had already corrected (e.g. it kept saying `extractCommonFields` was missing after I had switched to `extractResponseFields`). I had to ignore the diagnostics and trust `npm run typecheck` output instead.

This isn't strictly a project issue — it's editor caching — but it added cognitive overhead because every Edit returned a noisy "PostToolUse:Edit hook" with stale errors.

**Fix**

- Not really fixable in this codebase, but: in CLAUDE.md, a one-liner "if `<ide_diagnostics>` errors look stale or contradict `npm run typecheck`, trust typecheck — the IDE process is sometimes one edit behind." Saves the next contributor (or model) from chasing ghosts.

---

## 11. Plan workflow: when to skip the Plan agent is ambiguous — P3

**What happened**

The grill-me skill's Phase 2 says "**Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives" but also "**Skip agents**: Only for truly trivial tasks". The work I did was clearly non-trivial (multi-PR, types-system refactor) but after the grilling I had a clear picture and judged the Plan agent's value-add to be limited (it would mostly enumerate file changes I could enumerate myself). I skipped it and went straight to writing the final plan.

I was unsure whether this was the right call.

**Fix**

- In the `grill-me` skill, refine the Phase 2 guidance: "Skip the Plan agent when grilling has already produced (a) the full design contract, (b) every file path that will change, and (c) the specific functions / types that need to be added or modified. The Plan agent's value is highest when grilling left implementation details under-specified."
- Or: just remove the "Default: launch" language and let the grilling-or-not decision dominate.

---

## 12. Plan files get random suffixes — discoverability suffers — P3

**What happened**

The grill-me skill auto-generated the plan file path `/home/vince/.claude/plans/grill-me-on-how-hidden-eclipse.md`. The "hidden-eclipse" suffix is a session-stable random tag, which is fine for one-shot uniqueness but terrible for finding the plan again later. If I want to revisit "the plan for the type-narrowed RuleContext refactor" in a week, `ls ~/.claude/plans/` shows me a list of nonsense filenames.

**Fix**

- The grill-me skill could ask the user once near the end of grilling for a short slug ("type-narrowed-rulecontext"), then write to that path. Two seconds of friction at write time, much better discoverability later.
- Or: write a short `INDEX.md` in `~/.claude/plans/` that maps random-suffix files to human topics.

---

## Summary table

| # | Item | Priority |
|---|------|----------|
| 1 | CLAUDE.md missing `custom/` rule directory | **P1** |
| 2 | ~~`MatchFilter` is wide-only — narrowing missed in filters~~ | ~~**P1**~~ ✅ |
| 3 | ~~`defineRule` `TState` inference quirk (init shape vs schema)~~ | ~~P2~~ ✅ |
| 4 | `Call.transfer` is `TransferState \| null \| undefined` | P2 |
| 5 | `exactOptionalPropertyTypes` requires tuple-wrap in conditional types | P2 |
| 6 | Duplicate "B2BUA message" type in TransactionEvent + CallEvent | P2 |
| 7 | Effect v4 API renames not in skill (Chunk, Stream.runCollect, fork) | P2 |
| 8 | `it.scoped` deprecation message misleads | P3 |
| 9 | No focused TransactionLayer test stack helper | P2 |
| 10 | IDE diagnostics stale across edits | P3 |
| 11 | grill-me Plan-agent skip-criteria ambiguous | P3 |
| 12 | Plan files have random suffixes (poor discoverability) | P3 |
