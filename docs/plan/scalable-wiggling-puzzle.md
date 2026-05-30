# Callflow services — typed `ext` foundation + first migration (183→200 / PEM)

## Context

The B2BUA wants integrators to build new media callflows (PRBT, announcement,
MRF-during-transfer) as **callflow services** — typed bundles of cooperating
rules — without forking core (ADR-0015, CONTEXT.md `[[callflow service]]`). The
open question driving this work: *how does the type system correlate the
extended data an integrator emits from the HTTP decision adapter with the
extended call-context their rules consume in the interpreter?*

Resolution (settled through design grilling): a typed, integrator-extensible
**`ext` slot on `Call` and on every `Leg`**, keyed by service id, **opaque to
core** but **typed at the rule layer**. The two ext types (`TCallExt`,
`TLegExt`) are **type parameters of `RuleContext`**, each an **intersection** of
per-service contributions keyed by service id (`&`, not Effect's `|` — keys are
integrator-owned, so they never collide). Core carries `ext` as opaque bytes
through its fast static codec; each service owns the codec for its slice
(core-provided for core services; integrator-provided later — they compile their
own worker, and it keeps the base codec fast).

A service is **activated by the presence of its `ext` key**, seeded from
`/call/new` through a generic descriptor channel — replacing the closed
`features`-guard model. This is the same typed channel end-to-end: the adapter
writes `ext[serviceId]`, the interpreter reads `ext[serviceId]`, correlated by
the service's schema.

The two in-tree precedents — REFER (`Call.transfer`) and `promote18xPemTo200`
(`Call.earlyPromote`) — are callflow services in all but name; they use bespoke
**named** `Call` fields and the closed `features` union. This plan builds the
**full `ext` foundation** (call-ext **and** leg-ext, the descriptor channel, and
ext-presence activation) and migrates **`promote18xPemTo200` (183→200) only** as
the first consumer. PEM uses **call-ext only**; leg-ext is built but first
consumed by REFER/PRBT. REFER is shown here for illustration, not migrated now.

This supersedes the earlier "move state into opaque `ruleState[].state` with a
decode bracket" sketch — state stays **typed**, in `ext`, not JSON-opaque.

## The model

```ts
// CORE — ext is a keyed record on Call AND Leg, opaque to core (core never reads its contents)
Leg  = Schema.Struct({ /* base */ ext: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) })
Call = Schema.Struct({ /* base */ aLeg: Leg, bLegs: Schema.Array(Leg),
                       ext: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) })

// A service declares typed ext contributions (call-level and/or leg-level) + its rules
const promotePem = defineService({
  id: "promote-pem",                                   // the ext key + activation key
  callExt: PemCallExt,                                 // { promoted, promotedSdp?, windowOpen, resyncReinviteCSeq? }
  // legExt: none for PEM
  rules: [ /* 8 rules minted via promotePem.rule(...) */ ],
})

// Worker combines services → ext types are intersections keyed by id, DERIVED via UnionToIntersection
type CallExt = { "promote-pem"?: PemCallExt } & { "transfer"?: TransferCallExt }
type LegExt  = { "transfer"?: TransferLegExt }

// RuleContext gains two ext params, defaulted so every legacy rule is untouched
interface RuleContext<TMatch extends Match = Match, TCallExt = {}, TLegExt = {}> {
  readonly call:      BaseCall & { readonly ext: TCallExt }
  readonly sourceLeg: BaseLeg  & { readonly ext: TLegExt }
}

// Adapter side (type-safe correlation): activate seeds the call-ext descriptor
newCall: req => Effect.succeed(route(dest, { serviceExt: { ...promotePem.activate({ promoted:false, windowOpen:false }) } }))
//                                                          ^ descriptor checked vs PemCallExt

// Rule side: reads/writes ONLY its own typed slice; active iff ext key present
promotePem.rule({
  match: { kind: "response", status: 183, direction: "from-b" },
  filter: ctx => ctx.call.ext["promote-pem"]!.promoted === false,
  handle: ctx => Effect.sync(() => ({ actions: [/* respond 200 */],
    callExt: { promoted: true, promotedSdp: ctx.event.message.body, windowOpen: true } })),
})
```

**Soundness:** core stores `ext` opaque; the framework decodes `ext[serviceId]`
(call) and `leg.ext[serviceId]` (legs) via that service's schema *before
matching*, so filters/handlers read a *checked* projection, never a bare cast;
the rule's returned slice is re-encoded before persist. Decode/encode are
synchronous `Schema` calls in the dispatch region → permitted by
[ADR-0003](../adr/0003-must-run-effects-under-interruption.md) (sync JS only).

## Scope — build now

**A. Schema** ([src/call/CallModel.ts](../../src/call/CallModel.ts)): add
`ext: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))` to `Leg`
and `Call`. Remove `Call.earlyPromote` + `EarlyPromoteState` (relocated as
`PemCallExt` into the PEM service file, with an added `promoted: boolean` so the
former `earlyPromote == null` becomes `!promoted` and the seed is encodable).

**B. `defineService`** (new
[src/b2bua/rules/framework/Service.ts](../../src/b2bua/rules/framework/Service.ts)):
`defineService({ id, callExt?, legExt?, alwaysActive?, rules })` →
- `.rule(...)` mints a `RuleDefinition` (via `defineRule`) bound to the service
  id, with filter/handle typed over the service's call+leg ext slice.
- `.activate(descriptor)` → a typed `{ [id]: encoded }` entry for the decision
  response (adapter-side correlation, checked vs `callExt`).
- `.toPolicyModule()` → a `PolicyModule` so `createRuleRegistry`'s flattening +
  shadow-validation ([RuleRegistry.ts:30-46](../../src/b2bua/rules/framework/RuleRegistry.ts))
  are reused. **Activation = ext-presence** (`call.ext[id]` set) OR
  `alwaysActive`; the registry composes that into each rule's filter in place of
  the old module `guard`. Schemas register into a new `RuleRegistry.services` map
  for the executor bracket.

**C. `RuleContext` generics**
([RuleDefinition.ts](../../src/b2bua/rules/framework/RuleDefinition.ts)): add
`TCallExt = {}`, `TLegExt = {}`; `call.ext: TCallExt`, `sourceLeg.ext: TLegExt`.
Defaults keep every existing `RuleContext<M>` usage compiling untouched; the
Matcher needs **no change** (it already calls `match.filter(ctx)`).

**D. Decode/encode bracket** ([RuleExecutor.ts](../../src/b2bua/rules/framework/RuleExecutor.ts)):
before `pickRanked`, for each active service decode `call.ext?.[id]` and the
source `leg.ext?.[id]` via the service schemas (seed initial when absent); expose
typed on ctx for filters/handlers. Wrap in `Effect.sync` + `Effect.catchDefect`
like the existing init hop ([:258-266](../../src/b2bua/rules/framework/RuleExecutor.ts));
decode defect → service inert this event. Re-encode the rule's returned slice
into `call.ext[id]` / `leg.ext[id]`, localized in the minted handle closure so
the executor persist sites are untouched, with a "same decoded object → reuse
original encoded" short-circuit so no-mutation rules don't force a spurious Redis
flush.

**E. Leg-ext write** ([ActionExecutor.ts](../../src/b2bua/rules/framework/ActionExecutor.ts)):
a `set-leg-ext` action (write `leg.ext[serviceId]`, id auto-filled from the
minted rule). Call-ext is written via the rule's returned `callExt` slice.

**F. Descriptor channel** (the `/call/new` → `Call.ext` path):
- [src/decision/schemas/responses.ts](../../src/decision/schemas/responses.ts):
  add `serviceExt?: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))`
  to `NewCallRouteResponse` (the generic descriptor field; typed entries built by
  `service.activate`).
- [src/decision/apply/applyRoute.ts](../../src/decision/apply/applyRoute.ts):
  write `routing.serviceExt` into `Call.ext`, mirroring the `features` line
  (:187). For PEM, additionally **derive** `ext["promote-pem"]` from
  `strategy === "promote-pem-to-200"` so the existing e2e scenarios activate PEM
  unchanged (PEM is entangled with the `relayFirst18xTo180` feature, which stays
  on `features` until migrated).

**G. PEM rewrite**
([promote18xPemTo200.ts](../../src/b2bua/rules/custom/promote18xPemTo200.ts)):
8 rules → `promotePem.rule(...)`; filters read `ctx.call.ext["promote-pem"]`
(typed); the two handle-reads similarly; `set-early-promote`/`clear-early-promote`
actions become returned `callExt` slices. `windowOpen` stays in state (no phase
machine). All 8 `overrides` preserved. Export
`promote18xPemTo200 = promotePem.toPolicyModule()` so
[B2buaCore.ts](../../src/b2bua/B2buaCore.ts) is unchanged.

**H. Remove the two actions** + `executeSetEarlyPromote` + `EarlyPromoteState`
import (RuleDefinition.ts / ActionExecutor.ts).

**I. Codec** — `Call.ext` / `Leg.ext` as keyed records of each service's
**Encoded** form (`promotedSdp` → base64, JSON-safe). Core carries the record
like `ruleState` today; no integrator bytes-codec yet.
- [call.proto](../../src/call/codec/call.proto): remove `earlyPromoteJson` /
  `earlyPromoteIsNull` (35/36); add `ext` to `Call` and `Leg` (opaque-JSON map,
  mirroring `ruleState` at [protobuf.ts:107-111](../../src/call/codec/protobuf.ts)).
  Regenerate `call.proto.gen.cjs` with pinned pbjs 1.1.3 (command in
  [protobuf.ts](../../src/call/codec/protobuf.ts) header) — generated, no hand-edit.
- [protobuf.ts](../../src/call/codec/protobuf.ts): remove earlyPromote blocks;
  add `ext` encode/decode.
- [msgpack.ts](../../src/call/codec/msgpack.ts): drop `earlyPromote` + the
  index-23 shape; add `ext` to Call/Leg structures.
- Bench mirror ([tests/bench/call-codec](../../tests/bench/call-codec)): align.

Fresh-cluster (ADR-0011) makes the wire churn free (drain + FLUSHDB + redeploy).

## Out of scope (later slices)

- **Service phase machine** (PEM uses a `windowOpen` boolean) — proven by REFER.
- **Integrator-provided per-service bytes codec** — PEM uses core schema-driven
  encoding; the fast escape hatch is proven by PRBT.
- Migrating REFER (proves leg-ext consumption + phase machine) and
  `relayFirst18xTo180` (keeps the legacy `ruleState`/`features` path until then).
- The full PRBT integrator service.

## Risks (ranked)

1. **Codec churn + proto regen** — pinned pbjs 1.1.3; msgpack records-mode order
   is position-sensitive (append-only). Gate: codec property suite + new test.
2. **`Uint8Array` in `ext`** — `promotedSdp` must ride as the Encoded base64
   string (the bracket guarantees it); a dedicated test locks the contract
   (protobuf `JSON.stringify` would corrupt a raw `Uint8Array`).
3. **Activation parity** — `applyRoute`'s PEM derivation must activate PEM under
   exactly `strategy === "promote-pem-to-200"`; the relayFirst18x feature must be
   unaffected. Gate: PEM e2e + relayFirst18x e2e both green.
4. **No-op flush regression** — handled by the "same decoded object → reuse
   original encoded" short-circuit.
5. **ADR-0003** — decode/encode are synchronous `Schema` calls wrapped like the
   existing init hop; no async/blocking IO in the dispatch region.

## Implementation order (smallest blast radius first)

1. `RuleContext` gains `TCallExt`/`TLegExt` defaults (inert; compiles).
2. `ext` on `Leg`/`Call` schema + codec carry; keep `earlyPromote` alive. Codec
   round-trip green.
3. `Service.ts` (defineService / `.rule` / `.activate` / `.toPolicyModule`) +
   registry `services` map + `set-leg-ext` action. Unused.
4. Decode/encode bracket into `RuleExecutor` (call-ext + leg-ext). Unused.
5. Descriptor channel: `serviceExt` on the response + `applyRoute` write +
   PEM derivation. Unused by rules yet.
6. Rewrite `promote18xPemTo200.ts` onto `promotePem` (call-ext); activate via
   ext-presence. PEM e2e green (earlyPromote still alive, unused).
7. Remove the two actions + handlers. Re-run e2e.
8. Remove `Call.earlyPromote` + `EarlyPromoteState`; finish codec removal +
   regen. Full typecheck + PEM e2e + codec property + new test.

## Verification

- `npm run typecheck` — tsc **and** Effect plugin, zero warnings. Residual
  `set-early-promote`/`earlyPromote` references become compile errors (proves
  removal).
- **PEM e2e**: all 8 scenarios in
  [tests/scenarios/promote-pem-to-200.ts](../../tests/scenarios/promote-pem-to-200.ts)
  green through the real RuleExecutor/registry/ActionExecutor (black-box — assert
  SIP wire, never `earlyPromote`; no edits).
- **relayFirst18x e2e** green (activation parity).
- **sdpDiff unit** ([tests/b2bua/sdpDiff.test.ts](../../tests/b2bua/sdpDiff.test.ts)) green.
- **Codec property suite** green across Msgpack / MsgpackRecords / Protobuf.
- **New codec round-trip test**: an encoded `PemCallExt` with a real
  `promotedSdp` base64 in `Call.ext["promote-pem"]` survives encode→decode across
  all three codecs and re-decodes to the original bytes — locks the
  `Uint8Array`-via-`ext` contract. Add a leg-ext round-trip case too (a typed
  `Leg.ext` entry) to exercise the leg path even though PEM doesn't.
- `npm run test:fake` (must always pass).

## Documentation, ADR & complaints updates (land in the same change)

Per the dogfood-doc "close the loop" rule, these ship **with** the code, not
after.

### NEW — `docs/adr/0016-callflow-services-typed-ext.md`

> **# ADR 0016 — Callflow services: typed per-service `ext` on Call and Leg**
>
> **## Status** — Proposed. Refines [ADR-0015](0015-integrator-extensibility-contract.md)
> (storage mechanism) and [ADR-0014](0014-leg-kind-and-singleton-active-peer.md);
> relates to [ADR-0011](0011-codec-and-opaque-apply.md).
>
> **## Context** — Integrators build callflows as bundles of cooperating rules
> ([[callflow service]]). They need typed per-call **and** per-leg data, initial
> config from `/call/new`, and replication — without core understanding each
> service and without per-service core schema changes. ADR-0015 parked this on
> opaque `activeRules[].params` + `ruleState[].state` (`Schema.Unknown`, never
> decoded — the rule generics were an unchecked cast) and a **closed** `features`
> activation union. That gave neither adapter↔interpreter type-safety nor per-leg
> data, and forced header-sniffing for activation.
>
> **## Decision**
> - **Typed `ext` on `Call` and every `Leg`** — a record keyed by service id,
>   **opaque to core** (carried, never interpreted), **typed at the rule layer**.
> - **`RuleContext<TMatch, TCallExt, TLegExt>`** — the ext types are
>   **intersections** of per-service contributions keyed by id (`&`; integrator
>   keys never collide). Each service's rules see their own typed slice.
> - **`defineService`** bundles rules + `callExt`/`legExt` schemas; rules minted
>   from it share the types by construction. The framework decodes `ext[id]` via
>   the service schema **before matching** and re-encodes the returned slice on
>   write — a checked projection, synchronous (ADR-0003).
> - **Activation by ext-presence** — the decision response carries a generic
>   `serviceExt` descriptor (typed via `service.activate()`); `applyRoute` writes
>   it into the replicated `Call.ext`; a service is active iff its `ext` key is
>   present. Replaces the closed-`features` guard.
> - **Per-service codec** — core carries `ext` as opaque bytes through its fast
>   static base codec; each service owns its slice's codec (core-provided default
>   = schema-driven Encoded form; integrator may supply a fast bytes codec).
>   Keeps base-codec speed; aligns with ADR-0011 opaque-apply.
> - **Core services express on the same template** — `promote18xPemTo200` first
>   (call-ext only); REFER + `relayFirst18xTo180` follow; their bespoke named
>   fields (`Call.transfer`, `Call.earlyPromote`) and `features` activation retire
>   as each migrates.
>
> **## Considered options** — opaque `activeRules[].params`/`ruleState` (ADR-0015
> original: untyped, no per-leg, no adapter correlation); `features.custom` bag
> (untyped, breaks the closed union); woven `ExtendedCall`/`ExtendedLeg` (most
> invasive, replaces the fast base codec); kind-discriminated payload (core learns
> integrator kinds, data only on the one leg). All rejected for the reasons given.
>
> **## Consequences** — one typed, replicated channel for adapter output *and*
> rule context (correlation by construction, not cast); `Call`/`Leg` gain an
> opaque `ext`; `RuleContext` gains two defaulted generics (legacy rules
> untouched); bespoke per-service fields/actions removed as services migrate;
> `features` shrinks to platform-only. ADR-0015's storage decision is superseded;
> its core decisions (own binary, stateless backend, B2BUA owns replicated state)
> stand.

### AMEND — `docs/adr/0015-integrator-extensibility-contract.md`

Under **Status** add "Storage mechanism refined by ADR-0016." In **Decision**,
replace the "Initial config → `Call.activeRules[].params` … Evolving state →
`ruleState[].state`" paragraph with: descriptor + state now ride in typed
`Call.ext` / `Leg.ext`, keyed by service id, decoded via the owning service's
schema (see ADR-0016). The rest of ADR-0015 stands.

### CONTEXT.md

`[[callflow service]]` term already added (this session). Refine its line to note
**ext-presence activation** (active iff its `ext` key is present). Keep the
glossary **domain-only** — do *not* add implementation terms (`ext`, "descriptor
channel"); those live in ADR-0016 (per `feedback_context_md_scope`).

### `~/complaints.md`

- **feature-activation-closed** — flip heading `NEW` → `IN-PROGRESS`; add:
  > **### fix** — Generalized as a *typed per-service descriptor channel*, not an
  > open bag. The decision response carries `serviceExt` (built type-safely by
  > `service.activate(descriptor)`, checked vs the service's `callExt` schema);
  > `applyRoute` writes it into the replicated `Call.ext`; a service activates by
  > **ext-presence** — no `features` guard, no header sniffing. Typed per service,
  > replicates opaquely (ADR-0011), and is the *same* channel the rules read
  > (`ctx.call.ext[id]`) — superseding both the suggested `features.custom` bag
  > and the `activeRules[].params` route. See ADR-0016. Mechanism lands in the
  > PEM-migration commit; RESOLVED once `rule-sdk-not-exported` exports
  > `defineService` / `service.activate` so an integrator can author **and**
  > activate a service end-to-end.
- **leg-kind-missing** — add (status stays `NEW`):
  > **### fix** — Two concerns. (a) Integrator *correlation* of a leg's role —
  > delivered by typed `Leg.ext`: a service stamps/reads `leg.ext[id]` (e.g.
  > `{ role: "media" }`), replacing the by-address hack. Lands with this plan.
  > (b) Core *failover/relay gating* (exclude media/parked legs; the unadopted-leg
  > gate) — remains ADR-0014's `Leg.kind` + adoption flag, still open (see
  > `unadopted-leg-gate-missing`).
- All other entries are untouched by this plan and stay open.

### Reference docs (update as the mechanism lands)

- [CallModel.md](../CallModel.md) — document `Call.ext` / `Leg.ext`.
- [rule-extension-guide.md](../rule-extension-guide.md) — the `defineService` /
  `.rule` / `.activate` / ext pattern.
- [AdvancedCallModel.md](../AdvancedCallModel.md) — `RuleContext` ext generics +
  the decode/encode bracket.
- [external-usage/dogfood-and-extensibility.md](../external-usage/dogfood-and-extensibility.md)
  — pointer to ADR-0016 as the validated extensibility mechanism.

## Follow-on (later slices, not this plan)

- Migrate REFER (consumes leg-ext + phase machine) and `relayFirst18xTo180`.
- PRBT integrator service (proves the integrator-owned per-service codec + a real
  adapter descriptor via `service.activate`).
- `rule-sdk-not-exported`: export `defineService` et al. so the above complaints
  reach RESOLVED.
