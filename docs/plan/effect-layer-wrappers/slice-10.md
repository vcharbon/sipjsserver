# Slice 10 — PartitionedRelayStorage wrappers

Parent plan: [review-this-plan-and-noble-goblet.md](../review-this-plan-and-noble-goblet.md)
ADR: [0013-effect-layer-wrappers-and-typed-recorder.md](../../adr/0013-effect-layer-wrappers-and-typed-recorder.md)

Extends Slice 9's `PartitionedRelayStorage.contracts.ts` stub from a single `repl.frameReceived` variant into the full wrapper set: typed-channel events per public method, `paranoidInputs`, `scopedAudit` with refcount / scan-drain / replication-frame invariants, and a `parity` wrapper comparing memory vs Redis impls. Wired into `tests/support/stackLayer.ts` so every fake-stack scenario silently audits the storage layer.

## Deliverables landed

### 1. Extended `PartitionedRelayStorageEvent` union (13 variants)

The Slice 9 single-variant stub gains 12 new variants, mirroring the codec Slice 8 pattern (`<method>.called` / `<method>.result` for Effect-returning methods, `<stream>.streamStart` / `streamItem` / `streamEnd` for the one Stream-returning method).

| Method | Variants |
|---|---|
| `getCall` | `getCall.called`, `getCall.result` |
| `getIndex` | `getIndex.called`, `getIndex.result` |
| `putCall` | `putCall.called`, `putCall.result` |
| `refreshCall` | `refreshCall.called`, `refreshCall.result` |
| `deleteCall` | `deleteCall.called`, `deleteCall.result` |
| `scanCalls` | `scanCalls.streamStart`, `scanCalls.streamItem`, `scanCalls.streamEnd` |
| (Slice 9, retained) | `repl.frameReceived` |

`.called` events carry the full input shape (role / owner / callRef / indexes / ttlSec / opts) so projectors and rules can correlate without recomputing keys. `.result` carries `outcome: "ok" | "fail" | "interrupt"` plus value-shape stamps where meaningful (`bodyBytes` on `getCall.result`, `callRef` on `getIndex.result`). Recording only runs in tests — payload size is intentional.

### 2. `paranoidInputs` wrapper

All-on (no env gating — every check is µs-cost type/range guard).

| Check | Methods | Detail |
|---|---|---|
| `PA_*_role` | get/put/refresh/delete/scan | role must be `"pri"` or `"bak"` |
| `PA_*_owner` | get/put/refresh/delete/scan | non-empty string |
| `PA_*_callRef` | get/put/refresh/delete | non-empty string |
| `PA_putCall_body` | put | non-empty Buffer |
| `PA_*_indexes` | put/refresh/delete | array of non-empty strings |
| `PA_*_ttl` | put/refresh | positive integer |
| `PA_putCall_callGen` | put | finite number when defined |
| `PA_*_peer` | put/refresh/delete | non-empty string when defined |
| `PA_*_propagateSetTtl` | put/refresh/delete | positive integer when defined |
| `PA_getIndex_indexKey` | getIndex | non-empty string |
| `PA_scanCalls_batch` | scan | positive integer when defined |

Violations are programmer error → `Effect.die(new PartitionedRelayStorageParanoidInputViolation(...))`. Stream-returning `scanCalls` defers the check inside `Stream.unwrap(Effect.suspend(...))` so the die fires when the stream is run, not at construction.

### 3. `scopedAudit` wrapper

Three invariants checked at layer-close:

| Check | Default severity | Rationale |
|---|---|---|
| **A1_refcountImbalance** | `advisory` | `putCall(...)` without matching `deleteCall(...)` at scope close. Many real-run patterns intentionally outlive the layer scope (e.g. backup-side replication retains state for the next puller iteration); deferred-fail would surface too many false positives until settle-bound assertion sites land (mirrors Slice 4's `queueLeak` / `undeliverable` decision). |
| **A2_scanCursorLeak** | `advisory` | `scanCalls(...)` Stream that fired `streamStart` but no `streamEnd`. Surfaces fiber-interrupted mid-walks. Advisory same as A1 (test fixtures legitimately drop streams). |
| **A3_replicationFrameLeak** | `advisory` | `repl.frameReceived` events arriving after layer-close marker — the puller is a forked sibling. Recorded for diagnostics; advisory by default. (Not currently materialised as a separate check — surfaces in the replTrace timeline.) |

**Severity matrix per `RunContext`:**

| RunContext | A1 | A2 | A3 |
|---|---|---|---|
| `real-run` | `advisory` | `advisory` | `advisory` |
| `test-with-recorder` | `advisory` | `advisory` | `advisory` |
| `unit-test-of-layer` (PartitionedRelayStorage) | `deferred-fail` → `PartitionedRelayStorageAuditViolation` | `deferred-fail` | `deferred-fail` |

The deferred-fail surfacing path is wired but only triggers when an anomaly is upgraded to `deferred-fail`. All variants ship at `advisory` to avoid widespread fixture-cascade failures — mirrors the Slice 4 decision for SignalingNetwork's `queueLeak` / `undeliverable`. Future hardening passes (after settle-bound assertion sites land) can promote specific variants.

### 4. Shared anomaly buffer + single projector

Per the Slice 8 handoff, this slice deliberately avoids the codec's per-wrapper-projector-array pattern.

Implementation:
- `scopedAudit` registers a **single projector** for `PartitionedRelayStorage` that walks the typed channel events once and produces BOTH `replTrace` (from `repl.frameReceived` variants — same payload as Slice 9's standalone `toReplTrace`) and `anomalies` (from a local `RecordedAnomaly[]` array the wrapper mutates as findings accumulate).
- `parity` does NOT register a competing projector. Parity violations are `Effect.die(...)` immediately on detection — they never need to surface through the snapshot, so no anomaly buffer is needed for them.
- `paranoidInputs` likewise `Effect.die`s — no projector.
- The standalone `toReplTrace` export is preserved for tests that want the replication projection without the audit overlay (e.g. `simulated-backend.ts`'s `drainReplicationTrace`).

This keeps the anomaly buffer surface narrow (one array per scopedAudit scope, owned by the closure) and the projector registration explicit. Future wrappers that need to push anomalies (e.g. property-test invariants if added later) would extend the same array via a small captured-closure setter or, cleaner, by accepting an explicit `anomalies` array parameter when constructing the projector at scopedAudit-time.

Anomaly variants used: the new findings reuse the existing `signalingAudit` `RecordedAnomaly` shape with a `prs.*` prefix on the `check` field. This avoids extending the `RecordedAnomaly` union for variants that share a `{ check, detail, severity }` payload structure — the prefix discriminates downstream consumers.

### 5. `parity` wrapper (memory vs redis)

Per D7: parity sits OUTSIDE `withAllContracts`. Callers explicitly build a parity layer from two impls and pass the result as `impl`:

```ts
const blueLayer = PartitionedRelayStorage.memoryLayer
const greenLayer = PartitionedRelayStorage.redisLayer({ self, gen })
const paired = parity(blueLayer, greenLayer)
PartitionedRelayStorage.withAllContracts(paired, { scopedAudit: true })
```

Coverage scope:
- `getCall` / `getIndex` — `deepEqual(blue, green)` on outcomes; mismatched buffer length or null/non-null divergence triggers a violation.
- `putCall` / `refreshCall` / `deleteCall` — both impls run via `Effect.all`; violations surface only via downstream `getCall` / `getIndex` reads since these are void-returning ops.
- `scanCalls` — `Stream.zip` lock-step comparison; first divergent (callRef, body, ttlSec) tuple fires `PartitionedRelayStorageParityViolation`.

Parity violations are `Effect.die` (the inner storage `Effect` is typed `StorageError`-only; introducing a new typed error would change the public API surface for every caller). The thrown class carries `_tag = "PartitionedRelayStorageParityViolation"` for catch-site discrimination.

**Where parity is exercised today: nowhere (yet).** Per D7's spirit and the slice constraint about perf, parity stays out of the default `withAllContracts` and is opt-in via explicit construction. The `withAllContracts` helper signature is documented to accept a pre-built parity layer when callers want it. No fake-stack scenarios currently wrap their storage in parity — adding a focused parity test fixture is deferred to a follow-up.

### 6. `Tag.withAllContracts(options)` forwarder

Mirrors SignalingNetwork's shape:

```ts
withAllContracts(
  impl: Layer<PartitionedRelayStorage>,
  options?: {
    scopedAudit?: ScopedAuditOptions | true,
    paranoidInputs?: boolean,  // default true when scopedAudit is set
  },
): Layer<PartitionedRelayStorage, never, Recorder | RunContext>
```

`propertyTest` is intentionally not exposed (no natural input domain — Buffers and caller-supplied callRefs are opaque). Inline comment in the source documents this. `parity` stays outside per D7.

### 7. stackLayer wiring

`tests/support/stackLayer.ts`:

- **Fake mode** (`buildFake`): wraps `PartitionedRelayStorage.memoryLayer` with `withAllContracts({ scopedAudit, paranoidInputs })`. `perfMode` toggles:
  - `baseline` → no wrappers
  - `no-audit` → wrappers active, both audit checks disabled (`checkRefcount: false, checkScanDrained: false`)
  - `full` (default) → wrappers + all checks
- **Live mode** (`buildLive`): wraps `PartitionedRelayStorage.redisLayer(...)` with `withAllContracts({ scopedAudit: true, paranoidInputs: true })`. The wrappers are test-time enforcement, not production — live tests still benefit from the paranoid input checks (real Redis client + real caller-side mistakes).

The `Recorder + RunContext` requirement is satisfied by the existing `RecorderLayer + RunContextLayer` already provided in both modes for SignalingNetwork's wrappers.

### 8. testLayers.contracts.partitionedRelayStorage

The previously-empty `contracts` field on `tests/support/testLayers.ts` now exposes:

```ts
contracts: {
  partitionedRelayStorage: withPartitionedRelayStorageContracts,
}
```

Per the parent plan's D6, tests that need to compose storage contracts explicitly (e.g. wrapping a custom storage impl in a kind-cluster fixture) import via `testLayers.contracts.partitionedRelayStorage(...)` rather than the path-deep contracts module.

## Real defects caught by the new rules

**None.** Running the full fake-stack suite with all wrappers enabled produces the same 1470 passed + 5 skipped as the Slice 9 baseline. No tests started failing, no anomalies promoted to defects. This is the expected outcome given:

1. `paranoidInputs` checks are caller-side hygiene — every existing caller already obeys the implicit contract (the production code paths construct partitioned-storage keys from validated B2BUA state).
2. The three `scopedAudit` invariants all default to `advisory` to match Slice 4's calibration. They surface in the report's anomaly panel but do not fail tests until a future slice promotes specific findings.

No fixtures needed to be relaxed; no rules needed to be downgraded.

## Verification

- `npm run typecheck` — zero `tsc` errors, zero Effect-plugin warnings.
- `npm run test:fake` — **205 files / 1470 passed + 5 skipped** (Slice 9 baseline preserved).
- `grep -l "PartitionedRelayStorageEvent\|PartitionedRelayStorageParanoidInputViolation\|PartitionedRelayStorageAuditViolation\|PartitionedRelayStorageParityViolation" -r src/ tests/` — exports defined in `src/cache/PartitionedRelayStorage.contracts.ts`; existing reference in `tests/fullcall/framework/simulated-backend.ts` (Slice 9).
- Slice 1 canary still fires: `tests/fullcall/canary-signaling-audit.test.ts` passes (the malformed-INVITE scenario still surfaces a `SignalingAuditViolation`).

## Files touched

| File | Change |
|---|---|
| `src/cache/PartitionedRelayStorage.contracts.ts` | extended with 12 new event variants, `paranoidInputs`, `scopedAudit`, `parity`, `withAllContracts`, three new failure-shape exports |
| `tests/support/stackLayer.ts` | apply `withAllContracts` to the storage layer in both fake (perfMode-gated) and live modes |
| `tests/support/testLayers.ts` | populate `contracts.partitionedRelayStorage` |
| `docs/plan/effect-layer-wrappers/slice-10.md` | **new** — this file |
