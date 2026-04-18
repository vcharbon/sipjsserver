# Rule Framework ADT Refactor — Plan

**Status:** A + B + C + D done
**Driver:** issues #1, #2, #3 of [REFER-SLICE5-SURPRISES.md](REFER-SLICE5-SURPRISES.md) — junior-engineer fixes deemed not radical enough for long-term maintainability.
**Owner:** TBD
**Rough cost:** ~1.5 weeks focused effort, 8–10 PRs.

Only edit documentation if new refactor contradicts what is currently written.

## Why this exists

Three P1 surprises from slice 5 share a common root cause: **the `RuleAction` type declares a contract, but the `ActionExecutor` silently fails to uphold it — and TypeScript can't see the gap.**

- `create-leg.updateBody` was typed but never read by `executeCreateLeg`. Would have shipped A's live SDP as the C-leg INVITE body.
- `confirm-dialog` silently rewrote *both* legs' dialogs and the tag-mapping table; its signature advertised none of this reach.
- `create-leg.newRuri` accepted a name-addr string (`<sip:charlie@...>`) verbatim as a Request-URI; no type-level contract distinguishes bare-URI from name-addr.

Patch-the-instance fixes (add a comment, split one action, brand one slot) leave the mechanism intact. A new action or new slot will re-expose the same three traps.

**Target invariant after this refactor:**

1. Every declared field of every action is provably read by its executor (compile-time).
2. Every action's state mutation reach equals the state named in its parameters (runtime-tested).
3. Every URI, body, and header-set slot has a type that captures its semantic shape — no `string | null | undefined` tri-states.

## What's in scope

- `src/b2bua/rules/framework/RuleDefinition.ts` — `RuleAction` union, `MessageTransform`, match types.
- `src/b2bua/rules/framework/ActionExecutor.ts` — every `execute*` function.
- `src/b2bua/rules/defaults/*.ts` and `src/b2bua/rules/custom/*.ts` — every rule that emits actions (~20 files).
- `src/sip/MessageFactory.ts` — URI handling (`buildBLegInvite`, `extractNameAddrUri`, Via/Contact builders).
- Documentation: CLAUDE.md, [AdvancedCallModel.md](../AdvancedCallModel.md), [b2bua-sip-headers.md](../b2bua-sip-headers.md), [rule-extension-guide.md](../rule-extension-guide.md), [REFERIMPL.md](REFERIMPL.md).

## What's out of scope

- Migrating brands to `Schema.brand` (deferred — see TODOs at end).
- Full `SipUri` ADT (structured `{scheme, user, host, port, params, headers}` parsed/serialized at every hop). Only branded strings in this refactor.
- Restructuring the Matcher or rule registry.
- Per-kind `MatchFilter` narrowing (issue #12 of the surprises doc).

---

## Core shapes

Locked in during the design-phase grilling. These types land in Slice A and all later slices consume them.

```ts
// ── Branded URI types ─────────────────────────────────────────────────────
export type BareSipUri = string & { readonly __brand: "bare-sip-uri" }
// sip:charlie@127.0.0.1:5667;transport=udp
// No angle brackets, no display name, no header parameters.

export type NameAddr = string & { readonly __brand: "name-addr" }
// "Charlie" <sip:charlie@127.0.0.1:5667>;tag=abc123
// Angle-bracketed URI, optional display, header parameters (tag, expires, q, ...).

// Only constructors — no `as` casts allowed in the codebase.
export function toBareUri(input: string | NameAddr): BareSipUri
export function toNameAddr(uri: BareSipUri, display?: string): NameAddr
export function tagsOf(addr: NameAddr): ReadonlyMap<string, string>

// ── Body update ───────────────────────────────────────────────────────────
export type BodyUpdate =
  | { readonly kind: "inherit" }                     // pass through snapshot/source body
  | { readonly kind: "set"; readonly value: Uint8Array }
  | { readonly kind: "drop" }                        // Content-Length: 0

// ── URI update ────────────────────────────────────────────────────────────
export type RuriOp =
  | { readonly kind: "inherit" }                     // reuse a-leg URI
  | { readonly kind: "set"; readonly value: BareSipUri }

// ── Header name discriminated by well-known vs proprietary ───────────────
export type KnownHeader =
  | "From" | "To" | "Call-ID" | "CSeq" | "Via" | "Contact"
  | "Content-Type" | "Content-Length" | "Max-Forwards" | "Expires"
  | "Route" | "Record-Route" | "Supported" | "Require"
  | "Refer-To" | "Refer-Sub" | "Referred-By" | "Replaces"
  | "Diversion" | "History-Info" | "P-Asserted-Identity" | "P-Preferred-Identity"
  | "Subject" | "User-Agent" | "Allow" | "Event" | "Subscription-State"
  // Closed list; grows only when B2BUA code references a new header.

export type HeaderName =
  | { readonly kind: "well-known"; readonly name: KnownHeader }
  | { readonly kind: "proprietary"; readonly name: string }  // lowercased

// Factories — custom("From") throws at construction.
export const H: { readonly [K in KnownHeader]: HeaderName }
export function custom(name: string): HeaderName

// ── Header updates — declarative "final state" per header ────────────────
export type HeaderUpdate =
  | { readonly kind: "replace"; readonly values: readonly [string, ...string[]] }  // non-empty; ordered
  | { readonly kind: "remove" }

export type HeaderUpdates = ReadonlyMap<HeaderName, HeaderUpdate>

// Factories
export function replaceH(...values: [string, ...string[]]): HeaderUpdate
export function removeH(): HeaderUpdate

// ── Free-function readers (slot-agnostic) ─────────────────────────────────
export function readHeaders(msg: SipMessage, name: HeaderName): ReadonlyArray<string>
export function readBody(msg: SipMessage): Uint8Array | undefined
```

**Rationale summary** (full grilling transcript elided):

- **Declarative final-state over op-list**: rules read source via `readHeaders`, compute the final list, emit `replaceH(...)`. Handles multi-valued headers (Diversion, Supported), preserves ordering, and avoids the "hidden apply-order" ambiguity of a structured-spec (`{set, append, prepend, remove}`).
- **Two URI brands, not one**: name-addr and bare-URI are different grammars, each trapping the other. Separating them makes `RuriOp.set: BareSipUri` reject `Refer-To` values at the type level.
- **`HeaderName` discriminated well-known vs proprietary**: autocomplete + typo-proof for known headers; escape hatch for `X-*` and custom P-* without loosening the well-known type.
- **Readers as free functions (not context methods)**: the source of truth varies — current event, a-leg snapshot, held-SDP payload, etc. Each reader call names the message explicitly.

---

## Slice order

Each slice is independently shippable, typecheck-clean, and passes `npm test`.

### Slice A — Core types + factories + readers

**Scope:**
- Add `src/b2bua/rules/framework/actions/types.ts` exporting all shapes above.
- Add `src/b2bua/rules/framework/actions/factories.ts` exporting `H`, `custom`, `replaceH`, `removeH`, `toBareUri`, `toNameAddr`, `tagsOf`.
- Add `src/b2bua/rules/framework/actions/readers.ts` with `readHeaders`, `readBody`.
- Extend `RuleAction` union **additively**: `create-leg` gets new optional fields `bodyUpdate?: BodyUpdate`, `headerUpdates?: HeaderUpdates`, `ruri?: RuriOp`. Old fields (`updateBody`, `updateHeaders`, `newRuri`) remain; compile errors if both old and new are set for the same slot.
- `ActionExecutor.executeCreateLeg` reads new fields preferentially; falls through to old fields for unmigrated rules.

**Tests:**
- Unit: `toBareUri` round-trip (bare, name-addr with display, name-addr with header-params, malformed → typed error).
- Unit: `custom("From")` throws (well-known smuggled in).
- Unit: apply `HeaderUpdates` to a message — asserts multi-valued Diversion handled correctly, ordering preserved, `remove` erases all occurrences, `replace` replaces all occurrences.
- Unit: apply `BodyUpdate` to a message (inherit/set/drop).
- Unit: apply `RuriOp` to an outbound INVITE (inherit/set with `toBareUri` input).
- `npm run typecheck` + `npm test` green.

**Doc updates:**
- CLAUDE.md: add "Action ADTs" subsection under **Architecture** describing the new types and where to import from. Note that old `updateBody` / `updateHeaders` / `newRuri` fields are deprecated and will be removed in Slice F.
- [AdvancedCallModel.md](../AdvancedCallModel.md): new "Rule action types" section documenting `BodyUpdate`, `RuriOp`, `HeaderUpdates`, `HeaderName`. Point at it from the existing "Action types" table.
- [rule-extension-guide.md](../rule-extension-guide.md): update code examples to use `bodyUpdate`/`headerUpdates`/`ruri`; mark old fields deprecated.

---

### Slice B — Decompose `confirm-dialog` + migrate default A↔B bridging rules

**Scope:**
- New primitive actions:
  - `confirmDialog({ legId })` — touches only the named leg's dialog state.
  - `updateLegState({ legId, state, disposition? })` — generic leg state setter.
  - `addTagMapping` — already exists; verify it touches only the mapping.
- Composite factory helper in `src/b2bua/rules/framework/actions/composites.ts`:
  ```ts
  confirmBridgedCall(sourceLeg: Leg, aLeg: Leg, sourceTag: string): ReadonlyArray<Action>
  ```
- Migrate all ~15 default rules currently emitting `{ type: "confirm-dialog" }` to `...confirmBridgedCall(...)` (spread). Rules are in [src/b2bua/rules/defaults/DialogRules.ts](../../src/b2bua/rules/defaults/DialogRules.ts) and [CornerCaseRules.ts](../../src/b2bua/rules/defaults/CornerCaseRules.ts).
- The REFER slice-5 C-leg rule replaces its `skipPeerSync: true` workaround with a direct `confirmDialog({ legId: cLeg.legId })`. Remove `skipPeerSync` from the union.
- Remove the old `{ type: "confirm-dialog" }` action variant.

**Tests:**
- New unit test file `tests/unit/rules/actions-reach.test.ts`: asserts `confirmDialog({ legId: "b" })` touches only leg b (diff whole `Call` tree before/after, deep-equals every unrelated leg/dialog/mapping).
- `npm test` e2e suite must stay green — this is the compatibility test. In particular the REFER suite and every A↔B bridging scenario.
- **Kill test check:** `npm run test:rule-kill` — mutants on the new primitives should all be killed by the existing e2e coverage.

**Doc updates:**
- [AdvancedCallModel.md](../AdvancedCallModel.md): replace `confirm-dialog` entry in the action table with the three primitives + a sidebar describing `confirmBridgedCall`. Delete all mentions of `skipPeerSync`.
- [b2bua-sip-headers.md](../b2bua-sip-headers.md): if it describes "confirm-dialog behavior on the A leg" (it does — in the tag-stamping section), rewrite in terms of `updateLegState` + `addTagMapping` primitives.
- CLAUDE.md: in the "Key design decisions" bullet about confirm-dialog (if present), rewrite; otherwise ensure the "actions" vocabulary is consistent.
- [REFERIMPL.md](REFERIMPL.md): update slice 5 rule inventory rows that reference `confirm-dialog` with `skipPeerSync`. Remove the workaround note.
- [rule-extension-guide.md](../rule-extension-guide.md): replace the "confirm-dialog action" worked example with the decomposed version.

---

### Slice C — Audit + decompose remaining composite actions

Per-action mini-PRs; each one small.

**Audit targets** (confirmed composite reach suspected):

| Action | Suspected implicit reach | Primitive breakdown after decomp |
|---|---|---|
| `destroy-leg` | sends BYE or CANCEL, marks peer as unpeered, may touch tag map | `sendBye` / `sendCancel` primitives + `updateLegState` + `clearTagMapping` |
| `cancel-leg` | sends CANCEL + sets `disposition: "cancelling"` on named leg | verify named-only; if peer touched, decompose |
| `terminate-leg` | marks leg terminated + sets `byeDisposition` on named leg | verify named-only |
| `merge` / `split` | both names in parameters; verify no side effects beyond args |
| `begin-termination` | documented scope = "all live legs" + sets `call.state = "terminating"` + schedules safety timer; scope IS the call — keep as composite but document it |

**Method per action:**
1. Read the current `execute*` top-to-bottom.
2. List every state mutation.
3. Confirm each mutation's target is named in the action's parameters.
4. If any mutation touches un-named state: decompose to primitives, add factory helper for old composite behavior, migrate call sites.
5. Add a reach test (same shape as Slice B's).

**Doc updates per action migrated:**
- [AdvancedCallModel.md](../AdvancedCallModel.md) action table row rewritten.
- CLAUDE.md if the action is mentioned by name in a "Key design decisions" bullet.
- [rule-extension-guide.md](../rule-extension-guide.md) code examples.

---

### Slice D — Reach tests for every primitive action

**Scope:**
- `tests/unit/rules/actions-reach.test.ts` gets one test per primitive action, using a shared `runActions(actions, before) → after` helper and a `diffCall(before, after) → Set<string>` helper that returns dotted paths of mutated state.
- Each test asserts the mutation-path set is exactly what the action's parameters name.

**Form:**
```ts
it("confirmDialog touches only the named leg's dialog", () => {
  const before = makeBridgedCallState()
  const after  = runActions([confirmDialog({ legId: "b" })], before)
  expect(diffCall(before, after)).toEqual(new Set(["legs.b.dialog"]))
})
```

**Why a dedicated slice:** runs incrementally alongside B and C, but listed separately so the test helpers are built once and reused.

**Doc updates:**
- Add "Action reach discipline" section to [AdvancedCallModel.md](../AdvancedCallModel.md) documenting the invariant and pointing at the test file.

---

### Slice E — Migrate rule call sites from old fields to new ADTs

Mechanical. ~20 rule files. Each PR migrates one cluster (Dialog, Relay, Failure, Lifecycle, Timer, Corner, Terminating, custom policy modules).

**Scope per cluster:**
- Replace `updateBody: "..."` → `bodyUpdate: { kind: "set", value: encoder.encode("...") }` (or `replaceBody(...)` helper).
- Replace `updateHeaders: { "X-Foo": "bar", "Y": null }` → `headerUpdates: new Map([[custom("X-Foo"), replaceH("bar")], [custom("Y"), removeH()]])`.
- Replace `newRuri: "..."` → `ruri: { kind: "set", value: toBareUri("...") }` (or `overrideRuri(toBareUri(...))`).
- Remove any `extractNameAddrUri(rawReferTo)` call sites — `toBareUri()` now handles that internally.

**Tests:**
- `npm test` must stay green on every cluster PR. No behavioral change expected.
- Typecheck fails on any site using both old and new field for the same slot (Slice A introduced this as a compile error).

**Doc updates:**
- None per cluster — already covered by Slices A and B. Last cluster PR removes deprecation notes from [rule-extension-guide.md](../rule-extension-guide.md) because the code sites are all migrated.

---

### Slice F — Remove old fields from `RuleAction` union

**Scope:**
- Delete `updateBody`, `updateHeaders`, `newRuri` from the `create-leg` action.
- Delete corresponding fall-through branches in `executeCreateLeg`.
- Delete old `MessageTransform.headers: Record<string, string | null>` and `MessageTransform.body: Uint8Array | null`; replace with `headerUpdates: HeaderUpdates` and `bodyUpdate: BodyUpdate`.
- Delete `extractNameAddrUri` export from `MessageFactory.ts` if no callers remain outside of the internal `toBareUri` implementation.

**Tests:**
- Typecheck proves no references remain.
- Full `npm test` green.
- `npm run test:rule-kill` — no new surviving mutants.

**Doc updates:**
- [AdvancedCallModel.md](../AdvancedCallModel.md): remove all "deprecated" annotations added in Slice A. Remove any paragraphs describing the old tri-state semantics of `updateBody` / `updateHeaders` / `newRuri`.
- CLAUDE.md: remove the Slice-A deprecation note.
- [rule-extension-guide.md](../rule-extension-guide.md): remove deprecated-field mentions.
- [b2bua-sip-headers.md](../b2bua-sip-headers.md): if it mentions `updateHeaders` or raw `string | null` header overrides, rewrite in terms of `HeaderUpdates`.

---

### Slice G — Destructure + no-unused-vars lint on every executor

Compile-time enforcement that every action field is read by its executor. Replaces the full "solution (2)" constructor-per-action refactor with a much smaller change.

**Scope:**
- ESLint config: `@typescript-eslint/no-unused-vars: "error"` for `src/b2bua/rules/framework/ActionExecutor.ts` (or repo-wide).
- Rewrite every `execute*` to begin with a full destructure of its action parameter, marking the discriminator with `void type` to acknowledge its intentional non-use:

```ts
function executeCreateLeg(action: Extract<RuleAction, { type: "create-leg" }>, ctx: RuleContext, state: ExecutionState) {
  const { type, destination, fromInvite, headerUpdates, bodyUpdate, ruri, noAnswerTimeoutSec, callbackContext } = action
  void type  // discriminator, intentionally unused
  // every other identifier MUST be referenced in the body or CI fails
  ...
}
```

**Tests:**
- Proof test: a diagnostic PR (locally reverted before merging Slice G) that adds a new field to an action without wiring — ESLint reports unused. Screenshot/paste into the Slice G PR description as evidence.
- CI lint step must fail on unused destructured vars (verify with one temporary violation).

**Doc updates:**
- CLAUDE.md "Architecture" section: new bullet — **"Executor destructure discipline"** — with the rule and a pointer to ESLint config.
- [rule-extension-guide.md](../rule-extension-guide.md): new "Adding a new action field" section. Checklist:
  1. Add the field to the action variant in `RuleDefinition.ts`.
  2. Add the field to the destructure in the corresponding `executeXxx` in `ActionExecutor.ts`.
  3. Use the identifier in the executor body (or `void` it with an explanation comment).
  4. Add a reach test for the new field's observable effect.
  5. Re-run `npm run typecheck` + `npm run lint` + `npm test`.

---

## Per-slice doc-update checklist (summary)

| Slice | CLAUDE.md | AdvancedCallModel.md | b2bua-sip-headers.md | rule-extension-guide.md | REFERIMPL.md |
|---|---|---|---|---|---|
| A | Action ADTs subsection | New "Rule action types" section | — | Use new fields, mark old deprecated | — |
| B | `confirm-dialog` bullet rewritten | Action-table row rewritten; `skipPeerSync` purged | Tag-stamping section if it referenced confirm-dialog | Worked example rewritten | Slice 5 rows purge `skipPeerSync` |
| C | Per composite if mentioned | Per composite action-table row | — | Per composite code example | — |
| D | — | "Action reach discipline" section added | — | — | — |
| E | — | — | — | Deprecation notes removed | — |
| F | Remove deprecation note | Remove deprecation annotations; remove tri-state paragraphs | `updateHeaders` paragraph rewritten if present | Deprecated-field mentions removed | — |
| G | "Executor destructure discipline" bullet | — | — | "Adding a new action field" checklist | — |

**Rule:** every PR touching code ships with its doc delta in the same commit. No separate "docs PR" backlog.

---

## Post-refactor: follow-up TODOs (not in this plan)

1. **Migrate brands to `Schema.brand`** (deferred). Replace manual `string & { __brand }` for `BareSipUri` / `NameAddr` / `HeaderName` proprietary with Effect `Schema.brand` + runtime decoders. Gains: typed decode errors, integration with wire-boundary parsing, reusability across `SipParser` adapters.
2. **Full `SipUri` ADT** (consider only if a URI-mutation bug hits production). Parse URIs at wire boundaries into `{scheme, user?, host, port?, params, headers}`; serialize on the way out. Catches URI-construction typos (forgotten `;`, wrong separator, un-escaped `@`). Large refactor; not justified by current bug surface.
3. **Per-kind `MatchFilter` narrowing** (surprise #12). Type-specialize `MatchFilter` so `kind:"response"` filters receive `ResponseRuleContext` without defensive checks.
4. **`PRIO_*` constants audit** (surprise #6). Likely delete most; rename `defaultPriority` → `tiebreaker` in `RuleDefinition`.

---

## Exit criteria for this refactor

- No `updateBody` / `updateHeaders` / `newRuri` / `skipPeerSync` references in the codebase.
- Every primitive action has a reach test.
- ESLint fails on any unused destructured variable in any `execute*`.
- `npm run typecheck` + `npm test` + `npm run test:rule-kill` all green.
- Doc-update table above completed.
- One new e2e test validates that a rule typing a name-addr into a `ruri` slot fails to compile (via `@ts-expect-error`).
