# Remaining TODOs: SIP E2E Test Framework & Rule Migration

Items implemented in the 2026-04-12 session have been removed. This file contains only skipped or remaining work.

---

## Skipped — requires larger refactoring

### TODO 7: Move MockCallControlServer Out of `src/`

**Priority:** LOW — SKIPPED
**Reason:** `src/http/StatusServer.ts` (production code) imports `addCallControlRoutes` from `MockCallControlServer.ts`. A simple file move would break the production dev server. Needs a split: extract the route-adding function into a shared module, then move the mock server to `tests/`. Not worth the churn for now.

**Files:** `src/http/MockCallControlServer.ts`

### TODO 9: Replace `defined()` Casts with Typed Constructors

**Priority:** LOW — SKIPPED
**Reason:** Mechanical refactoring across ~20 call sites. Low risk of bugs from current approach; the `as` casts work correctly today. Worth doing during a larger test framework cleanup pass.

**Files:** `tests/e2e/framework/utils.ts`, all call sites in `recorder.ts`, `interpreter.ts`

### TODO 10: Split `AgentDialogState`

**Priority:** MEDIUM — SKIPPED
**Reason:** Significant refactoring of `message-builder.ts` internals. The 14-field mutable bag works but is hard to reason about. Best done alongside TODO 9 in a dedicated test framework cleanup session.

**Files:** `tests/e2e/framework/message-builder.ts`
**Action:** Separate into `SipDialogState` (callId, localTag, remoteTag, localCSeq, remoteCSeq, routeSet, remoteContact) and `FrameworkBookkeeping` (messagesByRef, pendingRequests, sentRequests, lastMessage, callIdConfirmed, localTags).

---

## Remaining — rule framework

### TODO 15: Thread target dialog through `relay-to-peer` action

**Priority:** LOW — already functionally fixed
**Reason:** `executeRelayToPeer` now extracts `targetToTag` from `findByATag` and threads it through correctly. The design improvement (adding `targetDialog` to the action type to make routing explicit) is nice-to-have but not a bug.

- [ ] Consider `{ type: "relay-to-peer", targetDialog?: string }` to make routing explicit in the action rather than hidden in the executor's fallback chain.

### TODO 18: `byeDisposition` not set by `destroy-leg`

**Priority:** MEDIUM
**What:** `executeDestroyLeg` sets `leg.state = "terminated"` but does not set `byeDisposition`. `isFullyResolved()` checks that every non-trying leg has a terminal `byeDisposition`. Without it, the call gets stuck in `"terminating"` forever (until 64s safety timer).

- [ ] Make `byeDisposition` mandatory when `state === "terminated"` — either in the Schema (conditional validation) or as an assertion in `setLegState`.
- [ ] Consider merging `state` and `byeDisposition` into a single discriminated union: `{ state: "terminated", disposition: "bye_sent" | "bye_received" | ... }`.

### TODO 20: Reorganize rule files by SIP concern

**Priority:** MEDIUM
**What:** `CornerCaseRules.ts` is a grab bag of unrelated rules (race condition, retransmission, re-INVITE relay, glare). `DialogRules.ts` contains absorption rules unrelated to dialog state.

- [ ] Reorganize by SIP concern: `ResponseAbsorptionRules.ts`, `ReInviteRules.ts`, etc. Or merge small rules into files for the related SIP method.

### TODO 21: Migrate `helpers.ts` into ActionExecutor

**Priority:** LOW
**What:** `helpers.ts` (188 LOC) generates `SideEffect[]` arrays for termination — but `ActionExecutor` now handles termination internally. The helpers are only used by `InitialInviteHandler.ts`.

- [ ] Migrate `createBLegFromRoute` into ActionExecutor as a `create-leg` action enhancement.
- [ ] Migrate `terminateCallEffects` usage in InitialInviteHandler to use the `terminate-call` action via the rule chain.
- [ ] Delete `helpers.ts` once InitialInviteHandler is migrated to a rule.

### TODO 22 (remaining): CI check for doc rot

**Priority:** LOW
**What:** The "last verified" date was added to `AdvancedCallModel.md`. The CI check for stale type/field references in docs is still pending.

- [ ] Add a CI check that greps for deleted type/field names in `.md` files (e.g., `bridgedLegs`, `peerMap`, `InDialogHandlers`) to catch doc rot.

---

## Remaining — test framework design issues

These are from the original surprise report. They represent design friction, not bugs.

### 2. `send(200)` Is Dangerously Ambiguous

Responses should always be visually tied to the request they answer. The `inResponseTo` parameter is sometimes required, sometimes optional, sometimes irrelevant.

### 3. `send()` Is Overloaded for Two Different SIP Operations

`send("INVITE")` creates a client transaction. `send(200)` responds to a server transaction. These are fundamentally different operations sharing one method with a `string | number` discriminator.

### 4. `invite()`, `ack()`, `bye()`, `cancel()` Add Almost No Value

Convenience methods are just aliases — they don't enforce any SIP semantics (e.g., `ack()` doesn't verify there's a 200 to ACK).

### 5. No Type-Level Distinction Between UAC and UAS Roles

Both agents get the same `AgentProxy` API. `alice.send(200)` compiles even when Alice has no pending request.

### 8. `AgentDialogState` Is a 14-Field Mutable Bag

See TODO 10 above.

### 13. `recorder.ts` Naming Doesn't Match Responsibility

"Recorder" is really the DSL proxy layer. `message-builder.ts` has three responsibilities under one name.

---

## Summary of implemented items (for reference)

| TODO | What | Commit |
|------|------|--------|
| 14 | Removed `ctx.peer`/`peerDialog` from RuleContext | `deb8c3e` |
| 16 | Moved Effect.void bail-outs to `matches()` across 4 rules | (Task 5 commit) |
| 17 | Distinct priorities for 850-band rules + registry collision warning | (Task 3 commit) |
| 19 | Renamed `pendingReInvites` → `inboundPendingReInvites` | `2c26331` |
| 5 | Validation checks already existed in `validation.ts` | N/A (already done) |
| 6 | `withOr()` now throws "not implemented", `or()` marked experimental | `226998b` |
| 8 | Fixed stale CLAUDE.md architecture tree | `f675832` |
| 22 | Added "last verified" date to AdvancedCallModel.md | `ea5f143` |
