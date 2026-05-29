# ADR 0014 — Uniform leg collection with explicit kind; `activePeer` stays a 1↔1 singleton

## Status

Proposed.

## Context

Media callflows that an integrator wants to build on the B2BUA — PRBT
(personalised ringback), pre-call / post-call announcement, MRF usage
during a REFER transfer — all introduce a *third* leg alongside the
A-leg and the destination B-leg: a leg toward a media server (MRF) that
brokers SDP and exchanges control bodies (MSCML over INFO), but is never
a call party.

Today the call model encodes leg role **positionally** (`legId` =
`"a"`, `"b-1"`, `"b-2"`) and carries transfer-specific role state in a
side-band `TransferState` (`cLegId`, `phase`, `referrerLegId`). The REFER
C-leg already demonstrates the lifecycle these media flows need — a leg
with its own life, driven by bespoke rules, adopted by the generic relay
rules only once it is realigned into the A path (`transferPhase:
"c-realign"`). But that mechanism is transfer-specific, and there is no
first-class notion of "a leg the generic rules must not touch yet."

A tempting generalisation is a fully symmetric "list of peers" with no
distinguished leg and a multi-valued peering relation. That breaks two
load-bearing invariants: the call's identity/replication key is the
A-leg dialog (`callRef = {ordinal}|{aLegCallId}|{aLegFromTag}`), and
`activePeer` is a strict 1↔1 singleton that tag mapping, BYE pairing, and
the ADR-0011 replication apply gate all rely on.

## Decision

**The A-leg stays structurally distinguished** as the call-identity
anchor, replication partition key, and limiter subject. Generalisation
applies only to the non-A legs.

**Every non-A leg carries an explicit `kind`** — `destination` (a B-leg
toward the called party; the only kind in the failover/selection set),
`media` (a leg to an MRF; see [[media leg]] in CONTEXT.md), or
`transfer-target` (the REFER C-leg). This replaces the positional
`legId` convention and the `TransferState` reach-ins as the answer to
"what is this leg."

**`activePeer` remains a re-pointable 1↔1 singleton, never a set.** The
B2BUA bridges one pair at a time and re-points it via `merge`/`split`.
Media mixing / conferencing is the media server's responsibility, not the
B2BUA's. "List of legs" is a dynamic *collection*, bridged pairwise — not
simultaneous multi-bridging.

**Adoption is an explicit per-leg ownership flag**, defaulted from
`kind`: whether the framework's generic relay/keepalive rules own this
leg's in-dialog signaling (*adopted*) or the owning extension rule owns it
exclusively (*unadopted*). `destination` and the A-leg default adopted;
`media` is never adopted; `transfer-target` flips unadopted→adopted at
realignment, set by the owning rule. Generic relay **and** generic
keepalive both skip unadopted legs — one predicate, two rule families.
This generalises the transfer-only `transferPhase: "c-realign"` gate.

Adoption is **not** peering: a `destination` leg is adopted from creation
while still `trying`/`early` and unpeered (generic relay carries its early
18x/200 to A via the implicit-peer/tagMap fallback). Being an `activePeer`
is the steady state of two already-adopted legs bridged together — a
consequence, not the definition.

## Consequences

- Call teardown already reaps every leg by *state*, independent of
  peering ([ActionExecutor.ts](../../src/b2bua/rules/framework/ActionExecutor.ts)
  `terminate-call` / `begin-termination`), so an unadopted media leg is
  BYE/CANCELled like any other — provided its dialog was confirmed on the
  MRF 200 OK. "Always properly cleaned" holds structurally, not by
  integrator discipline.
- The generic relay-to-peer implicit-`"a"` fallback must be gated on
  `leg.adopted` so a parked media/transfer leg is never mis-routed to A.
  This is the single core enabler the rest of the media-callflow work
  hangs off.
- A media leg lives in `bLegs[]` but is excluded from destination
  selection/failover by `kind`, so failover never retries onto an MRF.

## Trade-offs

- **No conferencing via `activePeer`.** Holding the singleton means a
  future B2BUA-mixed conference is out of scope by construction; it would
  be an MRF feature, not an `activePeer` change. Accepted: mixing is the
  media server's job.
- **`kind` + `adopted` add per-leg fields to the replicated body.** Tiny,
  and they ride opaquely in the existing call body (ADR-0011).
- **Explicit `adopted` flag over a derived predicate.** Chosen because
  `transfer-target` flips and `media` never adopts, so a pure
  kind+phase derivation would be re-computed and easy to get wrong; one
  stored flag is the cheaper invariant.
