# RFC Compliance: CANCEL, B-Leg Creation, and Auto-ACK — Surprises & Todos

Observations from fixing 8 RFC compliance violations across CANCEL handling, delayed-offer model, auto-ACK for non-2xx, and failover INVITE construction.

---

## 1. Duplicate B-Leg Creation Paths — Two Independent Implementations

**Priority: HIGH** (caused confusion, forced parallel fixes, and is a correctness timebomb)

### Problem

There are two completely independent code paths that construct b-legs:

1. **`helpers.ts:createBLegFromRoute()`** — used by `InitialInviteHandler` for the first b-leg
2. **`ActionExecutor.ts:executeCreateLeg()`** — used by the rule engine for failover b-legs

Both build a `Leg` object, call `buildBLegInvite()`, merge headers, schedule no-answer timers, and add CDR events. But they do it with different code, different parameter shapes (`RouteParams` vs `RuleAction`), and different ordering of operations.

When I added `inviteRequestUri` to the Leg, I had to fix it in **both** places with slightly different code. When `newRuri` support was added, it only existed in `helpers.ts` (via `RouteParams.new_ruri`) but was missing from `ActionExecutor.ts` — the rule engine silently passed `undefined` to `buildBLegInvite`, causing failover INVITEs to use the wrong Request-URI.

### Why This Is Dangerous

Any future Leg field addition (e.g. `inviteBranch`, SDP state tracking, codec negotiation state) must be added to **both** paths or one will silently break. There's no compiler safety net — the Leg fields are optional, so forgetting one path compiles fine.

### Suggested Fix

Extract a shared `buildBLeg()` function that both paths call. It should accept a normalized input (destination, INVITE source, header overrides, RURI override, timeout) and return `{ leg: Leg, invite: SipRequest, timer: TimerEntry }`. Both `createBLegFromRoute` and `executeCreateLeg` become thin adapters that map their specific parameter shapes to this shared core.

---

## 2. CANCEL Construction Copy-Pasted in 3 Places

**Priority: HIGH** (caused 3 identical edits, will cause 3 identical bugs next time)

### Problem

`buildCancel()` is called identically in three functions in `ActionExecutor.ts`:

- `executeDestroyLeg` (line ~860)
- `executeTerminateCall` (line ~925)
- `executeBeginTermination` (line ~997)

All three had the same bug (hardcoded `sip:target@host:port` instead of `leg.inviteRequestUri`) and all three needed the same fix. The call signature is:

```typescript
buildCancel(leg.callId, leg.fromTag, leg.inviteRequestUri ?? `sip:target@...`, leg.initialCSeq ?? 1, leg.localUri, leg.remoteUri)
```

### Suggested Fix

Add a `buildCancelForLeg(leg: Leg): SipRequest` helper in `ActionExecutor.ts` or `MessageFactory.ts` that encapsulates this. The Leg already carries all the data needed. The 3 call sites become `buildCancelForLeg(leg)`.

---

## 3. `stampHeaders` Is a Black Hole — Generates Branch But Doesn't Return It

**Priority: HIGH** (forced an ugly regex extraction hack in processResult)

### Problem

`SipRouter.stampHeaders()` replaces `__PLACEHOLDER__` Via with a generated branch, but returns only the stamped message. The branch value is discarded. To implement CANCEL branch reuse (RFC 3261 section 9.1), I had to:

1. Call `stampHeaders()` to stamp the INVITE
2. Parse the stamped Via header back with a regex to extract the branch
3. Store it on the Leg via `callState.update()` — **inside the outbound sending loop**

This means we now have a `callState.update()` call injected into what the architecture describes as a pure "output" phase (step 2 of the fixed-order execution pipeline). The CLAUDE.md clearly states the order is: "1) update state, 2) stamp+send outbound, 3-7) execute side effects". We're violating our own invariant.

### Suggested Fix

`stampHeaders` should return `{ message: SipMessage, branch?: string }` — structured output instead of just the message. The caller can then store the branch on the Leg during the state-update phase (step 1), or the branch capture can be a dedicated side effect. Alternatively, `buildVia` could accept an out-parameter or the branch could be pre-generated and passed in (which is actually what `forceBranch` already does — just generalize it to always be caller-provided).

---

## 4. `determineOutboundLeg` Uses String Matching on `env.label`

**Priority: MEDIUM** (fragile, would break silently if label format changes)

### Problem

```typescript
function determineOutboundLeg(call: Call, env: OutboundEnvelope): string {
  // ...
  for (const bLeg of call.bLegs) {
    if (env.label.includes(bLeg.legId)) return bLeg.legId
  }
  return call.bLegs[0]?.legId ?? "b-1"
}
```

The outbound leg is determined by checking if the free-text `label` string contains the leg ID. Labels like `"send b-1 INVITE"` or `"CANCEL b-2 (begin-termination)"` happen to work, but:

- If anyone writes a label like `"send INVITE to b-1 backup"` vs `"send b-12 INVITE"`, `b-1` would match `b-12`.
- The fallback `call.bLegs[0]?.legId ?? "b-1"` silently picks the wrong leg if label matching fails.

### Suggested Fix

Add `legId: string` to `OutboundEnvelope`. Every envelope creator already knows which leg the message is for. This eliminates the heuristic entirely.

---

## 5. `allowExtra("ACK")` Needed in 5+ Scenarios After Auto-ACK Fix

**Priority: MEDIUM** (caused 3 test failures, 2 more were silently passing by timing luck)

### Problem

After implementing RFC 3261 section 17.1.1.3 (auto-ACK for non-2xx on client INVITE transactions), every test scenario where a bob agent replies with a non-2xx to a B2BUA INVITE now receives an ACK. I had to add `bob.allowExtra("ACK")` to:

- `cancel.ts` (487)
- `limiter-cancel.ts` (487)
- `failover-reroute.ts` (503)
- `shared-port.ts` / `failover-with-headers` (486)
- `suppress-18x.ts` / `failover-reject` (503)
- `suppress-18x.ts` / `failover-no-answer` (487)

Two of these (cancel.ts, limiter-cancel.ts) were passing by luck — the scenario ended before the ACK arrived, so the framework never checked. This means the "unexpected message" detection is timing-dependent, which is itself a latent bug.

### Suggested Fix

The test framework knows the SIP transaction model. When a UAS agent sends a non-2xx final response to an INVITE, the framework should **automatically expect** an ACK from the B2BUA — this is not an "extra" message, it's mandatory per RFC. This could be:

- A framework-level implicit expectation (like the CANCEL validations added in this session)
- Or at minimum, auto-allow ACK after non-2xx INVITE responses

This would eliminate all the `allowExtra("ACK")` boilerplate and catch the case where ACK is **missing** (which was the original bug this session fixed).

---

## 6. `executeCreateLeg` Ordering Dependency — baseInvite Must Be Resolved Before bLeg

**Priority: MEDIUM** (caused a failed edit and forced code restructuring)

### Problem

The original code in `executeCreateLeg` constructed the `bLeg` object first, then resolved `baseInvite` afterward. Since `Leg` is a Schema-derived readonly type, I couldn't set `inviteRequestUri` after construction. I had to restructure the function to resolve `baseInvite` first.

This ordering was not just inconvenient — it was architecturally backwards. The bLeg needs data from `baseInvite` (the Request-URI), but was constructed before that data was available.

### Suggested Fix

Already done as part of this session (moved `baseInvite` resolution above `bLeg` construction). But the same pattern may exist elsewhere. Audit other Leg/Dialog construction sites for similar ordering dependencies where Schema readonly types prevent post-construction mutation.

---

## 7. `docs/b2bua-sip-headers.md` Missing CANCEL Request-URI and Branch Requirements

**Priority: MEDIUM** (CLAUDE.md says to read this doc before modifying header logic, but it didn't cover the bugs)

### Problem

The doc says:
> "CANCEL reuses the original INVITE's CSeq number."

That's it. No mention of:
- **CANCEL must copy the Request-URI from the original INVITE** (RFC 3261 section 9.1)
- **CANCEL must copy the topmost Via (including branch) from the original INVITE** (RFC 3261 section 9.1)

These are the two bugs that consumed the most implementation time in this session. The doc covers CSeq (which was already correct) but misses the two properties that were actually broken.

### Suggested Fix

Add a "CANCEL header requirements" section to `docs/b2bua-sip-headers.md` covering:
- Request-URI: must match INVITE's Request-URI exactly
- Via: topmost Via (including branch) must match INVITE's topmost Via
- CSeq: same number as INVITE, method = CANCEL (already documented)
- From/To/Call-ID: same as INVITE (standard dialog matching)

Also add a section on "ACK for non-2xx" documenting:
- Request-URI: from original INVITE
- Via: from original INVITE (same branch)
- CSeq: same number as INVITE, method = ACK
- No body, Content-Length: 0

---

## 8. `create-leg` Action Type Missing `newRuri` — Silent Failover Bug

**Priority: LOW** (already fixed, but the design gap is instructive)

### Problem

`buildBLegInvite()` has accepted a `new_ruri` parameter since it was written. `RouteParams` (used by `helpers.ts`) has `new_ruri` since it was written. But the `create-leg` rule action type in `RuleDefinition.ts` never had `newRuri`.

This meant every failover b-leg created through the rule engine used the wrong Request-URI. The HTTP API returned `new_ruri` in the failure response, `FailureRules.ts` had access to it, but the action type had no field to carry it through. The value was silently dropped.

### Root Cause

When the rule engine was added as a second path for b-leg creation, not all capabilities from the original `RouteParams` were ported to the `RuleAction` type. There's no systematic check that the two interfaces are feature-equivalent.

### Suggested Fix

Already fixed. But consider adding a comment or test that verifies all `RouteParams` capabilities are expressible through `RuleAction` create-leg.
