# ADR 0016 — Callflow services: typed per-service `ext` on Call and Leg

## Status

Implemented. `defineService` + typed `Call.ext` / `Leg.ext`, ext-presence
activation (`applyRoute` writes the decision response's `serviceExt`), and the
single precise `isApplicable` guard are live; PEM + REFER + `relayFirst18xTo180`
run on the template. The service-authoring surface is exported through the
`@vcharbon/sipjs/rules-sdk` entrypoint (see ADR-0015). Refines
[ADR-0015](0015-integrator-extensibility-contract.md) (storage mechanism) and
[ADR-0014](0014-leg-kind-and-singleton-active-peer.md); relates to
[ADR-0011](0011-codec-and-opaque-apply.md).

## Context

Integrators build callflows as bundles of cooperating rules ([[callflow
service]]). They need typed per-call **and** per-leg data, initial config from
`/call/new`, and replication — without core understanding each service and
without per-service core schema changes. ADR-0015 parked this on opaque
`activeRules[].params` + `ruleState[].state` (`Schema.Unknown`, never decoded —
the rule generics were an unchecked cast) and a **closed** `features`
activation union. That gave neither adapter↔interpreter type-safety nor
per-leg data, and forced header-sniffing for activation.

## Decision

- **Typed `ext` on `Call` and every `Leg`** — a record keyed by service id,
  **opaque to core** (carried, never interpreted), **typed at the rule layer**.
- **`RuleContext<TMatch, TCallExt, TLegExt>`** — the ext types are
  **intersections** of per-service contributions keyed by id (`&`; integrator
  keys never collide). Each service's rules see their own typed slice. The two
  generics default to the base opaque type, so every legacy `RuleContext<M>`
  usage compiles untouched.
- **`defineService`** bundles rules + `callExt`/`legExt` schemas; rules minted
  from it share the types by construction. The framework decodes `ext[id]` via
  the service schema **before matching** and re-encodes the returned slice on
  write — a checked projection, synchronous (ADR-0003: sync `Schema` work in
  the dispatch region, wrapped like the existing init hop). Call-ext is written
  back via the rule's returned `callExt` slice (a `set-call-ext` action minted
  by the closure); leg-ext via a `set-leg-ext` action. A returned slice that is
  referentially the decoded input is a true no-op — no spurious Redis flush.
- **Activation by a single precise predicate** — each service has exactly one
  applicability guard `(ctx) => boolean`; individual rules never re-check
  activation (the guard is composed into every rule's `match.filter`). The
  default is presence-based: the decision response carries a generic
  `serviceExt` descriptor (typed via `service.activate()`); `applyRoute` writes
  it into the replicated `Call.ext`; the service is active iff its `ext` key is
  present (or `alwaysActive`). For richer conditions pass `isApplicable` to
  `defineService`. Replaces the closed-`features` guard. **The guard MUST be
  `false` unless the service genuinely owns the call** — see the precedence
  section below for why an over-broad guard is a defect, not just a style issue.
- **Per-service codec** — core carries `ext` as opaque bytes through its fast
  static base codec; each service owns its slice's codec (core-provided default
  = schema-driven Encoded form; integrator may supply a fast bytes codec).
  Keeps base-codec speed; aligns with ADR-0011 opaque-apply. The at-rest form
  is always the **Encoded** (JSON-safe) shape — e.g. PEM's `promotedSdp` rides
  as a base64 string, never a raw `Uint8Array` (the protobuf codec
  `JSON.stringify`s opaque ext and would corrupt a `Uint8Array`).
- **Core services express on the same template** — `promote18xPemTo200` first
  (call-ext only); REFER + `relayFirst18xTo180` follow; their bespoke named
  fields (`Call.transfer`, the retired `Call.earlyPromote`) and `features`
  activation retire as each migrates.

## Rule precedence, ordering, and the decline contract

Discovered while migrating REFER onto this template. These are framework
contracts, not advice:

- **Layered precedence, no per-rule priority.** Rule selection is
  first-match-wins by **layer**, then registration order *within* a layer.
  `createRuleRegistry` stamps core defaults `CORE_LAYER` and service /
  policy-module rules `SERVICE_LAYER`; a higher layer wins. So an active
  service automatically outranks a colliding core rule **without the author
  naming any core rule id**. There is deliberately **no specificity scoring** —
  the old per-column score was removed because it forced integrators to reason
  about a global ranking and core internals (it "doesn't scale").
- **Ordering is the author's tool, within their own layer.** Order rules
  most-specific-first within `defaultRules` (core) or within a service. The
  registry's reachability lint throws at startup only when a later rule is
  fully shadowed by an earlier *filterless* same-layer rule. `overrides` /
  `composesWith` survive as rare, layer-agnostic escape hatches: a core rule
  that must trump a service rule (e.g. `transfer-reject-replaces` over the
  service rule `transfer-reject-second-refer`), or two same-layer rules that
  must resolve one way.
- **The guard must be precise — false unless the service owns the call.** A
  too-broad guard is a correctness defect: it makes a service active alongside
  a sibling that owns the call, leaking its rules into the wrong flow. Concrete
  case: `relayFirst18xTo180`'s guard was `features.relayFirst18xTo180 !==
  undefined`, true for *all four* strategies including `promote-pem-to-200` —
  so its `suppress-18x` competed with the PEM service's `promote-183-pem` on
  the same 183. Old specificity masked it (183 outscored 1xx); the layered
  model exposed it. Fix: the guard excludes `promote-pem-to-200`, making the
  two services **mutually exclusive by applicability**. Two services that can
  both match an event must be mutually exclusive by guard (or ordered /
  `overrides`-resolved) — never left to chance.
- **Easy "active" hint.** For presence-based services, omit `isApplicable` and
  let the default guard fire on `call.ext[id]` presence (seed the slice from
  `/call/new` via `service.activate(...)`). When several strategies share one
  feature flag, the guard must discriminate the strategy this service owns, not
  the flag's mere presence.
- **Returning `undefined` declines the event.** A rule whose `handle()` returns
  `undefined`/`void` does **not** consume the event — the dispatcher proceeds
  to the next candidate (next in the same layer, then lower layers, ultimately
  a core default). Returning `{ actions: [] }` *consumes* it as a handled
  no-op. These are different: use `undefined` to defer to a more general rule;
  use `{ actions: [] }` to claim-and-do-nothing. Because a declined service
  rule falls through to core, a rule's `filter` should encode its precondition
  precisely (e.g. `ctx.sourceLeg.legId === ext.cLegId`) rather than relying on
  a defensive `undefined` return inside `handle()`.

## Considered options

- opaque `activeRules[].params` / `ruleState` (ADR-0015 original: untyped, no
  per-leg, no adapter correlation);
- `features.custom` bag (untyped, breaks the closed union);
- woven `ExtendedCall` / `ExtendedLeg` (most invasive, replaces the fast base
  codec);
- kind-discriminated payload (core learns integrator kinds, data only on the
  one leg).

All rejected for the reasons given.

## Consequences

One typed, replicated channel for adapter output *and* rule context
(correlation by construction, not cast); `Call`/`Leg` gain an opaque `ext`;
`RuleContext` gains two defaulted generics (legacy rules untouched); bespoke
per-service fields/actions removed as services migrate (`Call.earlyPromote` +
`set-early-promote` / `clear-early-promote` are gone with the PEM migration);
`features` shrinks to platform-only. ADR-0015's storage decision is
superseded; its core decisions (own binary, stateless backend, B2BUA owns
replicated state) stand.

With `relayFirst18xTo180` now migrated onto the service template (its `strategy`
+ `{ firstRelayed, storedATag }` ride in `Call.ext["relayFirst18x"]`, seeded in
`applyRoute`), the *original* ADR-0015 storage mechanism is fully retired: the
per-rule state surface (`stateSchema` / `paramsSchema` / `init`, `RuleHandleResult.state`,
`Call.ruleState`, `getRuleState`/`setRuleState`, `stateKey`) and the never-populated
`ActiveRule.params` are deleted. `RuleDefinition` is no longer generic; a rule
`handle(ctx)` returns only `{ actions }`. Typed `ext` is the single channel for
per-call rule data.
