# Leg Termination Model

How a SIP dialog ends in this B2BUA, who is responsible for what, and how
the framework prevents the "call gets stuck in `terminating`" leak class.

## Two — and only two — paths terminate a dialog

1. **BYE** sent or received on an established (confirmed) dialog.
2. **Final non-2xx response to INVITE** (including the 487 a UAS sends in
   response to a CANCEL) **or B2BUA-internal timeout** on an early dialog.

CANCEL is upstream of #2: it triggers the 487 that *is* the termination
signal. There is no third path.

## Layers and responsibilities

```
┌────────────────────────────────────────────────────────────────────┐
│ SIP transaction layer  (src/sip/TransactionLayer.ts)               │
│   Owns RFC 3261 client/server transaction state machines:          │
│   Timer A/B/E/F retransmits, INVITE/non-INVITE state, ACK reuse,   │
│   65s completed-state cleanup. Emits `timeout` CallEvents on       │
│   Timer F/B expiry. Knows nothing about legs or calls.             │
├────────────────────────────────────────────────────────────────────┤
│ Rule  (src/b2bua/rules/defaults/*.ts)                              │
│   Says "this leg is terminated" by emitting a `terminate-leg`      │
│   action with a terminal `byeDisposition`. The framework catches   │
│   any rule that absorbs a BYE-resolution event without doing so.   │
├────────────────────────────────────────────────────────────────────┤
│ Framework  (src/b2bua/rules/framework/{RuleExecutor,                │
│             ByeDispositionInvariant,InvariantEnforcer}.ts)         │
│   Aggregates: when every leg is terminal (`isFullyResolved`),      │
│   promotes call `terminating → terminated`. Then `InvariantEnforcer│
│   `auto-injects `cancel-all-timers` / `decrement-limiter` /        │
│   `write-cdr` / `remove-call`. CDR fires exactly once.             │
├────────────────────────────────────────────────────────────────────┤
│ Orphan sweep  (src/call/CallState.ts)                              │
│   Last-line recovery for crashes / reboots / framework escapes.    │
│   Runs every 60 s; performs the full cleanup (CDR + Redis delete +  │
│   replication tombstone). Increments                               │
│   `orphanSweepRecoveredCount` for observability.                   │
└────────────────────────────────────────────────────────────────────┘
```

## Field ownership

| Concept | Field | Lives on | Owner |
|---|---|---|---|
| Transaction in flight | (in-memory `txnMap`, branch-keyed) | TransactionLayer | TransactionLayer |
| Inbound transparent-relay request awaiting response | `Dialog.ext.inboundPendingRequests` | Dialog | Rule (via `add-pending-request` etc.) |
| Leg's BYE state | `Leg.byeDisposition` | Leg | Rule (`terminate-leg` action) — **framework will force-correct if rule fails** |
| Leg's lifecycle state | `Leg.state` (`trying`/`early`/`confirmed`/`terminated`) | Leg | ActionExecutor (mutates on `update-leg-state` / `destroy-leg` / etc.) |
| Call's lifecycle state | `Call.state` (`active`/`terminating`/`terminated`) | Call | RuleExecutor (promotes `terminating → terminated` when `isFullyResolved`) |

## byeDisposition state machine

```
                   ┌──────────────────────────────────────┐
                   │                                      ▼
   undefined ──→ bye_sent ─────(2xx-6xx response or Timer F)─→ bye_confirmed / bye_timeout
       │
       └─────(incoming BYE we 200'd)─→ bye_received
       │
       └─────(local CANCEL on early leg)─→ cancelled
       │
       └─────(rejected at INVITE)─→ rejected / none
```

Terminal dispositions (from `TERMINAL_BYE_DISPOSITIONS`,
[src/call/CallModel.ts](../src/call/CallModel.ts)):
`bye_confirmed`, `bye_received`, `bye_timeout`, `cancelled`, `rejected`,
`none`. The only non-terminal value is `bye_sent`.

`isFullyResolved(call)` returns true when every leg has a terminal
disposition (or is in `trying` state with no disposition — never
established, no BYE expected).

## Rule-author contract

If your rule's matcher selects an event that resolves an outbound BYE —
that is, either:

- a final response (≥200) with `cseqMethod: "BYE"`, or
- a `timer` event of `terminating_timeout`,

— **and** the source leg's pre-rule `byeDisposition` was `bye_sent`, your
rule MUST emit `terminate-leg` with a terminal `byeDisposition`.

The framework enforces this in `RuleExecutor.finalizeTermination` by
running `enforceByeDispositionInvariant` after every rule firing. If a
rule absorbed such an event without emitting `terminate-leg`, the framework
will:

1. Force-set the disposition: `bye_confirmed` for response events,
   `bye_timeout` for `terminating_timeout`.
2. Log `Effect.logWarning` naming the rule id, callRef, leg id, and event
   kind: `bye-disposition invariant: rule X consumed Y for call Z leg L
   without terminating it; framework forced bye_confirmed`.
3. Increment `framework_invariant_violation_bye_disposition_total`,
   surfaced through the `/status` endpoint and the harness assertion below.

So nothing leaks — but every violation is loud. Production should run with
the counter at zero.

## How rules learn about transaction completion

Rules subscribe to raw SIP responses via `match.cseqMethod` /
`statusClass`. Two rules share responsibility for resolving an outbound
BYE:

- **`resolveByeResponseRule`** (`src/b2bua/rules/defaults/TerminatingRules.ts`):
  matches `kind:response, cseqMethod:BYE, statusClass:[2xx-6xx]` with a
  `filter: ctx.sourceLeg.byeDisposition === "bye_sent"`. Specificity 4.
  Wins regardless of `call.state`.
- **`absorbBye200Rule`** (`src/b2bua/rules/defaults/DialogRules.ts`):
  matches `kind:response, cseqMethod:[BYE,CANCEL], statusClass:2xx`.
  Specificity 3. Handles residuals — peer 200 retransmits to a BYE we
  already 200'd, second 200 to a CANCEL we already absorbed, etc. — where
  the leg is *not* in `bye_sent`.

Specificity ranking
([src/b2bua/rules/framework/Matcher.ts](../src/b2bua/rules/framework/Matcher.ts))
guarantees `resolveByeResponseRule` wins whenever a BYE we sent is being
resolved. The leg-state filter rather than a `callState: terminating`
filter lets it fire after a single-leg `destroy-leg` action that left the
call in `active` state.

## Test contract

Every fake-clock scenario asserts on completion (in
[tests/support/harness.ts](../tests/support/harness.ts) `assertCleanCallTermination`):

- `cdr.readAll().length === stats.total` — every created call produced
  exactly one CDR record.
- `stats.orphanSweepRecoveredCount === 0` — the rule path or the
  framework invariant cleaned up every call; the sweep never had to.

Per-scenario overrides (when legitimate):

- `expectCdrCount(name, n)` — scenarios that create multiple calls
  (REFER + c-leg).
- `expectNoCdr(name)` — scenarios that explicitly verify no call was
  created or terminated.
- `skipCdrCheck(name)` — multi-worker SUTs (failover, HA, registrar)
  where the harness sees only one worker's services.

A regression in any of {Slice 1 CDR layer, Slice 2 sweep, Slice 3 rule
matcher relaxation, Slice 4 framework invariant, Slice 5 de-dup write-cdr}
shows up here as a per-scenario failure naming the scenario, instead of
silently leaking calls 60 s at a time as the production bug did.

## Pointers

- [docs/CallModel.md](CallModel.md) — Call/Leg/Dialog data model.
- [docs/AdvancedCallModel.md](AdvancedCallModel.md) — rule framework,
  action types, framework guarantees.
- [docs/b2bua-sip-headers.md](b2bua-sip-headers.md) — Via stamping, which
  is what lets a 200/BYE response find the right leg.
- [docs/replication/call-cache-backup.md](replication/call-cache-backup.md)
  — `propagate:{peer}` tombstone propagation that the orphan sweep emits.
