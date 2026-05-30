# Callflow Service primitive — minimal first slice (PEM migration)

Read-only planning output. Designs `defineService` and migrates
`promote18xPemTo200` onto it. No params/leg/dialog/phase machinery — that is
later. Project is not in production (ADR-0011 fresh-cluster per release), so
wire-format field removal is free.

## Ground truth confirmed by exploration

- Framework lives under `src/b2bua/rules/framework/` (not the path in the
  brief). Registry built in `src/b2bua/B2buaCore.ts:56`:
  `createRuleRegistry(defaultRules, [relayFirst18xTo180, promote18xPemTo200])`.
- All 8 PEM rules read `ctx.call.earlyPromote` in `match.filter` (matcher,
  pre-handle). Only `confirm-after-promote` reads it in `handle`
  (promote18xPemTo200.ts:303). All 8 use `overrides` (relay-provisional,
  suppress-18x, confirm-dialog, relay-update, relay-info, relay-ack,
  route-failure). NONE use `composesWith` — confirmed by grep.
- `stateSchema`/`stateKey` are vestigial: RuleExecutor never applies the
  schema. `getRuleState`/`setRuleState` (CallModel.ts:1191/1204) store/read
  `ruleState[].state` as a RAW value. PEM's real state is the bespoke
  `Call.earlyPromote` field, mutated by `set-early-promote`/`clear-early-promote`
  (ActionExecutor.ts:503-508, 2141-2151).
- `relayFirst18xTo180` already shares ONE `stateKey` across its 5 rules — the
  "shared stateKey == service identity" pattern is established.
- Codec reality (the load-bearing constraint):
  - `RuleStateEntry.state` is `Schema.optional(Schema.Unknown)` (CallModel.ts:510).
  - **protobuf** encodes it via `JSON.stringify` / decodes via `JSON.parse`
    (protobuf.ts:107-111, 336-341). A `Uint8Array` does NOT survive that —
    it becomes a numeric-keyed object. So `ruleState[].state` MUST hold the
    **Encoded** (JSON-safe) form, never a decoded `Uint8Array`.
  - **msgpack** preserves `Uint8Array` natively and (records mode) hardcodes a
    structure list in `msgpack.ts:36-61`: index 22 `["ruleId","state"]`,
    index 23 `["promotedSdp","windowOpen","resyncReinviteCSeq"]` (the
    EarlyPromoteState shape, used today only by the named field).
  - Codecs do NOT run `Schema.decode` on the Call — they round-trip the raw
    in-memory structure. `contracts.ts` paranoid mode only runs
    `Schema.is(CallSchema)`; `state: Unknown` accepts anything, so it would
    NOT catch a stray `Uint8Array` — protobuf JSON is the real failure point.
  - `Schema.Uint8ArrayFromBase64` has Encoded type `string` (confirmed in
    effect dist). So Encoded EarlyPromoteState =
    `{ promotedSdp: string(base64), windowOpen: boolean, resyncReinviteCSeq?: number }`
    — fully JSON-safe.
- `Schema.decodeUnknownSync`, `Schema.decodeSync`, `Schema.encodeSync` all
  exist in this Effect version (effect dist Schema.d.ts:978/987/1110).
- The 8 e2e scenarios (tests/scenarios/promote-pem-to-200.ts) are pure
  black-box: they assert SIP wire behavior, never internal `earlyPromote`.
  So they require NO edits and are a true behavior-preserving gate. The
  historical doc plan (docs/plan/2026-05-12-...glistening-biscuit.md) is the
  only other mention and is not code.

## Design decision summary (the spine)

**The Encoded↔Type boundary is `ruleState[].state`.**
- AT REST (in `Call.ruleState[serviceId].state`, between events, and through
  every codec): the **Encoded** form (JSON-safe; `promotedSdp` is base64).
- TRANSIENTLY (per event, inside one `executeRules` invocation, for filters
  and handle): the **decoded Type** (`promotedSdp` is `Uint8Array`).

The framework decodes once per active service at the top of `executeRules`
(before `pickRanked`), exposes the decoded value to filters/handle, and
re-encodes the winner's returned state before `setRuleState`. This keeps the
protobuf JSON path safe (only base64 strings cross it) and gives rules typed
state. `Call.earlyPromote` is deleted entirely.

Service id == shared `stateKey` == `ruleState[].ruleId` key.

---

## A. `defineService` primitive

New file: `src/b2bua/rules/framework/Service.ts`.

API:
```
defineService<TState>({
  id: string,
  guard: (ctx: RuleContext) => boolean,
  stateSchema: Schema.Schema<TState, TEncoded>,
  initialState: (ctx) => TState,          // "state absent" seed (replaces init)
})  =>  Service<TState>

interface Service<TState> {
  readonly id: string
  readonly guard: (ctx) => boolean
  readonly stateSchema: Schema.Schema<TState, any>
  readonly initialState: (ctx: RuleContext) => TState
  // mints a rule bound to this service; filter/handle get decoded state
  rule<TMatch extends Match>(def: {
    id, name, match: TMatch,
    overrides?: string, composesWith?: string, onError?,
    filter?: (ctx: RuleContext<TMatch>, state: TState) => boolean,
    handle: (ctx: RuleContext<TMatch>, state: TState)
              => Effect.Effect<ServiceHandleResult<TState> | undefined | void>,
  }): AnyRuleDefinition
  toPolicyModule(): PolicyModule   // bundle of minted rules + guard
}
```

`ServiceHandleResult<TState> = { actions, state: TState }` — same as
`RuleHandleResult` but `state` is the decoded Type. (Can reuse
`RuleHandleResult<TState>` directly; no new type strictly needed.)

**Mapping onto existing machinery (reuse, do not replace):**
`service.rule(...)` returns a normal `RuleDefinition` via `defineRule`, with:
- `stateKey: service.id` (so all rules in the service share one
  `ruleState[]` slot — exactly the relayFirst18x pattern).
- `match.filter` set to a framework closure (see B) that reads the
  pre-decoded state from the context and calls the user's
  `filter(ctx, state)`. The closure must be present whenever the user
  supplied a filter OR whenever specificity needs the filter bump — keep it
  identical to today (every PEM rule has a filter).
- `handle` set to a framework closure that reads the decoded state, calls the
  user's `handle(ctx, state)`, and (the result's `state`) is returned as-is;
  the executor re-encodes it (see B).
- `stateSchema`/`paramsSchema`: pass `Schema.Unknown`/`Schema.Undefined` at
  the `defineRule` level (the rule-level schema stays vestigial; the SERVICE
  owns the real schema). `init: () => undefined` (rule-level init unused —
  service `initialState` is what the framework calls).

`service.toPolicyModule()` returns `definePolicyModule({ id, guard, rules })`.
This means **`createRuleRegistry`'s guard composition + shadow validation run
unchanged** — the service is just a PolicyModule at registration. The guard
gets AND-composed into each minted rule's `match.filter` exactly as today
(RuleRegistry.ts:30-46), so the guarded filter becomes
`(ctx) => guard(ctx) && frameworkFilterClosure(ctx)`.

**How the executor learns each service's stateSchema (the registration of
the schema):** extend `RuleRegistry` with a second map:
```
interface RuleRegistry {
  readonly definitions: ReadonlyMap<string, AnyRuleDefinition>
  readonly services: ReadonlyMap<string, ServiceRuntime>  // NEW
}
interface ServiceRuntime {
  readonly id: string
  readonly stateSchema: Schema.Schema<unknown, unknown>
  readonly initialState: (ctx: RuleContext) => unknown
}
```
Change `createRuleRegistry` signature to accept services explicitly OR derive
them: simplest is to accept the same `PolicyModule[]` but have `defineService`
ALSO stamp a discoverable marker on the produced PolicyModule
(`module.__service?: ServiceRuntime`). `createRuleRegistry` collects any
`module.__service` into the `services` map. This keeps the call site in
B2buaCore.ts unchanged in shape: still
`createRuleRegistry(defaultRules, [relayFirst18xTo180, promoteService.toPolicyModule()])`.
(Alternative, cleaner long-term: a dedicated `services?: Service[]` param on
createRuleRegistry. Pick whichever the grilling prefers; the marker form is
the smallest diff and keeps one list.)

Keep minimal: no params, no per-leg/dialog, no phase. `initialState` takes
`ctx` (not params) — the PEM service ignores it and there is no decoded
service state until promotion (initial state is the "pre-promotion" value;
see C for the windowOpen-absent representation).

---

## B. Decode/encode bracket + threading decoded state to filters

All inside `executeRules` (RuleExecutor.ts:208-357). Sequence:

1. After `collectActivations` and building `ruleCtx` (line 231), BEFORE
   `pickRanked` (line 233): compute which services are active for this call
   and decode their state.
   - Active = `registry.services` whose `guard(ruleCtx)` is true. (Guard is
     pure/sync per PolicyModule contract — fine under ADR-0003.)
   - For each active service id `sid`:
     ```
     const encoded = getRuleState(call, sid)          // Encoded form or undefined
     const decoded = encoded === undefined
       ? service.initialState(ruleCtx)                 // state-absent → init
       : Schema.decodeUnknownSync(service.stateSchema)(encoded)
     ```
     Wrap in `Effect.sync(() => ...)` + `Effect.catchDefect` mirroring the
     existing init hop (RuleExecutor.ts:258-266): on decode defect, log a
     warning and SKIP the service (treat as inactive for this event) rather
     than crash the call. `decodeUnknownSync` is synchronous JS — ADR-0003
     permits it in the dispatch region (sync JS allowed; only blocking IO
     forbidden). This is the same legitimacy as the existing
     `Effect.sync(() => definition.init(...))`.
   - Build `decodedServiceState: ReadonlyMap<string, unknown>` (sid → decoded
     Type).

2. **Thread to filters.** The Matcher (`matchAccepts`/`pickRanked`) invokes
   `match.filter(ctx)`. The cleanest mechanism that touches the matcher
   minimally: add an OPTIONAL field to `RuleContext`:
   ```
   readonly serviceState?: ReadonlyMap<string, unknown>
   ```
   Populate it on `ruleCtx` once (a single augmented context object) before
   `pickRanked`. The minted `service.rule` filter closure reads
   `ctx.serviceState?.get(service.id)` and passes it to the user filter:
   ```
   match.filter = (ctx) => {
     const st = ctx.serviceState?.get(SERVICE_ID) as TState | undefined
     // st is always present when guard passed (init covers absent) — but
     // if a service was skipped on decode error, st is undefined → return
     // false (rule inert this event), matching the skip semantics.
     if (st === undefined) return false
     return userFilter(ctx, st)
   }
   ```
   Matcher.ts itself needs NO change — it already calls `match.filter(ctx)`
   with the wide ctx; we only widened the ctx type. The guard composition in
   RuleRegistry.ts also needs no change — it wraps our closure, and our
   closure reads `ctx.serviceState`.

   Touch points:
   - RuleDefinition.ts: add `serviceState?` to `RuleContext` interface
     (one optional field; legacy rules ignore it).
   - RuleExecutor.ts: populate `ruleCtx.serviceState` once.
   - Service.ts: filter/handle closures read it.
   - Matcher.ts: untouched.

3. **Thread to handle.** The minted `handle` closure reads the same
   `ctx.serviceState.get(id)` and calls `userHandle(ctx, state)`. (It does
   NOT use the executor's `state` param — that param carries the raw Encoded
   value from `getRuleState`; the service path ignores it. The executor still
   computes `state` at line 258-266 for legacy rules; for service rules it is
   harmless.)

4. **Encode the winner's returned state.** Today the non-composed path does
   `setRuleState(ruleCtx.call, stKey, outcome.state)` (RuleExecutor.ts:346).
   `outcome.state` from a service rule is the decoded Type. Re-encode before
   persisting. Two options:

   - **(Recommended) Localize in the minted handle closure.** The closure
     wraps the user result so the value handed back to the executor is
     ALREADY Encoded:
     ```
     handle: (ctx, _rawState, _params) =>
       userHandle(ctx, decodedState).pipe(Effect.map((r) =>
         r == null ? r
         : { actions: r.actions,
             state: Schema.encodeSync(service.stateSchema)(r.state) }))
     ```
     Then `outcome.state` reaching `setRuleState` is the Encoded form — NO
     change needed in RuleExecutor's persist line, and the composed path
     (lines 293-333) also stays correct because it likewise persists
     `outcome.state` (already Encoded). This is the SMALLEST executor diff:
     the bracket's encode lives in Service.ts, decode lives in
     RuleExecutor.ts (because decode must happen before matching, which is
     executor-scoped). `encodeSync` is sync JS — ADR-0003 compliant.

     Edge: a rule that returns `state` to CLEAR the service. With the named
     field gone, "clear" = return the service's empty/initial Encoded state
     (e.g. encode `initialState`), OR represent cleared as a distinct
     Encoded value. See C — PEM "clear" becomes "return windowOpen:false,
     drop resync, keep/!keep promotedSdp" depending on the rule. There is no
     longer a `null` earlyPromote; the service slot always holds a struct
     once promotion happened. (If a true "no slot" is desired post-clear, add
     an optional `state: undefined` convention that maps to `setRuleState(...,
     undefined)` which no-ops/removes — but simpler to keep a struct with
     `windowOpen:false`.)

   - (Alternative) Encode in RuleExecutor at the persist sites. Rejected:
     requires the executor to know which rules are service-bound and look up
     the schema at two persist sites (non-composed + composed) — more diff,
     more surface. Prefer localizing in the closure.

**State-absent → init.** Handled in step 1: when `getRuleState` returns
`undefined`, use `service.initialState(ctx)`. For PEM the initial state must
encode cleanly too; choose an initial Encoded value that the filters read as
"no promotion yet" (see C: `windowOpen:false` + absent `promotedSdp`? — but
`promotedSdp` is required in the current schema). Resolve by making the PEM
service state schema model the pre-promotion case (see C, "schema shape").

---

## C. PEM rule rewrite (8 rules)

File: `src/b2bua/rules/custom/promote18xPemTo200.ts`.

**Service + state schema.** Co-locate the state schema in this file (move
`EarlyPromoteState` out of CallModel.ts). The schema must represent BOTH
"not yet promoted" and "promoted" so `initialState` is encodable and filters
that today test `earlyPromote == null` have a typed equivalent.

Recommended shape (keeps windowOpen inside state, no phase machine):
```
const PemState = Schema.Struct({
  promoted: Schema.Boolean,                      // replaces `earlyPromote != null`
  promotedSdp: Schema.optional(Schema.Uint8ArrayFromBase64),
  windowOpen: Schema.Boolean,
  resyncReinviteCSeq: Schema.optional(Schema.Int),
})
initialState = () => ({ promoted: false, windowOpen: false })
```
Encoded form is JSON-safe (`promotedSdp` → base64 string when present).
Filter translations:
- `earlyPromote == null`            → `!state.promoted`
- `earlyPromote != null`            → `state.promoted`
- `earlyPromote?.windowOpen === true` → `state.windowOpen`
- `earlyPromote?.resyncReinviteCSeq` → `state.resyncReinviteCSeq`
- handle read `ctx.call.earlyPromote!.promotedSdp` (line 303) →
  `state.promotedSdp!` (non-null because `promoted` gated it).

Per-rule changes (all via `promoteService.rule({...})`):
1. promote-183-pem: filter `state => !state.promoted`. handle: drop
   `{type:"set-early-promote", update:{promotedSdp, windowOpen:true}}`;
   instead return `state: { ...state, promoted:true, promotedSdp: resp.body,
   windowOpen:true }` (resp.body is Uint8Array; closure base64-encodes it).
2. suppress-post-promote-18x: filter `state => state.promoted`. handle
   returns state unchanged (`state: state`). overrides stays `suppress-18x`.
3. confirm-after-promote: filter `state => state.promoted`. handle reads
   `state.promotedSdp!`; on equivalent SDP it cleared → return
   `{ ...state, windowOpen:false, resyncReinviteCSeq: undefined }` (the
   former `clear-early-promote`); on mismatch return
   `{ ...state, resyncReinviteCSeq: nextCSeq }` (former `set-early-promote`).
   overrides stays `confirm-dialog`.
4. promote-resync-reinvite-response: filter
   `state => state.resyncReinviteCSeq !== undefined && cseq === state.resyncReinviteCSeq`.
   handle: provisional → return undefined (unchanged); 2xx → former
   `clear-early-promote` becomes return `{ ...state, windowOpen:false,
   resyncReinviteCSeq: undefined }`; failure → return cleared state +
   begin-termination (state can stay or reset; window closed).
5. reject-a-reinvite-update: filter `state => state.windowOpen`. handle
   returns state unchanged. overrides stays `relay-update`.
6. reject-a-other-indialog: filter `state => state.windowOpen`. handle
   returns state unchanged. overrides stays `relay-info`.
7. absorb-a-ack: filter `state => state.promoted && ctx.call.activePeer === null`.
   handle returns state unchanged. overrides stays `relay-ack`.
8. b-fails-post-promote: filter `state => state.promoted`. handle: former
   `clear-early-promote` → return `{ ...state, windowOpen:false }` (or reset);
   keep terminate-leg + begin-termination. overrides stays `route-failure`.

Notes:
- Every rule that previously returned `state: undefined` now returns the
  (possibly unchanged) service state. Rules that don't mutate return the same
  `state` object — the closure re-encodes; `setRuleState` reference-equality
  no-op (CallModel.ts:1207-1208) only holds if the encoded value is
  referentially stable, which it is NOT (encodeSync makes a fresh object).
  This means a no-mutation service rule WILL now produce a new `ruleState`
  array and trigger auto-flush (RuleExecutor.ts:184-195). RISK/behavior
  change: extra Redis flushes on suppress/reject/absorb events that today
  do nothing to `earlyPromote`. Mitigation: in the minted handle closure,
  if the decoded result `state` is deep-equal to the decoded input, return
  the ORIGINAL Encoded value (the one from `getRuleState`) so `setRuleState`
  no-ops. Implement as: closure remembers the original Encoded `rawState`;
  if `r.state` is referentially identical to the `decodedState` it was given
  (rule returned the same object), persist `rawState` unchanged. This makes
  "return state untouched" a true no-op flush-wise. (Cheap, robust, and keeps
  the auto-flush diff-gate honest.)
- Guard unchanged: `ctx.call.features?.relayFirst18xTo180?.strategy ===
  "promote-pem-to-200"` becomes the SERVICE guard.
- `overrides`/`composesWith` relationships preserved verbatim (all
  `overrides`; none `composesWith`).
- Export `promote18xPemTo200 = promoteService.toPolicyModule()` so
  B2buaCore.ts:56 is unchanged.

---

## D. Removals

1. CallModel.ts:
   - Delete `EarlyPromoteState` struct (533-542) — relocate (renamed
     `PemState`) into promote18xPemTo200.ts.
   - Delete `earlyPromote: Schema.optional(Schema.NullOr(EarlyPromoteState))`
     from the Call schema (724).
2. RuleDefinition.ts:
   - Delete `set-early-promote` and `clear-early-promote` from the
     `RuleAction` union (678-679) and the doc block (670-679).
3. ActionExecutor.ts:
   - Delete the two `case` arms (503-508) and `executeSetEarlyPromote`
     (2133-2151). Remove the now-unused `EarlyPromoteState` import (line 24).
4. Codec — proto:
   - call.proto: remove `earlyPromoteJson = 35` and `earlyPromoteIsNull = 36`
     (193-194). Do NOT renumber 37/38/39 (append-only within a release is the
     rule; but since this is a fresh-cluster release, renumbering is also
     legal — leave gaps to minimize churn / keep diff small). Regen:
     `npx -p protobufjs-cli@1.1.3 pbjs --target static-module --keep-case
      --wrap commonjs --out src/call/codec/call.proto.gen.cjs
      src/call/codec/call.proto`
     (command from protobuf.ts:11-13). This regenerates call.proto.gen.cjs —
     a generated artifact; do not hand-edit.
   - protobuf.ts: remove the encode block (178-184) and decode block
     (350-354); remove the `earlyPromote` line from the header comment (29).
5. Codec — msgpack:
   - msgpack.ts CALL_STRUCTURES: remove `earlyPromote` from the top-level
     Call field list (index 0, line 37) and remove the standalone
     EarlyPromoteState shape at index 23 (line 60,
     `["promotedSdp","windowOpen","resyncReinviteCSeq"]`). IMPORTANT ordering:
     msgpackr assigns structure IDs by position. Removing index 23 shifts
     nothing AFTER it only if it is last — verify it is the last entry
     (it is, line 60 is the final array element). The NEW service state shape
     now appears INSIDE `ruleState[].state` as a plain object — in
     non-records mode it serializes structurally (fine); in records mode it
     becomes an inline object under the `["ruleId","state"]` record (index
     22). Decide whether to APPEND a new structure for the service-state
     shape `["promoted","promotedSdp","windowOpen","resyncReinviteCSeq"]` to
     CALL_STRUCTURES (append-only, keeps records-mode compact) — RECOMMENDED,
     append at the end. This is a fresh-cluster event (ADR-0011), so the
     learned-shape change is free.
6. The msgpack `CALL_STRUCTURES` field-list comment (msgpack.ts:36) and the
   bench mirror (tests/bench/call-codec/codec.ts:443,484,489,517,522 and
   fixture ruleState) — update the bench fake codec to drop `earlyPromoteJson`
   and (optionally) carry the encoded service state in `ruleState`. The bench
   codec is test-only; align it so bench/property fixtures still round-trip.

Search to confirm no stragglers (already done):
`grep -rn "earlyPromote\|EarlyPromoteState\|set-early-promote\|clear-early-promote" src tests`
— only the files above + historical doc plan reference it.

---

## E. Verification gates

1. `npm run typecheck` — tsc + Effect plugin, ZERO warnings. Watch:
   - `RuleContext.serviceState?` added; legacy rules unaffected (optional).
   - Service generic plumbing (`defineService<TState>`, `rule<TMatch>`)
     infers; the minted rule is `AnyRuleDefinition`.
   - Removed action union members: any residual `set-early-promote` reference
     is now a compile error (good — proves full removal).
   - Removed `EarlyPromoteState` import in ActionExecutor.
2. PEM e2e: all 8 scenarios in tests/scenarios/promote-pem-to-200.ts green
   through the REAL RuleExecutor/registry/ActionExecutor via
   tests/fullcall/e2e-fake-clock.test.ts. These are black-box (assert SIP
   wire, not `earlyPromote`) — no test edits; they ARE the behavior gate.
3. sdpDiff unit: tests/b2bua/sdpDiff.test.ts green (untouched; import path
   src/b2bua/rules/custom/_shared/sdpDiff.ts unchanged).
4. Existing codec property suite: tests/codec/round-trip-property.test.ts
   (Msgpack, MsgpackRecords, Protobuf, paranoid mode) green — proves the
   structure-list edits and proto regen didn't break round-trip on the
   fixture pool (representativeCall already carries a `promote-pem-to-200`
   ruleState entry; set its `state` to an encoded PemState — see below).
5. NEW codec round-trip test (the unproven path): prove an encoded `PemState`
   with a REAL `promotedSdp` base64 string survives
   encode → ruleState[].state → decode through json+protobuf+msgpack.
   - Place under tests/codec/ (e.g. service-state-round-trip.test.ts),
     mirroring round-trip-property.test.ts wiring
     (`CallBodyCodec.propertyTest(CallBodyCodec.paranoidInputs(layer))` over
     [MsgpackLayer, MsgpackRecordsLayer, ProtobufLayer]).
   - Build a Call whose `ruleState` has
     `{ ruleId: "promote_18x_pem_to_200", state: <Schema.encodeSync(PemState)({
        promoted:true, promotedSdp:<Uint8Array>, windowOpen:true,
        resyncReinviteCSeq: 42 })> }`. Assert that after encode→decode the
     `state.promotedSdp` is the SAME base64 string (protobuf JSON path) AND
     that `Schema.decodeUnknownSync(PemState)(state)` yields the original
     bytes. This is the critical proof: the protobuf JSON.stringify/parse on
     `ruleState[].state` only ever sees base64 (string) — NOT a Uint8Array.
   - RISK called out: if anyone ever stores the DECODED PemState (with a
     Uint8Array) in `ruleState[].state`, protobuf silently corrupts it. The
     test must specifically use the ENCODED form to lock the contract; add a
     comment. (msgpack would survive a raw Uint8Array; protobuf would not —
     this asymmetry is the trap.)

---

## Files to modify (exact)

- `src/b2bua/rules/framework/Service.ts` (NEW) — defineService, Service,
  minted-rule closures (decode-read in filter/handle, encode-wrap in handle).
- `src/b2bua/rules/framework/RuleDefinition.ts` — add `serviceState?` to
  RuleContext; remove `set-early-promote`/`clear-early-promote` union members.
- `src/b2bua/rules/framework/RuleExecutor.ts` — decode active-service states
  before pickRanked; populate `ruleCtx.serviceState`; (persist path unchanged
  if encode is localized in Service.ts closure).
- `src/b2bua/rules/framework/RuleRegistry.ts` — add `services` map to
  RuleRegistry; collect `module.__service` markers in createRuleRegistry
  (guard composition + shadow validation otherwise unchanged).
- `src/b2bua/rules/custom/promote18xPemTo200.ts` — rewrite 8 rules onto the
  service; co-locate PemState schema; export via toPolicyModule().
- `src/b2bua/rules/framework/ActionExecutor.ts` — remove the two action arms +
  executeSetEarlyPromote + EarlyPromoteState import.
- `src/call/CallModel.ts` — remove EarlyPromoteState + Call.earlyPromote.
- `src/call/codec/call.proto` — remove fields 35/36.
- `src/call/codec/call.proto.gen.cjs` — REGEN (do not hand-edit).
- `src/call/codec/protobuf.ts` — remove encode/decode earlyPromote blocks +
  header comment line.
- `src/call/codec/msgpack.ts` — edit CALL_STRUCTURES (drop earlyPromote field
  + index-23 shape; append service-state shape for records mode).
- `tests/bench/call-codec/codec.ts` + `tests/bench/call-codec/fixture.ts`
  (+ fixtureKinds.ts) — align bench fake codec + fixture ruleState entry to
  carry encoded PemState; drop earlyPromoteJson.
- `tests/codec/service-state-round-trip.test.ts` (NEW) — the unproven-path
  proof.
- `src/b2bua/B2buaCore.ts` — only if `toPolicyModule()` naming requires it;
  if the export keeps the name `promote18xPemTo200` as a PolicyModule, this
  file is UNCHANGED.

## Riskiest steps (ranked)

1. **Codec field removal + proto regen.** Generated cjs must be regenerated
   with the pinned pbjs 1.1.3; msgpack records-mode structure ordering is
   position-sensitive (append-only). Gate: full codec property suite + new
   round-trip test across all 3 layers. Fresh-cluster (ADR-0011) makes the
   shape change legal but the round-trip MUST stay green.
2. **Matcher filter-state threading.** Must keep ADR-0003: decode is sync JS
   in the dispatch region (allowed). The `serviceState` map must be populated
   on the SAME ctx object the matcher and handlers see, and the guard-composed
   filter (RuleRegistry) must still find it. Subtle: a service skipped on
   decode-error must make its rules inert (filter returns false) without
   throwing.
3. **No-op flush regression.** Service rules that return unchanged state must
   NOT trigger spurious Redis flushes — implement the "same decoded object →
   reuse original Encoded rawState" short-circuit in the minted handle closure
   (preserves setRuleState reference-equality no-op).
4. **ADR-0003 compliance of the decode hop.** Use `Schema.decodeUnknownSync` /
   `encodeSync` (sync), wrapped exactly like the existing
   `Effect.sync(() => init(...))` + `Effect.catchDefect` at
   RuleExecutor.ts:258-266. No async, no blocking IO introduced.

## Implementation order (smallest blast radius first)

1. Add `serviceState?` to RuleContext (inert; compiles; no behavior change).
2. Build Service.ts (defineService + minted closures + toPolicyModule) and
   the RuleRegistry `services` map + marker collection. Still unused.
3. Wire the decode bracket into RuleExecutor (populate serviceState before
   pickRanked). Still unused (no service registered yet).
4. Rewrite promote18xPemTo200.ts onto the service; co-locate PemState. Keep
   `Call.earlyPromote` + actions ALIVE temporarily so the file compiles
   against the old codec — but rules now use service state. Run PEM e2e
   green here (proves the service path end-to-end with the field still
   present but unused).
5. Remove the action union members + ActionExecutor handlers. Re-run e2e.
6. Remove `Call.earlyPromote` + EarlyPromoteState from CallModel. Fix codec
   (proto fields, regen cjs, protobuf.ts, msgpack.ts, bench codec/fixtures).
7. Add the new codec round-trip test. Run full typecheck + PEM e2e + codec
   property + new test. Green = done.
