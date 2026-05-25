# Slice 9 — `ReplicationTraceRecorder` consolidation

Parent plan: [review-this-plan-and-noble-goblet.md](../review-this-plan-and-noble-goblet.md)
ADR: [0013-effect-layer-wrappers-and-typed-recorder.md](../../adr/0013-effect-layer-wrappers-and-typed-recorder.md)

**Irreversible.** Deletes the legacy `tests/support/ReplicationTraceRecorder.ts` test-support module after migrating every consumer to the unified `Recorder.forTag(PartitionedRelayStorage)` typed channel.

## Deliverables landed

1. **`PartitionedRelayStorageEvent` typed-channel union (stub).**
   New module `src/cache/PartitionedRelayStorage.contracts.ts` defines
   the narrow stub union the existing producers need:

   ```ts
   export type PartitionedRelayStorageEvent =
     | {
         readonly tag: "repl.frameReceived"
         readonly timestamp: number
         readonly from: string
         readonly to: string
         readonly frame: DataFrame | NoopFrame
       }
   ```

   The variant mirrors the legacy `ReplicationTraceEvent` payload —
   only the `tag` discriminant and the `seq`/`atMs` stamps the Recorder
   adds at record time are new. The existing producers (the puller
   `Stream.mapEffect` taps in `proxyB2bFakeStack` / `k8sFakeStack`) only
   emit Data frames, so a single variant suffices for this slice.

2. **Built-in projector.** `toReplTrace` in
   `PartitionedRelayStorage.contracts.ts` turns stamped events into a
   `Partial<RecordedScenario>` carrying `replTrace: RecordedReplEntry[]`.
   `simulated-backend.ts` runs the projector at scenario end and feeds
   the result into `TestTransport.drainReplicationTrace`, preserving
   the existing `ScenarioResult.replicationTrace` field the HTML / SVG
   renderers consume unchanged.

3. **`makeRecorderApi` export.** New sync factory on
   `src/test-harness/framework/report-recorder/Recorder.ts`. Lets
   `simulated-backend.ts` materialise a self-contained Recorder
   instance at SUT-construction time — before any Effect runtime is
   available — and pass the resulting channel handle down into the
   stack layers. Production tests-as-effects continue to use
   `Recorder.fake` / `.live` / `.hybrid` + `yield* Recorder`.

4. **Consumer migration.** Three consumer files migrated to the typed
   channel; one was already a pass-through and only needed signature
   renames:

   | Consumer | Old → new |
   |---|---|
   | `tests/support/proxyB2bFakeStack.ts` | `replicationTraceRecorder?: ReplicationTraceRecorder` → `replicationTraceChannel?: PartitionedRelayStorageChannel`. `Stream.mapEffect` tap now does `yield* recordReplFrameReceived(channel, {...})` instead of a synchronous `recorder.record({...})`. Legacy `export { makeReplicationTraceRecorder }` block removed. |
   | `tests/support/k8sFakeStack.ts` | Same rename + helper swap as above. Per-puller tap migrated to `yield* recordReplFrameReceived(...)`. |
   | `tests/fullcall/framework/simulated-backend.ts` | `makeReplicationTraceRecorder()` → `makeRecorderApi("fake")` + `forTag<typeof PartitionedRelayStorage, PartitionedRelayStorageEvent>(PartitionedRelayStorage)`. `drainReplicationTrace()` runs `Effect.runSync(channel.snapshot)` then `toReplTrace(...)` to produce the legacy `ReadonlyArray<ReplicationTraceEntry>` shape. The drained data is identical — only the buffer vehicle changed. |

5. **Documentation-comment sweep.**
   `src/test-harness/framework/EventSequencer.ts` and `types.ts`
   referenced `ReplicationTraceRecorder` only in doc-comments — no
   functional dependency. Updated to point at the typed channel +
   `repl.frameReceived` projector.

6. **`tests/support/ReplicationTraceRecorder.ts` deleted.** No
   remaining producer or consumer.

## What Slice 10 must extend (not redefine)

The typed channel now looks like:

```ts
Recorder.forTag<PartitionedRelayStorage, PartitionedRelayStorageEvent>(
  PartitionedRelayStorage,
) // returns TaggedChannel<PartitionedRelayStorageEvent>
```

Slice 10 extends `PartitionedRelayStorageEvent` with one variant per
public method (per D3 — same shape as `CallBodyCodecEvent`). The
missing variants today, in `PartitionedRelayStorageApi` declaration
order:

- `getCall.{called,result}` — payload: `{ role, owner, callRef }` →
  `{ ok: Buffer | null }`. Needed by `paranoidInputs` (non-empty
  callRef) and `parity` (memory vs Redis).
- `getIndex.{called,result}` — same shape, indexKey-flat.
- `putCall.{called,result}` — payload: full `{ role, owner, callRef,
  indexes, ttlSec, callGen, opts? }`. Needed by `scopedAudit` (refcount
  / orphan-key invariants) and `parity`.
- `refreshCall.{called,result}` — same shape minus body.
- `deleteCall.{called,result}` — same shape, minus body and ttl.
- `scanCalls.{streamStart,streamItem,streamEnd}` — Stream lifecycle
  per D4 (`recordStreamLifecycle` helper). Required by `scopedAudit`
  to verify the SCAN cursor drained on scope close.

`toReplTrace` stays first-registration-wins. Slice 10's
`scopedAudit` / `parity` projectors should NOT register a competing
projector for the same Tag — per the Slice 8 handoff note, the cleaner
pattern is a single shared per-Tag anomaly buffer (e.g. a small
scope-level service) that every wrapper pushes into. Avoid replicating
the codec's per-wrapper-projector-array pattern verbatim. The
`PartitionedRelayStorage` projector composition needs to merge
`replTrace` (from this slice) with the future `anomalies` channel that
`scopedAudit` / `parity` populate — straightforward inside one
projector that walks the typed events once and contributes to multiple
`RecordedScenario` fields.

## Opportunistic Slice 4 drainTrace migration: NOT done

Slice 4's deferred `drainTrace()` deletion calls out the same five
fakeStack helpers that touch the replication channel today
(`proxyB2bFakeStack`, `k8sFakeStack` are two of them). The two slices'
deferrals are about *different* buffers, however:

- Slice 4: `SignalingNetwork.simulated`'s internal `trace[]` array
  (the SIP-message buffer feeding `drainNetworkTrace` / the HTML SIP
  lanes). Deleting it requires migrating the helpers off direct
  `SignalingNetwork.simulated` instantiation onto
  `Tag.withAllContracts(...)` — a structural rebuild of the SUT
  composition. Out of scope here.
- Slice 9 (this slice): the replication-frame buffer. Replaced
  in-place by a typed channel, no structural change to the SUT layer
  composition (the layers still construct `SignalingNetwork.simulated`
  directly; only the per-puller tap migrates).

Migrating Slice 4's `drainTrace` requires wiring `Recorder` as a
*requirement* of these SUT layers (so the `scopedAudit` wrapper can
fire). That's a non-trivial layer rewrite the parent plan correctly
defers to a broader fixture-wide `withAllContracts` rollout. Staying
narrow here per the slice constraint.

## Verification

- `npm run typecheck` — zero `tsc` errors, zero Effect-plugin warnings.
- `npm run test:fake` — 205 files / 1470 tests passing, 1 file / 5
  skipped (Slice 8 baseline preserved). Replication-frame assertions
  (e.g. tests under `tests/sip-front-proxy/failover/` and
  `tests/fullcall/sipproxyHA/`) still see the same `replicationTrace`
  array in `ScenarioResult`.
- `git grep -l "ReplicationTraceRecorder"` returns matches only in
  `docs/plan/effect-layer-wrappers/slice-09.md` (this file) and the
  parent plan's slice catalog row.
- Slice 1 canary still fires for `rfc.contentLength` (regression gate
  unchanged — this slice only touches replication-side recording).

## Files touched

| File | Change |
|---|---|
| `src/cache/PartitionedRelayStorage.contracts.ts` | **new** — typed event union, projector, channel-handle helper |
| `src/test-harness/framework/report-recorder/Recorder.ts` | added sync `makeRecorderApi` factory |
| `src/test-harness/framework/EventSequencer.ts` | doc-comment sweep |
| `src/test-harness/framework/types.ts` | doc-comment sweep (`drainReplicationTrace` + `traceSequencer`) |
| `tests/support/proxyB2bFakeStack.ts` | opt rename + tap migration + legacy re-exports removed |
| `tests/support/k8sFakeStack.ts` | opt rename + tap migration |
| `tests/fullcall/framework/simulated-backend.ts` | Recorder materialisation + drain via `channel.snapshot` + `toReplTrace` |
| `tests/support/ReplicationTraceRecorder.ts` | **deleted** |
