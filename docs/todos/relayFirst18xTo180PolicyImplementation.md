# Post-Implementation Report: relayFirst18xTo180 Policy

Session: 2026-04-12 — First HTTP-piloted custom rule implementation.

## Surprises and Time Wasters


### 2. Content-Length not updated when MessageTransform replaces body

**Time wasted:** ~15 minutes tracing through the entire SIP pipeline with debug logging.

**What happened:** The `MessageTransform` on `relay-to-peer` supports `body: null` to strip the body. The transform correctly replaces the body with `new Uint8Array(0)`, but `Content-Length` is set by `relayResponse()` BEFORE the transform is applied. The serialized SIP message has `Content-Length: 149` (original SDP size) but zero body bytes. The custom parser in the simulated transport rejects this as `Content-Length 149 exceeds remaining bytes 0` and silently drops the packet.

The silent drop is the real killer. The simulated transport's send function had a bare `catch { return }` — parse failures were swallowed with no trace. I had to add temporary `console.log` statements to find the issue.

**Why this is a latent bug:** This affects ANY rule that uses `MessageTransform.body` to strip or replace a body. It was never caught because no existing rule uses body transforms — all prior transforms only modify status/headers. The first custom rule to strip a body hit this immediately.

**Priority:** CRITICAL (fixed in this session, but the pattern needs a test)

---

### 3. Simulated transport silently swallows parse failures

**Time wasted:** ~5 minutes (would have been more without the Content-Length clue).

**What happened:** `simulated-backend.ts` line 243-245:
```typescript
} catch {
  // Parse failure — drop silently (malformed test packet)
  return
}
```

When the Content-Length mismatch caused a parse failure, the packet was silently dropped. No log, no error, no trace. Alice just never received anything, and the test hung until the 30s timeout.

For a test infrastructure, silently dropping messages is terrible DX. A real transport might legitimately drop malformed packets, but the test transport should scream when something unexpected happens.

**Priority:** HIGH

---

### 4. `relayResponse()` builds Content-Length from original body, then callers mutate body later

**Time wasted:** Subsumed in issue #2, but this is a separate design concern.

**What happened:** `relayResponse()` in `MessageFactory.ts` (line 357) computes `Content-Length` from `bLegResp.body.byteLength` and bakes it into the header list. Then `ActionExecutor.relayResponseMsg()` applies transforms AFTER `relayResponse()` returns — including body replacement. The Content-Length is stale.

This is a violation of "build once, correctly." The Content-Length should either be computed AFTER all transforms, or the transform should be responsible for updating it (which is what I implemented as a fix). But the current design makes it easy to forget.

**Priority:** MEDIUM (fixed, but the pattern is fragile)

---

### 5. CLAUDE.md architecture tree doesn't mention `PolicyModule.ts` or `custom/` rule files

**Time wasted:** Not directly a time waste in this session (I was creating these files), but the architecture tree in CLAUDE.md is now stale.

**What's missing:**
- `src/b2bua/rules/framework/PolicyModule.ts` — not listed
- `src/b2bua/rules/custom/relayFirst18xTo180.ts` — not listed (the `custom/` directory only says "Per-deployment custom rules (REFER, MRF, etc.)")
- `tests/e2e/framework/simulated-backend.ts` — not documented in the architecture tree at all, despite being a critical piece of test infrastructure

**Priority:** MEDIUM

---

### 6. No documentation of "test infrastructure mirrors production wiring"

**Time wasted:** Subsumed in issue #1, but this is the root cause.

**What's missing:** CLAUDE.md should document that `tests/e2e/framework/simulated-backend.ts` is a parallel B2BUA bootstrap. It should warn that any change to production wiring (rule registry, layers, service composition) must be replicated there. Ideally it would link to a section explaining why this duplication exists (test isolation, TestClock, mock layers) and what the risks are.

**Priority:** HIGH

---

### 7. `HandlerResult.spanEvents` type is inlined, not a named type

**Time wasted:** ~2 minutes reading through multiple files to understand the span event structure.

The `spanEvents` field on `HandlerResult` is typed as:
```typescript
readonly spanEvents?: ReadonlyArray<{ readonly name: string; readonly attributes?: Record<string, unknown> }>
```

This anonymous type is repeated in `ActionExecutor.ts`'s `ExecutionState` (slightly different — mutable `Array<{ name: string; ... }>`). When I added `addRuleAttribution()`, I had to match the structure by reading both definitions. A named `SpanEvent` type would be clearer.

**Priority:** LOW

---

## TODO List

### TODO 1: Extract shared B2BUA wiring into a reusable factory

**Priority:** HIGH
**Reason:** Three independent bootstraps (`main.ts`, `WorkerEntry.ts`, `simulated-backend.ts`) diverge silently. Adding a new rule, service, or layer requires updating all three. This caused a 10-minute debugging session.

**Files:**
- `src/main.ts` (lines 148-160)
- `src/cluster/WorkerEntry.ts` (lines 139-155)
- `tests/e2e/framework/simulated-backend.ts` (lines 342-360)

**Action:** Create a `createHandlerRegistry(registry, config)` factory or similar that encapsulates `createRuleRegistry(defaultRules, policyModules)` + `executeRules(registry, fallback)` + handler wiring. All three entry points call this factory. The test infrastructure can override specific layers (mock transport, mock call control) without duplicating the rule registry setup.

**Acceptance:** Adding a new `PolicyModule` requires touching exactly one file for registration (the factory), not three.

---

### TODO 2: Add warning/error logging for parse failures in simulated transport

**Priority:** HIGH
**Reason:** Silent packet drops in test infrastructure cause tests to hang at 30s timeout with no diagnostic. Debugging requires adding temporary `console.log` statements.

**Files:**
- `tests/e2e/framework/simulated-backend.ts` (lines 243-246)

**Action:** Replace the bare `catch { return }` with `catch (e) { console.error(...) }` that logs the parse error, the destination address:port, and the first 200 bytes of the raw packet. Consider also logging to the scenario report so failures show up in test output.

**Acceptance:** A malformed packet to a test agent produces a visible error in test output, not a silent hang.

---

### TODO 3: Add unit test for MessageTransform body replacement + Content-Length

**Priority:** HIGH
**Reason:** The Content-Length bug was latent — no existing test covered body transforms. The fix is in place, but a regression is easy without a targeted test.

**Files:**
- New test in `tests/` (or add to existing ActionExecutor tests if any)

**Action:** Write a unit test that:
1. Creates a `RuleAction` with `relay-to-peer` + `transform: { body: null }`
2. Feeds it through `executeActions` with a context containing a SIP response with a non-empty body
3. Asserts the outbound message has `Content-Length: 0` and empty body
4. Also test `body: new Uint8Array([...])` (replacement with non-empty body) — Content-Length should match

**Acceptance:** Test fails if Content-Length fix is reverted.

---

### TODO 4: Update CLAUDE.md architecture tree

**Priority:** MEDIUM
**Reason:** Architecture tree is stale after this session. New files not documented.

**Files:**
- `CLAUDE.md` (architecture tree section)

**Action:** Add to the architecture tree:
```
      framework/
        ...
        PolicyModule.ts        Type-safe module-level rule grouping with guard
      custom/                  Policy-module rules (HTTP-piloted):
        relayFirst18xTo180.ts    Suppress 18x / force tag consistency policy
```

Also add `tests/e2e/framework/simulated-backend.ts` to the architecture tree or add a note under "Key design decisions" explaining that e2e tests have their own B2BUA bootstrap.

---

### TODO 5: Add "test infrastructure" section to CLAUDE.md

**Priority:** MEDIUM
**Reason:** No documentation that `simulated-backend.ts` is a parallel B2BUA bootstrap. New contributors (or LLMs) will miss it when modifying production wiring.

**Files:**
- `CLAUDE.md`

**Action:** Add a section documenting:
- `tests/e2e/framework/simulated-backend.ts` mirrors production wiring with mock layers
- Changes to rule registry, service composition, or layer wiring MUST be replicated there
- The mock transport, mock call control, and TestClock integration
- Link to `MockCallControlLayer.ts` and explain X-Api-Call driven routing

---

### TODO 6: Extract `SpanEvent` as a named type

**Priority:** LOW
**Reason:** The anonymous `{ name: string; attributes?: Record<string, unknown> }` type is inlined in `HandlerResult` and duplicated (slightly differently) in `ActionExecutor`'s `ExecutionState`. A named type improves readability and ensures consistency.

**Files:**
- `src/sip/SipRouter.ts` (HandlerResult definition)
- `src/b2bua/rules/framework/ActionExecutor.ts` (ExecutionState definition)

**Action:** Define `SpanEvent` type in `SipRouter.ts` (or a shared types file), use it in both `HandlerResult.spanEvents` and `ExecutionState.spanEvents`.

---

### TODO 7: Consider making `relayResponse()` not set Content-Length

**Priority:** LOW
**Reason:** `relayResponse()` sets Content-Length based on the body it receives. But callers (ActionExecutor) may replace the body via transforms AFTER calling `relayResponse()`. This creates a window where Content-Length is wrong. The current fix updates Content-Length in the transform application, but the underlying design is fragile.

**Files:**
- `src/sip/MessageFactory.ts` (`relayResponse()`)
- `src/b2bua/rules/framework/ActionExecutor.ts` (transform application)

**Action:** Either:
- (a) Have `relayResponse()` NOT set Content-Length, and always set it as a final step after all transforms in ActionExecutor
- (b) Have the Serializer always recompute Content-Length from the actual body at serialization time (most robust, but changes the wire-format contract)
- (c) Keep current approach but add a comment warning about the Content-Length + transform ordering dependency

Option (b) is the most robust but largest change. Option (c) is sufficient for now.
