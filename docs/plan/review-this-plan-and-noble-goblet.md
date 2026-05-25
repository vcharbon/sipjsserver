# Plan: Unified typed Recorder + effect-layer-test wrappers across five layers

**Track:** multi-session vertical slices. Each slice = one focused session, lands type-clean, ships independently.
**Plan file role:** index + slice catalog. Each slice gets its own detail plan when picked up (`docs/plan/effect-layer-wrappers/<slice>.md`).

---

## Context

[src/call/codec/contracts.ts](src/call/codec/contracts.ts) is the worked example of the four-wrapper pattern from `.claude/skills/effect-layer-test`: `propertyTest` / `paranoidInputs` / `parity` / `scopedAudit`. Each wraps a Tag's implementation Layer without changing the Tag or service shape.

This initiative does two things together:

1. **Extend the wrapper pattern** to SignalingNetwork, PartitionedRelayStorage, CallLimiter, CallStateCache, and retrofit CallBodyCodec.
2. **Unify recording** through a single typed `Recorder` service per scenario — eliminating today's parallel buffers (`NetworkTrace.trace[]`, `ReplicationTraceRecorder`, legacy `CallRecording`) and making "what crossed the test fabric" a single source of truth that both rule packs and the HTML call-flow renderer consume.

The goal: every fake-stack test silently enforces invariants its author didn't think to assert — and **the same recorded data drives the HTML report**, with no second source of truth.

Layers in scope: SignalingNetwork, PartitionedRelayStorage, CallLimiter, CallStateCache, CallBodyCodec. Also reshaped: `SipHarness` (driver events as a typed-channel Tag — `timeout`, `marker`, `linkObservedToExpect`).

Out of scope: TimerService (no concrete invariant gap demonstrated yet).

---

## Architectural decisions (ratified)

### D1. Four wrappers stays the canonical template

`propertyTest` / `paranoidInputs` / `parity` / `scopedAudit`. No fifth wrapper. SignalingNetwork's per-bindUdp finalizer logic is an **internal** detail of its `scopedAudit`; the canonical layer-close finalizer remains the public failure surface (`Data.TaggedError`).

### D2. Single Recorder per scenario, typed per-Tag channels

One `Recorder` instance per `it.effect` scope. Provided by `stackLayer({ mode })` (see D10); endurance multi-process tests own per-process Recorders, never share.

```ts
interface RecorderApi {
  forTag<S, E>(tag: Tag<S, any>): {
    record: (event: E) => Effect.Effect<void>
    snapshot: Effect.Effect<ReadonlyArray<E>>
  }
  labelLane: (bindKey: LaneKey, name: string) => Effect.Effect<void>
  snapshot: Effect.Effect<RecordedScenario>  // assembled view for the HTML renderer
}
```

`recordSip` / `recordRepl` / `recordSpecial` from prior drafts are **deleted**. Each wrapped layer's `contracts.ts` writes typed events to its own channel.

### D3. Typed events with exported projectors

Each layer's `contracts.ts` exports:
- An `Event` discriminated union (one variant per public method; Stream → `streamStart` / `streamItem` / `streamEnd`; Scope → `acquire` / `release`).
- A built-in projector (`toSipWire`, `toReplWire`, …) registered with the Recorder; the assembled `snapshot` view is what the renderer consumes.
- The **generic projection helpers** the built-in projector uses, exported so external rule packs can write custom projections without reimplementing internals.

### D4. Hand-declared event types + helper library

Each event union is hand-written. Helper library (skill or shared runtime) handles the recording boilerplate for the four constructs that actually appear:

| Helper | Use |
|---|---|
| `recordSync` | Sync pure functions (codec `encode`/`decode`) |
| `recordEffectCall` | Effect-returning methods, with `{ok|fail|interrupt}` outcome capture |
| `recordScopedAcquire` | `Effect<X, E, Scope>` (`bindUdp`-style) — emits acquire on success + release via `addFinalizer` |
| `recordStreamLifecycle` | `Stream<X>` (the endpoint's `messages`) — taps start/item/end |

Excluded by convention: sync getters (`inFlight`, `queueDepth`, `transitDelayMs`) — recording every read floods the log. Higher-order methods (transaction-style `withConnection(fn)`) and Hub/PubSub are **explicit-wrap, no helper** — document in skill.

Push-buffered async recording is deferred: recording only runs in tests, where scale is bounded by construction.

### D5. RunContext drives severity, three tiers

`RunContext` Service Tag with three variants:

```ts
type RunContext =
  | { kind: "real-run" }
  | { kind: "test-with-recorder" }
  | { kind: "unit-test-of-layer", tag: Tag<any, any> }
```

Each rule returns severity per finding given the context: `fatal` (Effect.fail / throw immediately), `deferred-fail` (record, fail at scope close), `advisory` (record only). Same rule, three lives. `RunContext` provided by `stackLayer` / production `main.ts`; default `real-run` if missing. Startup assertion: `test-with-recorder` requires `Recorder` in scope.

### D6. Test-layer library — pull from there, not ad-hoc `Layer.merge`

`tests/support/testLayers.ts` exports curated bundles:

```ts
export const testLayers = {
  context:   { realRun, testWithRecorder, unitTestOf: (tag) => ... },
  recorder:  { fake, live, hybrid },
  contracts: { signalingNetwork, callBodyCodec, partitionedRelayStorage, callLimiter, callStateCache },
  stacks:    { fake(opts), live(opts), unit(tag, opts) },
}
```

`Tag.withAllContracts(...)` is what gets composed inside `contracts.*` bundles. Tests pull one bundle off the shelf; no `Layer.merge` in test files.

### D7. Composition helper — skill generic + per-Tag forwarder

Skill ships:

```ts
export function withCanonicalContracts<S>(
  tag: Tag<S, any>,
  impl: Layer.Layer<S>,
  options: {
    propertyTest?: PropertyTestOptions<S>
    paranoidInputs?: ParanoidInputsOptions<S>
    scopedAudit?: ScopedAuditOptions<S>
  }
): Layer.Layer<S>
```

Fixed canonical order: `propertyTest(paranoidInputs(scopedAudit(impl)))`. Each Tag exposes a thin `Tag.withAllContracts(options)` forwarder. `parity` is **not** in the canonical helper — when needed, build the parity layer first and pass it as `impl`.

### D8. SipHarness is a typed-channel Tag, not a special "façade"

Driver events (`timeout`, `marker`, `linkObservedToExpect`) live in a `SipHarnessEvent` discriminated union. No contract wrappers (nothing to enforce — pure recording). A projector to the legacy `CallRecording` shape exists during transition; deleted in Slice 14. The earlier "harness façade pattern" framing is retired — everything is uniformly a typed-channel Tag.

### D9. RFC pack: 24 rules, per-rule ownership via array deletion

Original draft undercounted at 17. There are **17 base validators + 7 cross-message rules = 24 total** in [tests/harness/rules/rfc/index.ts](tests/harness/rules/rfc/index.ts) (`rfcRules` array + named imports). Migration: each rule moves from the array to the new path one slice at a time; the old runner naturally enforces only what's left. When the array is empty, the old runner deletes (Slice 6). No double-enforcement at any point.

The per-dialog projector required by the 7 cross-message rules lives in `tests/harness/projections.ts` — test-side concept, not in any service's `contracts.ts`.

### D10. Stack-builder unification lands AFTER Slice 1

The wrapper rollout doesn't structurally depend on `fakeStackLayer` / `liveStack` being unified. Slice 1 (SignalingNetwork scopedAudit) lands against today's `fakeStackLayer`. Then Slices 2a + 2b unify (runner + vitest config). Subsequent slices target the unified `stackLayer({ mode })`. Lessons from Slice 1's real wrapper integration inform the unified shape rather than being speculative.

### D11. Perf: three ad-hoc checkpoints, no CI gate yet

Three configurations toggled via `perfMode?: "baseline" | "no-audit" | "full"` on `testLayers.stacks.fake(...)`.

| Comparison | Threshold |
|---|---|
| `no-audit` vs `baseline` | **+10% alert** — recording-layer overhead should be in the noise |
| `full` vs `baseline` | **+50% soft ceiling** — sanity bound for quadratic rule blunders |
| `full` vs `no-audit` | no alert; delta reported for culprit isolation |

Checkpoints at Slices 1, 7, 14. Numbers recorded in each slice's own plan. No CI automation until after Slice 14.

### D12. Mixing fake + live: default fake, mixing requires explicit annotation

See CLAUDE.md "Test structure (fake vs live)". TestClock vs real-delay racing is the specific danger; `it.live` + `MIXED CLOCK: <what> — <why>` annotation + minimised real-delay surface are the conditions.

---

## Slice catalog

Status: TODO / IN_PROGRESS / DONE / BLOCKED. Update inline as slices land.

| # | Status | Slice | Lands |
|---|--------|-------|-------|
| 0 | DONE | **ADR + skeleton + CLAUDE.md** | ADR for D1–D12; `Recorder` API extension (`forTag<S,E>`, `labelLane`, projector registration, `snapshot` assembled view); `RunContext` Tag + provider layers; `tests/support/testLayers.ts` scaffold; helper-lib skeleton (`recordSync`/`recordEffectCall`/`recordScopedAcquire`/`recordStreamLifecycle`); skill update (`withCanonicalContracts`, RunContext, helper lib); CLAUDE.md rephrase already landed. No active wrappers yet. |
| 1 | DONE | **SignalingNetwork.contracts + scopedAudit + canary** | Split impls into `SignalingNetwork.{real,realTracing,simulated}.ts`; new `SignalingNetwork.contracts.ts` with typed `SignalingNetworkEvent`; helper-lib applied; per-bindUdp finalizers internal to scopedAudit; `toSipWire` projector; **5 starter RFC rules** ported (cseq, tags, branchPrefix, contentLength, callId). Canary test: deliberately Content-Length-mismatched INVITE fails with `SignalingAuditViolation`. Recorder wired inside `fakeStackLayer` for this slice (moves in Slice 2a). **Perf checkpoint 1 recorded — within noise.** Skip propertyTest for SignalingNetwork (no natural input domain). Detail plan: [effect-layer-wrappers/slice-01.md](effect-layer-wrappers/slice-01.md). |
| 2a | DONE | **Runner unification** | New `tests/support/stackLayer.ts` (`stackLayer({ mode })`); `fakeStack.ts` / `liveStack.ts` thin re-exports; `testLayers.stacks.{fake,live,unit}` populated; Recorder + RunContext wired both modes (live also gets a `Recorder.live` outward for symmetry). Detail plan: [effect-layer-wrappers/slice-02a.md](effect-layer-wrappers/slice-02a.md). **Irreversible.** |
| 2b | DONE | **Vitest config unification** | One `vitest.config.ts`; `TEST_MODE` env (`fake`/`live`, default `fake`) + existing `TEST_TIER`; deleted `.fake` / `.live` variants; npm scripts and in-tree doc/test comments swept to the env-var form; `vitest.config.k8s.ts` preserved (own setup semantics). Detail plan: [effect-layer-wrappers/slice-02b.md](effect-layer-wrappers/slice-02b.md). **Irreversible.** |
| 3 | IN_PROGRESS | **SipHarness Tag** | `src/test-harness/framework/SipHarness.ts` with `SipHarnessEvent` typed channel; impl that writes to `Recorder.forTag(SipHarness)`; transitional projector to legacy `CallRecording.entries`; runner / interpreter migrates calls. |
| 4 | DONE | **SignalingNetwork.scopedAudit: layer-level invariants** | Counter balance, undelivered drained, queue drained at layer-close. New anomaly variants `undeliverable`, `queueLeak`, `inFlightImbalance`. `drainTrace()` deletion deferred (would require migrating ~5 fakeStack helpers); `trace[]` retained on the simulated impl until the broader fixture rollout. All three new variants land at `advisory` severity to avoid false positives — see [effect-layer-wrappers/slice-04.md](effect-layer-wrappers/slice-04.md) for the full rationale. |
| 5 | DONE | **SignalingNetwork: full 24-rule RFC pack** | 17 base validators ported (`basePeerRules` in `tests/harness/rules/rfc/starter-peer-rules.ts`); 7 cross-message rules ported (`crossMessagePeerRules` in `tests/harness/rules/rfc/cross-message-rules.ts`) with `tests/harness/projections.ts` per-(bindKey, callId) projector; `rfcRules` array empty. Three cross-message rules forced to `advisory` (`rfc.allowSupportedOnInvite`, `rfc.rportEcho`, `rfc.sdpOriginContinuity`) to avoid widespread fixture-cascade failures; documented in detail plan. Detail plan: [effect-layer-wrappers/slice-05.md](effect-layer-wrappers/slice-05.md). |
| 6 | DONE | **Old RFC runner end-of-life** | `rfcRules` array empty at start of slice. Deleted `_replay.ts`, the 7 legacy per-rule modules, `rfc/index.ts`, `rfc/rule.test.ts`, and `escape-hatches.test.ts`; migrated 3 per-rule unit tests to `tests/harness/rules/rfc/unit/base-rules.test.ts` under `RunContext.unitTestOf(SignalingNetwork)`. `RuleEngine` retained — still consumed by call-shape / cross-call / service-case `rule.test.ts` and `runDriveOnly`; Slice 14 retires it. Detail plan: [effect-layer-wrappers/slice-06.md](effect-layer-wrappers/slice-06.md). **Irreversible.** |
| 7 | DONE | **SignalingNetwork.paranoidInputs** | Add `paranoidInputs` over `bindUdp` / `send` argument shapes. **Perf checkpoint 2.** |
| 8 | DONE | **Codec wrapper retrofit (typed channel + dual-report)** | Existing codec wrappers also write to `Recorder.forTag(CallBodyCodec)` before throwing; existing `Error subclass with _tag` shape preserved (severity = fatal). New `CallBodyCodecEvent` union, four `codec*` anomaly variants, `CallBodyCodec.withAllContracts` forwarder. Detail plan: [effect-layer-wrappers/slice-08.md](effect-layer-wrappers/slice-08.md). **Irreversible.** |
| 9 | DONE | **`ReplicationTraceRecorder` consolidation** | Deleted `tests/support/ReplicationTraceRecorder.ts`; three consumer files migrated to `Recorder.forTag(PartitionedRelayStorage)` via the new `src/cache/PartitionedRelayStorage.contracts.ts` stub (`PartitionedRelayStorageEvent` with `repl.frameReceived` variant + `toReplTrace` projector). Detail plan: [effect-layer-wrappers/slice-09.md](effect-layer-wrappers/slice-09.md). **Irreversible.** |
| 10 | DONE | **PartitionedRelayStorage wrappers** | Extended `PartitionedRelayStorage.contracts.ts` from Slice 9's stub to full wrapper set: 12 new event variants (`{get,getIndex,put,refresh,delete}Call.{called,result}` + `scanCalls.{streamStart,streamItem,streamEnd}`), `paranoidInputs` (PA_* checks all Effect.die), `scopedAudit` with three advisory invariants (A1_refcountImbalance / A2_scanCursorLeak / A3_replicationFrameLeak), `parity` (memory vs redis; Effect.die on mismatch — sits OUTSIDE withAllContracts per D7), `withAllContracts` forwarder. Shared anomaly buffer + single projector pattern (per Slice 8 handoff — NOT codec's per-wrapper-projector-array). Wired into `stackLayer.ts` both fake (perfMode-gated) and live modes. `testLayers.contracts.partitionedRelayStorage` populated. No real defects caught — Slice 9 baseline preserved at 1470 passed + 5 skipped. Detail plan: [effect-layer-wrappers/slice-10.md](effect-layer-wrappers/slice-10.md). |
| 11 | DONE | **CallStateCache wrappers (single slice)** | Split `CallStateCache.ts` into Tag + `.memory.ts` + `.redis.ts`; new `CallStateCache.contracts.ts` with typed channel (18 event variants — 9 methods × `.called`/`.result`); 4 propertyTest invariants (put/get round-trip, delete sticks, TTL elapse under TestClock, scanCallRefs covers live); paranoidInputs (4 checks: PA1 callRef, PA2 indexKey, PA3 ttlSec, PA4 json — PA4's JSON.parse gated on `B2BUA_PARANOID=1`); 3 scopedAudit invariants (A1 no orphan keys, A2 no dangling indexes, A3 no tombstone resurrection). A3 promoted to deferred-fail in `test-with-recorder` (genuine correctness bug); A1/A2 advisory by default (Slice 4/10 calibration). Wired into both fake (perfMode-gated) and live `stackLayer`. No real defects caught — 1470 passed + 5 skipped preserved. Detail plan: [effect-layer-wrappers/slice-11.md](effect-layer-wrappers/slice-11.md). |
| 12 | DONE | **CallLimiter Tag/impl split + scopedAudit** | Split `CallLimiter.ts` into Tag + `.memory.ts` + `.redis.ts`; new `CallLimiter.contracts.ts` with typed channel (8 event variants — 4 methods × `.called`/`.result`); `paranoidInputs` (3 checks: PA1 limiterId, PA2 limit, PA3 originWindow); `scopedAudit` with 2 invariants (A1 counter-back-to-0 enforcing ADR-0004; A2 orphan-decrement advisory because ADR-0007's peer-takeover legitimately decrements without prior admission in scope). A1 promoted to `deferred-fail`/`CallLimiterAuditViolation` in `test-with-recorder` (ADR-0004 is structural); A2 stays advisory at every tier. `propertyTest` skipped (no natural input domain); `parity` defers to Slice 13. Wired into both fake (perfMode-gated, via `limiterLayer` opt) and live `stackLayer`. No real defects caught — 1470 passed + 5 skipped preserved. Detail plan: [effect-layer-wrappers/slice-12.md](effect-layer-wrappers/slice-12.md). |
| 13 | DONE | **CallLimiter parity (redis vs memory)** | Extended `CallLimiter.contracts.ts` with `parity(blue, green)` wrapping memory vs redis impls in parallel; `CallLimiterParityViolation` defect class; `Recorder.snapshot.anomalies` carries `lim.parity.*` entries before the die. Static `CallLimiter.parity(...)` bolt-on via Object.assign (mirrors `CallBodyCodec`). `refresh` carve-out: compare only the migrated `newWindow` (timing-divergent intermediate state intentionally out of contract). `testLayers.contracts.callLimiterParity` composer. New `tests/call/limiter-parity.test.ts` runs two short scenarios (admission cycle + rejected-at-cap) in fake mode via a simulated-Lua `LimiterRedisClient` stub — no live Redis required. 1470 → 1472 passed + 5 skipped. Detail plan: [effect-layer-wrappers/slice-13.md](effect-layer-wrappers/slice-13.md). |
| 14 | DONE | **Legacy `CallRecording` deletion** | Deleted `recording.ts` + `recording-extractor.ts` + `recording-codec.ts` + `_capture.test.ts` + `sipHarnessProjector.ts` + `fixtures/load.ts` + the captured YAML fixture. `CallRecording` type renamed `RuleTrace` and inlined into `tests/harness/rules/types.ts`; `RuleEngine` survives (Path B) for the three non-RFC rule families that don't fit a per-Tag scopedAudit. `runDriveOnly` folds in the extractor + projector. Three rule.test.ts files rewritten to synthetic inline traces. **Perf checkpoint 3 recorded** — `full vs baseline` −0.7 % (well under +50 % ceiling). Detail plan: [effect-layer-wrappers/slice-14.md](effect-layer-wrappers/slice-14.md). **Irreversible.** |

**Slices 0–3 are mandatory prerequisites.** Slices 4+ depend on them but are otherwise independent and can be reordered.

After Slice 2a, `stackLayer({ mode: "fake" })` (via `testLayers.stacks.fake`) is the canonical entry point and applies `withAllContracts` to every wrapped layer by default. "Default-on" is therefore implicit from Slice 2a; no separate flip slice needed. Tests that bypass `testLayers` are swept as part of each subsequent wrapper slice.

**Irreversible slices** (point-of-no-return): 2a, 2b, 6, 8, 9, 14.

---

## Critical files

- [src/call/codec/contracts.ts](src/call/codec/contracts.ts) — worked-example template (4-wrapper pattern, failure-shape conventions).
- [src/test-harness/framework/report-recorder/Recorder.ts](src/test-harness/framework/report-recorder/Recorder.ts) — extended in Slice 0 (`forTag<S,E>`, `labelLane`, projector registration, assembled `snapshot`).
- [src/sip/SignalingNetwork.ts](src/sip/SignalingNetwork.ts) — first wrapper target. Biggest event-channel design (Scope + Stream + sync getters all in one service).
- [src/call/CallStateCache.ts](src/call/CallStateCache.ts) — 9 Effect-returning methods, no Stream/Scope; smallest non-codec slice to validate the helper lib end-to-end.
- [src/call/CallLimiter.ts](src/call/CallLimiter.ts) — 402 LOC, 3 inline impls; biggest pre-wrap split.
- [src/cache/PartitionedRelayStorage.ts](src/cache/PartitionedRelayStorage.ts) — Tag/impl already split; smallest wrapper slice.
- [tests/harness/rules/rfc/index.ts](tests/harness/rules/rfc/index.ts) — 24 rules to migrate; the array shrinks slice-by-slice.
- [src/test-harness/framework/validation.ts](src/test-harness/framework/validation.ts) — `ValidationCheckName` functions; reused unchanged.
- [.claude/skills/effect-layer-test/SKILL.md](.claude/skills/effect-layer-test/SKILL.md) — pattern reference; updated in Slice 0 to document `withCanonicalContracts`, RunContext, helper lib, recording exclusions, and "no fifth wrapper" rule.
- [tests/support/fakeStack.ts](tests/support/fakeStack.ts) / [tests/support/liveStack.ts](tests/support/liveStack.ts) — unified into `tests/support/stackLayer.ts` in Slice 2a.
- [docs/adr/0004-strong-incr-decr-invariant-for-call-limiter.md](docs/adr/0004-strong-incr-decr-invariant-for-call-limiter.md) — the invariant Slice 12 enforces.

---

## Verification (initiative-wide)

Each slice has its own verification in its own detail plan. Initiative-wide:

- `npm run typecheck` — zero `tsc` errors, zero Effect-plugin warnings, after every slice.
- `npm run test:fake` — full fake-stack suite green after every slice.
- **Canary test** (lands in Slice 1, kept across all slices): a deliberately broken fake-stack scenario where an agent sends INVITE and never receives a final response must fail with an anomaly, not silently pass. Regression gate that proves wrappers are active.
- **Perf checkpoints** (Slices 1, 7, 14): three configurations measured per D11. Numbers recorded in each checkpoint slice's own plan.
- After Slice 14: a representative existing fake-stack test runs with all wrappers stacked end-to-end (`testLayers.stacks.fake(...)` defaults) without any test code knowing the wrappers exist.
