# Advanced Call Model: INAP-Inspired Rule Framework

> **Last verified against code:** 2026-04-16

## Overview

The B2BUA uses an INAP-inspired rule framework where all call processing is expressed as **rules** — high-level event interceptors that return **actions** (relay, reject, create leg, merge, split). The framework (ActionExecutor) translates actions into SIP messages, CSeq management, dialog state, and side effects.

Rules never construct SIP messages, never manipulate CSeq, never modify Call state directly. The framework guarantees invariants (limiter cleanup, timer cleanup, CDR) regardless of rule errors.

## Architecture

```
TransactionLayer events
  -> RuleExecutor
       collects active rule definitions (per-call + always-active) and asks
       the Matcher for the ranked candidate list:
         1. drop any rule whose id is overridden by an active override rule
         2. keep rules whose declarative `match` descriptor accepts the event
         3. sort by [specificity score desc, priority asc]
       walks the ranked candidates:
         first one whose handle() returns non-undefined wins
           -> ActionExecutor (CSeq, tags, dialog, message construction)
              -> InvariantEnforcer (safety net: limiter/timer/CDR/removal)
                 -> HandlerResult
       if no rule handles -> noop fallback (log warning)
  -> SipRouter.processResult (stamp Via/Contact, serialize, send, execute effects)
```

### Specificity-based selection

Every rule carries a declarative `match: Match` descriptor — a discriminated union on event `kind` (`request` / `response` / `timer` / `timeout` / `cancelled`). The Matcher scores each candidate: a singleton column (e.g. `method: "INVITE"`) scores higher than an array column (e.g. `statusClass: ["3xx","4xx"]`), exact `status` beats `statusClass`, and a `filter` adds one more point. The highest-scoring rule whose `match` accepts the event wins.

Priority is only a tiebreaker when two rules have identical specificity scores. Overrides are explicit: a rule declaring `overrides: "some-other-id"` removes the named base from the candidate set whenever the overriding rule's `match` accepts the event (used by policy modules — see `suppress-18x`). `composesWith: "base-id"` layers a rule additively before the base (see `force-tag-consistency`).

## INAP Mapping

| INAP Concept | B2BUA Equivalent |
|---|---|
| Detection Point | CallEvent (sip, timer, cancelled, timeout) |
| Connect | `create-leg` action |
| ReleaseCall | `begin-termination` action |
| DisconnectLeg | `destroy-leg` action |
| ContinueWithArgument | `relay-to-peer` action |
| SplitLeg | `split` action |
| MergeCallSegments | `merge` action |
| FurnishChargingInformation | `add-cdr-event` action |

## Peering Model (activePeer)

Typed pair that structurally enforces 1<->1 or 1<->0 peering:

```typescript
activePeer: { legA: string; legB: string } | null
```

- `merge(legA, legB)` — connect two legs. Sets `activePeer = { legA, legB }`.
- `split(legId)` — disconnect a leg from its peer. Sets `activePeer = null`.
- `getPeer(call, legId)` — single routing primitive for all relay.
- `relay-to-peer` action calls `getPeer` internally. During early dialog (before merge), b-leg falls back to "a", and a-leg resolves target b-leg from To-tag via `tagMap`.
- N<->N peering is structurally unrepresentable — no runtime invariant check needed.

This enables REFER (A<->B becomes B<->C), MRF insertion (A<->MRF then A<->B), and arbitrary leg topologies.

## Call Lifecycle: Terminating vs Terminated

The call has three states: `active`, `terminating`, `terminated`.

### Terminating

B2BUA has initiated teardown (sent BYE or CANCEL to all live legs) but is still waiting for transaction-level confirmation (200 OK for BYE, 487 for CANCEL) or timeout on at least one leg. The call holds its limiter slot and stays in memory/Redis.

Entered via the `begin-termination` action. Rules own the terminating phase — they resolve individual legs as confirmations arrive.

### Terminated

Every leg has a terminal `byeDisposition`. Framework cleanup fires automatically.

The framework (RuleExecutor) checks `isFullyResolved(call)` after every rule execution during `call.state === "terminating"`. If all legs are resolved, it auto-promotes to `"terminated"`. Rules just do leg-level work; the framework manages the call lifecycle boundary.

### Leg resolution

A leg is "resolved" when it has a terminal `byeDisposition`:
- `bye_sent` — BYE sent, 200 OK received
- `bye_received` — BYE received from remote
- `bye_timeout` — safety timer expired before confirmation
- `cancelled` — CANCEL sent/received during early dialog

## Rule Definition

```typescript
interface RuleDefinition<TState, TParams> {
  id: string                    // unique identifier
  name: string                  // display name for logging
  alwaysActive?: boolean        // true = runs on every call (built-in rules)
  defaultPriority?: number      // tiebreaker when two rules have identical specificity
  stateKey?: string             // rules sharing a stateKey share persisted state
  composesWith?: string         // run additively BEFORE this base rule's id
  overrides?: string            // replace this base rule's id in the candidate set
  stateSchema: Schema<TState>   // validates rule-specific state
  paramsSchema: Schema<TParams> // validates params from HTTP response
  match: Match                  // declarative match descriptor (discriminated by kind)
  init: (params, call) => TState             // initial state on activation
  onError?: "passthrough" | "terminate"      // error policy
  handle: (ctx, state, params) => Effect<RuleHandleResult | undefined | void>
}
```

Rules return `undefined`/`void` to pass (next ranked candidate gets a turn), or `{ actions, state }` to consume the event.

### Match descriptor

```typescript
type Match =
  | { kind: "request";   method?: OneOrMany<SipMethod>; callState?: ...; legState?: ...;
                          legDisposition?: ...; direction?: "from-a"|"from-b"; filter?: MatchFilter }
  | { kind: "response";  cseqMethod?: OneOrMany<SipMethod>; status?: number;
                          statusClass?: OneOrMany<StatusClass>; callState?: ...; legState?: ...;
                          legDisposition?: ...; direction?: ...; filter?: MatchFilter }
  | { kind: "timer";     timerType?: OneOrMany<TimerType>; callState?: ...; filter?: MatchFilter }
  | { kind: "timeout";   method?: OneOrMany<SipMethod>; callState?: ...; filter?: MatchFilter }
  | { kind: "cancelled"; callState?: ...; filter?: MatchFilter }
```

Omitting a column means "accept any value". `OneOrMany<T>` accepts either a single value or a `ReadonlyArray<T>`. Filters are synchronous, pure, and only used for relational checks that can't be expressed as columns (CSeq-number correlation with `findPendingRequest`, etc.).

## Action Types

| Action | What it does |
|---|---|
| `relay-to-peer` | Relay current event to peer leg (CSeq, tags, dialog handled by framework). During early dialog, resolves target via To-tag fallback. |
| `relay-to-leg` | Relay to a specific leg by ID |
| `respond` | Send a response to the event sender |
| `ack-leg` | ACK a 200 OK on a specific leg |
| `send-request-to-leg` | Generate a new request (OPTIONS, INFO, etc.) to a leg (CSeq bump handled) |
| `create-leg` | Create a new outgoing INVITE (b-leg) |
| `destroy-leg` | **Composite (Slice C audited).** Tear down a single leg: BYE (confirmed), nothing (cancelling — CANCEL already in flight), or CANCEL (trying/early). Reach: `legs.{legId}.state → "terminated"`, `legs.{legId}.byeDisposition`, `legs.{legId}.disposition → "cancelling"` on the trying/early branch, and `call.activePeer → null` when the leg was part of the current pair. Outbound: 0 or 1 SIP message depending on branch. |
| `cancel-leg` | **Primitive.** Send CANCEL for an outstanding early/trying b-leg INVITE while keeping the leg alive so the CANCEL/2xx race can resolve. Reach: `legs.{legId}.disposition → "cancelling"` only. No state change, no `byeDisposition` — cancel-resolving rules decide the terminal disposition. |
| `merge` | **Primitive.** Connect two legs — both named in parameters. Reach: `call.activePeer → { legA, legB }`. No leg-level mutation. |
| `split` | **Primitive (structural un-peer).** Disconnect the named leg from its peer. Reach: `call.activePeer → null` when the leg was part of the current pair, otherwise no-op. Clearing `activePeer` inherently un-peers both sides — that is the shape of the singleton, not hidden reach. |
| `confirm-dialog` | Populate `legs.{legId}.dialogs[0]` from the current 200 OK response (toTag, contact, RFC 3261 §12.1.2 route set from Record-Route, CSeq floor). Reach is one dialog. No peer-sync, no timers, no merge — rules compose with `update-leg-state`/`add-tag-mapping`/`stamp-dialog-to-tag` via the `confirmBridgedCall` helper when they need the full A↔B flip. |
| `update-leg-state` | Set `legs.{legId}.state` and optionally `legs.{legId}.disposition`. |
| `stamp-dialog-to-tag` | Stamp an explicit `toTag` onto `legs.{legId}.dialogs[0]` (or create one via `makeDialogFromIncoming`/`makeEmptyDialog` when no dialog exists). Used on the a-leg (UAS side) at 200-OK-INVITE time. |
| `add-tag-mapping` | Append `{aTag,bLegId,bTag}` to `call.tagMap`. Idempotent by `(bLegId,bTag)`. |
| `schedule-timer` | Schedule a timer (typed — see TimerType) |
| `cancel-timer` | Cancel a timer by ID |
| `cancel-all-timers` | Cancel all timers on the call |
| `begin-termination` | **Composite (Slice C audited — call-scope).** Graceful teardown for the whole call. Reach: every live leg's `byeDisposition` (BYE for confirmed, CANCEL for trying/early b-legs, `"none"` for trying/early a-leg), `legs.{b-leg}.state → "terminated"` for trying/early b-legs, `call.state → "terminating"`, `call.timers` gets the `terminating_timeout` safety timer appended. `call.activePeer` is deliberately preserved so the final BYE 200 OK response still routes. Effects: `cancel-all-timers`, `schedule-timer`, `write-cdr`, `flush-redis`. Legs already marked (`byeDisposition` set, or `disposition = "cancelling"`) are skipped. |
| `terminate-call` | **Composite (Slice C audited — call-scope).** Immediate call death. Reach: every non-terminated leg’s `state → "terminated"`, `call.state → "terminated"`, `call.activePeer → null`. Outbound: BYE for each confirmed leg, CANCEL for each trying/early b-leg (a-leg in trying/early gets no SIP — the rule already handled it). No safety timer, no side-effects — `InvariantEnforcer` handles limiter/CDR/removal cleanup. Reserved for `onError: "terminate"` fallout and pre-dialog failures. |
| `terminate-leg` | **Primitive.** Reach: `legs.{legId}.state → "terminated"` and (when named) `legs.{legId}.byeDisposition`. No outbound, no peer touch. |
| `add-cdr-event` | Append a CDR event |
| `deactivate-rule` | Deactivate the current rule mid-call |
| `send-raw` | Escape hatch for custom SIP messages (NOTIFY body, etc.) |

### begin-termination vs terminate-call

All rules use `begin-termination` for call-level termination (BYE, CANCEL, timeout, max-duration, keepalive-timeout). This sends BYE/CANCEL to each live leg and transitions to `"terminating"`. If all legs are already resolved (e.g., pre-dialog failure), `isFullyResolved()` is immediately true and the framework transitions to `"terminated"` on the spot — same code path, no special case.

`terminate-call` is reserved for pre-dialog immediate failures where no confirmed legs exist and no BYE exchange is needed.

### Composite: `confirmBridgedCall`

Defined in [src/b2bua/rules/framework/actions/composites.ts](../src/b2bua/rules/framework/actions/composites.ts). Bundles the five single-reach primitives a rule needs to confirm an A↔B dialog on a 200 OK INVITE arriving from the source (B) leg:

1. `update-leg-state` → source leg to `confirmed/bridged`
2. `confirm-dialog`   → populate source-leg dialog[0] from the response
3. `add-tag-mapping`  → record the chosen a-facing tag (skipped when the caller reports `mappingAlreadyExists: true`, e.g. when a policy module pre-seeded the mapping)
4. `update-leg-state` → a-leg to `confirmed`
5. `stamp-dialog-to-tag` → a-leg dialog[0] toTag

Rules call it from `DialogRules.confirmDialogRule` and `CornerCaseRules.cancel200CrossingRule`. The REFER slice-5 `transfer-c-200-initial` rule does **not** use it — C-leg confirmation must not touch A↔B, so it emits `update-leg-state` + `confirm-dialog` on the C-leg only.

### MessageTransform

Applied to relay actions for protocol conversion (e.g., 183 -> 200):

```typescript
interface MessageTransform {
  status?: number          // override response status code
  reason?: string          // override reason phrase
  headers?: Record<string, string | null>  // add/modify/remove headers
  body?: Uint8Array | null // replace body
}
```

## Priority Bands

Priority only decides ties when two rules have identical specificity scores. Day-to-day rules rarely need to set it; the `match` descriptor already disambiguates most pairs. Registered bands remain useful as readable hints of intent:

| Range | Purpose | Examples |
|---|---|---|
| 0-99 | Framework-level | Overload, emergency bypass |
| 100-199 | Custom rules | REFER, MRF, 183-to-200 |
| 800-899 | Corner cases | cancel-200-crossing, retransmit-200, reinvite-glare, absorb-bye-200 |
| 900-999 | Default B2BUA | relay-bye, confirm-dialog, route-failure, keepalive |

## Default Rules (Built-In, Always-Active)

### Corner Cases (priority 850)

| Rule | Matches | Actions |
|---|---|---|
| `cancel-200-crossing` | 200 OK INVITE from b-leg with disposition=cancelling | ACK + destroy-leg |
| `retransmit-200` | 200 OK INVITE from confirmed b-leg (excludes re-INVITE responses) | ACK only (no relay) |
| `relay-reinvite-response` | INVITE response matching pendingReInvite | relay-to-peer |
| `absorb-bye-200` | 200 OK for BYE/CANCEL | noop (absorb) |
| `absorb-options-200` | 200 OK for keepalive OPTIONS (no pending relay snapshot) | cancel keepalive-timeout |

### Glare Detection (priority 890)

| Rule | Matches | Actions |
|---|---|---|
| `reinvite-glare` | re-INVITE when sourceDialog has pending outbound re-INVITE | respond 491 |

### Default Relay/Lifecycle (priority 900)

| Rule | Matches | Actions |
|---|---|---|
| `relay-options` | in-dialog OPTIONS request | relay-to-peer (transparent, payload preserved) |
| `relay-info` | in-dialog INFO request | relay-to-peer (transparent, payload preserved) |
| `relay-bye` | BYE request | respond 200, terminate-leg, add-cdr-event, begin-termination |
| `relay-ack` | ACK request | relay-to-peer |
| `relay-reinvite` | INVITE request (in-dialog) | relay-to-peer |
| `relay-prack` | PRACK request | relay-to-peer |
| `relay-provisional` | 1xx INVITE from b-leg | relay-to-peer, CDR |
| `confirm-dialog` | 200 OK INVITE from b-leg (new, not retransmit) | `confirmBridgedCall` composite (`update-leg-state` × 2 + `confirm-dialog` + `add-tag-mapping` + `stamp-dialog-to-tag`) + `merge` + `relay-to-peer` + destroy losers + timers + CDR |
| `relay-non-invite-200` | 200 OK for PRACK/UPDATE/INFO/OPTIONS (relayed) | relay-to-peer |
| `handle-timeout` | Transaction timeout | begin-termination |
| `handle-cancel` | CANCEL from a-leg | destroy all b-legs, CDR, begin-termination |
| `max-duration` | global_duration timer | CDR, begin-termination |
| `keepalive` | keepalive timer | send-request-to-leg OPTIONS to all peered legs, schedule timeouts |
| `keepalive-timeout` | keepalive_timeout timer | CDR, begin-termination |
| `route-failure` | 3xx-6xx INVITE from b-leg | CDR, HTTP failover or begin-termination |
| `no-answer-failover` | no_answer timer | destroy leg, HTTP failover or begin-termination |

### Terminating-State Rules (priority 900)

| Rule | Matches | Actions |
|---|---|---|
| `resolve-bye-response` | Final response (>=200) with CSeq=BYE, `call.state === "terminating"` | terminate-leg (framework auto-checks isFullyResolved) |
| `resolve-cross-bye` | BYE request, `call.state === "terminating"` | respond 200, terminate-leg |
| `terminating-safety-timeout` | Timer `terminating_timeout` | Force all unresolved legs to `byeDisposition: "bye_timeout"` |
| `terminating-drop-{request,response,timer,timeout,cancelled}` | Any event of the given kind, `call.state === "terminating"` (catch-all, one per kind) | noop (absorb silently) |

## Framework vs Rule Boundary

### Framework owns (unconditional guarantees)

| Concern | Mechanism | Why framework |
|---|---|---|
| **terminating → terminated transition** | `RuleExecutor` checks `isFullyResolved()` after each rule | Rules resolve legs; framework manages call lifecycle boundary |
| **Timer cleanup at terminated** | `InvariantEnforcer` ensures `cancel-all-timers` | 100% guarantee even on rule bugs |
| **Limiter cleanup at terminated** | `InvariantEnforcer` decrements all remaining `limiterEntries` | Must never leak slots |
| **CDR write at terminated** | `InvariantEnforcer` ensures `write-cdr` effect | Must never lose CDR records |
| **Call removal at terminated** | `InvariantEnforcer` ensures `remove-call` is last effect | Memory/Redis cleanup |
| **Limiter refresh** | `FrameworkLimiterRefresh.ts` (intercepted before rule chain) | Pure Redis housekeeping, zero business logic |

### Rules own (business decisions)

| Concern | Why rules |
|---|---|
| **Limiter increment** | Rule has routing context for `/call/failure` failover on rejection |
| **Limiter decrement** | Rule decides when to release (e.g., at begin-termination) |
| **Call termination initiation** | Rule decides why and when to terminate (BYE, CANCEL, timeout, max-duration) |
| **Leg resolution** | Rule interprets BYE responses, cross-BYE, timeouts |
| **Relay routing** | Rule decides what to relay where |
| **Dialog confirmation** | Rule interprets 200 OK, manages fork resolution |

## Rule Error Boundary

Each rule's `handle()` runs inside `Effect.catchDefect`:
- `onError: "passthrough"` (default) — log error, skip to next rule
- `onError: "terminate"` — log error, return `terminate-call` (InvariantEnforcer handles cleanup)

## Custom Rules (Per-Call Activation)

Custom rules are activated per-call via the HTTP `/call/new` response:

```json
{
  "rules": [
    { "id": "refer", "priority": 100, "params": { ... } }
  ]
}
```

Per-call rules with the same ID as a built-in rule override the built-in. Rules can `deactivate-rule` mid-call to return to normal B2BUA behavior.

### Planned Custom Rules

**REFER** (priority 100) — Intercepts REFER request, calls HTTP for authorization, creates C-leg, manages transfer via merge/split.

**183-to-200** (priority 100) — Transforms 183 SDP to 200 OK via `relay-to-peer` with `transform: { status: 200 }`. Framework runs normal dialog confirmation. Absorbs real 200 OK when it arrives.

**MRF** (priority 100) — Inserts media server leg for pre-call announcement or custom ringback. Uses create-leg + merge for MRF, split + merge to transfer to real B-leg when complete.

## Limitations and Not Yet Implemented

### Custom rules not yet implemented

REFER, 183-to-200, and MRF rules are designed but not yet coded. The framework supports them — `CallControlSchemas.ts` needs `rules` field on `NewCallRouteResponse`, and `CallControlClient.ts` needs `callRefer()`.
