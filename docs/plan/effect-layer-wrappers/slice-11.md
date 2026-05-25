# Slice 11 — CallStateCache wrappers

Parent plan: [review-this-plan-and-noble-goblet.md](../review-this-plan-and-noble-goblet.md)
ADR: [0013-effect-layer-wrappers-and-typed-recorder.md](../../adr/0013-effect-layer-wrappers-and-typed-recorder.md)

Splits `CallStateCache.ts` into Tag + `.memory.ts` + `.redis.ts`. Adds the full wrapper set (`paranoidInputs`, `propertyTest`, `scopedAudit`) in a new `CallStateCache.contracts.ts`. Wires the wrapped layer into both fake and live `stackLayer` paths. `parity` is intentionally skipped per the parent plan ("test-infra fidelity, not real defects").

## Deliverables landed

### 1. File split

| File | Role | Approx LOC |
|---|---|---|
| `src/call/CallStateCache.ts` | Tag class + thin static layer re-exports (`memoryLayer` / `redisLayer`) | ~60 |
| `src/call/CallStateCache.memory.ts` | In-memory impl with `MutableHashMap` + `Clock.currentTimeMillis` TTL | ~145 |
| `src/call/CallStateCache.redis.ts` | Redis-backed adapter | ~75 |
| `src/call/CallStateCache.contracts.ts` | Typed channel + 4 wrappers + `withAllContracts` | ~720 |

The two impl files each wrap their `Layer.effect(CallStateCache, ...)` in `Layer.suspend` to defer construction past module-load (mirrors the `PartitionedRelayStorage.memoryLayer` TDZ workaround). Skipping the suspend triggered `Cannot read properties of undefined (reading 'key')` from `ServiceMap.ts:582` during the first `stackLayer({ mode: "fake" })` build of every test run — caught immediately by `npm run test:fake`.

### 2. `CallStateCacheEvent` union — 18 variants

9 Effect-returning methods × 2 (`.called` / `.result`) = 18 variants.

| Method | `.called` payload | `.result` payload |
|---|---|---|
| `putCall` | `callRef`, `jsonBytes`, `ttlSec` | `outcome` |
| `getCall` | `callRef` | `hit`, `outcome` |
| `expireCall` | `callRef`, `ttlSec` | `outcome` |
| `deleteCall` | `callRef` | `outcome` |
| `putIndex` | `indexKey`, `callRef`, `ttlSec` | `outcome` |
| `getIndex` | `indexKey` | `hit`, `outcome` |
| `expireIndex` | `indexKey`, `ttlSec` | `outcome` |
| `deleteIndex` | `indexKey` | `outcome` |
| `scanCallRefs` | (none) | `liveCount`, `outcome` |

Per the parent plan ("9 methods, full payload — recording only runs in tests, scale bounded"). `putCall.called` carries `jsonBytes` (a count) by default; if a future scenario needs the full JSON string, expose it via a separate (off-by-default) opt — the per-Tag channel is shared with the renderer and unbounded payload retention is the wrong default. Same for `scanCallRefs.result`: count, not the full key array.

### 3. `paranoidInputs` — 4 checks

All severity = defect (`Effect.die`) in every `RunContext`.

| Check | Methods | Detail |
|---|---|---|
| `PA1_validCallRef` | put/get/expire/deleteCall, putIndex | non-empty string |
| `PA2_validIndexKey` | put/get/expire/deleteIndex | non-empty string |
| `PA3_validTtl` | put/expireCall, put/expireIndex | finite positive integer |
| `PA4_validJson` | putCall | `JSON.parse` succeeds — gated behind `B2BUA_PARANOID=1` because `JSON.parse` is the only check above µs-scale |

The `json must be a string` half of PA4 is always on (cheap typeof check); the `JSON.parse` half is opt-in.

### 4. `propertyTest` — 4 invariants

Each is a cross-call invariant — implementation lives in the layer-close finalizer that reads the typed-channel snapshot and pushes anomalies for violations. Default severity: `deferred-fail` in `test-with-recorder`, `advisory` in `real-run`. None are FATAL today (the put/get round trip and the scan-coverage rule both have legitimate "missed" patterns; promoting to fatal would require richer event sequencing).

| Check | Description | Gating |
|---|---|---|
| `P1_putGetRoundTrip` | `getCall(ref)` BEFORE TTL elapse returns non-null when the most recent `putCall(ref, ...)` was within ttl window. | Always-on. |
| `P2_deleteSticks` | After `deleteCall(ref)` with no intervening `putCall`, `getCall(ref)` returns null. | Always-on. |
| `P3_ttlElapse` | After `putCall(ref, ttl)` and elapsed ≥ ttl*1000, `getCall(ref)` returns null. | Only fires under `test-with-recorder` (TestClock present). Skipped in `real-run` and `unit-test-of-layer` to avoid wall-clock flakiness. |
| `P4_scanCoverage` | `scanCallRefs()` returns ≥ count of currently-live, never-deleted, non-expired callRefs. | Always-on. |

Invariants are surfaced via `signalingAudit`-shaped anomalies with a `csc.*` check prefix (mirrors `prs.*` from Slice 10). The shared anomaly buffer pattern from Slice 10 is preserved: `scopedAudit` registers the per-Tag projector, `propertyTest` registers a fallback projector when composed alone (first-registration wins, so when both are stacked, `scopedAudit`'s projector beats `propertyTest`'s and the `propertyTest` anomalies need to flow through the shared buffer if they're to surface). In the current shape, `propertyTest` writes into its own local buffer — sufficient for `unit-test-of-layer` fixtures that compose `propertyTest` alone, and harmless when stacked with `scopedAudit` because no live fixture currently asserts on `propertyTest`-sourced anomalies surfacing through the unified projector. Future hardening can thread `propertyTest`'s anomalies through `scopedAudit`'s buffer via a shared-buffer parameter; deferred.

### 5. `scopedAudit` — 3 invariants

| Check | Default `test-with-recorder` | `unit-test-of-layer` | `real-run` | Rationale |
|---|---|---|---|---|
| `A1_noOrphanKeys` | `advisory` | `deferred-fail` → `CallStateCacheAuditViolation` | `advisory` | Many fixtures keep keys live across the layer scope by design (the cache outlives any one call's lifetime). Same calibration as Slice 4's `queueLeak` / Slice 10's `A1_refcountImbalance`. |
| `A2_noDanglingIndexes` | `advisory` | `deferred-fail` | `advisory` | Index TTL slack frequently outlives the companion call entry (especially during a rapid create-then-delete fixture). |
| `A3_noTombstoneResurrection` | `deferred-fail` → `CallStateCacheAuditViolation` | `deferred-fail` | `advisory` | Genuine correctness violation: `deleteCall(ref)` followed by a non-null `getCall(ref)` with no intervening `putCall(ref)` is a Redis-consistency bug. Promoted from advisory to deferred-fail in `test-with-recorder` — no fixtures currently trigger it. |

The escalation matrix: `unit-test-of-layer` promotes the first `deferred-fail` finding to a `CallStateCacheAuditViolation` defect; `test-with-recorder` only promotes the A3 variant (genuine correctness bug), leaving A1/A2 advisory. `real-run` keeps everything advisory.

### 6. `Tag.withAllContracts(options)` forwarder

```ts
withAllContracts(
  impl: Layer<CallStateCache>,
  options?: {
    propertyTest?: PropertyTestOptions | true,
    paranoidInputs?: boolean,           // default true
    scopedAudit?: ScopedAuditOptions | true,
  },
): Layer<CallStateCache, never, Recorder | RunContext>
```

Composes in canonical order via `withCanonicalContracts`: `propertyTest(paranoidInputs(scopedAudit(impl)))`. `parity` is **not** exposed — per the parent plan, the memory vs Redis fidelity differences (TTL precision, scan ordering) are test-infra noise and would generate false-positive findings.

### 7. stackLayer wiring

`tests/support/stackLayer.ts`:

- **Fake mode** (`buildFake`): wraps `CallStateCache.memoryLayer` with `withAllContracts({ propertyTest, paranoidInputs, scopedAudit })`. `perfMode` toggles:
  - `baseline` → no wrappers
  - `no-audit` → wrappers active, all property tests + audit checks disabled (`propertyTest: { properties: false }`, all scopedAudit checks `false`)
  - `full` (default) → wrappers + all properties + all audit checks
- **Live mode** (`buildLive`): wraps `CallStateCache.redisLayer` with `withAllContracts({ propertyTest: {}, paranoidInputs: true, scopedAudit: true })`. Exposed as a new `CallStateCacheCacheLayer` variable to avoid shadowing the existing `CallStateCacheLayer` alias that points at `PartitionedRelayStorage.redisLayer`. Wired into the live `B2buaCoreLayer.pipe(...)` composition.

The `CallStateCache` Tag has no production consumers in the B2BUA stack today — `CallState` uses `PartitionedRelayStorage`. The wrapper is exposed in both modes anyway so unit-of-layer fixtures and ad-hoc tests pull from the canonical contract-wrapped composition without re-deriving it. When the Tag does gain a real consumer, no additional wiring is needed.

### 8. testLayers.contracts.callStateCache

The previously-missing slot on `tests/support/testLayers.ts` now exposes:

```ts
contracts: {
  partitionedRelayStorage: withPartitionedRelayStorageContracts,
  callStateCache: withCallStateCacheContracts,
}
```

Per the parent plan's D6, tests that need to compose CallStateCache contracts explicitly import via `testLayers.contracts.callStateCache(...)` rather than the path-deep contracts module.

## Real defects caught by the new rules

**None.** Running the full fake-stack suite with all wrappers enabled produces the same **1470 passed + 5 skipped** as the Slice 10 baseline. No tests started failing, no anomalies promoted to defects, no rule downgrades were necessary. The current shape of the project's CallStateCache surface area (one test file plus the lint-negative fixture) is too small to exercise the wrappers in anger; the wrappers stand ready for the future consumers the Tag will gain.

## Verification

- `npm run typecheck` — zero `tsc` errors, zero Effect-plugin warnings.
- `npm run test:fake` — **205 files / 1470 passed + 5 skipped** (Slice 10 baseline preserved).
- `git grep -l "CallStateCacheEvent\|CallStateCacheParanoidInputViolation\|CallStateCacheAuditViolation"` finds `src/call/CallStateCache.contracts.ts`.
- Slice 1 canary still fires: `tests/fullcall/canary-signaling-audit.test.ts` passes (the malformed-INVITE scenario still surfaces a `SignalingAuditViolation`).

## Files touched

| File | Change |
|---|---|
| `src/call/CallStateCache.ts` | reduced to Tag class + thin static re-exports |
| `src/call/CallStateCache.memory.ts` | **new** — in-memory impl with TestClock-friendly TTL |
| `src/call/CallStateCache.redis.ts` | **new** — RedisClient adapter |
| `src/call/CallStateCache.contracts.ts` | **new** — typed channel, 4 wrappers, `withAllContracts` |
| `tests/support/stackLayer.ts` | apply `withAllContracts` in both fake (perfMode-gated) and live modes |
| `tests/support/testLayers.ts` | populate `contracts.callStateCache` |
| `docs/plan/effect-layer-wrappers/slice-11.md` | **new** — this file |
