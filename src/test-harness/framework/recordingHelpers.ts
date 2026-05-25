/**
 * Recording helpers (ADR-0013 D4) — boilerplate-elimination wrappers for
 * the four constructs that appear in our wrappable layer surfaces:
 *
 *   - `recordSync`            sync pure functions (codec encode/decode)
 *   - `recordEffectCall`      Effect-returning methods; outcome capture
 *   - `recordScopedAcquire`   `Effect<X, E, Scope>` resource acquire
 *   - `recordStreamLifecycle` `Stream<X>` start/item/end
 *
 * Each helper takes a `TaggedChannel<E>` handle (from `Recorder.forTag`)
 * plus event builders + the wrapped inner. The helper attaches no
 * routing decisions — it just calls `channel.record(event)` for each
 * lifecycle point. `seq` + `atMs` stamping happens inside the channel.
 *
 * Excluded by convention (see SKILL.md):
 *   - sync getters (`inFlight`, `queueDepth`, …) — too noisy
 *   - higher-order methods (`withConnection(fn)`) — explicit-wrap, no helper
 *   - Hub/PubSub — explicit-wrap, no helper
 */

import { Cause, Effect, Scope, Stream } from "effect"
import type { TaggedChannel } from "./report-recorder/types.js"

// ---------------------------------------------------------------------------
// recordSync
// ---------------------------------------------------------------------------

/**
 * Wrap a sync pure function so every call records one event built from
 * `(input, output)`. Throws propagate untouched — recording happens
 * BEFORE any property/paranoid wrapper would throw, so a thrown
 * violation still leaves the call captured for later analysis.
 *
 * Note: `buildEvent` runs AFTER `fn(a)`. If `fn` throws, no event is
 * recorded. For codecs this matches the convention used by the existing
 * `propertyTest` wrapper.
 */
export const recordSync =
  <E, A, B>(
    channel: TaggedChannel<E>,
    buildEvent: (input: A, output: B) => E,
    fn: (a: A) => B,
  ): ((a: A) => B) =>
  (a: A): B => {
    const out = fn(a)
    // Channel.record is an Effect; fire-and-forget via runSync is the
    // only option from a sync function. Acceptable because the channel
    // stores into a synchronous in-memory array.
    Effect.runSync(channel.record(buildEvent(a, out)))
    return out
  }

// ---------------------------------------------------------------------------
// recordEffectCall
// ---------------------------------------------------------------------------

/**
 * Outcome of an Effect call, surfaced to `buildAfter`.
 */
export type RecordEffectOutcome<A, EE> =
  | { readonly kind: "ok"; readonly value: A }
  | { readonly kind: "fail"; readonly error: EE }
  | { readonly kind: "interrupt" }

/**
 * Wrap an Effect so a `before` event fires on entry and an `after`
 * event fires once the inner exits (ok / typed-fail / interrupt). The
 * outcome is captured via `Effect.exit` so even failures and interrupts
 * record cleanly; the original Cause is re-raised unchanged.
 *
 * Return `null` from `buildAfter` to skip the after-event for a given
 * outcome (e.g. record only failures).
 */
export const recordEffectCall = <E, R, A, EE>(
  channel: TaggedChannel<E>,
  buildBefore: () => E,
  buildAfter: (outcome: RecordEffectOutcome<A, EE>) => E | null,
  inner: Effect.Effect<A, EE, R>,
): Effect.Effect<A, EE, R> =>
  Effect.gen(function* () {
    yield* channel.record(buildBefore())
    const exit = yield* Effect.exit(inner)
    if (exit._tag === "Success") {
      const after = buildAfter({ kind: "ok", value: exit.value })
      if (after !== null) yield* channel.record(after)
      return exit.value
    }
    // Failure path: distinguish typed fail vs interrupt vs defect. We
    // surface typed fails and interrupts to buildAfter; defects fall
    // through to `Effect.failCause` unrecorded (callers can layer a
    // defect-capture rule if needed).
    const cause = exit.cause
    if (Cause.hasInterrupts(cause)) {
      const after = buildAfter({ kind: "interrupt" })
      if (after !== null) yield* channel.record(after)
    } else {
      const failOpt = Cause.findErrorOption(cause)
      if (failOpt._tag === "Some") {
        const after = buildAfter({ kind: "fail", error: failOpt.value })
        if (after !== null) yield* channel.record(after)
      }
    }
    return yield* Effect.failCause(cause)
  })

/**
 * Simpler variant of `recordEffectCall`: collapses interrupt and defects
 * into a single `"fail"` outcome and exposes only the success value to
 * `buildAfter`. Use when the caller does not need to distinguish
 * interrupt or capture the typed error in the recorded event — most
 * cache / storage / limiter recorders fall into this bucket.
 *
 * Behaviour: emit `beforeEvent` on entry, run `inner`, emit
 * `buildAfter("ok", value)` on Success or `buildAfter("fail", null)` on
 * any non-Success Exit. The original `Cause` is re-raised unchanged.
 */
export const recordEffectCallSimple = <E, R, A, EE>(
  channel: TaggedChannel<E>,
  beforeEvent: E,
  buildAfter: (outcome: "ok" | "fail", value: A | null) => E,
  inner: Effect.Effect<A, EE, R>,
): Effect.Effect<A, EE, R> =>
  Effect.gen(function* () {
    yield* channel.record(beforeEvent)
    const exit = yield* Effect.exit(inner)
    if (exit._tag === "Success") {
      yield* channel.record(buildAfter("ok", exit.value))
      return exit.value
    }
    yield* channel.record(buildAfter("fail", null))
    return yield* Effect.failCause(exit.cause)
  })

// ---------------------------------------------------------------------------
// recordScopedAcquire
// ---------------------------------------------------------------------------

/**
 * Wrap an acquire Effect so an `acquire` event fires on success and a
 * `release` event fires via `Effect.addFinalizer` when the surrounding
 * Scope closes. Used by `bindUdp`-style APIs that return a resource
 * tied to the caller's scope.
 *
 * `buildAcquire` receives the acquired value; `buildRelease` runs at
 * scope close and receives the same value.
 */
export const recordScopedAcquire = <E, A, R>(
  channel: TaggedChannel<E>,
  buildAcquire: (acquired: A) => E,
  buildRelease: (acquired: A) => E,
  acquire: Effect.Effect<A, never, R>,
): Effect.Effect<A, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const acquired = yield* acquire
    yield* channel.record(buildAcquire(acquired))
    yield* Effect.addFinalizer(() => channel.record(buildRelease(acquired)))
    return acquired
  })

// ---------------------------------------------------------------------------
// recordStreamLifecycle
// ---------------------------------------------------------------------------

export type StreamEndReason = "ended"

/**
 * Wrap a `Stream<X>` so `start` fires on the first emitted element,
 * `item` fires per element, and `end` fires once when the stream is
 * torn down. Built on `Stream.tap` + `Stream.ensuring`.
 *
 * Note: distinguishing natural completion vs interruption requires a
 * stream-completion hook the public API doesn't expose; the helper
 * reports a single `"ended"` reason for either case. Wrappers that
 * care about that distinction should compose their own `Stream.tap`
 * + scope-aware finalizer.
 */
export const recordStreamLifecycle = <E, X, R>(
  channel: TaggedChannel<E>,
  buildStart: () => E,
  buildItem: (x: X) => E,
  buildEnd: (reason: StreamEndReason) => E,
  stream: Stream.Stream<X, never, R>,
): Stream.Stream<X, never, R> => {
  const started = { fired: false }
  return stream.pipe(
    Stream.tap((x) =>
      Effect.gen(function* () {
        if (!started.fired) {
          started.fired = true
          yield* channel.record(buildStart())
        }
        yield* channel.record(buildItem(x))
      }),
    ),
    Stream.ensuring(channel.record(buildEnd("ended"))),
  )
}
