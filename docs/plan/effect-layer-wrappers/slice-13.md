# Slice 13 — CallLimiter parity (memory vs redis)

Parent plan: [review-this-plan-and-noble-goblet.md](../review-this-plan-and-noble-goblet.md)
ADR: [0013-effect-layer-wrappers-and-typed-recorder.md](../../adr/0013-effect-layer-wrappers-and-typed-recorder.md)
Load-bearing invariants: [0004-strong-incr-decr-invariant-for-call-limiter.md](../../adr/0004-strong-incr-decr-invariant-for-call-limiter.md) (counter-back-to-zero AND peer-takeover overshoot semantics)

Extends `CallLimiter.contracts.ts` with the `parity` wrapper (memory vs
redis) per Slice 13 of the parent plan. Parity stays OUTSIDE
`withAllContracts` per D7. A static-method bolt-on
`CallLimiter.parity(blue, green, options?)` mirrors `CallBodyCodec.parity`'s
shape so tests can construct the wrapped Layer without reaching into
the contracts module.

## Deliverables landed

### 1. `parity` wrapper in `CallLimiter.contracts.ts`

Signature:

```ts
export const parity = (
  blue: Layer.Layer<CallLimiter>,
  green: Layer.Layer<CallLimiter>,
  options?: ParityOptions,
): Layer.Layer<CallLimiter, never, Recorder>
```

`options.returnSide` defaults to `"blue"` (memory). Returns one side's
result per method; the other side is run in parallel via
`Effect.all([...], { concurrency: "unbounded" })` to keep wall-clock
timing tight (the Redis impl carries a 150 ms outer budget and serial
execution would otherwise double the per-call timing).

### 2. Per-method comparison semantics

| Method | Compared field(s) | Notes |
|---|---|---|
| `checkAndIncrement` | `decision._tag`; for `Allowed`, also `currentWindow` | Mixed outcome (one ok, one fail) is a parity violation. Both-failed is NOT compared in detail — both sides took the fail-open path and ADR-0004 says no counter follows either way. |
| `decrement` | Outcome (Success / Failure) | Mismatched outcome `_tag` is a violation. |
| `refresh` | `newWindow` (success path) | See carve-out below. |
| `currentWindow` | Numeric value | Both sides observe the same `Clock`, so values must match exactly. |

### 3. `refresh` carve-out (per Slice 12 handoff)

The memory `refresh` is a single `Effect.sync` while the Redis `refresh`
runs a two-step Lua (`INCR current; EXPIRE current; DECR origin`). Both
reach the same end state but their failure modes differ — partial
failure on the Redis side (crashed mid-Lua) would leave a
timing-divergent view the memory side cannot reproduce.

The parity wrapper:

- runs both calls in parallel via `Effect.all`,
- on `Success`/`Success` compares ONLY the final returned
  `newWindow` (both sides observe the same `Clock`, so they must
  agree on the migration target),
- on `Failure`/`Failure` does NOT compare failure shapes (timing-only
  divergence carve-out),
- on mixed outcome (Success/Failure) raises a parity violation.

If a future test ever genuinely needs to assert intermediate-state
equality across a refresh, it should drive both sides past the
migration point with `TestClock` before observing — the parity contract
explicitly does not cover the in-flight migration window.

### 4. Mismatch reporting

On any mismatch the wrapper:

1. Pushes a `signalingAudit`-kind anomaly into a dedicated buffer with
   `check: "lim.parity.<method>"`, `severity: "deferred-fail"`.
2. Registers a projector so `Recorder.snapshot.anomalies` carries
   the entries.
3. `Effect.die`s with `CallLimiterParityViolation` (extends `Error`,
   `_tag: "CallLimiterParityViolation"`).

`Effect.die` (not `Effect.fail`) preserves the limiter service
signature: putting `CallLimiterParityViolation` on the typed error
channel would force every caller of `checkAndIncrement` to widen its
`catchTags` set to an error class that exists only in tests. Same
choice as `PartitionedRelayStorage.parity`.

### 5. Static-method bolt-on (`CallLimiter.parity`)

`src/call/CallLimiter.ts` declares `static parity` on the class with
the matching signature; `CallLimiter.contracts.ts` does an
`Object.assign(CallLimiter, { parity })` at the bottom of the file as a
side-effect import. This mirrors `CallBodyCodec`'s `index.ts` shape and
avoids a load cycle (the Tag file MUST NOT import contracts directly).

Consumers that call `CallLimiter.parity(...)` MUST import the contracts
module first. `testLayers` does this transitively; ad-hoc test files
either pull from `testLayers.contracts.callLimiterParity` or do a
direct `import "src/call/CallLimiter.contracts.js"` for the bolt-on.

### 6. `testLayers.contracts.callLimiterParity`

```ts
contracts: {
  ...,
  callLimiterParity: (memoryImpl, redisImpl, options?) =>
    withCallLimiterContracts(parity(memoryImpl, redisImpl), options),
}
```

Convenience composer that runs `parity` first, then wraps with
`withAllContracts`. Tests that want the full audit + parity stack pull
this single bundle instead of re-deriving the composition order.

### 7. Test wiring — `tests/call/limiter-parity.test.ts`

Two `it.effect` scenarios under `vitest.config.ts` (default fake mode):

- **Admission cycle** — 5 admissions under a generous limit, a
  `currentWindow` read, 3 decrements in the same window, a
  TestClock-driven window advance + `refresh`, one more admission.
  Asserts `Recorder.snapshot.anomalies` contains no `lim.parity.*`
  entries.
- **Rejected parity** — fills to cap, asserts the next call returns
  `Rejected` on BOTH sides without parity violation.

Both run under a stubbed `LimiterRedisClient` whose `eval` callback
simulates the three Lua scripts (`CHECK_AND_INCREMENT`, `REFRESH`,
`DECREMENT`) over an in-memory `Map`. The simulator mirrors the lazy-
expiry behaviour Redis exhibits for our use (sweep on access). State
lives entirely in-process so `TestClock` drives both sides
deterministically.

### 8. Gating decision — fake-only

The parity test runs in the default fake-stack suite. There is NO
`KV_BACKEND=redis` or `TEST_PARITY=1` gating.

Rationale:

- The parity wrapper's job is to detect divergence between the two
  CallLimiter impls. Both impls are real Effect code; the only
  external dependency the Redis impl needs is a `LimiterRedisClient`,
  which `tests/call/limiter-fail-open.test.ts` has already
  established a stubbing pattern for.
- The stub simulates the Lua semantics directly. If a future
  divergence sneaks into the Redis impl's pre/post processing (window
  arithmetic, fail-open handling, Lua argument ordering), the parity
  test catches it — the stub is downstream of all that.
- A `KV_BACKEND=redis` variant remains a possibility (the `kv-backend-parity`
  test already does this for storage). Deferred — Slice 13's
  short-scenario remit doesn't require it.

If a regression ever requires real-Redis confirmation, the right
escalation is to add a `live-stack` parity test under `it.live` gated
by an env var, NOT to relax the fake-stack stub.

### 9. No real divergence caught

The two impls produce identical observable state for the test scenario.
No comparator carve-outs were necessary beyond the documented
`refresh` timing carve-out (which the wrapper accepts by design).

## Files touched

| File | Change |
|---|---|
| `src/call/CallLimiter.ts` | Added `static parity` signature on the Tag class (impl wired by Object.assign in contracts). Imports `Recorder` type-only for the return-type annotation. |
| `src/call/CallLimiter.contracts.ts` | Added `parity` wrapper (~250 LOC), `CallLimiterParityViolation` class, `ParityOptions` interface, Object.assign bolt-on. Updated header comment. Added `renderDecision` helper to keep `JSON.stringify` out of the file (Effect-plugin clean). |
| `tests/support/testLayers.ts` | Added `contracts.callLimiterParity` composer. |
| `tests/call/limiter-parity.test.ts` | **new** — 2 `it.effect` scenarios with simulated-Redis stub. |
| `docs/plan/effect-layer-wrappers/slice-13.md` | **new** — this file. |

## Verification

- `npm run typecheck` — zero `tsc` errors, zero Effect-plugin warnings.
- `npm run test:fake` — **206 files / 1472 passed + 5 skipped**
  (Slice 12 baseline of 1470 + 2 new parity tests).
- Slice 1 canary still fires:
  `tests/fullcall/canary-signaling-audit.test.ts` passes.
- New parity test passes both scenarios.
- `grep -rn "CallLimiterParityViolation" src tests` finds the export
  in `src/call/CallLimiter.contracts.ts`.

## Hand-off to Slice 14

Slice 14's scope is the legacy `CallRecording` deletion + perf
checkpoint 3. Touch points for Slice 14 that became visible during
this slice:

- **No active CallRecording consumers were uncovered by Slice 13.**
  The parity wrapper writes to `Recorder.forTag(CallLimiter)`, the
  same typed channel scopedAudit already uses; no new consumer of the
  legacy `recording.ts` shape was created.
- `CallLimiter.parity`'s static bolt-on uses the same Object.assign
  pattern as `CallBodyCodec.parity` in `src/call/codec/index.ts`.
  Slice 14's renderer rewrite, if it touches the codec barrel, should
  preserve both surfaces.
