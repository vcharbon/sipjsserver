# Rule Extension Guide

How to add new HTTP-piloted custom rules to the B2BUA rule framework.

> **Before shipping a new rule**, confirm it is covered — or prove that it is meaningfully tested. See [rule-coverage-and-killing.md](./rule-coverage-and-killing.md): the e2e HTML index flags never-fired rules automatically. The `npm run test:rule-kill` campaign is currently disabled pending a fake-clock speedup — run `tsx scripts/rule-kill.ts` manually if you need the mutation audit for a specific rule.

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
import { defineRule, type RuleAction } from "../framework/RuleDefinition.js"
import { definePolicyModule } from "../framework/PolicyModule.js"

// ── Shared state (module-private) ──────────────────────────────────

const PolicyState = Schema.Struct({
  // ... rule-specific state fields
})
type PolicyState = typeof PolicyState.Type

const STATE_KEY = "my_policy"

// ── Rule 1 (module-private) ────────────────────────────────────────

const myRule = defineRule({
  id: "my-rule",
  name: "My Rule Description",
  alwaysActive: true,
  stateKey: STATE_KEY,
  stateSchema: PolicyState,
  paramsSchema: Schema.Undefined,

  // Declarative match descriptor — discriminated union on event kind.
  // The PolicyModule guard is composed into `match.filter` by createRuleRegistry,
  // so the Matcher only picks this rule on events where both the guard and
  // the SIP-level columns accept the event.
  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: "1xx",
    direction: "from-b",
  },

  // `defineRule` infers TState from `stateSchema` via NoInfer — `init` does
  // not need an explicit return-type annotation even when PolicyState has
  // optional fields. ctx is RuleContext<TMatch> here, so ctx.event.message
  // is typed as a SipResponseTagged with INVITE CSeq — no defensive guards.
  init: () => ({ /* initial state */ }),

  handle: (ctx, state) => {
    // Return Effect<RuleHandleResult | undefined>
    // undefined = pass through to next rule
    return Effect.succeed({
      actions: [/* RuleAction[] */],
      state: { /* updated state */ },
    })
  },
})

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

## Callflow services (`defineService`) — typed per-service `ext`

For a bundle of cooperating rules that share **typed** per-call (and per-leg)
state, prefer `defineService` over a hand-built policy module. A service owns a
schema for its call-ext (and optionally leg-ext) slice; rules minted from it
read the decoded slice and return an updated one — the framework decodes
`call.ext[id]` / `leg.ext[id]` before matching and re-encodes on write. See
[ADR-0016](adr/0016-callflow-services-typed-ext.md).

```typescript
import { Schema } from "effect"
import { defineService } from "../framework/Service.js"

const MyCallExt = Schema.Struct({
  phase: Schema.Literals(["announce", "bridge"]),
  playedSdp: Schema.optional(Schema.Uint8ArrayFromBase64), // base64 at rest
})

const myService = defineService({ id: "my-service", callExt: MyCallExt })

myService.rule({
  id: "my-service-on-200",
  name: "...",
  match: { kind: "response", cseqMethod: "INVITE", statusClass: "2xx", direction: "from-b" },
  // filter + handle receive the DECODED slice as the second arg (guaranteed
  // present — the service is active iff its ext key is present):
  filter: (_ctx, ext) => ext.phase === "announce",
  handle: (ctx, ext) =>
    Effect.sync(() => ({
      actions: [/* ... */],
      callExt: { ...ext, phase: "bridge" }, // omit to leave ext unchanged (no flush)
    })),
})

export const myPolicy = myService.toPolicyModule() // register like any policy module
```

- **Activation = ext-presence.** Seed the slice from `/call/new` by returning
  `serviceExt: { ...myService.activate({ phase: "announce" }) }` on the route
  response; `applyRoute` writes it into `Call.ext`. The service's guard is
  "ext key present" (or pass `alwaysActive: true` to `defineService`).
- **Encoded vs decoded.** At rest (and across every codec), `ext[id]` holds the
  **Encoded** form — `Uint8ArrayFromBase64` rides as a base64 string. Never put
  a raw `Uint8Array` in `ext`; the framework owns encode/decode so rules only
  ever see decoded values.
- **Per-leg writes.** Emit a `set-leg-ext` action with a decoded value; the
  minted closure encodes it via the service's `legExt` schema.

## Shared State via `stateKey`

Multiple rules in a policy module can share state by using the same `stateKey`:

```typescript
const rule1 = defineRule({
  id: "rule-1",
  stateKey: "shared_key",
  stateSchema: SharedState,
  // ...
})

const rule2 = defineRule({
  id: "rule-2",
  stateKey: "shared_key",
  stateSchema: SharedState,
  // ...
})
```

Both rules read/write the same entry in `call.ruleState`. The `init()` of whichever rule runs first creates the state; subsequent rules find the existing state via `getRuleState()`.

## Composition with `composesWith`

A rule can declare that it runs BEFORE a named base rule:

```typescript
const myPreProcessor = defineRule({
  id: "my-preprocessor",
  composesWith: "confirm-dialog",  // runs before confirm-dialog
  // ...
  handle: (ctx, state) => {
    // Return actions that run BEFORE confirm-dialog
    // Return undefined to let confirm-dialog run alone
  },
})
```

**Composition semantics:**
1. Framework executes this rule's actions first (updating working call state)
2. Invokes the base rule's `handle()` with the modified state
3. Appends base rule's actions after this rule's actions
4. The combined result claims the event

**When the guard fails:** composition only activates when the composing rule's guard passes AND its `match` descriptor accepts the event. When the guard fails, the base rule runs normally in its original position — it is NOT consumed.

**When `handle()` returns undefined:** the base rule runs alone, as if the composing rule didn't exist.

## Resolving overlap with default rules

A new rule can collide with an existing rule when their `match` descriptors overlap and score the same specificity. The registry validator throws at startup in that case — you must declare the relationship explicitly:

- **`overrides: "<base-id>"`** — the new rule replaces the base in the candidate set whenever its own `match` accepts the event. Used by `suppress-18x` (overrides `relay-provisional`) and by transfer rules (e.g. `transfer-c-realign-200` overrides `retransmit-200`).
- **`composesWith: "<base-id>"`** — the new rule runs additively before the base; the base's actions are appended after. Used by `force-tag-consistency` to pre-seed tag mappings before `confirm-dialog`.
- **Narrow the match** — add a column the existing rule doesn't set (e.g. `legState`, `legDisposition`, `transferPhase`), or replace `statusClass` with an exact `status`. The narrower rule wins by specificity, no override needed.

If you don't pick one of these, `createRuleRegistry` throws with the conflicting pair listed.

## Action Types

Available actions that rules can emit (see `RuleAction` in `RuleDefinition.ts`):

| Action | Purpose |
|--------|---------|
| `relay-to-peer` | Relay event to the peered leg (with optional transform) |
| `relay-to-leg` | Relay event to a specific leg |
| `respond` | Generate a response to the source |
| `ack-leg` | Send ACK to a leg |
| `send-request-to-leg` | Generate a new request to a leg (OPTIONS, INFO) |
| `confirm-dialog` | Populate `legs.{legId}.dialogs[0]` from the current 200 OK response (toTag, contact, routeSet, CSeq floor). One-dialog reach — does not touch leg state, tagMap, or the peer leg. |
| `update-leg-state` | Set `legs.{legId}.state` and optionally `legs.{legId}.disposition`. |
| `stamp-dialog-to-tag` | Stamp an explicit `toTag` onto `legs.{legId}.dialogs[0]` (creates a fresh dialog when none exists — see `makeDialogFromIncoming`/`makeEmptyDialog`). Used on the a-leg (UAS side) at 200-OK-INVITE time. |
| `add-tag-mapping` | Append `{aTag,bLegId,bTag}` to `call.tagMap`. Idempotent by `(bLegId,bTag)`. |
| `create-leg` | Create a new b-leg from snapshot/INVITE |
| `destroy-leg` | **Composite.** Tear down a single leg (BYE for confirmed, CANCEL for trying/early, nothing when a CANCEL is already in flight). Reach: `legs.{legId}.state`, `legs.{legId}.byeDisposition`, `legs.{legId}.disposition` (trying/early path only), `call.activePeer` cleared if the leg was peered. |
| `cancel-leg` | **Primitive.** CANCEL an outstanding INVITE on an early/trying b-leg while keeping the leg alive. Reach: `legs.{legId}.disposition → "cancelling"` only — cancel-resolving rules set the final `byeDisposition` when bob responds. |
| `terminate-leg` | **Primitive.** `legs.{legId}.state → "terminated"` and (when named) `legs.{legId}.byeDisposition`. No outbound. |
| `merge` / `split` | **Primitives.** INAP-style peering. Reach is limited to `call.activePeer` (merge sets it to `{legA, legB}`; split clears it when the named leg is part of the pair). |
| `schedule-timer` / `cancel-timer` | Timer management |
| `begin-termination` | **Composite (call-scope).** Graceful call teardown. Reach: every live leg’s `byeDisposition` (+ `state` on CANCELed b-legs), `call.state → "terminating"`, appends a `terminating_timeout` safety timer. `call.activePeer` preserved so final BYE responses still route. |
| `terminate-call` | **Composite (call-scope).** Immediate cleanup — every leg `state → "terminated"`, `call.state → "terminated"`, `call.activePeer → null`. Reserved for `onError:"terminate"` and pre-dialog failures. |
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

## Adding a new action field

Every `execute*` function in [src/b2bua/rules/framework/ActionExecutor.ts](../src/b2bua/rules/framework/ActionExecutor.ts) begins by destructuring every field of its action parameter. Combined with the repo-wide `noUnusedLocals` / `noUnusedParameters` flags in [tsconfig.json](../tsconfig.json), this turns "declared but never read" fields into a compile-time error.

When adding a new field to a `RuleAction` variant:

1. Add the field to the action variant in [src/b2bua/rules/framework/RuleDefinition.ts](../src/b2bua/rules/framework/RuleDefinition.ts).
2. Add the field to the destructure at the top of the corresponding `executeXxx` in [src/b2bua/rules/framework/ActionExecutor.ts](../src/b2bua/rules/framework/ActionExecutor.ts).
3. Reference the identifier in the executor body (or `void` it with a one-line comment explaining why it's intentionally unused — the discriminator `type` is the only pre-existing case).
4. Add a reach test in `tests/unit/rules/actions-reach.test.ts` asserting the field's observable effect (what state it mutates or what outbound it affects).
5. Re-run `npm run typecheck` + `npm test` and confirm both are green.

Pattern:

```ts
function executeCreateLeg(
  action: Extract<RuleAction, { type: "create-leg" }>,
  ctx: RuleContext,
  state: ExecutionState,
): void {
  const { type, destination, fromInvite, noAnswerTimeoutSec, callbackContext, bodyUpdate, headerUpdates, ruri } = action
  void type  // discriminator, intentionally unused
  // every other identifier MUST be referenced below or typecheck fails
  ...
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
