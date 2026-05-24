# TODO — Optimise per-call context size at the rule level

**Status:** open
**Owner:** unassigned
**Last touched:** 2026-05-23
**Triggered by:** endurance run `20cps-1abuse-nochaos-30m-fixA1B-2026-05-23T1848`
**Related:** [TERMINATING_TIMEOUT_MS shortening](../call/timer-helpers.ts) (the quick win that motivated this),
[Fix A1 + Fix B per-leg refresh / fast-reject](./../../src/call/CallState.ts), `project_endurance_residual_steady_failure`,
`project_oom_investigation_2026_05_10`.

## Problem

Every entry in `CallState.callsMap` is a **full `Call` object** (the
struct at [`src/call/CallModel.ts:590`](../../src/call/CallModel.ts#L590)).
A call kept in memory for the `terminating` linger window carries every
field that was needed at handler time — `aLegInvite` (URI + header
array + raw body bytes), full `aLeg.dialogs` / `bLegs[*].dialogs` with
SDP echoes, `tagMap`, `cdrEvents`, `limiterEntries`, `aLegPendingVias`,
`policyUpdateHeaders/Body`, `features`, `perCallRules`. Conservative
envelope: ~3-6 KB / call once header arrays and per-leg state are
counted, plus the per-callRef `MutableHashMap` entry, the slot in
`semaphores`, the per-call dispatcher queue object, and TxnLayer
entries that have not yet GC'd.

The quick-win timeout shortening (TERMINATING_TIMEOUT_MS → 32 s) brings
the steady-state terminating pile from 20 cps × 17 min = 20 400 calls
down to 20 cps × 32 s = 640. At 8-12 KB / call total residency that's
~5-7 MB instead of ~150-250 MB. But the structural cost of "store the
whole Call body even when 99 % of its fields will never be read again"
remains; the linger window is now small enough to hide it under normal
load, but any longer-lived state (the long-options 20-min calls, an HA
backup partition holding sister-worker entries, a future feature that
extends the terminating window for compliance reasons) re-exposes it.

This plan describes the more disciplined fix: **trim the in-memory
Call to only the fields each downstream consumer actually reads, at
the lifecycle stage where those fields stop mattering**. The trim is
done by the rule framework on a state transition, not by ad-hoc
post-hoc field clearing.

## Goal

For each call lifecycle stage (`active`, `terminating`, `terminated`,
HA backup-partition resident, etc.) define the **minimum field set**
that any code path is allowed to read while the call is in that stage.
Make the rule framework produce that subset on transition, so memory
residency matches the read pattern.

## Non-goals

- Schema redesign — the on-the-wire / Redis `Call` schema stays as it
  is. The trim is in-memory only.
- Persistence change — `flushToRedis` still serialises the full call
  when needed (the flush call may decide not to flush at all for
  terminating, see Stage 3 below).
- Touching the per-call dispatcher queue, semaphore slot, or txnMap
  entries — those are separate eviction problems with their own owners.

## Approach

### Stage 1 — audit (read-only)

For each lifecycle state in [`CallModelState`](../../src/call/CallModel.ts),
enumerate every `Call`-field read by code reachable from that state.

Concretely:
- grep every `call.X`, `c.X`, `bumpedCall.X`, `next.X`, `prev.X`
  inside the rule framework, SipRouter handler bodies, ActionExecutor,
  CdrWriter, CallState orphan sweep, flush path, terminate writer.
- For each read, note the gating state (`if state === "active" / …`).
- Output a matrix `(field × stage) → {read, written, dead}`.

Deliverable: `docs/plan/call-field-residency-matrix.md` with the
matrix. Without it, any subsequent trim is guesswork.

### Stage 2 — type-level encoding of the trim contract

Introduce a discriminated-union view over the in-memory call:

```ts
type LiveCall      = Call & { state: "active" | "establishing" | … }
type TerminatingCall = Pick<Call,
  | "callRef"
  | "state"
  | "terminatingRefreshLegs"
  | "timers"
  | "_topology"
  | "createdAt"
  | "limiterEntries"      // still needed for InvariantEnforcer
  | "cdrEvents"           // still needed for the terminal CDR write
  // … as decided by Stage 1 matrix
>
type CallInMemory  = LiveCall | TerminatingCall
```

The dispatcher and rule handlers narrow on `state` and the type-checker
forbids reads of trimmed fields from the `terminating` branch.

### Stage 3 — produce the trim on transition

`CallState.update`'s `enteringTerminating` branch (currently at
[`src/call/CallState.ts:548`](../../src/call/CallState.ts#L548)) is the
single chokepoint. On the transition the new `Call` is replaced with
its `TerminatingCall` projection before being written to `callsMap`.

The projection is a pure helper:

```ts
function toTerminating(call: Call): TerminatingCall { /* Pick + drop */ }
```

`flushToRedis` for terminating calls becomes: do not flush. The on-disk
copy is already there from the prior flush — the in-memory copy is
authoritative for the terminating window, after which `forcePurge` /
safety timer deletes both.

### Stage 4 — drop unused indirection

After Stage 3, several adjacent structures are also reducible:

- `semaphores` — per-callRef permit. For `TerminatingCall` we still
  need serialisation while a real teardown response is being processed
  (e.g. peer BYE 200), but we no longer need it for the fast-reject
  path (Fix B already bypasses `withCall` for non-ACK / non-BYE). Could
  drop the semaphore entry on enter-terminating and lazily re-allocate
  if a budgeted update arrives.
- `dispatcher`'s per-call queue object — terminating-call queues
  receive at most a few legitimate messages (BYE responses + leg-budget
  refreshes). Could route them through a single shared "terminating"
  queue, not a per-callRef one.
- `txnMap` entries — already aged via TIMER_H / TIMER_J. Cross-check
  that aging works on terminating-state branches; otherwise add a
  fast-prune step in `cancelTxnsForCallRef`.

These are deferred until Stage 1-3 land; they don't earn their keep
unless the matrix from Stage 1 confirms a meaningful reachable-set
shrink.

## Validation

- Endurance run `20cps-2abuse-nochaos-2h` (longer + heavier abuse,
  exposes the residency steady-state) — RSS slope expected to flatten
  visibly vs the pre-trim baseline.
- New invariant test: post-Stage 3, a `callsMap` entry whose `state`
  is `terminating` must not retain `aLegInvite`, `tagMap`,
  `policyUpdateBody`, `features`, `perCallRules`, `aLegPendingVias`.
  Test asserts those fields are `undefined`.
- The existing rule-coverage and CDR tests must keep passing without
  modification — if a rule references one of the trimmed fields from
  the terminating branch, that's the audit's job to surface and either
  add the field back to `TerminatingCall` or rewrite the rule to read
  earlier.

## Open questions

1. **HA backup partition.** A worker also holds entries in `callsMap`
   for calls it backs up for the peer (the `bak:{primary}:` body via
   replication). The state field is whatever the primary stamped.
   Should the backup hold a trimmed view too? `docs/replication/call-cache-backup.md`
   §0 corollary 1 says the backup must be able to serve in-dialog
   traffic and bump gen — does that need the full call body? Audit
   matrix should cover this.

2. **Transfer / mid-call REFER scenarios.** Some rule paths may
   transition the call back from `terminating` to `active` (e.g.
   the failed-transfer recovery rule). If those exist, the trim is a
   one-way arrow and the back-transition needs to error or re-hydrate
   from Redis. Stage 1 grep should surface any such write.

3. **CDR readiness.** `cdrEvents` is read by the terminal CDR write,
   which happens at the `terminated` promotion or in `forcePurge`. If
   the trim happens on enter-terminating, `cdrEvents` must stay; the
   matrix needs to verify CDR write is the only reader.

4. **Pino log-record references.** Some `Effect.logWarning` callsites
   build a string from many call fields. Trimming those fields would
   change log output. Acceptable for `terminating`-only log lines
   (probably should be quieter anyway); audit which log lines fire in
   that branch and pre-bake the strings before trim.

## Out of scope

- The fast-reject 481 template buffer-cache (the *other* GC-pressure
  win from the same endurance run). That's an allocation-side fix; this
  plan is a residency-side fix. Both compound but are independent.
