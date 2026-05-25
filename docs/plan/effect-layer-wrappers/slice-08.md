# Slice 8 — Codec wrapper retrofit (typed channel + dual-report)

Parent plan: [review-this-plan-and-noble-goblet.md](../review-this-plan-and-noble-goblet.md)
ADR: [0013-effect-layer-wrappers-and-typed-recorder.md](../../adr/0013-effect-layer-wrappers-and-typed-recorder.md)

## Deliverables landed

1. **Typed `CallBodyCodecEvent` union.** New export in
   `src/call/codec/contracts.ts`:

   ```ts
   export type CallBodyCodecEvent =
     | { tag: "encode.called"; input: Call }
     | { tag: "encode.result"; outBytes: number; outHash?: string }
     | { tag: "decode.called"; inBytes: number; inHash?: string }
     | { tag: "decode.result"; output: Call }
   ```

   Default-record-the-full-value: `encode.called` carries the whole
   `Call`, `decode.result` carries the decoded `Call`. Recording only
   runs in tests (where scale is bounded by construction), so the
   payload size is intentional — matches the CallStateCache discussion
   from the parent plan ("full record because tests are small-scale").

2. **New `RecordedAnomaly` variants.** `src/test-harness/framework/types.ts`
   extends the discriminated union with four codec kinds:

   - `codecPropertyViolation { propertyId, detail, callRef?, severity }`
   - `codecParanoidInput { check, detail, severity }`
   - `codecParity { side, detail, callRef?, severity }`
   - `codecAudit { check, detail, severity }`

   Severity is `"fatal" | "deferred-fail" | "advisory"`. All four
   variants currently emit at `fatal` in every `RunContext` kind —
   the codec wrappers always throw / `Effect.fail`, so the lower
   severity tiers are unreachable today. Field is kept open for future
   relaxation (e.g. an opt-in audit pass that records but doesn't throw).

3. **Dual-report on every wrapper.** All four wrappers in
   `src/call/codec/contracts.ts` now write to
   `Recorder.forTag(CallBodyCodec)` and a `codec*` anomaly through a
   first-registration-wins projector:

   | Wrapper | Records on entry | Records on result | Records on violation |
   |---|---|---|---|
   | `propertyTest`   | `encode.called` / `decode.called` | `encode.result` / `decode.result` (on success) | anomaly + throws `PropertyViolation` |
   | `paranoidInputs` | `encode.called` / `decode.called` | `encode.result` / `decode.result` (on success) | anomaly + throws `ParanoidInputViolation` |
   | `parity`         | `encode.called` / `decode.called` | `encode.result` / `decode.result` (on success) | anomaly + throws `ParityViolation` |
   | `scopedAudit`    | `encode.called` / `decode.called` | `encode.result` / `decode.result` (on every call) | anomaly + `Effect.fail(AuditViolation)` in finalizer |

   The throw shape (`Error subclass with _tag`, `Data.TaggedError`) is
   unchanged — existing catch sites and `_tag`-dispatchers continue to
   compile and work. Recording is purely additive.

4. **recordSync/inline-record decision.** The wrappers use **inline
   `pushChannel` calls** rather than the `recordSync` helper from
   `recordingHelpers.ts`. Reason: `recordSync` records *after* the inner
   call returns and only records the success path (the helper has a
   "if `fn` throws, no event is recorded" comment). The codec wrappers
   need to record both the `*.called` event BEFORE the inner runs (so
   the call site is captured even on throw) and the `*.result` event
   AFTER. Inline `pushChannel(channel, ...)` is clearer than splitting
   into two `recordSync` calls — and the helper's "skip on throw"
   semantic actively conflicts with the requirement that violations be
   captured.

5. **`CallBodyCodec.withAllContracts` forwarder.** New export mirroring
   Slice 7's `SignalingNetwork.withAllContracts`. Delegates to the
   generic `withCanonicalContracts(CallBodyCodec, impl, ...)`. Canonical
   order is `propertyTest(paranoidInputs(scopedAudit(impl)))`. `parity`
   stays outside the helper per D7 — when needed, build the parity
   layer first and pass it as `impl`.

6. **Recorder + RunContext on requires-channel.** Each wrapper's return
   type changed from `Layer<CallBodyCodec, never, never>` to
   `Layer<CallBodyCodec, never, Recorder | RunContext>`. The test
   `tests/codec/round-trip-property.test.ts` was updated to provide
   `Layer.mergeAll(Recorder.fake, RunContext.testWithRecorder)` as a
   downstream layer for each wrapped stack. The production codec
   selector (`selectCallBodyCodecLayer` in `src/call/codec/index.ts`)
   continues to return a bare implementation Layer — production never
   composes the wrappers, so it never depends on Recorder.

## Signature change to existing imports

- `propertyTest`, `paranoidInputs`, `parity`, `scopedAudit` (and the
  Tag-static aliases `CallBodyCodec.propertyTest` etc.) now return
  `Layer<CallBodyCodec, never, Recorder | RunContext>`. Callers
  composing these into a wider Layer.merge must also provide
  `Recorder.fake` (or `.live`/`.hybrid`) + a `RunContext.*` layer
  somewhere in the stack.

- The `Recorder` requirement does NOT propagate into production
  `main.ts` because no production code consumes the codec wrappers —
  `selectCallBodyCodecLayer` returns the bare impl (MSGPACK /
  MSGPACK_RECORDS / PROTOBUF) without any contract wrapping. Verified
  via `git grep`:

  ```
  src/main.ts                              → no CallBodyCodec reference
  src/call/CallCodec.ts                    → uses makeMsgpackUnsafe directly
  src/call/codec/index.ts:selectCallBodyCodecLayer → bare impl Layer
  ```

  Wrappers are test-only consumers (`tests/codec/round-trip-property.test.ts`,
  the new `tests/codec/typed-channel.test.ts`).

## stackLayer wiring

CallBodyCodec is NOT currently part of `tests/support/stackLayer.ts`'s
composition (codec test sites compose Tag wrappers explicitly), so per
the slice constraints, `stackLayer.ts` is unchanged. When codec
consumers later land inside the wrapped fake/live stack, the natural
hook is `CallBodyCodec.withAllContracts({ scopedAudit: { ... } })` as
an additional `Layer.provideMerge` in `buildFake`.

`testLayers.contracts.callBodyCodec` is still unpopulated (the
`contracts` bundle field in `tests/support/testLayers.ts` remains a
typed `Record<string, never>` placeholder). It can be wired with the
new forwarder once a stackLayer-level consumer exists.

## Verification

- `npm run typecheck` — zero `tsc` errors, zero Effect-plugin warnings.
- `npm run test:fake` — 205 files / 1470 tests passing, 1 file / 5
  skipped. Two new tests in `tests/codec/typed-channel.test.ts`
  (encode/decode event order + `codecPropertyViolation` anomaly path)
  bring the count from 1468 → 1470. No regressions in
  `tests/codec/round-trip-property.test.ts` (17 tests still green).
- Sample typed-channel assertion (lives in `tests/codec/typed-channel.test.ts`):

  ```ts
  const channel = recorder.forTag<CallBodyCodec, CallBodyCodecEvent>(CallBodyCodec)
  const events = yield* channel.snapshot
  expect(events.map((e) => e.tag)).toEqual([
    "encode.called",
    "encode.result",
    "decode.called",
    "decode.result",
  ])
  ```

  Proves the typed channel is fed by every encode/decode through the
  paranoidInputs wrapper.

## Anomalies / deviations from the spec

- The spec suggested `recordSync` as the recording helper. Found a
  semantic mismatch (helper records after the inner call returns, on
  the success path only). Used inline `Effect.runSync(channel.record(...))`
  via the local `pushChannel` helper instead — cleaner for the
  "record-before-and-after-and-on-violation" pattern that the codec
  needs. The `recordSync` helper remains useful for sync APIs whose
  rules don't fire mid-call.

- The spec's anomaly variants list described `severity` open-endedly.
  Implemented as `"fatal" | "deferred-fail" | "advisory"` to match the
  existing `signalingAudit` shape, but every codec anomaly is emitted
  at `"fatal"` today since the wrappers all throw synchronously /
  fail the Effect.

- The spec mentioned "if production caller uses these wrappers, those
  callers need a Recorder dependency". Verified there are no
  production consumers — wrappers are test-only — so no production
  wiring needs to change.

## Slice 9 / Slice 10 handoff

One observation for the upcoming `PartitionedRelayStorage.contracts.ts`
(Slice 10) on top of `ReplicationTraceRecorder` consolidation
(Slice 9): codec's projector is `first-registration-wins`. Three
wrappers (`propertyTest`, `paranoidInputs`, `scopedAudit`) can each
attempt to `recorder.registerProjector(CallBodyCodec, ...)`, and only
the first registration is honoured. The current implementation works
because each wrapper installs the same shape of projector that drains
its own local anomaly array — the second `registerProjector` is a
no-op, and the first projector's array is the one that gets read at
snapshot time. This works only because at most one of those wrappers
is composed in any real stack today.

The cleaner pattern (for Slice 10 onwards) is to share a single
mutable anomaly buffer per Tag at the scope level — e.g. a small
service `PerTagAnomalyBuffer.layer(tag)` that all wrappers read. When
`PartitionedRelayStorage` wraps its impl with both `scopedAudit` and
`parity` (or scopedAudit + propertyTest), they'll need to push into
one buffer. Avoid replicating the codec's per-wrapper-projector-array
pattern verbatim.
