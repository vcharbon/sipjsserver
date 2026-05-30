# ADR 0016 — Callflow services: typed per-service `ext` on Call and Leg

## Status

Proposed. Refines [ADR-0015](0015-integrator-extensibility-contract.md)
(storage mechanism) and [ADR-0014](0014-leg-kind-and-singleton-active-peer.md);
relates to [ADR-0011](0011-codec-and-opaque-apply.md).

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
- **Activation by presence** — the decision response carries a generic
  `serviceExt` descriptor (typed via `service.activate()`); `applyRoute` writes
  it into the replicated `Call.ext`; a service is active iff its `ext` key is
  present (or `alwaysActive`). Replaces the closed-`features` guard.
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
