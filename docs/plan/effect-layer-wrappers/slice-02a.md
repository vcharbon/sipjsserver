# Slice 2a — Runner unification (`stackLayer({ mode })`)

Parent plan: [review-this-plan-and-noble-goblet.md](../review-this-plan-and-noble-goblet.md)
ADR: [0013-effect-layer-wrappers-and-typed-recorder.md](../../adr/0013-effect-layer-wrappers-and-typed-recorder.md)

**Status:** DONE. **Irreversible** — `fakeStack.ts` / `liveStack.ts`
are now transitional re-exports; the canonical builder is
`tests/support/stackLayer.ts`.

## What moved

1. **New `tests/support/stackLayer.ts`** — single entry point.
   `stackLayer({ mode, config, ... })` builds either the fake or live
   B2BUA stack. Internally branches on `mode`:
   - `fake`: `SignalingNetwork.simulated(...)` piped through
     `withAllContracts({ scopedAudit: { rules, shouldAuditBind } })`
     (gated by `perfMode`), in-memory `CallStateCache` /
     `CallLimiter`, `MockCallControl`, `NoOpTracing`, `NoOpCdr`
     (delegated to `b2buaWorkerStackLayer`), `PumpableClockLayer`
     unless `realClock: true`.
   - `live`: `SignalingNetwork.realTracing()`, redis-backed
     `CallStateCache` / `CallLimiter`, real `HttpReferenceAdapter`,
     real `TracingService`, real `CdrWriter` — same composition the
     old `liveStackLayer` had.
   Both modes provide `Recorder` + `RunContext.testWithRecorder`
   outward (live mode previously had no Recorder wiring at all —
   now symmetrical).

2. **`tests/support/fakeStack.ts`** — rewritten as a ~15 LOC thin
   re-export that forwards to `stackLayer({ mode: "fake", ... })`.
   Preserves `fakeStackLayer`, `DEFAULT_TRANSIT_DELAY_MS`,
   `NoOpCdrLayer`, `NoOpTracingLayer`, `Recorder`, and the
   `FakeStackPerfMode` type alias. Every existing importer keeps
   working unchanged.

3. **`tests/support/liveStack.ts`** — same treatment, forwards to
   `stackLayer({ mode: "live", ... })`. No external consumers exist
   yet (the symbol was a spec-symmetry placeholder for B.4/B.5);
   the live short-tier suite continues to use `createLiveRunner`
   against an external B2BUA process, which is unaffected.

4. **`tests/support/testLayers.ts`** — `stacks` bundle populated:
   ```ts
   stacks.fake(opts)        // stackLayer({ mode: "fake", ...opts })
   stacks.live(opts)        // stackLayer({ mode: "live", ...opts })
   stacks.unit(tag, impl)   // Layer.merge(impl, Recorder.fake, RunContext.unitTestOf(tag))
   ```

## What stayed

- `SignalingNetwork.contracts.ts` — `withAllContracts` already
  accepts `shouldAuditBind` via `ScopedAuditOptions`. No signature
  change needed; `stackLayer` just passes the option through.
- `b2buaWorkerStackLayer` (in `networkLeaves.ts`) — unchanged.
  Fake-mode composition delegates here for the worker bundle, same
  as the old `fakeStackLayer` did.
- The `realLayer` `Layer.suspend` wrapper in `SignalingNetwork.ts`
  is preserved.
- `vitest.config.fake.ts` / `vitest.config.live.ts` — unchanged
  this slice (those land in Slice 2b).

## Signature changes

- `FakeStackPerfMode` is now an alias re-exported from
  `stackLayer.ts` as `StackPerfMode`. Same shape (`"baseline" |
  "no-audit" | "full"`), same default (`"full"`). Tests that
  import the type name continue to work.
- `stackLayer({ mode: "fake", ... })` accepts an optional
  `shouldAuditBind` override at the top-level options (previously
  the predicate was hard-coded inside `fakeStackLayer`). The
  default behaviour — exempt `${sipLocalIp}:${sipLocalPort}` — is
  unchanged.
- `testLayers.stacks` is now a populated bundle, not a
  `Record<string, never>` placeholder. `stacks.unit(tag, impl)`
  is a new symbol — the minimal layer-of-one helper described in
  D6, used by per-rule unit-of-layer fixtures (Slice 6).

## Deprecation notice

`tests/support/fakeStack.ts` and `tests/support/liveStack.ts` are
**transitional**. New code should import from
`tests/support/testLayers.ts` (`testLayers.stacks.fake({ ... })` /
`testLayers.stacks.live({ ... })`) or from
`tests/support/stackLayer.ts` directly. Existing tests will be
swept incrementally as subsequent wrapper slices touch them; the
two transitional files stay around until that sweep completes.

## Verification

- `npm run typecheck` — zero tsc errors, zero Effect-plugin warnings.
- `npm run test:fake` — 205 files / 1471 tests passing, 3 files /
  12 tests skipped (same as Slice 1's baseline). Canary test
  still passes.
- `npm run test` (fake + short-tier live) — fake suite green;
  live short tier: 2 files / 6 tests passing, 2 files / 13 tests
  skipped (tier-gated — unchanged from baseline).

## Anomalies / deviations from the plan

- The spec said "Apply `Recorder.fake` (or `Recorder.live` for
  live mode) at the top, Apply `RunContext.testWithRecorder` at
  the top". Done for both modes, but live-mode does **not** wrap
  `SignalingNetwork` with `withAllContracts` — real-UDP traffic
  isn't audited the same way fake-fabric traffic is, and
  `realTracing` is what live tests want for hop-by-hop reports.
  This is consistent with Slice 1's "liveStack.ts UNCHANGED"
  framing — the audit wrapper stays a fake-mode feature for now.
- `SignalingNetwork.contracts.ts` did not need any signature
  changes: `ScopedAuditOptions` already exposes
  `shouldAuditBind`. The spec flagged this as a possible
  follow-up — turns out Slice 1 already wired it cleanly.
- `stacks.unit(tag)` requires an `impl: Layer.Layer<S>` argument
  (not just the tag). A bare unit stack with no impl is a
  no-op — Slice 6's fixtures pass the per-Tag impl layer
  explicitly, so this matches how the helper will actually be
  called.

## Slice 2b handoff

`vitest.config.fake.ts` and `vitest.config.live.ts` are still
separate files. The two relevant axes are:

- **Test files included.** `vitest.config.fake.ts` picks up
  `tests/**/*.test.ts` minus `tests/fullcall/e2e-real-clock.test.ts`;
  `vitest.config.live.ts` includes only the real-clock file (plus
  the medium endurance suite when `TEST_TIER` is set).
- **`@effect/vitest` mode.** Fake config uses default
  TestClock injection (overridden by `PumpableClockLayer`); live
  config uses `it.live` + real clock.
- **`TEST_TIER` env.** Already shared via `process.env.TEST_TIER`
  in `e2e-real-clock.test.ts`; only the live config consults it.

For Slice 2b the unified `vitest.config.ts` should switch on a
`TEST_MODE=fake|live` env var (defaulting to `fake`), pick the
include/exclude pattern accordingly, and keep `TEST_TIER` as the
secondary axis it already is. The two `.fake` / `.live` variants
get deleted in the same slice (irreversible).
