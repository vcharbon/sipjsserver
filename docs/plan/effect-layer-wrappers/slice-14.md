# Slice 14 — Legacy `CallRecording` deletion + perf checkpoint 3

Parent plan: [review-this-plan-and-noble-goblet.md](../review-this-plan-and-noble-goblet.md)
ADR: [0013-effect-layer-wrappers-and-typed-recorder.md](../../adr/0013-effect-layer-wrappers-and-typed-recorder.md)

**Irreversible.** The legacy `tests/harness/recording.ts` surface is
gone for good. The `RuleEngine` survives in a narrowed-down form;
future work could migrate the three remaining rule-family unit tests
to scopedAudit too.

## RuleEngine decision: Path B (with rename)

The three non-RFC rule families consumed by `RuleEngine` —
`call-shape`, `cross-call`, `service-case` — are **legitimately not
scopedAudit-shaped**:

- `cross-call.limiter-concurrency` aggregates multi-call X-Api-Call
  declarations + 2xx timing windows. A scopedAudit rule runs per
  bindUdp; it has no natural seam for "concatenate everyone's wire
  bytes and run a sweep-line."
- `cross-call.unique-call-id` is identity-of-traces sanity, not a SIP
  invariant.
- `service-case.field-checks` is parameterised by an external
  `ServiceCase` JSON; the existing scopedAudit rules don't accept
  per-test config payloads.
- `call-shape.{no-unexpected,all-expected-received}` reads
  `entry.unexpected` (set by the interpreter when a packet matches
  no `expect` step) and consults the ServiceCase's declared
  legs/alices — again, post-hoc aggregation, not per-peer invariants.

Migrating these to per-Tag scopedAudit rules would require either:
(a) reinventing the per-test config plumbing inside the SignalingNetwork
contracts, or (b) introducing a fifth "scenario-aggregator" rule kind —
which D1 explicitly forbids.

**Path B chosen:** `RuleEngine` stays. The per-call trace shape it
consumes is renamed `CallRecording → RuleTrace` and moved inline into
`tests/harness/rules/types.ts`. The grep gate is satisfied; the legacy
projector/codec/extractor surface is gone. `runDriveOnly` is refactored
to derive `RuleTrace[]` directly from `ScenarioResult.trace` +
`Recorder.forTag(SipHarness)` (no second file).

## Files deleted

- `tests/harness/recording.ts` — the legacy `CallRecording` types.
- `tests/harness/recording-extractor.ts` — `extractRecordings`
  helper. Logic moved inline into `runner.ts:buildRecordings`.
- `tests/harness/recording-codec.ts` — YAML serializer / parser
  scoped to the `CallRecording` schema. No remaining consumer once
  fixture-driven tests rewrite to synthetic inputs.
- `tests/harness/recording-codec.test.ts` — round-trip tests for the
  deleted codec.
- `tests/harness/sipHarnessProjector.ts` — Slice 3's transitional
  projector. The shape now lives inline in
  `runner.ts:projectHarnessEntries`.
- `tests/harness/_capture.test.ts` — one-shot YAML fixture writer.
  Unreachable now that the codec + fixture path is gone.
- `tests/harness/fixtures/load.ts` + `fixtures/recordings/basic-call-clean.yaml`
  — YAML fixture loader + sole captured recording. Replaced by
  inline synthetic traces in the three rule.test.ts files below.

## Files updated

- `tests/harness/rules/types.ts` — `CallRecording` →
  `RuleTrace`; `RecordedMessage`/`RecordedTimeout`/`RecordedMarker` →
  `RuleTraceMessage`/`RuleTraceTimeout`/`RuleTraceMarker`. Type defs
  inlined here rather than in a sibling file. RFC family removed
  from `RuleFamily` (Slice 6 already migrated those rules; the
  union now matches the surviving consumer set).
- `tests/harness/runner.ts` — folds in the deleted extractor +
  projector. Effect plumbing unchanged. Comments rewritten to drop
  slice-number references and the legacy file names.
- `tests/harness/rules/cross-call/limiter-concurrency.ts` — type
  rename pass.
- `tests/harness/rules/cross-call/unique-call-id.ts` — doc-comment
  reference to deleted file rewritten.
- `tests/harness/rules/service-case/field-checks.ts` — type rename
  pass.
- `tests/harness/rules/{call-shape,cross-call,service-case}/rule.test.ts`
  — rewritten to construct synthetic `RuleTrace` inline. No
  fixture-loading; each test owns the minimal SIP bytes it needs.
- `src/test-harness/framework/SipHarness.ts` — top-of-file comment
  rewritten (legacy projector + `RecordingEntry` references gone).
- `tests/scenarios2/basic-call.ts`,
  `tests/harness/projections.ts`,
  `tests/harness/rules/rfc/cross-message-rules.ts` — doc-comment
  passes; no behavioural change.

## RuleEngine survives — narrower remit

`tests/harness/rules/types.ts` still exports `RuleEngine`, the three
`Rule` shapes (`PerCallRule` / `CrossCallRule`), and the rule registry
infrastructure. Consumers:

- `tests/harness/runner.ts:runDriveOnly` — main driver for scenarios
  in `tests/harness/*.test.ts` (basic-call, matrix, slice4,
  refer-allow-happy, limiter-rejection).
- `tests/harness/rules/{call-shape,cross-call,service-case}/rule.test.ts`
  — three rule-family self-tests.

These no longer have any RFC dependencies (Slice 6 cleaned that up).
Future work could migrate them — but that would require either
inventing a "cross-scenario" rule kind in `SignalingNetwork.contracts.ts`
or introducing a fifth wrapper. Neither is justified by the current
test set.

## Perf checkpoint 3

Two consecutive `npm run test:fake` runs per configuration
(matching Slice 1 / Slice 7's protocol):

| Config       | Run 1    | Run 2    | Average  |
| ------------ | -------- | -------- | -------- |
| baseline     | 26.74 s  | 25.62 s  | 26.18 s  |
| no-audit     | 25.55 s  | 25.53 s  | 25.54 s  |
| full         | 25.84 s  | 26.13 s  | 25.99 s  |

Deltas:

- **`no-audit` vs `baseline`: −0.64 s (−2.4 %).** Well below the
  +10 % alert threshold. Five wrapped layers' recording channels
  still cost nothing measurable at this suite size. The negative
  delta is run-to-run noise; the structural cost is zero.
- **`full` vs `baseline`: −0.19 s (−0.7 %).** Far below the +50 %
  soft ceiling. Paranoid inputs across five layers + the 24-rule
  RFC pack + four layers of scope-close audits — all in — is still
  noise-dominated.
- **`full` vs `no-audit`: +0.45 s (+1.8 %).** Property tests + PA
  checks + the four audit invariants families together cost ~450 ms
  across a 26 s suite. None of them rates a hot-path optimisation.

Trend across checkpoints:

| Checkpoint | baseline | no-audit | full     | full vs baseline |
| ---------- | -------- | -------- | -------- | ---------------- |
| 1 (Slice 1)| 30.03 s  | 29.32 s  | 29.60 s  | −1.4 %           |
| 2 (Slice 7)| 25.13 s  | 25.42 s  | 25.68 s  | +2.2 %           |
| 3 (this)   | 26.18 s  | 25.54 s  | 25.99 s  | −0.7 %           |

The suite shrank ~13 % between checkpoints 1 and 2 (test cleanup
elsewhere), then stayed flat. Across the whole rollout — five
wrapper-bearing layers, 24 RFC rules, paranoid inputs everywhere —
the `full vs baseline` delta has stayed inside ±2 %. No quadratic
rule blunders; no recording-channel surprises; the wrapper rollout
landed with effectively zero perf cost.

## Initiative-wide retrospective

- **All 24 RFC rules migrated** to the SignalingNetwork.scopedAudit
  path. The legacy `rfcRules` array is empty; Slice 6 deleted the
  per-rule modules.
- **All 5 layers wrapped**: SignalingNetwork (S1/S4/S5/S7),
  CallBodyCodec (S8 retrofit), PartitionedRelayStorage (S9/S10),
  CallStateCache (S11), CallLimiter (S12/S13).
- **Recorder is the single source of truth**. Three parallel buffers
  collapsed: `NetworkTrace.trace[]` (still retained on the simulated
  impl — `drainTrace` deferral from Slice 4), `ReplicationTraceRecorder`
  (deleted Slice 9), and `CallRecording` (deleted this slice). The
  HTML report and the rule packs consume the same `RecordedScenario`
  shape.
- **Severity calibration**: of 24 RFC rules, **3 are advisory**
  (`rfc.allowSupportedOnInvite`, `rfc.rportEcho`,
  `rfc.sdpOriginContinuity` — all forced down in Slice 5 to avoid
  widespread fixture-cascade failures). Three SignalingNetwork
  layer-close invariants from Slice 4 (`undeliverable`, `queueLeak`,
  `inFlightImbalance`) are also advisory. Two PartitionedRelayStorage
  audits (A1 refcount, A2 scan-cursor) are advisory. One
  CallStateCache audit (A3 tombstone resurrection) and the
  CallLimiter A1 counter-back-to-zero invariant are **deferred-fail**.
  Net: **6 deferred-fail, ~6 advisory**, the rest fatal-in-tests.
- **Real defects caught during rollout**: zero across Slices 5–13
  (every slice plan reports "no real defects caught"). The wrappers
  are positioned to catch future regressions; today they prove the
  existing code paths are clean.
- **Known follow-ups**:
  - Slice 4's `drainTrace()` deferral: the simulated SignalingNetwork
    impl still maintains `trace[]` because the broader fakeStack
    fixture rollout hasn't migrated off it.
  - Six advisory rules to consider hardening once the underlying
    fixture cascade is resolved.
  - SipHarness payloads carry no `callId` hint, so
    `mergeSipHarnessEntries` attributes every driver event to the
    first per-call bucket. Refining attribution requires extending
    `SipHarnessEvent` with an optional callId field.
  - **Live-tier limiter-rejection failure**: the new ADR-0004 audit
    promotion (Slice 12) fires `lim.A1_counterBackToZero` against
    `tests/harness/limiter-rejection.test.ts` under live mode + the
    simulated transport + `realClock=true`. Pre-existing — entered
    the tree alongside the Slice 12/13 CallLimiter work currently on
    `main`. Test fails with `net delta=1 at scope close`. Not caused
    by Slice 14 (which touches nothing under the limiter); investigation
    deferred to a precursor diagnose pass.
  - Three non-RFC rule families remain on `RuleEngine` (`call-shape`,
    `cross-call`, `service-case`). If a future wrapper slot opens
    they could migrate; today they don't fit the four-wrapper template.

## Verification

- `npm run typecheck` — zero tsc errors, zero Effect-plugin warnings.
- `npm run test:fake` — **205 files / 1467 passed + 4 skipped**.
  Net vs Slice 13 baseline (1472 + 5): −5 passed (deleted
  `recording-codec.test.ts` had 5 round-trip tests), −1 skipped
  (`_capture.test.ts`'s sole `describe.skipIf` block also gone).
  The three rewritten rule.test.ts files keep the same `it` count
  (3 + 5 + 4 = 12 tests).
- `npm run test` — fake suite green; live suite has one
  pre-existing failure (`limiter-rejection.test.ts`) flagged as a
  known follow-up. `tests/fullcall/e2e-real-clock.test.ts` short
  tier passes 5 / 9 skipped — the live UDP+TestClock path is clean.
- Slice 1 canary still fires: `tests/fullcall/canary-signaling-audit.test.ts`
  passes (1/1) — the deliberately Content-Length-mismatched INVITE
  still surfaces `rfc.contentLength` at layer close.
- `git grep -l "CallRecording\|RecordedTimeout\|RecordedMarker\|RecordedMessage\|recording-extractor\|recording-codec\|sipHarnessProjector\|recording\.js" src/ tests/` returns nothing.
