---
name: effect-layer-test
description: Use every time you design new Effect Layer.
version: 1.2.0
---

When designing a new Effect Layer, list every invariant the service must respect and express each invariant as a **wrapper layer**. A wrapper takes the implementation Layer as an explicit argument and returns a Layer of the **same Tag** — consumers cannot tell whether the bare impl or a stack of wrappers is providing the service. Composition is plain function nesting:

```ts
MyService.propertyTest(
  MyService.paranoidInputs(
    MyService.scopedAudit(RealImplLayer, { /* opts */ })
  )
)
```

The wrappers live in the same module as the implementation (separate file, e.g. `MyService.contracts.ts`, so they don't grow the impl).

For end-to-end context — including the rollout plan, the typed Recorder, and the three-tier severity model — see ADR-0013 ([docs/adr/0013-effect-layer-wrappers-and-typed-recorder.md](../../../docs/adr/0013-effect-layer-wrappers-and-typed-recorder.md)) and the initiative plan ([docs/plan/review-this-plan-and-noble-goblet.md](../../../docs/plan/review-this-plan-and-noble-goblet.md)).

## The four wrappers (canonical names)

| Wrapper | Purpose | Signature shape |
|---|---|---|
| `propertyTest(wrapped, options?)` | Asserts the layer's CONTRACT properties on every call. Each property is a `(input, output) → ok | reason` function and is checked on every method call. | `(Layer<S, never, R>, opts?) => Layer<S, never, R>` |
| `paranoidInputs(wrapped)` | Asserts CALLER-side preconditions on every input (what the caller must respect). | `(Layer<S, never, R>) => Layer<S, never, R>` |
| `parity(blue, green, options?)` | Wraps two implementations. Runs both, asserts deep-equal outcomes, returns one side's bytes/result. Use when the service is deterministic and you have ≥ 2 impls. | `(Layer<S, never, R1>, Layer<S, never, R2>, opts?) => Layer<S, never, R1 | R2 | Scope>` |
| `scopedAudit(wrapped, options?)` | `Layer.scoped` that records cross-call state and verifies invariants on scope close. Default checks are extensible via an `extra` hook. | `(Layer<S, never, R>, opts?) => Layer<S, never, R | Scope>` |

**No fifth wrapper.** Per-sub-scope finalizer logic (e.g. SignalingNetwork's per-`bindUdp` cleanup verification) is an **internal** detail of that layer's `scopedAudit`. The canonical, public failure surface stays the layer-close finalizer (`Data.TaggedError`). If you find yourself reaching for a fifth wrapper, the right move is almost always richer rules inside `scopedAudit`.

## Hard rules

### Rule 1 — Wrappers MUST NOT change the Tag or the service shape.

A wrapper returns `Layer<S, never, ...>` for the same `S` Tag with the same method surface. Consumers of `S` are oblivious to wrapping. **Do not** add methods, do not rename methods, do not return a richer service shape from a wrapper.

### Rule 2 — Layer CONSTRUCTION never fails (`E = never`).

Wrappers add no construction-time failure path. The implementation Layer's own `E` is preserved unchanged (and is typically also `never` for self-contained services). Type the wrapper as `Layer<S, never, R>` and enforce it at the type level.

### Rule 3 — Runtime contract violations surface where the service surfaces.

If the service interface is **synchronous pure functions** (`(input) => output` without `Effect`), runtime violations are **thrown synchronous exceptions**. Use plain `Error` subclasses with a `_tag` field for caller-side dispatch:

```ts
export class PropertyViolation extends Error {
  readonly _tag = "MyServicePropertyViolation"
  constructor(readonly propertyId: string, readonly detail: string) {
    super(`${propertyId}: ${detail}`)
  }
}
```

If the service interface returns `Effect`, runtime violations surface as Effect failures via `Data.TaggedError`. Pick the form that matches the service.

The only wrapper that ALWAYS uses Effect failures regardless of service shape is `scopedAudit` — its verification runs on scope close, which is always an Effect context. Use `Data.TaggedError` for `AuditViolation`.

### Rule 4 — Composition is positional function application.

Each wrapper takes its inner Layer as an **explicit argument**. No magic, no Tag merging. `propertyTest(paranoidInputs(impl))` is the natural form; both standalone functions and `MyService.propertyTest(MyService.paranoidInputs(impl))` static-method sugar work identically.

### Rule 5 — Implementation lives in a sibling file, surfaces from the Tag.

```
src/<area>/MyService.ts          # Context.Tag + selectLayer + static-method sugar
src/<area>/MyService.<impl>.ts   # one file per implementation
src/<area>/MyService.contracts.ts  # the 4 wrappers + supporting types
```

The Tag class exposes the wrappers as static methods that thin-forward to `contracts.ts`. Consumers import only from `MyService.ts`.

## Canonical composition: `withCanonicalContracts` + per-Tag forwarder

The composition order matters and is fixed: **`propertyTest(paranoidInputs(scopedAudit(impl)))`**. Centralised in [src/test-harness/framework/effectLayerTest.ts](../../../src/test-harness/framework/effectLayerTest.ts):

```ts
import { withCanonicalContracts } from "../../src/test-harness/framework/effectLayerTest.js"

const wrapped = withCanonicalContracts(MyService, RealImplLayer, {
  propertyTest:   { wrap: MyService.propertyTest,   opts: { /* ... */ } },
  paranoidInputs: { wrap: MyService.paranoidInputs, opts: { /* ... */ } },
  scopedAudit:    { wrap: MyService.scopedAudit,    opts: { /* ... */ } },
})
```

Each Tag exposes a thin **`Tag.withAllContracts(options)`** forwarder so callers don't repeat the wrap references:

```ts
class MyService extends ServiceMap.Service<MyService, MyServiceApi>()("MyService") {
  static readonly propertyTest = propertyTest
  static readonly paranoidInputs = paranoidInputs
  static readonly scopedAudit = scopedAudit

  static readonly withAllContracts = (
    impl: Layer.Layer<MyService>,
    options: { propertyTest?: P; paranoidInputs?: PI; scopedAudit?: SA },
  ): Layer.Layer<MyService> =>
    withCanonicalContracts(MyService, impl, {
      propertyTest:   options.propertyTest   !== undefined ? { wrap: propertyTest,   opts: options.propertyTest   } : undefined,
      paranoidInputs: options.paranoidInputs !== undefined ? { wrap: paranoidInputs, opts: options.paranoidInputs } : undefined,
      scopedAudit:    options.scopedAudit    !== undefined ? { wrap: scopedAudit,    opts: options.scopedAudit    } : undefined,
    })
}
```

`parity` is **not** in `withCanonicalContracts`. When you need two implementations compared, build the parity layer first and pass it as `impl`.

## RunContext + three-tier severity

`RunContext` (Service Tag in [src/test-harness/framework/RunContext.ts](../../../src/test-harness/framework/RunContext.ts)) tells each rule how loudly to fail:

```ts
type RunContextValue =
  | { kind: "real-run" }
  | { kind: "test-with-recorder" }
  | { kind: "unit-test-of-layer", tag: ServiceMap.Key<any, any> }
```

| Context | Default severity | Notes |
|---|---|---|
| `real-run` | wrappers off | Production. No rule fires. |
| `test-with-recorder` | `deferred-fail` for layer-scope invariants; `fatal` for hot-path contract violations; `advisory` for advisory checks | The normal fake-stack test mode. Requires `Recorder` in scope (startup assertion). |
| `unit-test-of-layer { tag }` | rules targeting `tag` promoted to `fatal`; others stay `advisory` | Use when isolating a single wrapped layer under property-based tests. |

Wrappers read `RunContext` via `Effect.services()` + `ServiceMap.getOption`; if missing, fall back to `real-run` (safety default, never relied on in tests).

## Recording helpers + sync-getter exclusion

Helpers in [src/test-harness/framework/recordingHelpers.ts](../../../src/test-harness/framework/recordingHelpers.ts) eliminate the boilerplate around `Recorder.forTag(...).record(...)` for the four method shapes that actually appear:

| Helper | Wraps | Records |
|---|---|---|
| `recordSync(channel, buildEvent, fn)` | sync pure `(a: A) => B` | one event per call, after `fn` succeeds |
| `recordEffectCall(channel, buildBefore, buildAfter, inner)` | `Effect<A, EE, R>` | before-event on entry; after-event with `{ ok, fail, interrupt }` outcome on exit. `buildAfter` may return `null` to skip |
| `recordScopedAcquire(channel, buildAcquire, buildRelease, acquire)` | `Effect<A, never, R \| Scope>` | `acquire` event on success + `release` via `Effect.addFinalizer` |
| `recordStreamLifecycle(channel, buildStart, buildItem, buildEnd, stream)` | `Stream<X, never, R>` | start (first pull), per-item, end (completion or interruption) via `Stream.tap` + `Stream.ensuring` |

The channel stamps `seq` (from the shared `EventSequencer`) and `atMs` (from `Clock.currentTimeMillis`) on every record. The wrapper passes ONLY the layer-specific payload — helpers attach the bookkeeping.

**Sync-getter exclusion convention.** Methods like `inFlight`, `queueDepth`, `transitDelayMs` are **NOT** wrapped via `recordSync`. Recording every read floods the log without adding signal. Document the exclusion at the wrapper definition site.

**Higher-order methods + Hub/PubSub** are explicit-wrap, no helper. Pick the relevant pieces by hand and document why a helper doesn't fit.

## What to include in EVERY layer design

When you design a new Layer, the design doc / ADR must list:

1. **Exhaustive properties** — every invariant the service must respect. This list is the layer's contract. Each property gets a stable ID (`P1_…`, `P2_…`, …) and a one-line description of what it rules out.
2. **Paranoid input checks** — what callers must respect. Cost note for each (always-on vs env-gated).
3. **A vs B parity** — justified or explicitly skipped. Skip only when the service is non-deterministic (e.g., random-id generator) or when only one impl will ever exist (e.g., the embedded SQLite layer). Otherwise include.
4. **Scoped audit** — justified or explicitly skipped. Skip only when no cross-call invariant exists (every method call is fully independent). Include when:
   - The implementation has internal state that spans calls (encoder pools, connection pools, learned shapes).
   - Resource cleanup or TTL-bound state needs end-of-scope verification.
   - A statistical property (hit rate, p99 latency budget) is part of the contract.

## Failure-shape decision matrix

| Wrapper | Service is sync pure | Service returns Effect | scope-close finalizer? |
|---|---|---|---|
| `propertyTest` | `throw new Error subclass with _tag` | `Effect.fail(new Data.TaggedError)` | n/a |
| `paranoidInputs` | `throw` (programmer error — defect equivalent) | `Effect.die` (programmer error) | n/a |
| `parity` | `throw` on mismatch | `Effect.fail` on mismatch | n/a |
| `scopedAudit` | n/a (recording is sync) | n/a (recording is sync) | **always** `Effect.fail(AuditViolation)` |

## Example template (filled in for `CallBodyCodec` in this repo)

See [src/call/codec/contracts.ts](../../../src/call/codec/contracts.ts) for the worked example: 14 properties, 5 paranoid checks, parity justified for codec migration, scopedAudit justified for records-mode hit-rate + buffer-aliasing detection.
