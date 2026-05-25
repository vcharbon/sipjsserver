/**
 * `lazyEffect(() => Tag, () => Effect)` — defers `Layer.effect(tag, ...)`
 * past module load.
 *
 * Equivalent to `Layer.suspend(() => Layer.effect(tagThunk(), build()))`.
 * The extra indirection matters when `Tag` is a class defined in a
 * sibling file and the impl module evaluates before the class statics
 * are initialized — without `Layer.suspend`, `Layer.effect(Tag, ...)`
 * resolves to `undefined` at module-eval time and throws
 * `Cannot read properties of undefined (reading 'key')` at the first
 * `Layer.build`.
 *
 * Both arguments are thunks because JavaScript evaluates function
 * arguments eagerly. Passing `Tag` directly (instead of `() => Tag`)
 * would capture whatever value `Tag` had at the lazyEffect call site
 * — which is `undefined` exactly in the TDZ case this helper exists
 * to dodge. The original `Layer.suspend(() => Layer.effect(Tag, ...))`
 * idiom works because the inner lambda re-resolves `Tag` from the
 * closure when it runs (at `Layer.build` time, post-init).
 *
 * Use whenever a `Layer.effect(Tag, ...)` is exported from a file other
 * than the one defining `Tag`. The named helper makes the intent
 * explicit at the call site.
 *
 * See `docs/todos/EFFECT-LAYER-WRAPPERS-SURPRISES.md` T1.
 */

import { Effect, Layer, type Scope, type ServiceMap } from "effect"

export const lazyEffect = <I, S, E, R>(
  tagThunk: () => ServiceMap.Key<I, S>,
  build: () => Effect.Effect<S, E, R>,
): Layer.Layer<I, E, Exclude<R, Scope.Scope>> =>
  Layer.suspend(() => Layer.effect(tagThunk(), build()))
