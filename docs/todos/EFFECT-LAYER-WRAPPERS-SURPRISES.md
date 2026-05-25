# Surprises & Time Wasters — Effect-Layer-Wrappers Initiative

Session: 15-slice rollout of typed Recorder + per-Tag wrapper contracts across SignalingNetwork / CallBodyCodec / PartitionedRelayStorage / CallStateCache / CallLimiter. See [docs/plan/review-this-plan-and-noble-goblet.md](../plan/review-this-plan-and-noble-goblet.md).

The work landed, but several recurring patterns burned subagent cycles or sent investigations on the wrong path. This is the friction log.

---

## HIGH — affects every future Tag/impl split

### T1. `Layer.suspend` is a load-bearing workaround nobody documents

**Surprise:** Slices 1, 11, 12 each independently hit a TDZ crash on the first test run. Error shape: `Cannot read properties of undefined (reading 'key')` from `ServiceMap.ts:582`. Root cause: when a `Tag` class lives in one file and its `Layer.effect(Tag, …)` is exported from a sibling impl file (the standard split pattern this initiative imposes), the impl module evaluates before the Tag's class statics are initialized. `Layer.suspend(() => Layer.effect(Tag, …))` is the workaround.

**Time wasted:** Each subagent rediscovered it from first principles. Slice 1's report mentioned it as a footnote; Slices 11 and 12 hit it again because nothing in the skill or CLAUDE.md warns about it. Easily 30–45 minutes of head-scratching per slice.

**Action:**
- Add a section to [.claude/skills/effect-layer-test/SKILL.md](../../.claude/skills/effect-layer-test/SKILL.md) called "Splitting Tag from impl: the Layer.suspend rule." One paragraph + the exact error signature + the fix template.
- Also add to [docs/typescript-effect.md](../typescript-effect.md) since it's an Effect v4 pattern.

**Priority:** HIGH — recurs every split slice; trivial doc fix.

---

### T2. Wrappers' Recorder + RunContext requirement is a production footgun

**Surprise:** After Slice 8, `CallBodyCodec.propertyTest/paranoidInputs/parity/scopedAudit` all require `Recorder | RunContext` in their R channel. If anyone applies `withAllContracts(...)` in `src/main.ts` (production), Effect refuses to build the layer without those services. Today nothing in production composes wrappers — verified during Slice 8 — but there is no type-level or doc-level signal preventing a future hand from doing it.

**Time wasted:** Slice 8 had to manually grep production consumers of `CallBodyCodec.{propertyTest,paranoidInputs,parity,scopedAudit}` to confirm wrappers don't escape into prod. That check is now needed for every new wrapped layer.

**Action:**
- Pick ONE: (a) make wrappers gracefully no-op when Recorder is absent (probably wrong — recording is the whole point), or (b) add a "wrappers are test-only" rule to [.claude/skills/effect-layer-test/SKILL.md](../../.claude/skills/effect-layer-test/SKILL.md) AND a top-level comment in each `contracts.ts` saying so, or (c) name the wrappers' static methods with a `test*` prefix (e.g., `CallBodyCodec.testWithAllContracts`) so the intent is in the name.
- Recommendation: (b) — the skill rule is enough; renaming is heavy.

**Priority:** HIGH — silent prod breakage waiting to happen.

---

### T3. `Effect.forkDetach` in SignalingNetwork.simulated guarantees scope-close anomalies

**Surprise:** Slice 4 designed layer-close invariants (counter balance / queue drain / undelivered drain). When activated at `deferred-fail`, **135 false-positive failures** across the fake-stack suite. Root cause: [src/sip/SignalingNetwork.simulated.ts](../../src/sip/SignalingNetwork.simulated.ts) uses `Effect.forkDetach` for transit-delay fibers — they outlive layer scope by design. Every scope close therefore reports `inFlightImbalance` even when the scenario was clean.

**Time wasted:** Slice 4 had to downgrade all three new anomalies to `advisory`, which means the layer-close enforcement is effectively log-only. The actual invariants are NOT being enforced today. Wrapper landed, contract is hollow.

**Action:**
- Convert transit fibers from `forkDetach` to scope-bound (probably `Effect.forkScoped` inside the `bindUdp` scope, or a settle-bound wait in the layer-close finalizer that gives transit fibers their `transitDelayMs` to drain before judging counters).
- Then promote the three anomalies to `deferred-fail`.
- See followup handoff doc at `/tmp/handoff-B7rWuJ.md` for full reproducer recipe.

**Priority:** HIGH — the wrapper that was supposed to be the headline win is currently not enforcing.

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

## Summary table

| # | Issue | Priority | Fix locus |
|---|---|---|---|
| T1 | `Layer.suspend` TDZ workaround undocumented | HIGH | SKILL.md + typescript-effect.md |
| T2 | Recorder+RunContext production footgun | HIGH | SKILL.md + contracts.ts JSDoc |
| T3 | `forkDetach` makes Slice 4 invariants hollow | HIGH | `SignalingNetwork.simulated.ts` refactor |
| T4 | rfcRules count was wrong in plan | MEDIUM | SKILL.md planning checklist |
| T5 | `registerProjector` API is narrower than it looks | MEDIUM | Recorder.ts JSDoc |
| T6 | RuleEngine deletion scope too narrow | MEDIUM | Planning convention |
| T7 | CallStateCache has no production consumer | MEDIUM | Codebase hygiene (delete or ADR) |
| T8 | CallLimiter `refresh` shape divergence | MEDIUM | Tag interface tightening |
| T9 | recording.ts consumer set wider than plan | MEDIUM | Planning convention (same as T6) |
| T10 | testLayers convention buried in CLAUDE.md | LOW | CLAUDE.md emphasis |
| T11 | Per-Tag anomaly buffer pattern was relitigated | LOW | SKILL.md guidance |
| T12 | Silent external plan edits | LOW | Workflow note |

Three HIGH-priority items (T1, T2, T3) are the load-bearing fixes. T3 specifically means the wrapper initiative's headline goal — "silent enforcement at scope close" — is currently not delivered because the rules had to be downgraded to advisory. Without fixing T3, much of Slice 4's value is theoretical.
