# ADR 0013 — Effect-layer wrappers across the test fabric and typed Recorder

**Status:** Accepted (Slice 0 in progress).
**Plan:** [docs/plan/review-this-plan-and-noble-goblet.md](../plan/review-this-plan-and-noble-goblet.md). Slice catalog and per-slice detail live there.

## Context

[src/call/codec/contracts.ts](../../src/call/codec/contracts.ts) is the worked example of the four-wrapper pattern from [.claude/skills/effect-layer-test](../../.claude/skills/effect-layer-test/SKILL.md): `propertyTest` / `paranoidInputs` / `parity` / `scopedAudit`. Each wraps a Tag's implementation Layer without changing the Tag or service shape.

Today the test fabric has three parallel buffers — `NetworkTrace.trace[]`, `ReplicationTraceRecorder`, legacy `CallRecording` — and the rule packs / HTML renderer disagree about what "happened" in a scenario. The four-wrapper pattern is only applied to the codec; SignalingNetwork, PartitionedRelayStorage, CallLimiter, CallStateCache get no invariant enforcement at the layer boundary.

This initiative extends the wrapper pattern to those layers and unifies recording behind one typed `Recorder` service — so the same captured data drives rule packs AND the HTML report, and so every fake-stack test silently enforces invariants its author didn't think to assert.

## Decisions

### D1 — Four wrappers stays canonical
`propertyTest` / `paranoidInputs` / `parity` / `scopedAudit`. No fifth wrapper. Per-sub-scope finalizer logic (e.g. SignalingNetwork's per-`bindUdp`) is an internal detail of `scopedAudit`; the public failure surface remains the layer-close finalizer on `Data.TaggedError`.

### D2 — One Recorder per scenario, typed per-Tag channels
Single `Recorder` instance owned by `stackLayer({ mode })`. Endurance multi-process tests own per-process Recorders, never share. The API exposes `forTag<S, E>(tag)` returning a typed `{ record, snapshot }` handle, plus assembled-view `snapshot: Effect<RecordedScenario>`.

### D3 — Typed events with exported projectors
Each layer's `contracts.ts` exports an event union (one variant per public method; Stream → `streamStart`/`streamItem`/`streamEnd`; Scope → `acquire`/`release`) and registers a built-in projector with the Recorder. Generic projection helpers are exported for external rule packs.

### D4 — Hand-declared event types + helper library
Event unions are hand-written. Four helpers cover the constructs that actually appear:

| Helper | Use |
|---|---|
| `recordSync` | sync pure functions |
| `recordEffectCall` | Effect-returning methods, `{ok|fail|interrupt}` outcome capture |
| `recordScopedAcquire` | `Effect<X, E, Scope>` — acquire on success + release via `addFinalizer` |
| `recordStreamLifecycle` | `Stream<X>` — `Stream.scoped` + `Stream.tap` + `Stream.ensuring` |

Excluded by convention: sync getters (`inFlight`, `queueDepth`, `transitDelayMs`) — recording every read floods the log. Higher-order methods and Hub/PubSub are explicit-wrap, no helper.

### D5 — RunContext drives severity
`RunContext` Service Tag with three variants — `real-run`, `test-with-recorder`, `unit-test-of-layer { tag }`. Each rule returns severity per finding given the context: `fatal` (immediate fail), `deferred-fail` (record, fail at scope close), `advisory` (record only). Same rule, three lives. Default `real-run` when missing; `test-with-recorder` requires `Recorder` in scope (startup assertion).

### D6 — Test-layer library, not ad-hoc Layer.merge
`tests/support/testLayers.ts` exports curated bundles (`context`, `recorder`, `contracts`, `stacks`). Tests pull one bundle off the shelf; no `Layer.merge` in test files. `Tag.withAllContracts(...)` composes inside `contracts.*`.

### D7 — Composition: canonical-order helper + per-Tag forwarder
Shared `withCanonicalContracts<S>(tag, impl, { propertyTest?, paranoidInputs?, scopedAudit? })` applies `propertyTest(paranoidInputs(scopedAudit(impl)))` in fixed order; each option optional. Each Tag exposes a thin `Tag.withAllContracts(options)` forwarder. `parity` is NOT in the canonical helper — build the parity layer first and pass it as `impl`.

### D8 — SipHarness is a typed-channel Tag
Driver events (`timeout`, `marker`, `linkObservedToExpect`) live in a `SipHarnessEvent` discriminated union. No contract wrappers (nothing to enforce — pure recording). A transitional projector to the legacy `CallRecording` shape exists until Slice 14 deletes it.

### D9 — RFC pack: 24 rules, per-rule ownership via array deletion
17 base validators + 7 cross-message rules = 24 total in `tests/harness/rules/rfc/index.ts`. Migration: each rule moves from the array to the new path one slice at a time; the old runner enforces only what's left. When the array is empty, the old runner deletes. No double-enforcement at any point.

### D10 — Stack-builder unification lands AFTER Slice 1
Slice 1 (SignalingNetwork scopedAudit) lands against today's `fakeStackLayer`. Slices 2a + 2b unify (runner + vitest config) once lessons from real wrapper integration are in. Subsequent slices target the unified `stackLayer({ mode })`.

### D11 — Perf: three ad-hoc checkpoints, no CI gate yet
`perfMode?: "baseline" | "no-audit" | "full"` on `testLayers.stacks.fake(...)`. `no-audit` vs `baseline`: +10% alert. `full` vs `baseline`: +50% soft ceiling. Checkpoints at Slices 1, 7, 14. No CI automation until after Slice 14.

### D12 — Mixing fake + live requires explicit annotation
Default is fully-fake. Mixing requires `it.live` + `MIXED CLOCK: <what> — <why>` annotation + minimised real-delay surface (TestClock-vs-real-delay racing is the danger).

## Consequences

**Irreversible slices** (no rollback once landed): 2a (runner unification), 2b (vitest config unification), 6 (old RFC runner deletion), 8 (codec dual-report), 9 (`ReplicationTraceRecorder` deletion), 14 (legacy `CallRecording` deletion).

**Deletions over the initiative:**
- `NetworkTrace.trace[]` parallel buffer (Slice 4).
- `tests/support/ReplicationTraceRecorder.ts` (Slice 9).
- `RuleEngine`, `tests/harness/rules/rfc/_replay.ts`, legacy `rule.test.ts`, `escape-hatches.test.ts` (Slice 6).
- `tests/harness/recording.ts` + `recording-extractor.ts` + SipHarness legacy projector (Slice 14).

**Performance budget** (D11): recording-layer overhead in fake-stack runs targets +10% over baseline (`no-audit` mode); full audit may add up to +50% before a quadratic-rule blunder is suspected. No CI gate until after Slice 14.

**Test-author surface stays opaque:** consumers of any wrapped Tag see the same `Layer<S>` shape. Wrappers compose under `Tag.withAllContracts(opts)`; no test code references individual wrappers directly.

**Canary regression gate** (introduced Slice 1, kept across all subsequent slices): a deliberately broken fake-stack scenario (INVITE with no final response) must fail with an anomaly. Proves wrappers are active.

## Related ADRs

- [ADR-0003](0003-must-run-effects-under-interruption.md) — must-run categories; wrappers must NOT break the safety contract on the listed sites.
- [ADR-0004](0004-strong-incr-decr-invariant-for-call-limiter.md) — the counter-back-to-0 invariant Slice 12's `scopedAudit` enforces.
- [ADR-0011](0011-codec-and-opaque-apply.md) — codec opacity; the parity wrapper is the test-side complement.
