# Slice 3 — SipHarness Tag (typed driver-event channel)

Parent plan: [review-this-plan-and-noble-goblet.md](../review-this-plan-and-noble-goblet.md)
ADR: [0013-effect-layer-wrappers-and-typed-recorder.md](../../adr/0013-effect-layer-wrappers-and-typed-recorder.md) (D8)

**Status:** DONE.

## What landed

1. **`src/test-harness/framework/SipHarness.ts`** — new typed-channel
   Tag with three methods:
   - `timeout({ agent, waitingFor, expectStepId })`
   - `marker({ phase, note? })`
   - `linkObservedToExpect({ expectStepId, observedSipSeq })`

   Single `SipHarness.layer` requires `Recorder`; impl just dispatches
   into `Recorder.forTag<SipHarness, SipHarnessEvent>` so stamps
   (`seq`, `atMs`) come from the channel. No contract wrappers per
   D8 — pure recording, nothing to enforce.

2. **`tests/harness/sipHarnessProjector.ts`** — transitional projector
   `toCallRecordingEntries(events)` mapping the typed channel into the
   legacy `RecordingEntry` shape:
   - `timeout` → `RecordedTimeout` (`label = expectStepId`)
   - `marker`  → `RecordedMarker` (`label = phase`, optional `note`)
   - `linkObservedToExpect` → not an entry; returned as
     `labelsByExpectStepId: Map<string, observedSipSeq>` so a future
     extractor pass can attach labels to messages.

   Lives test-side intentionally — `src/` does not import the legacy
   `tests/harness/recording.ts` types. Deleted in Slice 14 along with
   the legacy recording surface.

3. **`tests/support/stackLayer.ts`** — provides `SipHarness.layer`
   alongside `Recorder` and `RunContext.testWithRecorder` for both
   `fake` and `live` modes. The harness depends only on `Recorder`,
   so a `Layer.provide(RecorderLayer)` chain plugs it into either
   composition without touching downstream services.

4. **`tests/support/testLayers.ts`** — `recorder.sipHarness`
   surfaced for unit-of-layer scenarios that want SipHarness without
   the full stack. `stacks.fake` / `stacks.live` already include it
   via `stackLayer`, so existing tests need no changes.

5. **Driver migration** — `src/test-harness/framework/interpreter.ts`:
   `executeExpect`'s timeout branch now checks `Effect.serviceOption(SipHarness)`
   and, when present, calls `SipHarness.timeout({ agent, waitingFor:
   methodOrStatus, expectStepId: String(step.ref.id) })` before the
   existing `state.results.push` failure entry. Service-optional so
   the interpreter still runs in stacks that don't wire SipHarness
   (consumer-api tests, hybrid runners, etc.). One driver call-site
   migrated — no pre-existing `marker` / `linkObservedToExpect`
   emission paths existed (markers and link entries were defined in
   `tests/harness/recording.ts` but unreachable from the driver until
   now).

6. **Runner splice** — `tests/harness/runner.ts`: new
   `mergeSipHarnessEntries(recordings)` step. After `extractRecordings`
   it pulls the SipHarness channel snapshot, projects via
   `toCallRecordingEntries`, and appends driver entries to the first
   `CallRecording`. When neither `Recorder` nor any SipHarness event
   is present the recordings pass through unchanged. Falls back to a
   `<pre-call>` bucket when the driver emits before any SIP traffic
   creates a recording.

## What's deferred to Slice 14

- The projector deletes when `tests/harness/recording.ts` retires.
- Refined per-call attribution: events currently append to the first
  recording. Once a recording-shape rule actually depends on
  `timeout` / `marker` placement, the projector or driver gains a
  callId hint. Today's rule pack (`tests/harness/rules/cross-call/limiter-concurrency.ts`)
  only reads `atMs`, so the coarse attribution is harmless.
- `linkObservedToExpect` correlation: the projector emits
  `labelsByExpectStepId` but the runner doesn't fold those labels
  back onto `RecordedMessage.label` yet — `LabelRegistry` already
  covers the existing label use cases. Wiring is deferred until a
  driver consumer needs it.

## Verification

- `npm run typecheck` — zero `tsc` errors, zero Effect-plugin
  warnings (all five tsconfig projects clean).
- `npm run test:fake` — full fake-stack suite still green; SipHarness
  imports compile across the live entry path too.
- Canary `tests/fullcall/canary-signaling-audit.test.ts` still fails
  for the right reason (deliberate Content-Length mismatch →
  `SignalingAuditViolation`) — SipHarness wiring is orthogonal to
  the SignalingNetwork audit channel.
- The new `SipHarness` Tag is importable from
  `src/test-harness/framework/SipHarness.ts`.
- `tests/harness/runner.ts`'s `mergeSipHarnessEntries` is the legacy
  consumer that now reads entries through the SipHarness projector
  via `Recorder.forTag(SipHarness).snapshot`.

## Anomalies / deviations from the brief

- **Projector lives test-side, not in `SipHarness.ts`.** Moving it
  into `src/` would force a `src/ → tests/` import to reach
  `RecordedTimeout`/`RecordedMarker`. Project convention keeps that
  edge clean; the projector module is small and deletes with the
  legacy types anyway. Functional shape matches the brief.
- **`linkObservedToExpect` does not yet rewrite the existing
  `RecordedSipEntry` `label`.** The current `LabelRegistry` already
  attaches labels via `extractRecordings`, and no driver call-site
  emits `linkObservedToExpect` today. The projector returns the
  correlation map so a future caller can fold it in without
  reshaping the channel.
- **Marker / linkObservedToExpect migrations** — no existing driver
  call-sites; the SipHarness API is the first surface to expose them.
  Brief's "wherever the driver currently emits ... events" reduces
  to the one timeout site in `executeExpect`.

## Slice 4 handoff

SignalingNetwork's per-bindUdp finalizer (counter balance,
undelivered drained) is **orthogonal** to SipHarness events: they
target different channels (`Recorder.forTag(SignalingNetwork)` vs
`Recorder.forTag(SipHarness)`) and the SignalingNetwork finalizer
is concerned with packets that crossed the wire, not with driver
intent. No coupling. The only shared surface is the underlying
`Recorder`, which is `addFinalizer`-free for both channels.
