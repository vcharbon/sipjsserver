---
name: effect-layer-test
description: Use every time you design new Effect Layer.
version: 1.1.0
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

## The four wrappers (canonical names)

| Wrapper | Purpose | Signature shape |
|---|---|---|
| `propertyTest(wrapped, options?)` | Asserts the layer's CONTRACT properties on every call. Each property is a `(input, output) → ok | reason` function and is checked on every method call. | `(Layer<S, never, R>, opts?) => Layer<S, never, R>` |
| `paranoidInputs(wrapped)` | Asserts CALLER-side preconditions on every input (what the caller must respect). | `(Layer<S, never, R>) => Layer<S, never, R>` |
| `parity(blue, green, options?)` | Wraps two implementations. Runs both, asserts deep-equal outcomes, returns one side's bytes/result. Use when the service is deterministic and you have ≥ 2 impls. | `(Layer<S, never, R1>, Layer<S, never, R2>, opts?) => Layer<S, never, R1 | R2 | Scope>` |
| `scopedAudit(wrapped, options?)` | `Layer.scoped` that records cross-call state and verifies invariants on scope close. Default checks are extensible via an `extra` hook. | `(Layer<S, never, R>, opts?) => Layer<S, never, R | Scope>` |

These names supersede the earlier draft (`propertyBasedTesting` / `paranoidLayer` / `comparatorLayer` / `recordingLayer`). The new names are tighter and disambiguate paranoid-INPUTS (preconditions on callers) from propertyTest (postconditions on the service).

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

See [`docs/plan/to-refine-the-plan-soft-map.md`](../../docs/plan/to-refine-the-plan-soft-map.md) sections D8.1–D8.7 for a worked example: 14 properties, 5 paranoid checks, parity justified for codec migration, scopedAudit justified for records-mode hit-rate + buffer-aliasing detection.
