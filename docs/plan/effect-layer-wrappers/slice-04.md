# Slice 4 — SignalingNetwork.scopedAudit layer-level invariants + anomaly variants

Parent plan: [review-this-plan-and-noble-goblet.md](../review-this-plan-and-noble-goblet.md)
ADR: [0013-effect-layer-wrappers-and-typed-recorder.md](../../adr/0013-effect-layer-wrappers-and-typed-recorder.md)

## Deliverables landed

1. **New `RecordedAnomaly` variants.** `src/test-harness/framework/types.ts`
   gains three variants alongside the existing `signalingAudit`:
   - `undeliverable { src, dst, atMs, seq, severity }`
   - `queueLeak { bindKey, queueDepth, atMs, seq, severity }`
   - `inFlightImbalance { inFlight, atMs, seq, severity }`

   All three currently emit at `advisory` severity — see "Deviation"
   below for why the spec's `deferred-fail` tier doesn't land yet.

2. **Layer-close finalizer in `scopedAudit`.** `src/sip/SignalingNetwork.contracts.ts`:
   - A second `Effect.addFinalizer` runs at layer scope close
     (separate from Slice 1's per-bindUdp finalizer).
   - Skipped for non-simulated impls (`transitDelayMs === undefined`)
     so real/realTracing/Native don't hit the structural checks.
   - Reads `inFlight()`, `drainUndeliverable()`, and `queueDepths()` on
     the inner API and emits one anomaly per finding.
   - Anomalies surface through the existing projector (already
     registered in Slice 1) so they merge into `Recorder.snapshot.anomalies`.

3. **Per-bindUdp `queueLeak` check.** Slice 1's per-bindUdp finalizer
   now also captures `endpoint.queueDepth()` BEFORE the inner release
   removes the routing-table entry (LIFO finalizer order). Emits a
   `queueLeak` anomaly when the queue is non-empty at peer scope close.

4. **Simulated-impl accessor `queueDepths()`.** Added to
   `SignalingNetworkApi`. Simulated returns a snapshot of the routing
   table's `(ip,port) → depth` pairs; real / realTracing / Native
   return `[]`. Pure read; no mutators exposed.

5. **`toNetworkTrace` projector.** New helper in
   `SignalingNetwork.contracts.ts` projects the typed channel to the
   legacy `NetworkTraceEntry[]` shape. Unused this slice but in place
   for the broader migration the spec calls for.

## Verification

- `npm run typecheck` — zero tsc errors, zero Effect-plugin warnings.
- `npm run test:fake` — 205 files / 1471 tests passing, 1 file / 8
  tests skipped (Slice 3 baseline preserved).
- Slice 1 canary (`tests/fullcall/canary-signaling-audit.test.ts`)
  still fails for the right reason (Content-Length mismatch →
  `SignalingAuditViolation`).

## Deviations from the spec

The spec's deliverable list expected:
- `drainTrace()` deletion from `SignalingNetwork.simulated.ts`
- `inFlightImbalance` / `queueLeak` / `undeliverable` as `deferred-fail`
  in `test-with-recorder` mode

Both ran into a structural blocker that the spec acknowledges:

> **No false positives.** A scenario that closes cleanly today must close
> cleanly after Slice 4. If you find a real existing test that
> legitimately leaks (inFlight > 0 at close), investigate before failing
> it. CLAUDE.md: never deactivate tests without explicit confirmation;
> either fix the leak or refine the rule.

### Why `trace[]` / `drainTrace()` stay on the simulated impl

The spec assumed every simulated `SignalingNetwork` runs through
`Tag.withAllContracts(...)` (where the typed channel doubles as the
trace source). That's true for `stackLayer({ mode: "fake" })` but NOT
for the handful of fakeStack helpers that still construct
`SignalingNetwork.simulated` directly:
- `tests/support/proxy-only-fakeStack.ts`
- `tests/support/proxyB2bFakeStack.ts`
- `tests/support/registrarFrontProxyFakeStack.ts`
- `tests/support/k8sFakeStack.ts`
- `tests/support/topologies.ts`

These helpers run without a `Recorder` in scope, so deleting
`trace[]` from the simulated impl would silently empty their HTML
call-flow reports. Migrating all five to the contract wrapper is a
separate, larger slice; the explicit deliverable text for Slice 4
("DELETE from SignalingNetwork.simulated.ts") would force that
migration as a side effect, which exceeds Slice 4's intended scope.

Decision: keep `trace[]` and `drainTrace()` in
`SignalingNetwork.simulated.ts` as the legacy-fixture source. New
fixtures + `stackLayer({ mode: "fake" })` already populate the typed
channel; the broader migration lands in a follow-up slice after Slice
5 (24-rule RFC pack) lands the per-dialog projection that gives the
rest of the fixtures a reason to switch.

### Why layer-close severities are all `advisory`

A first attempt with `inFlightImbalance` as `deferred-fail` in
`test-with-recorder` mode failed 135 fake-stack tests at scope close.
Root cause: the simulated fabric uses `Effect.forkDetach` for transit
fibers (so `send()` returns immediately). Detached fibers outlive the
calling scope by design, so at layer-close time `inFlight` is
routinely non-zero — it only means transit hasn't drained, not that
anything leaked.

Similarly, an `undeliverable` deferred-fail tripped on proxy+b2b
fixtures that send to never-bound endpoints by design (overload tests,
`192.0.2.20` documentation-range targets in scenario fixtures). The
existing fake-stack `verifyCleanState` path is the explicit assertion
site for "no undeliverables expected"; making the wrapper fail at
scope close duplicates that assertion in a way that produces false
positives whenever a test legitimately exercises the unreachable-peer
path.

Decision: all three layer-close variants land at `advisory` severity
in every `RunContext`. The data is recorded — visible in
`Recorder.snapshot.anomalies` and the HTML report — but doesn't fail
the scope. Slice 5 (or whichever follow-up brings settle-bound
assertion sites and the per-dialog projector) can re-tier individual
variants to `deferred-fail` once the false-positive surface shrinks.

### Inline-at-send-time `undeliverable` anomaly

The spec called for recording the anomaly "at the moment a packet is
determined undeliverable in `send`". The simulated impl doesn't have
`Recorder` in its requirements; threading it in would force every
caller to provide one. Instead, the layer-close finalizer drains
`drainUndeliverable()` once and constructs one anomaly per packet
using the packet's stored `timestampMs`. Semantically equivalent: the
anomaly's `atMs` is the moment of detection; only the projection
moment differs.

## `drainTrace` consumer migration

Not done this slice (see "Why `trace[]` stays" above). The five known
consumers still rely on the legacy buffer:
- `src/test-harness/hybrid-runner.ts:391-392`
- `tests/fullcall/framework/simulated-backend.ts:483,485`
- `tests/sip-front-proxy/_report/runner.ts:82`
- `tests/sip/SignalingNetwork.test.ts:122,129,255,267,270` (drainTrace
  partition + drainUndeliverable round-trip tests)
- The `NativeSignalingNetwork` / `realTracing` stubs that satisfy the
  `SignalingNetworkApi` interface (no-op for the former, live trace
  for the latter)

These migrate when the fixture-wide `withAllContracts` rollout lands.

## Slice 5 handoff

The per-bindUdp finalizer and the layer-close finalizer share state
through these closure-scoped arrays:
- `deferredFindings` / `advisoryFindings` — populated by per-bindUdp
  rules; drained by the layer-close finalizer's signalingAudit defect
  path.
- `layerAnomalies` — populated by both the per-bindUdp `queueLeak`
  check and the layer-close structural checks; read by the projector.
- `layerAnomalySeq` — single counter for ordering within the layer's
  lifetime.

When Slice 5 ports the seven cross-message rules, the per-dialog
projector lives in `tests/harness/projections.ts` (per D9). Those
rules need per-`Call-ID` event slices, which the existing per-bindUdp
finalizer already produces (the `slice` array filtered to one peer).
Cross-peer correlation lands at the layer-close finalizer's
disposal — it can iterate every per-peer slice once.

The `severity` policy (`deferred-fail` in `test-with-recorder`,
`fatal` in `unit-test-of-layer`, `advisory` in `real-run`) per D5
remains the canonical contract for new rules added in Slice 5;
existing layer-close variants stay advisory until the false-positive
surface shrinks.
