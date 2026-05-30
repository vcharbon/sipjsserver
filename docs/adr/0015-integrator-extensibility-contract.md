# ADR 0015 — Integrator extensibility via a versioned rule SDK; B2BUA owns replicated callflow state

## Status

Implemented. The curated rule SDK ships as the `@vcharbon/sipjs/rules-sdk`
subpath (`src/rules-sdk/index.ts`): typed `defineRule` / `defineService` /
`definePolicyModule`, a narrowed `RuleContext` (no `callControl`/`limiter`), and
the **public** `PublicRuleAction` subset (`src/b2bua/rules/framework/actions/public.ts`).
The entrypoint IS the enforced boundary — internal actions (`send-raw`, PRACK /
transfer / tag-mapping plumbing) are unreachable, and `tests/consumer-api/rules-sdk.test.ts`
is the compile-time contract test. Builds on
[ADR-0014](0014-leg-kind-and-singleton-active-peer.md) (leg model) and
[ADR-0011](0011-codec-and-opaque-apply.md) (opaque-body replication). Storage
mechanism refined by [ADR-0016](0016-callflow-services-typed-ext.md).

## Context

A third party — the **integrator** (see CONTEXT.md) — wants to build new
media callflows (PRBT, pre/post-call announcement, MRF-during-transfer,
playcollect) on top of the B2BUA without us implementing each flow and
without destabilising the core. Constraints gathered while grilling the
design:

- The HTTP call-decision backend must stay **stateless** — no callflow
  state machine there.
- The B2BUA must **own and replicate all per-call state**, because the HA
  backup/takeover machinery (ADR-0011, ADR-0001) is complex and
  load-bearing; state that lived only in the backend or only in the
  integrator's process could not survive a worker death.
- The integrator compiling and deploying their **own worker binary** is
  acceptable (already true for the HTTP adapter). "Extensible without
  changing our code" therefore means *backward stability of a controlled
  surface*, not "no compile."
- Exposing the full in-process rule engine (the entire ~30-action union,
  the unrestricted `RuleContext`) as a third-party contract is a
  surface-area / backward-stability risk.

MSCML is the integrator's media-control dialect; the B2BUA has no reason
to parse it, consistent with the project's opaque-SDP / byte-faithful
philosophy.

## Decision

**Integrators extend the B2BUA by authoring policy modules
(`definePolicyModule`) in their own worker binary** — not by pushing
callflow logic into the stateless backend. The backend returns the
callflow descriptor **once** at `/call/new`; our rules interpret it to
completion. The `/call/new` HTTP API shape is **unchanged** — descriptors
ride in fields that already exist.

**The descriptor and flow state live in the replicated call body, opaque
to the core:**

Descriptor (initial config: MRF URI, MSCML payloads/refs, flow parameters)
and evolving callflow state (cursor, media-leg id, what has been played) now
ride in typed **`Call.ext` / `Leg.ext`**, keyed by service id and decoded via
the owning service's schema (see
[ADR-0016](0016-callflow-services-typed-ext.md)). This supersedes the original
sketch, which parked them on `Call.activeRules[].params` and
`Call.ruleState[].state` (both `Schema.Unknown`, never decoded — an unchecked
cast). The rest of the storage model is unchanged.

Both are part of the `Call` schema, so they replicate and survive
takeover (ADR-0011) with zero core involvement. The B2BUA never parses
MSCML; it transports control bodies as opaque bytes.

**The integrator-facing contract is a curated, independently-versioned
"rule SDK":** `defineRule`, a **narrowed** `RuleContext` (no
`callControl`/`limiter` service handles), and the **public subset** of the
action union — leg create/destroy, `send-request-to-leg` with an opaque
body, `respond`, relay/transform, timers, `ruleState`, terminate — plus
the match kinds and the opaque-body accessor. Internal actions
(`send-raw`, transfer / early-promote / PRACK / tag-mapping plumbing)
remain unexported. The public/internal boundary **is** the stability
promise; we start narrow and widen as the dogfood demands ("easier to open
than to close").

**Reliability is structural, not trust-based.** A rule's `handle()` is
`Effect<…, never, never>` — no service requirements, no I/O. Rules emit
*intents*; the framework's `ActionExecutor` performs every side effect
under the ADR-0003 must-run contract and owns every resource lifecycle. An
integrator rule therefore cannot leak a socket/fiber, skip a BYE, or
bypass the limiter `DECR`; the worst it can do is emit wrong intents
(caught by invariant enforcement / BYE-disposition checks), throw (caught
by the `onError` defect boundary), or hang (the integrator's own CPU
problem, isolated to that call by per-call FIFO). Framework-level global
cleanup and in-dialog keepalive do not depend on rule code running.

**The `../sipjsserverwithPrbt` dogfood project is the contract test.** It
implements basic PRBT as an integrator would, compiling against *only* the
public rule SDK, so breaking the contract breaks its CI build. Richer
flows are argued by extension from it.

## Considered options

- **Backend returns the next action per media event (stateful-ish
  decision function).** Rejected: forces the integrator to think in
  resumable steps and costs an HTTP round-trip per media milestone
  mid-setup — the state machine we explicitly did not want in the backend.
- **We author one generic MRF/MSCML interpreter rule; integrators supply
  only descriptor data (no binary).** Rejected for now: keeps the rule API
  fully internal but bounds integrator flexibility to whatever our
  descriptor grammar expresses. The integrator-authored-rules path was
  chosen instead, with the rule SDK as the stability boundary.
- **Expose the full action union to integrators.** Rejected: every
  internal action would become a frozen public promise.

## Consequences

- Per-callflow work is "new rule logic + new descriptor data" — **zero API
  change** and no `/call/new` schema churn.
- We take on maintaining a semver'd rule SDK and keeping the narrowed
  `RuleContext` / public action subset stable.
- Descriptor bytes ride in the per-call body: integrators should reference
  MSCML by template-id rather than embedding full XML per call where they
  can (ADR-0012 memory + replication bandwidth).
- The public/internal split must be enforced at the module boundary (a
  dedicated SDK entrypoint), and the dogfood must import *only* that
  entrypoint for the CI contract test to mean anything.
