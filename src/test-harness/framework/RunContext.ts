/**
 * RunContext — three-tier severity driver (ADR-0013 D5).
 *
 * Each contract wrapper consults RunContext to decide how loudly a rule
 * finding should surface:
 *
 *   - `real-run`              → wrappers are off, rules don't fire.
 *   - `test-with-recorder`    → all rules fire; severity comes from each
 *                               rule's per-context table.
 *   - `unit-test-of-layer`    → rules targeting `tag` get promoted to
 *                               `fatal`; others stay `advisory`.
 *
 * When no RunContext layer is provided, layers fall back to `real-run`
 * as a safety default — production must not depend on test plumbing.
 * Do NOT rely on the fallback in tests; always provide explicitly.
 */

import { Effect, Layer, ServiceMap } from "effect"

export type RunContextValue =
  | { readonly kind: "real-run" }
  | { readonly kind: "test-with-recorder" }
  | {
      readonly kind: "unit-test-of-layer"
      readonly tag: ServiceMap.Key<any, any>
    }

export class RunContext extends ServiceMap.Service<
  RunContext,
  RunContextValue
>()("@sipjsserver/test-harness/RunContext") {
  static readonly realRun: Layer.Layer<RunContext> = Layer.succeed(
    RunContext,
    { kind: "real-run" } as const,
  )

  static readonly testWithRecorder: Layer.Layer<RunContext> = Layer.succeed(
    RunContext,
    { kind: "test-with-recorder" } as const,
  )

  static readonly unitTestOf = <S, A>(
    tag: ServiceMap.Key<S, A>,
  ): Layer.Layer<RunContext> =>
    Layer.succeed(RunContext, { kind: "unit-test-of-layer", tag })

  /** Safety default for layers that read RunContext without a provider. */
  static readonly orRealRun: Effect.Effect<RunContextValue> = Effect.gen(
    function* () {
      const services = yield* Effect.services<never>()
      const opt = ServiceMap.getOption(services, RunContext)
      return opt._tag === "Some" ? opt.value : ({ kind: "real-run" } as const)
    },
  )
}
