# Plan — Hot-path perf fixes + worker-side MAX_MESSAGES_PER_CALL

## Context

Live `/metrics` from the kind endurance cluster show two reinforcing
collapse loops at 10 CAPS legit + 1 CAPS abuse:

1. **Proxy log volume** — `Effect.logInfo` per routed message at
   [ProxyCore.ts:668-682](src/sip-front-proxy/ProxyCore.ts#L668-L682) →
   [Logger.ts:93-100](src/sip-front-proxy/observability/Logger.ts#L93-L100)
   produces ~3.9k records/sec, pushing the active proxy to ~68 % ELU.
   Late health-probe servicing trips AIMD → cap collapses to 1 CPS →
   `503 rate_cap_exhausted` storm.
2. **Worker WARN per Unroutable** — `tracing.withErrorSpan("sip.unroutable", …, Effect.logWarning(…))`
   at [SipRouter.ts:820-822](src/sip/SipRouter.ts#L820-L822) fires
   per orphaned message; worker ELU=1.0, GC ~20 %, proxy sees
   `band=3 above_critical`, AIMD never recovers.

A third defense (`MAX_MESSAGES_PER_CALL`) is documented as future work
in [CONTEXT.md:221](CONTEXT.md#L221). It targets a **different**
attacker profile than the WARN spam: routable in-dialog floods
(e.g. [uac-abuse-reinvite-flood.xml](tests/k8s/charts/sipp/scenarios/uac-abuse-reinvite-flood.xml))
which pump hundreds of messages into a single established call. The
counter only fires once a Call-ID is resolved, so it does not address
the Unroutable WARN spam — that's handled by item (2).

### Domain reconciliation (grilling result)

| Handoff claim | Domain finding | Decision |
|---|---|---|
| Place counter at proxy | Proxy is documented as stateless: [b2bua-sip-headers.md:195-210](docs/b2bua-sip-headers.md#L195-L210); per-Call-ID state would die on VIP failover ([lb-proxy-ha.md:165-192](docs/lb-proxy-ha.md#L165-L192), `CancelBranchLru` not replicated). | **Move to worker.** CallState is already per-Call-ID, Redis-backed, semaphore-protected, survives failover via existing replication. |
| Synthesize BYE from proxy | Dialog tag ownership (From-tag, To-tag, CSeq, Route set) belongs to B2BUA — [b2bua-sip-headers.md:32-44](docs/b2bua-sip-headers.md#L32-L44). Proxy has no `StackDialog`. | **Forbidden as a layering violation.** Use the worker rule's `begin-termination` action which emits BYE via the existing dialog state machine. |
| `cancelLru` cadence as TTL anchor | `CancelBranchLru` is a 32 s transaction-layer artifact for CANCEL dedup, not call-level TTL ([b2bua-sip-headers.md:188-192](docs/b2bua-sip-headers.md#L188-L192)). | **Discard.** Counter rides Call lifecycle (Redis TTL = `LIMITER_TTL_SECONDS`, default 1200 s). |
| WARN rate-limit named "limiter" | `Call limiter` in [CONTEXT.md:95-106](CONTEXT.md#L95-L106) is a Redis concurrent-call counter — different beast. | **Rename to "per-Call-ID event shedding."** Distinct vocabulary; no conceptual overlap with ADR-0007 limiter contract. |
| WARN demote → `logDebug` would also work | ADR-0003 classifies pino as buffered observability ([0003:99-101](docs/adr/0003-must-run-effects-under-interruption.md#L99-L101)). Demote-after-format still pays format cost. | **Demote at call site for proxy; aggregate-into-counter for worker WARN.** Different sites, different right answers. |

## Implementation

### 1. Proxy `logInfo` → `logDebug` demotion

**File:** [src/sip-front-proxy/ProxyCore.ts:668-682](src/sip-front-proxy/ProxyCore.ts#L668-L682)
and [src/sip-front-proxy/observability/Logger.ts:93-100](src/sip-front-proxy/observability/Logger.ts#L93-L100).

Replace `Effect.logInfo` with `Effect.logDebug` for the per-routed-message
log. Verify the metrics `sip_proxy_messages_total`,
`sip_proxy_routing_decisions_total`, and `sip_proxy_routing_duration_seconds`
cover everything the INFO line carried — if a field is metric-orphan,
add a label rather than restore the log.

### 2. Worker Unroutable WARN — per-Call-ID event shedding

**File:** [src/sip/SipRouter.ts:820-822](src/sip/SipRouter.ts#L820-L822).

Replace the per-packet `Effect.logWarning` with a small in-process
shedder:

- Keyed on `Call-ID` (when present in the orphaned message) or
  `srcIP` fallback when no Call-ID.
- Token bucket of 1/sec/key, max 1 token banked.
- On rate-limit drop: increment counter
  `sip_unroutable_dropped_logs_total{key_kind}` (new metric).
- Keep the OTel error span — span cost ≪ pino cost; only suppress
  the formatted WARN line.
- Periodic flush: emit one aggregated `Effect.logInfo` per minute
  with `{ key_count, total_dropped }`.

The 481 reject at [SipRouter.ts:830-840](src/sip/SipRouter.ts#L830-L840)
is unchanged.

### 3. MAX_MESSAGES_PER_CALL at worker

**Schema** — add `messageCount: Schema.Int` (default 0) to the
`Call` struct in [src/call/CallModel.ts](src/call/CallModel.ts).
Encoded automatically by `JsonCallSchema` at
[CallState.ts:44](src/call/CallState.ts#L44).

**Increment** — at the entry to `withCall` after `callRef` is resolved,
inside the per-Call-ID semaphore in
[src/sip/SipRouter.ts:854](src/sip/SipRouter.ts#L854):

```
yield* callState.update(callRef, (c) => ({ ...c, messageCount: c.messageCount + 1 }))
```

Counts **all** inbound messages (requests, final responses, provisional
responses) per the user's spec. Sync increment inside the existing
semaphore is **not** a must-run effect per
[ADR-0003:127-143](docs/adr/0003-must-run-effects-under-interruption.md#L127-L143) —
no `Effect.uninterruptibleMask` needed.

**Rule** — add `messageCapRule` in
[src/b2bua/rules/defaults/](src/b2bua/rules/defaults/), modelled on
[FailureRules.ts:19-85](src/b2bua/rules/defaults/FailureRules.ts#L19-L85)
(`routeFailureRule`). The rule runs on every event after the increment;
when `call.messageCount >= config.maxMessagesPerCall` and call state
≠ `terminating`, emits `{ type: "begin-termination" }`. Existing
state-machine logic handles BYE generation with correct dialog
ownership and the eventual Redis delete; subsequent messages for that
Call-ID then fall through to the existing Unroutable→481 path at
[SipRouter.ts:830-840](src/sip/SipRouter.ts#L830-L840) — no new code
for the post-termination 481 behaviour.

**Config** — add `maxMessagesPerCall: number` to
[src/config/AppConfig.ts](src/config/AppConfig.ts). **Default: 1000.**
Rationale: a 30-min call with re-INVITE/min ≈ 150-200 msgs; 200 from
the handoff bites legit traffic. Abuse archetypes hit 1000 in < 2 s,
so 1000 still catches the abuse cleanly. Tunable from endurance data.

**Metric** — `sip_call_message_cap_terminations_total{reason="cap_exceeded"}`.

### 4. Endurance validation

After (1)–(3), run a fresh 30-min endurance against the same kind
cluster used for the `bvf3ndmxj` baseline. Success criteria:

- Active-proxy ELU mid-run < 0.35 (down from 0.68).
- Worker ELU < 0.8 with GC fraction < 0.05.
- STEADY phase failure rate < 5 % (baseline: 76 %).
- No new `503 rate_cap_exhausted` clusters > 30 s.
- New metric `sip_call_message_cap_terminations_total` > 0 against
  reinvite-flood; legit calls show messageCount p99 well below 1000.

## Critical files

| File | Change |
|---|---|
| [src/sip-front-proxy/ProxyCore.ts](src/sip-front-proxy/ProxyCore.ts) | logInfo → logDebug (hot-path only) |
| [src/sip-front-proxy/observability/Logger.ts](src/sip-front-proxy/observability/Logger.ts) | mirror demotion if call site is wrapped |
| [src/sip/SipRouter.ts](src/sip/SipRouter.ts) | (a) WARN shedder around line 820-822; (b) messageCount increment inside `withCall` ~854 |
| [src/call/CallModel.ts](src/call/CallModel.ts) | add `messageCount` to Call struct |
| [src/call/CallState.ts](src/call/CallState.ts) | no code change; field passes through `update` + Redis codec automatically |
| [src/b2bua/rules/defaults/MessageCapRule.ts](src/b2bua/rules/defaults/) (new) | new rule; pattern from `FailureRules.ts:19-85` |
| [src/b2bua/rules/defaults/](src/b2bua/rules/defaults/) (rule registry) | register `messageCapRule` |
| [src/config/AppConfig.ts](src/config/AppConfig.ts) | `maxMessagesPerCall: 1000` |

## ADR reading checklist (mandatory per CLAUDE.md)

Touches `src/call/CallState.ts:update` indirectly via the schema, and
adds a `RuleDefinition`. **Read
[docs/adr/0003-must-run-effects-under-interruption.md](docs/adr/0003-must-run-effects-under-interruption.md)
first** — confirms the sync increment is not a must-run effect (Trap 2
re-read), and the rule's `begin-termination` action goes through the
existing safety-net path (lines 127-143).

## ADR proposal

This is **probably** worth an ADR — three of the three conditions hold:

1. Hard to reverse: a defaulted Call-schema field is a Redis-schema
   addition; downgrading is awkward.
2. Surprising without context: future readers may wonder why the
   counter is on the worker, not the proxy (handoff explicitly argued
   for proxy).
3. Real trade-off: worker-side correctness vs proxy-side shedding.

**Defer the ADR write-up until after endurance validation** confirms
the design works in practice. If the worker can't handle the extra
counter+rule under load, the ADR documents a corrective direction;
if it works, the ADR captures the rationale at the right point of
certainty.

## Verification

```bash
npm run typecheck                          # zero errors, zero Effect-plugin warnings
npm run test:fake                          # unit + fake-clock rule test
npm run test                               # + short-tier live
# Then: kind endurance — recipe in docs/k8s-endurance.md
```

Add a fake-clock test in
[tests/scenarios/](tests/scenarios/) that drives an established call
past `maxMessagesPerCall`, asserts `begin-termination` fires, asserts
the next inbound message gets 481 from the Unroutable path. Pattern:
existing failure-rule scenarios.

## Out of scope (intentional)

- Per-source-IP cap — flagged in handoff as "probably start with
  per-Call-ID." Revisit only if endurance shows attackers using many
  Call-IDs from one IP.
- Worker-side OTel error-span tuning — span cost is < 5 % of pino cost
  per handoff diagnosis; not worth touching.
- Dockerfile / native-stack changes — separate work item
  ([docs/plan/integration-of-c-based-sprightly-falcon.md](docs/plan/integration-of-c-based-sprightly-falcon.md)).
