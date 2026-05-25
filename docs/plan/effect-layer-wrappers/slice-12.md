# Slice 12 — CallLimiter Tag/impl split + scopedAudit

Parent plan: [review-this-plan-and-noble-goblet.md](../review-this-plan-and-noble-goblet.md)
ADR: [0013-effect-layer-wrappers-and-typed-recorder.md](../../adr/0013-effect-layer-wrappers-and-typed-recorder.md)
Load-bearing invariant: [0004-strong-incr-decr-invariant-for-call-limiter.md](../../adr/0004-strong-incr-decr-invariant-for-call-limiter.md)

Splits `CallLimiter.ts` into Tag + `.memory.ts` + `.redis.ts`. Adds
`paranoidInputs` + `scopedAudit` in a new `CallLimiter.contracts.ts`.
The `scopedAudit` enforces ADR-0004's counter-back-to-zero invariant
on the typed channel ledger. Wires the wrapped layer into both fake
and live `stackLayer` paths. `propertyTest` is intentionally skipped
(no natural unit-level input domain); `parity` lands in Slice 13.

## Deliverables landed

### 1. File split

| File | Role | LOC |
|---|---|---|
| `src/call/CallLimiter.ts` | Tag class + thin static layer re-exports (`memoryLayer` / `sharedMemoryLayer` / `redisLayer`) + `LimiterDecision` + `LimiterTimeout` + `LimiterBackendError` types | 125 |
| `src/call/CallLimiter.memory.ts` | In-memory impl with `MutableHashMap` + `Clock.currentTimeMillis` TTL. Exports `LimiterMemoryEntry`, `LimiterMemoryStore`, `makeLimiterMemoryStore`, `memoryLayer`, `sharedMemoryLayer`. | 168 |
| `src/call/CallLimiter.redis.ts` | Redis/Lua-backed impl with outer `Effect.timeoutOrElse(150ms)` budget. | 199 |
| `src/call/CallLimiter.contracts.ts` | Typed channel + 2 wrappers + `withAllContracts` | 704 |

Both impl files wrap their `Layer.effect(CallLimiter, ...)` in
`Layer.suspend` to defer construction past module load (mirrors the
Slice 11 TDZ workaround on `CallStateCache.memory.ts`).

### 2. `CallLimiterEvent` union — 8 variants

4 public methods × `.called` / `.result` = 8 variants.

| Method | `.called` payload | `.result` payload |
|---|---|---|
| `checkAndIncrement` | `limiterId`, `limit` | `outcome`, `decision`?, `currentWindow`?, `errorTag`? |
| `decrement` | `limiterId`, `originWindow` | `outcome` |
| `refresh` | `limiterId`, `originWindow` | `outcome`, `newWindow`? |
| `currentWindow` | (none) | `outcome`, `window`? |

`checkAndIncrement.result` carries enough discrimination to drive the
audit ledger:
- `outcome: "ok"` + `decision: "Allowed"` + `currentWindow` → ledger
  `+1` at that `(limiterId, window)`.
- `outcome: "ok"` + `decision: "Rejected"` → no ledger change.
- `outcome: "fail"` + `errorTag` (`"RedisError"` | `"LimiterTimeout"`)
  → fail-open admission per ADR-0004; no ledger change.

### 3. `paranoidInputs` — 3 checks

All severity = defect (`Effect.die`) in every `RunContext`.

| Check | Methods | Detail |
|---|---|---|
| `PA1_validLimiterId` | check/decrement/refresh | non-empty string |
| `PA2_validLimit` | checkAndIncrement | finite positive integer |
| `PA3_validOriginWin` | decrement/refresh | finite non-negative integer |

The existing impls don't validate caller inputs (they happily pass
empty strings into `redis.eval` and would surface obscure Lua errors).
Surfacing these at the wrapper layer gives clean defect-level
diagnostics without introducing duplication — there's nothing the
inner impls currently assert. Flagged as deliberately wrapper-only.

### 4. `scopedAudit` — 2 invariants (ADR-0004's counter-back-to-zero is THE one)

| Check | Default `test-with-recorder` | `unit-test-of-layer` | `real-run` | Rationale |
|---|---|---|---|---|
| `A1_counterBackToZero` | `deferred-fail` → `CallLimiterAuditViolation` | `deferred-fail` (FATAL via the unit-tier path) | `advisory` | ADR-0004's load-bearing invariant. Every successful `INCR` must be matched by exactly one `DECR`; fail-open admissions never `INCR` and must never `DECR`. In real-run mode, ADR-0004's reconcile bound documents transient overshoot — keep advisory there. In tests, every fixture should terminate every call it admits within its own scope. |
| `A2_orphanDecrement` | `advisory` | `advisory` (no escalation) | `advisory` | ADR-0004's peer-takeover path legitimately decrements a dead worker's counters this scope never admitted — exactly the pattern this rule would otherwise flag. Keep advisory at every tier; the structural symmetry is enforced by A1. |

The escalation matrix:
- `unit-test-of-layer` promotes the first `deferred-fail` finding to
  `CallLimiterAuditViolation`.
- `test-with-recorder` promotes only `A1_counterBackToZero` (the
  ADR-0004 invariant) — A2 stays advisory.
- `real-run` keeps everything advisory.

`skipLimiterId` predicate option exists for SUTs that intentionally
leak counters as part of their scenario (chaos fixtures exercising
ADR-0004's reconcile bound). No fixture currently passes a predicate;
the option is documented for future use.

#### Ledger semantics

The audit walks the channel snapshot and maintains a per-`(limiterId,
window)` net-delta ledger:

| Event | Ledger update |
|---|---|
| `checkAndIncrement.result` with `outcome="ok"` + `decision="Allowed"` | `+1` at `(limiterId, currentWindow)` |
| `checkAndIncrement.result` with `outcome="ok"` + `decision="Rejected"` | no change (limit hit; counter untouched) |
| `checkAndIncrement.result` with `outcome="fail"` (`errorTag` set) | no change (fail-open; ADR-0004 says no DECR follows) |
| `decrement.result` with `outcome="ok"` | `-1` at `(limiterId, originWindow)` |
| `refresh.result` with `outcome="ok"` and `originWindow !== newWindow` | `-1` at `(limiterId, originWindow)`, `+1` at `(limiterId, newWindow)` (atomic migration; net change per limiterId is 0) |
| `refresh.result` with `originWindow === newWindow` | no change (no-op migration) |

`refresh` is treated as an atomic pair so the audit doesn't
false-positive on the in-flight migration — same limiterId, two
windows in motion. A1 fires only on entries whose final delta is
nonzero.

### 5. `Tag.withAllContracts(options)` forwarder

```ts
withAllContracts(
  impl: Layer<CallLimiter>,
  options?: {
    paranoidInputs?: boolean,           // default true
    scopedAudit?: ScopedAuditOptions | true,
  },
): Layer<CallLimiter, never, Recorder | RunContext>
```

Composes in canonical order via `withCanonicalContracts`:
`paranoidInputs(scopedAudit(impl))`. `propertyTest` and `parity` are
NOT exposed — see parent plan rationale.

### 6. stackLayer wiring

`tests/support/stackLayer.ts`:

- **Fake mode** (`buildFake`): wraps `CallLimiter.memoryLayer` with
  `withAllContracts({ paranoidInputs, scopedAudit })` and threads the
  wrapped layer into `b2buaWorkerStackLayer({ limiterLayer })`.
  `perfMode` toggles:
  - `baseline` → raw `CallLimiter.memoryLayer` (no wrappers)
  - `no-audit` → wrappers active, both audit invariants disabled
    (`checkCounterBackToZero: false`, `checkNoOrphanDecrement: false`)
    + paranoidInputs off
  - `full` (default) → wrappers + both audit checks + paranoidInputs
- **Live mode** (`buildLive`): wraps `CallLimiter.redisLayer` with
  `withAllContracts({ paranoidInputs: true, scopedAudit: true })`.
  Wired via the existing `B2buaCoreLayer.pipe(...)` composition.

### 7. testLayers.contracts.callLimiter

`tests/support/testLayers.ts`:

```ts
contracts: {
  partitionedRelayStorage: withPartitionedRelayStorageContracts,
  callStateCache: withCallStateCacheContracts,
  callLimiter: withCallLimiterContracts,
}
```

## Real defects caught by the new rules

**None.** Running the full fake-stack suite with all wrappers enabled
produces the same **1470 passed + 5 skipped** as the Slice 11
baseline. No tests started failing, no anomalies promoted to defects,
no rule downgrades were necessary.

The ledger discipline turns out to be well-respected in the current
test corpus — every fixture that admits a call also terminates it
within the same scope, and the framework's `terminateCallEffects` /
force-purge paths already filter on `incrementSucceeded !== false`
(ADR-0004's Rule 1). The audit therefore acts primarily as a future
regression gate: any new admission path that forgets to thread the
flag, or any new termination path that forgets the filter, will
surface at scope close as a `lim.A1_counterBackToZero` defect.

## Verification

- `npm run typecheck` — zero `tsc` errors, zero Effect-plugin warnings.
- `npm run test:fake` — **205 files / 1470 passed + 5 skipped** (Slice
  11 baseline preserved).
- `grep -rn "CallLimiterEvent\|CallLimiterParanoidInputViolation\|CallLimiterAuditViolation" src tests` finds `src/call/CallLimiter.contracts.ts`.
- Slice 1 canary still fires:
  `tests/fullcall/canary-signaling-audit.test.ts` passes (the
  malformed-INVITE scenario still surfaces a `SignalingAuditViolation`).
- Existing limiter-specific tests (`limiter-fail-open.test.ts`,
  `forcepurge-skips-decr-on-fail-open.test.ts`,
  `forcepurge-limiter-decrement-bounded.test.ts`,
  `limiter-shared-cross-worker-rejection.test.ts`,
  `apply-route-incr-decr-invariant.test.ts`) all continue to pass.

## Files touched

| File | Change |
|---|---|
| `src/call/CallLimiter.ts` | reduced to Tag + thin static re-exports + service-level types |
| `src/call/CallLimiter.memory.ts` | **new** — in-memory impl with TestClock-friendly TTL |
| `src/call/CallLimiter.redis.ts` | **new** — Redis/Lua adapter |
| `src/call/CallLimiter.contracts.ts` | **new** — typed channel, 2 wrappers, `withAllContracts` |
| `tests/support/stackLayer.ts` | apply `withAllContracts` in both fake (perfMode-gated) and live modes; pass via `limiterLayer` |
| `tests/support/testLayers.ts` | populate `contracts.callLimiter` |
| `docs/plan/effect-layer-wrappers/slice-12.md` | **new** — this file |

## Hand-off to Slice 13 (CallLimiter parity)

The impl split puts `memoryLayer` (in `.memory.ts`) and `redisLayer`
(in `.redis.ts`) in separate files. From the parity-wrapper's
perspective this is a non-event: Slice 13 builds a `parity(blue,
green)` layer the same way as
`PartitionedRelayStorage.contracts.ts`'s `parity`, taking two
`Layer.Layer<CallLimiter>` arguments and zipping their outputs per
method. The split doesn't introduce any divergent method-level
behaviour — both impls satisfy the same service signature, share the
same `LimiterDecision` discriminator, and the only true semantic
difference is timing precision (memory uses `Clock`, Redis uses a
real network + Lua atomicity). Parity coverage should restrict itself
to short scenarios where the timing difference is below the audit's
ledger resolution; the parent plan already notes this.

One caveat: `refresh` in the memory impl is a single in-process
`Effect.sync` while the Redis impl runs a two-step Lua. Both reach
the same end state but the failure modes differ — a parity test that
kills the Redis side mid-Lua will see the memory side already
committed. Slice 13's parity wrapper should `Effect.all` both calls
in parallel (matching `PartitionedRelayStorage.contracts.ts`'s
pattern) and accept that timing-divergent failures stay outside the
parity contract.
