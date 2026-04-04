# Plan: Wait for BYE Response Before Call Cleanup

## Problem

When a call is terminated (BYE, CANCEL, timer, etc.), the current code immediately
calls `remove-call` which deletes the call from in-memory `callsMap` and sets a
short TTL on the Redis cache entry. If a legitimate SIP message for that call
arrives afterward (e.g., the 200 OK response to the BYE we just sent), `checkout()`
reloads the call from Redis cache back into `callsMap`. The handler sees
`state === "terminated"` and returns `noop(call)` with no effects — no
`remove-call` — so the call stays in memory forever.

This is the root cause of `calls_concurrent ≈ calls_total` observed under load:
41,000+ calls accumulating in memory with zero cleanup.

### Why TransactionLayer doesn't prevent this

TransactionLayer absorbs **retransmissions** of the same request (same branch).
But the 200 OK for our outbound BYE is a **response to a client transaction we
created** — it's a legitimate new message that TransactionLayer correctly passes
through. The problem is the application layer removed the call before the BYE
transaction completed.

## Design

### Core principle

**A call stays in memory and in Redis until we are certain no more SIP messages
will arrive for it.** "Certain" means: every outbound BYE/CANCEL transaction
either received a final response or timed out at the transaction layer.

### New call state: `"terminating"`

Add `"terminating"` to `CallModelState` (alongside `"active"` and `"terminated"`).

- `"terminating"` = BYE has been sent, waiting for all far-side BYE responses.
  Call stays in memory and Redis. New non-BYE-response messages are dropped.
- `"terminated"` = all BYE transactions resolved. Call can now be deleted.

### Per-leg BYE tracking

Add an optional field to `Leg`:

```typescript
byeDisposition: Schema.optional(Schema.Literals([
  "bye_sent",       // We sent BYE to this leg, awaiting response
  "bye_received",   // We received BYE from this leg (already sent 200 OK)
  "bye_confirmed",  // 200 OK for our BYE received (or BYE from them acknowledged)
  "bye_timeout",    // Transaction timed out — no response to our BYE
  "cancelled",      // CANCEL sent (pre-dialog, no BYE needed)
  "rejected",       // Far-side rejected INVITE (4xx/5xx/6xx, no BYE needed)
  "none",           // Leg was never established (e.g., failover replaced it)
]))
```

The field defaults to `undefined` (not set) for active legs. When BYE is sent or
received, the field is set to the appropriate value.

### When is a terminating call fully resolved?

A call transitions from `"terminating"` to `"terminated"` when **every leg** has
a terminal `byeDisposition`:

```typescript
function isFullyResolved(call: Call): boolean {
  const legsToCheck = [call.aLeg, ...call.bLegs]
  return legsToCheck.every(leg => {
    // Legs that never established don't need BYE resolution
    if (leg.state === "trying" && leg.byeDisposition === undefined) return true
    // Already resolved
    return leg.byeDisposition === "bye_confirmed"
        || leg.byeDisposition === "bye_timeout"
        || leg.byeDisposition === "bye_received"
        || leg.byeDisposition === "cancelled"
        || leg.byeDisposition === "rejected"
        || leg.byeDisposition === "none"
  })
}
```

### Redis cleanup: delete, not expire

Currently `remove()` sets a short TTL on Redis keys (`callCleanupDelaySec = 32s`)
as a "soft delete" to allow retransmissions to resolve. With the new design, we
**wait for all transactions to complete before removing**, so by the time we call
`remove()` we are confident no more messages will arrive. Therefore:

- Replace `cache.expireCall()` / `cache.expireIndex()` in the remove path with
  `cache.deleteCall()` / `cache.deleteIndex()` (new methods on `CallStateCache`).
- The call is gone from both memory and Redis immediately and permanently.
- TransactionLayer still holds the completed transaction for its 65s sweep, so
  true retransmissions of the BYE request get the cached 200 OK replayed.

## All Termination Cases

Every path that currently calls `terminateCallEffects()` must be reviewed.
The key question for each: **does this path send outbound BYE/CANCEL that we
need to wait for a response?**

### Case 1: BYE from a-leg (`handleBye`, direction="from-a")

**Current:** Send 200 OK to a-leg, relay BYE to all bridged b-legs, `remove-call`.

**New:**
1. Send 200 OK to a-leg.
2. Set `aLeg.byeDisposition = "bye_received"`.
3. For each bridged b-leg: relay BYE, set `bLeg.byeDisposition = "bye_sent"`.
4. Set `call.state = "terminating"`.
5. Effects: `cancel-all-timers`, `write-cdr`, `flush-redis`. **No `remove-call`.**
6. When 200 OK for each b-leg BYE arrives → set `byeDisposition = "bye_confirmed"`.
7. When all legs resolved → `remove-call` + `decrement-limiter` + `delete-redis`.

### Case 2: BYE from b-leg (`handleBye`, direction="from-b")

**Current:** Send 200 OK to b-leg, relay BYE to a-leg, `remove-call`.

**New:**
1. Send 200 OK to b-leg.
2. Set `bLeg.byeDisposition = "bye_received"`.
3. Relay BYE to a-leg, set `aLeg.byeDisposition = "bye_sent"`.
4. Other bridged b-legs (if any): send BYE, set `byeDisposition = "bye_sent"`.
5. Set `call.state = "terminating"`.
6. Effects: `cancel-all-timers`, `write-cdr`, `flush-redis`. **No `remove-call`.**
7. Wait for responses from a-leg and other b-legs.

### Case 3: CANCEL from a-leg (`handleTransactionCancelled`)

**Current:** Send CANCEL to all b-legs, `remove-call`.

**New:**
1. Set `aLeg.byeDisposition = "cancelled"`.
2. For each b-leg: send CANCEL, set `byeDisposition = "cancelled"`.
3. Set `call.state = "terminating"`.
4. Effects: `cancel-all-timers`, `write-cdr`, `flush-redis`. **No `remove-call`.**
5. The CANCEL + 487 flow is handled by TransactionLayer. The b-leg may respond
   with 487 (or 200 OK if it raced with a provisional). Either way, the response
   arrives through the normal handler path.
6. **Question:** For CANCEL, do we need to wait for the 487? TransactionLayer
   sends the 487 autonomously. The b-leg's 487 response is absorbed at the
   transaction layer (ACK for non-2xx). The only message that leaks through is
   a 200 OK that raced with the CANCEL — and that goes through the normal
   `handle200OkInvite` path which tries to handle it but the call is terminating.
7. **Decision:** For CANCEL, set all b-legs to `"cancelled"` immediately (terminal
   disposition). The 487 is a transaction-layer concern. If a 200 OK races, the
   existing handler already handles it (sends ACK + BYE). That BYE creates a new
   `bye_sent` disposition which enters the wait-for-response flow.

### Case 4: Transaction timeout (`handleTransactionTimeout`)

**Current:** Set `state = "terminated"`, `remove-call`.

**New:**
1. A transaction timeout means the far side is unresponsive — no point waiting.
2. Set all legs to appropriate terminal disposition (`"bye_timeout"` or `"none"`).
3. Set `call.state = "terminated"` directly (skip `"terminating"`).
4. Effects: full `terminateCallEffects` including `remove-call` + delete Redis.

**Rationale:** If the transaction timed out, the far side didn't respond after 32s.
No more messages will arrive. Safe to remove immediately.

### Case 5: No-answer timeout (`handleNoAnswerTimer`)

**Current:** CANCEL b-leg, try failover, or `remove-call`.

**New (no failover):**
1. CANCEL the timed-out b-leg, set `byeDisposition = "cancelled"`.
2. Set `call.state = "terminating"`, send reject to a-leg.
3. A-leg receives 487/408 → ACK for non-2xx absorbed by TransactionLayer.
4. Once a-leg INVITE transaction completes (TransactionLayer handles this),
   all legs are resolved → `remove-call`.
5. **Simplification:** Since we send a final response to the a-leg INVITE,
   the a-leg can be considered resolved once the response is sent (TransactionLayer
   handles ACK for non-2xx). Set `aLeg.byeDisposition = "rejected"`.
   The CANCEL to b-leg is also terminal. Both legs resolved → `remove-call`.

**New (failover):**
- Failover creates a new b-leg. The timed-out b-leg gets `byeDisposition = "cancelled"`.
  Call stays `"active"`. No change to the cleanup flow.

### Case 6: Max duration timeout (`handleMaxDurationTimer`)

**Current:** BYE to both a-leg and all b-legs, `remove-call`.

**New:**
1. BYE to a-leg, set `aLeg.byeDisposition = "bye_sent"`.
2. BYE to all bridged b-legs, set `byeDisposition = "bye_sent"`.
3. Set `call.state = "terminating"`.
4. Effects: `cancel-all-timers`, `write-cdr`, `flush-redis`. **No `remove-call`.**
5. Wait for 200 OK from all legs (or timeout).

### Case 7: Keepalive timeout (`handleKeepaliveTimeoutTimer`)

**Current:** BYE to the OTHER side(s), `remove-call`.

**New:**
1. The timed-out leg is unresponsive — set its `byeDisposition = "bye_timeout"`.
2. BYE to the other side(s), set their `byeDisposition = "bye_sent"`.
3. Set `call.state = "terminating"`.
4. Wait for 200 OK from the legs we sent BYE to.

### Case 8: B-leg INVITE failure (`handleBLegFailure`)

**Current:** Relay error to a-leg, `remove-call`.

**New (no failover):**
1. B-leg rejected the INVITE → `byeDisposition = "rejected"` (already terminal).
2. Relay error to a-leg → a-leg INVITE transaction gets a final response.
3. Set `aLeg.byeDisposition = "rejected"`.
4. All legs are immediately resolved → `remove-call` is safe.
5. **No change needed** for this case — can keep immediate removal.

**New (failover):**
- Same as current — failover creates a new b-leg, no termination.

### Case 9: Initial INVITE rejection (503/486 in `InitialInviteHandler`)

**Current:** Send reject response, `remove-call`.

**New:**
1. No outbound BYE was sent — we only sent a reject response.
2. TransactionLayer handles ACK for non-2xx.
3. No legs were established (or only the a-leg with no dialog).
4. **No change needed** — immediate removal is safe.

### Case 10: 200 OK for BYE (existing handler at line 292)

**Current:** Absorb (noop, empty effects).

**New:**
1. Identify which leg the 200 OK belongs to (from direction + leg in `ResolvedContext`).
2. Set that leg's `byeDisposition = "bye_confirmed"`.
3. Check if all legs are fully resolved.
4. If yes → return effects: `decrement-limiter`, `delete-redis`, `remove-call`.
5. If no → return effects: `flush-redis` (persist the updated disposition).

**This is the critical new handler logic.**

### Case 11: Transaction timeout for outbound BYE

**Current:** `handleTransactionTimeout` runs for the BYE client transaction.

**New:**
1. The call is in `"terminating"` state.
2. The timed-out leg's BYE got no response → set `byeDisposition = "bye_timeout"`.
3. Check if all legs resolved → if yes, `remove-call`.

**Important:** The `timeout` event from TransactionLayer carries `callRef` and
`legId`. This needs to correctly route to the right leg even during `"terminating"`.
Currently, `handleTransactionTimeout` sets the whole call to terminated. It needs
to be aware of the `"terminating"` state and handle per-leg resolution.

## Implementation Steps

### Step 1: Data model changes (`CallModel.ts`)

1. Add `"terminating"` to `CallModelState`: `Schema.Literals(["active", "terminating", "terminated"])`.
2. Add `byeDisposition` field to `Leg` schema.
3. Add `isFullyResolved(call: Call): boolean` helper function.

### Step 2: Cache changes (`CallStateCache.ts`, `CallState.ts`)

1. Add `deleteCall(callRef)` and `deleteIndex(indexKey)` to `CallStateCache`.
2. Implement in Redis layer (simple `DEL` command).
3. Implement in test in-memory layer.
4. Update `CallState.remove()` to use `deleteCall`/`deleteIndex` instead of
   `expireCall`/`expireIndex`.

### Step 3: New side effect type (`SipRouter.ts`)

1. Add `{ type: "delete-redis" }` side effect (or repurpose `"flush-redis"` — but
   keeping them separate is clearer).
2. Wire it in `processResult` to call `callState.deleteRedis(callRef)` or
   inline the delete logic.

Actually, simpler: just change `remove-call` to also delete from Redis (it
already does `expireCall` — change to `deleteCall`). No new side effect needed.

### Step 4: New helpers (`helpers.ts`)

1. Refactor `terminateCallEffects` → split into:
   - `beginTerminationEffects(call)` — cancel timers, write CDR, flush Redis.
     Used when entering `"terminating"` state.
   - `finalCleanupEffects(call)` — decrement limiters, delete Redis, remove call.
     Used when all legs are resolved.
2. Keep `terminateCallEffects` for cases that skip `"terminating"` (immediate
   removal: INVITE rejection, transaction timeout, b-leg failure without BYE).

### Step 5: Update handlers (`InDialogHandlers.ts`)

For each case listed above, update the handler per the "New" description.

The biggest change is **Case 10** — the 200-OK-for-BYE handler — which becomes
the trigger for final cleanup.

### Step 6: Guard against stale `"terminating"` calls

If a bug or edge case prevents a leg from ever resolving (e.g., the transaction
timeout event is lost), the call would be stuck in `"terminating"` forever.

Safety net: add a `"terminating_timeout"` timer (e.g., 64s — twice Timer B/F)
scheduled when entering `"terminating"`. If it fires, force `remove-call`
regardless of leg disposition.

### Step 7: Checkout guard (keep existing fix)

Keep the `checkout()` guard that rejects terminated calls from cache as a safety
net. Extend it to also log a warning — if it fires, something is wrong.

### Step 8: Update `noop` paths

All handlers that check `if (call.state === "terminated") return noop(call)` should
also check `if (call.state === "terminating")` and route to the appropriate
per-leg resolution logic instead of dropping the message.

## Edge Cases to Consider

### Race: 200 OK for INVITE arrives after CANCEL sent

CANCEL was sent to b-leg, but 200 OK for the INVITE arrives first. The existing
handler (`handle200OkInvite`) sends ACK + BYE to that b-leg. This creates a
`"bye_sent"` disposition. The subsequent 200 OK for that BYE resolves it normally.

**No special handling needed** — the existing ACK+BYE-on-cancel-race already
works. Just make sure the disposition is set correctly.

### Race: BYE from both sides simultaneously

A-leg sends BYE, b-leg sends BYE at the same time. Our handler processes A's BYE
first (sends 200 to A, BYE to B). Then B's BYE arrives. Currently the call is
already terminated, so it's a noop.

**New behavior:** Call is in `"terminating"`, `bLeg.byeDisposition = "bye_sent"`.
B's BYE arrives → we send 200 OK to B (correct) → we should set
`bLeg.byeDisposition = "bye_received"` (they sent us BYE, so the leg is resolved
from their side). But we also sent BYE to them. The 200 OK for our BYE might
still arrive.

**Decision:** If we receive BYE from a leg we already sent BYE to, treat it as
resolution: set `byeDisposition = "bye_confirmed"` (both sides agree the leg is
over). Send 200 OK, don't relay further.

### Multiple b-legs (forking / failover)

Only bridged b-legs need BYE. Non-bridged legs that were already terminated
(failover replaced them) should have `byeDisposition` set to `"rejected"` or
`"cancelled"` or `"none"`. The `isFullyResolved` check must handle these correctly.

### Timer fibers after `"terminating"`

Timers are cancelled when entering `"terminating"` (`cancel-all-timers`). But the
`terminating_timeout` safety timer is scheduled at the same time. Make sure it
doesn't conflict.

### Cache recovery after crash

On startup, `loadOwnedCalls` loads calls from Redis. If a call is in
`"terminating"` state, it should be treated as stuck and force-cleaned. The worker
was restarted, so all transaction state is lost — no BYE responses will arrive.

Add to `loadOwnedCalls`: if `decoded.state === "terminating"`, skip it (don't
load into memory) and delete from cache.

### CDR timing

CDR is written when entering `"terminating"` (on BYE), not on final cleanup.
This is correct — the CDR timestamp should reflect when the call ended, not when
the cleanup completed.

## Summary of Changes

| File | Change |
|------|--------|
| `CallModel.ts` | Add `"terminating"` state, `byeDisposition` on Leg, `isFullyResolved()` |
| `CallStateCache.ts` | Add `deleteCall()`, `deleteIndex()` |
| `CallState.ts` | `remove()` uses delete instead of expire; `loadOwnedCalls` skips terminating; keep checkout guard |
| `helpers.ts` | Split `terminateCallEffects` → `beginTerminationEffects` + `finalCleanupEffects` |
| `InDialogHandlers.ts` | Update all 11 cases per above; new 200-OK-for-BYE completion logic |
| `SipRouter.ts` | No new side effect types needed; `remove-call` handler uses delete |
