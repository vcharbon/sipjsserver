# Rule Extension Guide

How to add new HTTP-piloted custom rules to the B2BUA rule framework.

## Architecture Overview

The rule system has two categories:

- **Built-in rules** (`src/b2bua/rules/defaults/`) — always-active rules that handle standard B2BUA operations (relay, confirm-dialog, BYE, CANCEL, keepalive, etc.)
- **Policy module rules** (`src/b2bua/rules/custom/`) — grouped rules activated per-call via HTTP routing response flags

Policy modules use the `PolicyModule` type to bundle related rules with a shared activation guard. The guard is applied uniformly by `createRuleRegistry` — individual rules never check it themselves.

## Creating a New Policy Module

### Step 1: Add the HTTP schema field

In `src/http/CallControlSchemas.ts`, add an explicit boolean field to `NewCallRouteResponse` and (if needed for failover) `CallFailureFailoverResponse`:

```typescript
// In NewCallRouteResponse
my_policy_name: Schema.optional(Schema.Boolean),
```

Each policy gets its own explicit field — no generic mechanism.

### Step 2: Add the Call model policy flag

In `src/call/CallModel.ts`, add the flag to the `CallPolicies` struct:

```typescript
export const CallPolicies = Schema.Struct({
  relayFirst18xTo180: Schema.optional(Schema.Boolean),
  myPolicyName: Schema.optional(Schema.Boolean),  // new
})
```

### Step 3: Set the policy flag in InitialInviteHandler

In `src/b2bua/InitialInviteHandler.ts`, after the routing response is received:

```typescript
if (routing.my_policy_name) {
  updated = { ...updated, policies: { ...updated.policies, myPolicyName: true } }
}
```

If the policy needs header overrides on all b-leg INVITEs (including failover), set `policyUpdateHeaders`:

```typescript
updated = {
  ...updated,
  policyUpdateHeaders: {
    ...(updated.policyUpdateHeaders ?? {}),
    "Some-Header": newValue, // or null to remove
  },
}
```

### Step 4: Pass through in MockCallControlServer

In `src/http/MockCallControlServer.ts`, pass the field from X-Api-Call instruction:

```typescript
if (instruction.my_policy_name) {
  response.my_policy_name = true
}
```

### Step 5: Write the policy module

Create `src/b2bua/rules/custom/myPolicy.ts`:

```typescript
import { Effect, Schema } from "effect"
import type { RuleDefinition, RuleAction } from "../framework/RuleDefinition.js"
import { definePolicyModule } from "../framework/PolicyModule.js"

// ── Shared state (module-private) ──────────────────────────────────

const PolicyState = Schema.Struct({
  // ... rule-specific state fields
})
type PolicyState = typeof PolicyState.Type

const STATE_KEY = "my_policy"

// ── Rule 1 (module-private) ────────────────────────────────────────

const myRule: RuleDefinition<PolicyState, undefined> = {
  id: "my-rule",
  name: "My Rule Description",
  alwaysActive: true,
  defaultPriority: 850,  // see Priority Bands below
  stateKey: STATE_KEY,
  stateSchema: PolicyState,
  paramsSchema: Schema.Undefined,

  matches: (ctx) => {
    // Fast synchronous filter — does this rule care about this event?
    // The PolicyModule guard has ALREADY been checked by the framework.
    // Only match on SIP-level criteria here.
    return false
  },

  init: () => ({ /* initial state */ }),

  handle: (ctx, state) => {
    // Return Effect<RuleHandleResult | undefined>
    // undefined = pass through to next rule
    return Effect.succeed({
      actions: [/* RuleAction[] */],
      state: { /* updated state */ },
    })
  },
}

// ── Single export ──────────────────────────────────────────────────

export const myPolicy = definePolicyModule({
  id: "my_policy",
  guard: (ctx) => ctx.call.policies?.myPolicyName === true,
  rules: [myRule],
})
```

**Module encapsulation rules:**
- Individual rules (`myRule`) are `const` with no `export` — module-private
- Only the `PolicyModule` object is exported
- The guard is applied by `createRuleRegistry`, not by individual rules
- Adding a rule to the module = add to the `rules` array — guard is automatic

### Step 6: Register the module

In `src/main.ts`, `src/cluster/WorkerEntry.ts`, and `tests/e2e/framework/simulated-backend.ts`:

```typescript
import { myPolicy } from "./b2bua/rules/custom/myPolicy.js"

const ruleRegistry = createRuleRegistry(defaultRules, [relayFirst18xTo180, myPolicy])
```

## Shared State via `stateKey`

Multiple rules in a policy module can share state by using the same `stateKey`:

```typescript
const rule1: RuleDefinition<SharedState, undefined> = {
  id: "rule-1",
  stateKey: "shared_key",
  stateSchema: SharedState,
  // ...
}

const rule2: RuleDefinition<SharedState, undefined> = {
  id: "rule-2",
  stateKey: "shared_key",
  stateSchema: SharedState,
  // ...
}
```

Both rules read/write the same entry in `call.ruleState`. The `init()` of whichever rule runs first creates the state; subsequent rules find the existing state via `getRuleState()`.

## Composition with `composesWith`

A rule can declare that it runs BEFORE a named base rule:

```typescript
const myPreProcessor: RuleDefinition<...> = {
  id: "my-preprocessor",
  composesWith: "confirm-dialog",  // runs before confirm-dialog
  // ...
  handle: (ctx, state) => {
    // Return actions that run BEFORE confirm-dialog
    // Return undefined to let confirm-dialog run alone
  },
}
```

**Composition semantics:**
1. Framework executes this rule's actions first (updating working call state)
2. Invokes the base rule's `handle()` with the modified state
3. Appends base rule's actions after this rule's actions
4. The combined result claims the event

**When the guard fails:** composition only activates when the composing rule's guard passes AND `matches()` returns true. When the guard fails, the base rule runs normally in its original position — it is NOT consumed.

**When `handle()` returns undefined:** the base rule runs alone, as if the composing rule didn't exist.

## Priority Bands

| Priority | Band | Rules |
|----------|------|-------|
| 100-199 | Corner cases | cancel-200-crossing, retransmit-200, reinvite-glare |
| 200-299 | Re-INVITE responses | relay-reinvite-response |
| 840-860 | **Policy rules** | suppress-18x (850), force-tag-consistency (851) |
| 900-909 | Standard handlers | relay-provisional, confirm-dialog, relay-bye, etc. |

Policy rules should use priorities in the 840-860 band to run before the standard relay/confirm rules they augment.

## Action Types

Available actions that rules can emit (see `RuleAction` in `RuleDefinition.ts`):

| Action | Purpose |
|--------|---------|
| `relay-to-peer` | Relay event to the peered leg (with optional transform) |
| `relay-to-leg` | Relay event to a specific leg |
| `respond` | Generate a response to the source |
| `ack-leg` | Send ACK to a leg |
| `send-request-to-leg` | Generate a new request to a leg (OPTIONS, INFO) |
| `confirm-dialog` | Confirm b-leg dialog on 200 OK |
| `create-leg` | Create a new b-leg from snapshot/INVITE |
| `destroy-leg` | Send CANCEL/BYE to terminate a leg |
| `merge` / `split` | INAP-style peering operations |
| `schedule-timer` / `cancel-timer` | Timer management |
| `begin-termination` | Graceful call teardown (BYE/CANCEL all legs) |
| `terminate-leg` | Mark a single leg as terminated |
| `terminate-call` | Immediate call cleanup |
| `add-cdr-event` | Record CDR event |
| `add-tag-mapping` | Pre-seed a-facing tag ↔ b-leg tag mapping |
| `deactivate-rule` | Deactivate this rule for the current call |
| `send-raw` | Escape hatch for arbitrary SIP messages |

**MessageTransform** (on relay actions):
```typescript
{
  status?: number,          // Override response status (e.g., 183 → 180)
  reason?: string,          // Override reason phrase
  headers?: Record<string, string | null>,  // Add/modify/remove headers
  body?: Uint8Array | null, // Replace body (null = empty)
}
```

## Testing Patterns

### Mock call control via X-Api-Call

Tests use the `X-Api-Call` SIP header to drive routing decisions without a real HTTP backend:

```typescript
const instruction = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: 5690 },
  my_policy_name: true,
  on_failure: {
    action: "failover",
    destination: { host: "127.0.0.1", port: 5691 },
  },
})

alice.invite("sip:+1234@127.0.0.1:15060", {
  headers: { "X-Api-Call": instruction },
  body: sdpOffer(),
})
```

### Verifying suppressed messages

When a rule suppresses a message, the test should NOT have an `expect()` for it. The scenario framework flags unexpected messages — use `allowExtra()` for expected retransmissions:

```typescript
bob2.allowExtra("INVITE")  // Transaction-layer retransmissions
```

### Predicate assertions

Use `predicate` on `expect()` to verify message properties:

```typescript
alice.expect(180, {
  predicate: (msg) => {
    if (msg.type !== "response") return false
    // Check no body
    if (msg.body.length > 0) return false
    // Check specific header absent
    const require = msg.headers.find(h => h.name.toLowerCase() === "require")
    if (require) return false
    return true
  },
})
```

### Tag consistency verification

Capture the To-tag from the first response and verify it matches on subsequent ones:

```typescript
let firstToTag = ""
alice.expect(180, {
  predicate: (msg) => {
    if (msg.type !== "response") return false
    const to = msg.headers.find(h => h.name.toLowerCase() === "to")?.value ?? ""
    firstToTag = /;tag=([^;>\s]+)/.exec(to)?.[1] ?? ""
    return true
  },
})

// ... later, after failover ...

alice.expect(200, {
  predicate: (msg) => {
    if (msg.type !== "response") return false
    const to = msg.headers.find(h => h.name.toLowerCase() === "to")?.value ?? ""
    const okTag = /;tag=([^;>\s]+)/.exec(to)?.[1] ?? ""
    return firstToTag !== "" && okTag === firstToTag
  },
})
```

## Design Decision Log

| Decision | Choice | Reason |
|----------|--------|--------|
| Activation mechanism | `alwaysActive` + PolicyModule guard | Per-call `activeRules` requires HTTP assembling rule lists; guard on Call.policies is simpler |
| Rule grouping | `PolicyModule` with module-private rules | TypeScript module encapsulation prevents unguarded rules from escaping |
| Policy field format | Explicit boolean per policy | Type-safe, self-documenting; avoids string matching bugs |
| State sharing | `stateKey` on RuleDefinition | Multiple rules share typed state without global coupling |
| Composition | `composesWith` field (before-only) | Forward-compatible for after/around; clean semantic without breaking first-match-wins |
| Header overrides | `policyUpdateHeaders` on Call | Persists across failover; merged by both helpers.ts and ActionExecutor.ts |
| Observability | `rule_handled` span event on ALL rules | Uniform tracing regardless of rule type |
