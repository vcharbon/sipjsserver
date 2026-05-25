# Surprises & Time Wasters — Effect-Layer-Wrappers Initiative

Session: 15-slice rollout of typed Recorder + per-Tag wrapper contracts across SignalingNetwork / CallBodyCodec / PartitionedRelayStorage / CallStateCache / CallLimiter. See [docs/plan/review-this-plan-and-noble-goblet.md](../plan/review-this-plan-and-noble-goblet.md).

The work landed, but several recurring patterns burned subagent cycles or sent investigations on the wrong path. This is the friction log.

**Wrapper-initiative validation (added 2026-05-25).** Promoting four signaling audits from `advisory` to `deferred-fail` surfaced three real B2BUA defects that were hidden under advisory: REFER-realign re-INVITE missing `Allow`/`Supported`, response builder not stamping `received=`/`rport=` per RFC 3581 §4, and the test message builder adding `Contact` on every BYE. Commits `cb8b570d`, `92207401`, `b9ae0ec6`. This is the headline justification for the initiative.

---

## HIGH — affects every future Tag/impl split

### T1. `Layer.suspend` is a load-bearing workaround nobody documents — RESOLVED 2026-05-25

**Surprise:** Slices 1, 11, 12 each independently hit a TDZ crash on the first test run. Error shape: `Cannot read properties of undefined (reading 'key')` from `ServiceMap.ts:582`. Root cause: when a `Tag` class lives in one file and its `Layer.effect(Tag, …)` is exported from a sibling impl file, the impl module evaluates before the Tag's class statics are initialized. `Layer.suspend(() => Layer.effect(Tag, …))` is the workaround.

**Resolution:** Added [src/runtime/lazyEffect.ts](../../src/runtime/lazyEffect.ts) — `lazyEffect(() => Tag, () => Effect.gen(...))`. Both arguments are thunks. Migrated six TDZ-affected call sites: CallStateCache memory/redis, CallLimiter memory/redis (×2 layers in memory), ProxyCore Default. SignalingNetwork.real.ts uses `Layer.sync` (different shape) and was left alone.

**Watch out:** Both arguments MUST be thunks. The initial helper draft passed `Tag` directly and broke 186 tests with the same TDZ error — JavaScript evaluates function arguments eagerly, so `lazyEffect(CallLimiter, ...)` captures `undefined` at module-eval just as eagerly as `Layer.effect(CallLimiter, ...)` did. The original `Layer.suspend(() => Layer.effect(CallLimiter, ...))` idiom worked because the inner lambda re-resolves `CallLimiter` from the closure at execution time; the helper has to preserve that property explicitly via `() => Tag`. See helper docstring for the long form.

**Outstanding doc work (still valid):**
- Add to [.claude/skills/effect-layer-test/SKILL.md](../../.claude/skills/effect-layer-test/SKILL.md): "Tag/impl splits: use `lazyEffect` from `src/runtime/lazyEffect.ts`. Both thunks required." Reference this T1 entry.
- Add to [docs/typescript-effect.md](../typescript-effect.md): the error signature + the `lazyEffect` pointer, since it's a generic Effect v4 trap.

---

### T2. Wrappers' Recorder + RunContext requirement is a production footgun — RESOLVED 2026-05-25

**Surprise:** After Slice 8, `CallBodyCodec.propertyTest/paranoidInputs/parity/scopedAudit` all require `Recorder | RunContext` in their R channel. If anyone applies `withAllContracts(...)` in `src/main.ts` (production), Effect refuses to build the layer without those services. Today nothing in production composes wrappers — verified — but there was no type-level or doc-level signal preventing a future hand from doing it.

**Resolution:** Went with proposal (b). Top-of-file JSDoc warning added to all five `*.contracts.ts` files ([SignalingNetwork](../../src/sip/SignalingNetwork.contracts.ts), [CallLimiter](../../src/call/CallLimiter.contracts.ts), [CallStateCache](../../src/call/CallStateCache.contracts.ts), [PartitionedRelayStorage](../../src/cache/PartitionedRelayStorage.contracts.ts), [codec](../../src/call/codec/contracts.ts)) — each opens with "**TEST-ONLY exports**" and a reviewer-guidance line. Added SKILL.md Rule 6 codifying the convention. No type-level guard or rename; defense is doc + review.

---

### T3. `Effect.forkDetach` in SignalingNetwork.simulated guarantees scope-close anomalies — RESOLVED 2026-05-25

**Surprise:** Slice 4 designed layer-close invariants (counter balance / queue drain / undelivered drain). When activated at `deferred-fail`, **135 false-positive failures** across the fake-stack suite. Root cause: [src/sip/SignalingNetwork.simulated.ts](../../src/sip/SignalingNetwork.simulated.ts) uses `Effect.forkDetach` for transit-delay fibers — they outlive layer scope by design.

**Resolution (commits `3f0bdc38`, `0343c416`, `814217c1`):** Did *not* touch `Effect.forkDetach`. Instead added a bounded `awaitInFlight(200)` quiescence wait in the scopedAudit finalizer ([SignalingNetwork.simulated.ts](../../src/sip/SignalingNetwork.simulated.ts) + [SignalingNetwork.contracts.ts](../../src/sip/SignalingNetwork.contracts.ts)). All three anomalies (`inFlightImbalance`, `queueLeak`, `undeliverable`) now run at `deferred-fail`.

**Lesson:** When transit fibers are "fire and forget" by design, fix the *observer's* readiness window, not the producer's lifetime. The proposed `forkScoped` refactor remains a defensible hygiene pass for the future but is no longer load-bearing for the invariants.

**Watch out:** The `awaitInFlight` impl uses `Effect.callback` + raw `setTimeout` (not `Effect.sleep`) — see T14 for why. Don't "simplify" it back to `Effect.sleep`.

---

## MEDIUM — single-slice friction, but real signal

### T4. The `rfcRules` count was wrong in the plan from day one

**Surprise:** The original plan said "17 rfcRules." Actual count: 17 base + 7 cross-message named imports = **24 total**. Discovered during the interview phase (pre-Slice 1) — but only because I happened to grep the index file. A reader trusting the plan number would have undercounted by 30%.

**Time wasted:** Minor in this session (caught early). For Slice 5 the agent had to discover this AGAIN because the slice brief inherited the wrong premise; we corrected before dispatch.

**Action:**
- Add a check rule to the skill: "When migrating a rule pack, count both the exported array AND any side-imported individual rule modules. Grep for the pack symbol AND for each named import."
- Could also be a CI/lint check: a "rule pack" type that includes all rules by construction.

**Priority:** MEDIUM — caught early this time, but the same pattern (array + named imports) lives elsewhere.

---

### T5. `Recorder.registerProjector` only emits into 3 pre-defined fields

**Surprise:** Slice 0 designed `Recorder.registerProjector(tag, projector)` to support arbitrary `Partial<RecordedScenario>` outputs. But Slice 3 needed to project SipHarness events into legacy `CallRecording.entries` — a field that's NOT in `RecordedScenario` (it's in `tests/harness/recording.ts`). The projector API couldn't be used. Slice 3 had to put the projector in `tests/harness/sipHarnessProjector.ts` and call it manually from the runner, creating a `src → tests` import boundary the skill specifically tries to avoid.

**Time wasted:** Slice 3 spent time on the boundary problem, settled on a transitional projector at the test-side. Slice 14 then had to delete that file as the legacy boundary collapsed.

**Action:**
- Already self-corrected via Slice 14's CallRecording deletion. But: document this limitation in the Recorder API surface itself — `registerProjector` should have a JSDoc saying "projector outputs are merged into `RecordedScenario.sipTrace`/`replTrace`/`anomalies`; if you need a different output shape, the projector belongs in `tests/harness/` and is called manually."
- Or extend the API to support arbitrary projector outputs (write to a `RecordedScenario.extras` map keyed by Tag).
- Recommendation: doc the limitation; don't extend the API until a real downstream needs it.

**Priority:** MEDIUM — caught and worked around, but the API shape implies more flexibility than it has.

---

### T6. `RuleEngine` deletion was scoped too narrowly

**Surprise:** Slice 6 was billed as "delete the old RFC runner." But `RuleEngine` has THREE non-RFC consumers (`call-shape`, `cross-call`, `service-case` rule.test.ts files) PLUS `runner.ts:runDriveOnly`. Slice 6 kept the class alive; Slice 14 had to revisit and chose Path B (keep RuleEngine permanently for these families).

**Time wasted:** Slice 14 spent significant cycles inventorying which consumers needed migration. The original plan called this slice "irreversible" but it ended up being "narrow + carve-out."

**Action:**
- Before drafting a deletion slice, run `git grep -l <class-or-symbol-to-delete>` and triage consumers FIRST. Add the inventory to the slice brief, not just to the verification step.
- Add to skill / planning guide: "Deletion slices must include a consumer-inventory section in the plan, not just a 'delete X' bullet."

**Priority:** MEDIUM — the same shape will surface in any future deletion-slice planning.

---

### T7. CallStateCache has no production consumer — was it worth wrapping?

**Surprise:** Slice 11 produced a full contracts file (720 LOC), 4 propertyTest + 4 paranoid + 3 audit invariants. Then the slice plan noted: `CallStateCache` has no production consumer in the B2BUA stack (CallState uses `PartitionedRelayStorage` instead). The wrapped layer's only exercise is the per-Tag unit-of-layer tests we created in the same slice.

**Time wasted:** Arguably the entire Slice 11. If CallStateCache is unused, why wrap it? If we're keeping it for a planned future use, where's the ADR for that use?

**Action:**
- Decide: delete `CallStateCache` if truly dead code, OR write an ADR explaining what it's reserved for. Today it's wrapper'd-and-tested but exercises zero real call paths.
- This is a CODEBASE hygiene issue, not a wrapper-initiative issue. But the wrappers made the dead-code more visible.

**Priority:** MEDIUM — clean it up or document it.

---

### T8. CallLimiter `refresh` method-shape divergence between impls

**Surprise:** Memory impl returns `refresh` as a single `Effect.sync`; Redis impl returns it as a two-step Lua eval (acquire-old-window + set-new-window). Slice 13 parity had to add a comparator carve-out: compare only the final returned `newWindow`, not intermediate shapes.

**Time wasted:** Slice 13's parity handler had to special-case `refresh` and document the carve-out. The shape divergence is the kind of thing that should have been called out by `Tag` typing — if the service's contract is "Effect<Success | Failure>", both impls must satisfy that contract identically.

**Action:**
- Audit the `CallLimiter` service interface: do the memory and redis impls actually return *the same shape* for `refresh`? If not, the Tag's type is loose. Tighten it.
- Add to skill: "When wrapping a Tag with multiple impls, list and verify the result-shape per method across impls before designing `parity`. Method-shape divergence is a parity-killer."

**Priority:** MEDIUM — caught and documented, but the same risk lives in every multi-impl layer.

---

### T9. Slice 14 discovered 4 extra `recording.ts` consumers not in the plan

**Surprise:** The plan listed `recording.ts` + `recording-extractor.ts` for Slice 14 deletion. Actual: `recording-codec.ts`, `recording-codec.test.ts`, `_capture.test.ts`, `fixtures/load.ts` (+ a YAML fixture). Slice 14 had to discover and handle all of them.

**Time wasted:** Maybe 30 minutes of subagent discovery time. The plan's inventory was incomplete.

**Action:**
- Same fix as T6: plan deletion slices with a full `git grep` consumer inventory in the slice brief, not just the headline file path.
- This time the consumer set was wider than expected because the legacy `CallRecording` had an entire serialization sub-system (codec + YAML fixtures) that wasn't mentioned in the plan.

**Priority:** MEDIUM — same root cause as T6.

---

## LOW — cosmetic / process

### T10. CLAUDE.md doesn't mention the test-layer library convention prominently

**Surprise:** The shared `tests/support/testLayers.ts` bundle hub was the key piece that kept slices 4–14 from each rewriting Recorder+RunContext wiring. But CLAUDE.md (after the Slice 0 rephrase) only mentions it in one line at the bottom of the test-structure section. Future test authors will probably miss it and reach for `Layer.merge` chains.

**Action:**
- Promote the testLayers.ts mention to its own bullet under "## test strategy" in CLAUDE.md.
- Add an example invocation: `Effect.provide(testLayers.stacks.fake({ config }))`.

**Priority:** LOW — discoverable from the file, but the convention deserves more emphasis.

---

### T11. Slices kept reinventing the per-Tag anomaly buffer pattern

**Surprise:** Codec (Slice 8) used per-wrapper projectors. Storage (Slice 10) used a single shared per-Tag buffer (Slice 8's handoff caught the codec divergence). CallStateCache (Slice 11) and CallLimiter (Slice 12) followed Slice 10's pattern. But the skill didn't document which pattern wins.

**Action:**
- Add to [.claude/skills/effect-layer-test/SKILL.md](../../.claude/skills/effect-layer-test/SKILL.md): "When a Tag has multiple wrappers (e.g., paranoidInputs + scopedAudit + parity), use ONE per-Tag anomaly buffer shared across wrappers. Do not give each wrapper its own buffer + projector — that fragments the source-of-truth at the same Tag."
- Reference Slice 8's mistake → Slice 10's correction as the canonical example.

**Priority:** LOW — pattern is now consistent; doc fix prevents re-litigation.

---

### T12. External plan-file edits between slices were silent

**Surprise:** Between each slice dispatch, the plan file was externally modified (presumably by the user) to flip the slice row to DONE and add the detail-plan link. This was helpful — it kept the plan canonical — but the system-reminder mechanism re-injects the FULL D1–D12 section every time, which is noisy in the conversation log. Most of those 134 lines never changed.

**Action:** N/A — the user is driving this externally. But for future similar orchestration loops, consider asking the user to push truncated reminders OR to commit the plan edits via git so the orchestrator can see the delta via `git diff`.

**Priority:** LOW — workflow note, not a code issue.

---

## Added 2026-05-25 — surfaced during the advisory→deferred-fail promotion pass

### T13. `skipFinalSweep` conflates "skip verifyCleanState" with "skip settle" — RESOLVED 2026-05-25

**Surprise:** `runDriveOnly` in [tests/harness/runner.ts](../../tests/harness/runner.ts) sets `skipFinalSweep: true` via `toDriveOnly` to bypass `verifyCleanState` (cleanup-style assertions moved to call-shape rules). The interpreter's `if (!scenario.skipFinalSweep && transport.settle !== undefined)` short-circuits on the *same* flag — so transit drain is also skipped. Parallel sub-scenarios with in-flight BYE-decrements at the last `expect()` trip `lim.A1_counterBackToZero` as false positives.

**Resolution:** Doc-only. Considered a phase split of `settle()` (drainTransit vs runFinalSweep) but rejected — the existing 16+ `.skipFinalSweep()` callers in chaos/failover tests would have brittle semantics on transit-drain timing, and `runDriveOnly`'s explicit `transport.settle()` already covers the audit case (it needs the CallState termination poll, which is ~2s — longer than what `awaitInFlight`'s 200ms drain can cover).

Doc updates landed in three places: ([interpreter.ts gate comment](../../src/test-harness/framework/interpreter.ts) — three-consequence enumeration), ([dsl.ts `.skipFinalSweep()` method](../../src/test-harness/framework/dsl.ts) — cross-ref to interpreter), and SKILL.md Rule 7 ("Single-flag-two-intents is a recurring trap"). The runDriveOnly explicit settle is now documented as the canonical "finer split" escape hatch.

---

### T14. `Effect.sleep` hangs inside layer-close finalizers under fake-clock — RESOLVED 2026-05-25

**Surprise:** First pass at T3's bounded drain used `Effect.sleep("5 millis")`. Under fake-clock (TestClock), no fiber drives the virtual clock during a layer-close finalizer, so the sleep blocks forever. Ten REFER scenarios timed out at 30–60s before the cause was identified.

**Fix in T3:** Switched to `Effect.callback` + raw `setTimeout` — always fires on real wall-clock regardless of the Effect Clock service in scope.

**Resolution (T14-specific):** Factored the pattern into [src/runtime/sleepRealMs.ts](../../src/runtime/sleepRealMs.ts) as a reusable helper (cleanup-safe via `clearTimeout` on interrupt). Migrated the inline definition in `SignalingNetwork.simulated.ts` to import it. Added a "Wall-clock waits in finalizers — never `Effect.sleep`" subsection to [docs/typescript-effect.md](../typescript-effect.md), placed under "Two clocks under one test" where the conceptual context is established. Also amplified the `Effect.async` → `Effect.callback` rename entry to call out the deceptive typecheck failure mode (subsumes T15).

---

### T15. `Effect.async` is a v3→v4 rename trap that typechecks but fails at runtime — RESOLVED 2026-05-25

**Surprise:** Working on T14 above, the natural first reach was `Effect.async<void>(...)`. Symbol still exists in v4, typechecks fine, but runtime throws `TypeError: yield* (intermediate value) is not iterable`. v4 renamed `Effect.async` → `Effect.callback`.

**Resolution:** Amplified the existing rename entry in [docs/typescript-effect.md](../typescript-effect.md) to call out the deceptive typecheck + the exact runtime error string.

---

### T16. Wrong ADR cite propagated through 5 source lines + 3 plan files + handoff

**Surprise:** `CallLimiter.contracts.ts` originally cited "ADR-0007 peer-takeover" in 5 places (one in the file header, one in scopedAudit options doc, two in audit comments, one in the audit's anomaly detail message). The cited semantics — phantom INCRs left by dead workers, peer's OPTIONS-driven takeover decrement — actually live in **ADR-0004**. ADR-0007 is `strict-sip-parser-as-security-boundary` (an unrelated security ADR).

The wrong cite propagated to `slice-12.md`, `slice-13.md`, the master plan row 12, and the followup handoff at `/tmp/handoff-B7rWuJ.md`. The handoff author flagged uncertainty ("verify exact ADR-0007 path") but did not actually verify before propagating.

**Fix (commit `ec69098f`):** All 5 source cites and 3 doc cites updated to ADR-0004.

**Action:**
- Add to skill: "ADR cites by *number* (not title) require opening the file at least once before propagating. A misnumbered cite tends to recur in every downstream doc that cargo-cults the original."
- For agents: when reviewing a doc that cites `ADR-NNNN`, the first verification step is `head -1 docs/adr/NNNN-*.md` to confirm the title matches the semantics being described.

**Priority:** MEDIUM — cite drift erodes the document's value as a navigation aid.

---

### T17. Documented-but-unimplemented invariants ("doc vapor")

**Surprise:** Investigating PartitionedRelayStorage A3 per the followup handoff (which listed `A3_replicationFrameLeak` as a live advisory needing promotion): the rule is documented in [PartitionedRelayStorage.contracts.ts:619-622](../../src/cache/PartitionedRelayStorage.contracts.ts#L619-L622)'s docstring but **the finalizer body only checks A1 and A2**. A3 was never wired in. The handoff treated it as a live audit because it appeared in the docstring; the actual check site shows otherwise.

**Time wasted:** A subagent could have spent significant time investigating "why doesn't A3 ever fire?" before noticing it isn't wired. We caught it within minutes by skimming the finalizer body, but the trap is set for the next agent.

**Action:**
- When designing or auditing a scope-close audit, cross-reference the docstring's listed invariants against the actual `push(...)` call sites in the finalizer body. Gaps are bugs, not features.
- Decide for A3 specifically: implement it or remove the docstring mention. Today it's pure vapor.

**Priority:** MEDIUM — false confidence in coverage is worse than known uncovered.

---

## Summary table

| # | Issue | Status | Priority | Fix locus |
|---|---|---|---|---|
| T1 | `Layer.suspend` TDZ workaround undocumented | **RESOLVED 2026-05-25** (helper landed; doc updates outstanding) | — | See entry |
| T2 | Recorder+RunContext production footgun | **RESOLVED 2026-05-25** | — | See entry |
| T3 | `forkDetach` makes Slice 4 invariants hollow | **RESOLVED 2026-05-25** (commits `3f0bdc38`, `0343c416`, `814217c1`) | — | See entry |
| T4 | rfcRules count was wrong in plan | open | MEDIUM | SKILL.md planning checklist |
| T5 | `registerProjector` API is narrower than it looks | open | MEDIUM | Recorder.ts JSDoc |
| T6 | RuleEngine deletion scope too narrow | open | MEDIUM | Planning convention |
| T7 | CallStateCache has no production consumer | open | MEDIUM | Codebase hygiene (delete or ADR) |
| T8 | CallLimiter `refresh` shape divergence | open | MEDIUM | Tag interface tightening |
| T9 | recording.ts consumer set wider than plan | open | MEDIUM | Planning convention (same as T6) |
| T10 | testLayers convention buried in CLAUDE.md | open | LOW | CLAUDE.md emphasis |
| T11 | Per-Tag anomaly buffer pattern was relitigated | open | LOW | SKILL.md guidance |
| T12 | Silent external plan edits | open | LOW | Workflow note |
| T13 | `skipFinalSweep` conflates two intents | **RESOLVED 2026-05-25** (doc-only; phase split rejected as over-engineering) | — | See entry |
| T14 | `Effect.sleep` hangs inside layer-close finalizers under fake-clock | **RESOLVED 2026-05-25** | — | See entry |
| T15 | `Effect.async` → `Effect.callback` v4 rename trap | **RESOLVED 2026-05-25** | — | See entry |
| T16 | Wrong ADR cite propagated through code + plans + handoff | **RESOLVED 2026-05-25** (commit `ec69098f`) | — | See entry |
| T17 | Documented-but-unimplemented invariants ("doc vapor") | open | MEDIUM | SKILL.md audit-design rule + decide A3 |

**All HIGH-priority items now RESOLVED.** Initiative delivered: original blockers T1/T2/T3 closed; session-discovered T13/T14/T15/T16 closed; T17 documented and pending an A3 decision. The wrapper initiative is now delivering enforcement — promoting four signaling audits surfaced three real B2BUA defects (see top of doc), validating the design.

Remaining MEDIUM-priority items (T4, T5, T6, T7, T8, T9, T11, T17) are doc-only or codebase-hygiene tasks with no immediate blocker. LOW items (T10, T12) are workflow polish.
