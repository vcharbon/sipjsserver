# Surprises & Time Wasters: Rule Priority Collision + ruleState Schema Fix

Session: 2026-04-12 — fixing priority collision warnings, ruleState decode crash, and logging gaps.

---

## Surprise 1: `RuleStateEntry.state` was required but `undefined` is a valid value

**What happened**: The `RuleStateEntry` schema declared `state: Schema.Unknown` (required), but every stateless rule (all 18+ built-in rules) stores `state: undefined`. This works in-memory because JS objects can hold `undefined` values. But `JSON.stringify` silently drops `undefined` keys, so after a Redis round-trip the key vanishes and `Schema.decodeUnknownSync` throws "Missing key". This only surfaces under sustained load when calls spill to Redis and get re-decoded — invisible in unit tests that stay in-memory.

**Why this is a design problem**: The sibling field `ActiveRule.params` was already `Schema.optional(Schema.Unknown)` (line 260), proving the pattern was known. The inconsistency suggests `RuleStateEntry` was written separately without cross-referencing the existing schema patterns.

**Time wasted**: ~15 min tracing the JSON round-trip serialization path to confirm the root cause.

### TODO 1: Audit all Schema structs with `Schema.Unknown` fields for JSON safety
- [ ] Grep for `Schema.Unknown` in struct fields across CallModel.ts
- [ ] Verify each one is either `Schema.optional(Schema.Unknown)` or is guaranteed to never hold `undefined`
- [ ] Add a comment on `RuleStateEntry.state` explaining why it's optional (JSON round-trip drops undefined)

---

## Surprise 2: Priority collision warning fired but was just noise

**What happened**: The `createRuleRegistry` function warns on startup when multiple alwaysActive rules share a priority. This warning fired 3x (once per worker) on every startup. The comment in the code (RuleRegistry.ts:46-50) explicitly acknowledges these are safe because matchers don't overlap — yet the warning fires anyway. The "fix" was a comment explaining why the warning is okay, while the warning keeps spamming logs on every process start.

**Why this is a design problem**: Either enforce unique priorities (our fix) or don't warn. A warning that fires every time and is known to be benign trains operators to ignore all warnings. The fact that it printed 3x (once per worker) made it extra noisy in cluster mode.

**Time wasted**: Minimal (< 5 min), but this has been wasting operator attention on every startup for however long it's been in the codebase.

### TODO 2: Consider making priority collisions a fatal error now that all built-ins have unique priorities
- [ ] Change `console.warn` to `throw new Error` in `createRuleRegistry` for priority collisions
- [ ] This prevents future regressions where someone adds a rule at a colliding priority
- [ ] Alternative: keep as warning but add a `suppressPriorityCollisionWarning?: boolean` flag on `RuleDefinition` for intentional sharing

---

## Surprise 3: Stale priority numbers baked into comments everywhere

**What happened**: Every rule file has section headers like `// ── relay-options (priority 900) ──────`. The `index.ts` array has comments like `// Default relay and lifecycle rules (priority 900)`. After changing priorities, 8 of these comments are now stale (DialogRules.ts still says "priority 900" for `confirm-dialog` which is now 903, `relay-non-invite-200` which is now 927; FailureRules.ts says "priority 900" for rules now at 906/909; index.ts line 53 says "priority 800" but rules are now 800/805/810; line 69 says "priority 900" but rules span 900-942).

**Why this is a design problem**: Hard-coded numbers in comments are doomed to drift from the actual `defaultPriority` values. The comment is redundant since the priority is right there in the code 2 lines below. These comments add maintenance burden for zero value.

### TODO 3: Remove priority numbers from section-header comments
- [ ] In all rule files under `src/b2bua/rules/defaults/`, remove `(priority NNN)` from section-header comments — the actual `defaultPriority` field is the source of truth
- [ ] In `index.ts`, update comments to say band names instead of exact numbers (e.g. "Terminating-state rules (800 band)" instead of "priority 800")
- [ ] Update the stale comments in DialogRules.ts and FailureRules.ts that still say "priority 900"

---

## Surprise 4: Zero error context in the main event processing error handler

**What happened**: `SipRouter.ts:660` had `Effect.logError("Unhandled error processing event", cause)` — the catch-all for the entire event processing pipeline. No event type, no callRef, no method, no timer type. During a perf test processing 200k+ packets, this error message is useless for correlating which event triggered the failure. The `event` variable was right there in the closure scope, just never used.

**Why this is a design problem**: This is the last line of defense for error reporting. If it doesn't tell you what happened, you're grepping through packet captures. The fact that `describeEvent()` didn't exist until now (despite `CallEvent` having 4 distinct variants each with different identifying fields) suggests error context was never prioritized.

### TODO 4: (DONE) Added `describeEvent()` helper and enriched error/fallback logs
- [x] Created `describeEvent(event: CallEvent): string` in SipRouter.ts
- [x] Updated catchCause log to include `[${describeEvent(event)}]`
- [x] Updated noopFallback to include `describeEvent`, `callRef`, and `call.state`

---

## Surprise 5: noopFallback duplicated in main.ts and WorkerEntry.ts

**What happened**: The exact same `noopFallback` handler is copy-pasted in both entry points. When we updated the log message, we had to make the identical change in two files and add the same import to both.

**Why this is a design problem**: Two entry points with identical handler setup means every change must be applied twice. The handler registry construction (`createRuleRegistry`, `noopFallback`, `executeRules`, `handleInitialInvite`) is identical between standalone and cluster modes — only the transport layer differs (UDP vs IPC). This should be a shared `createHandlers()` factory.

### TODO 5: Extract shared handler registry setup
- [ ] Create a shared function (e.g. in `src/b2bua/HandlerFactory.ts` or alongside `RuleExecutor.ts`) that builds the `HandlerRegistry` from `createRuleRegistry(defaultRules, policyModules)` + `noopFallback` + `executeRules`
- [ ] Both `main.ts` and `WorkerEntry.ts` call this shared factory
- [ ] Eliminates the duplicate `noopFallback`, `createRuleRegistry`, and `executeRules` wiring

---

## Surprise 6: Deep relative imports in rule framework (`../../../`)

**What happened**: Every file under `src/b2bua/rules/framework/` imports from `../../../sip/types.js`, `../../../call/CallModel.js`, `../../../sip/SipRouter.js`, `../../../config/AppConfig.js`, etc. That's 3 levels of `../` for every cross-module import. Files under `src/b2bua/rules/defaults/` have `../../` depth for the same targets. The `framework/` directory alone has 15+ such deep imports.

**Why this is a design problem**: Deep relative paths are fragile (break on directory restructure), hard to read, and make it unclear what's a "local" vs "external" dependency. TypeScript path aliases (e.g. `@sip/types`, `@call/CallModel`) would make these clean and refactor-safe.

### TODO 6: Consider TypeScript path aliases for cross-module imports
- [ ] Evaluate adding `paths` to `tsconfig.json` (e.g. `"@sip/*": ["src/sip/*"]`, `"@call/*": ["src/call/*"]`)
- [ ] This affects build tooling (tsc path resolution, vitest, etc.) so evaluate the migration cost
- [ ] Low priority — functional but annoying

---

## Surprise 7: Hidden default priority of 900 if `defaultPriority` is omitted

**What happened**: `RuleRegistry.ts:54` and `RuleExecutor.ts:76` both use `rule.defaultPriority ?? 900`, meaning any alwaysActive rule without an explicit `defaultPriority` silently joins the 900 band. This is undocumented and means a new rule contributor could forget to set `defaultPriority` and not notice until it collides with existing rules.

### TODO 7: Make `defaultPriority` required for alwaysActive rules
- [ ] In `createRuleRegistry`, check that every `alwaysActive` rule has an explicit `defaultPriority` — throw if missing instead of defaulting to 900
- [ ] Keep the `?? 900` fallback in `RuleExecutor.buildRuleList` for per-call rules (those use `ActiveRule.priority` anyway)
- [ ] This prevents silent priority collisions from omitted fields
