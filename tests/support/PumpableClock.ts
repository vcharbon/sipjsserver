/**
 * PumpableClock — a TestClock with introspection.
 *
 * Same Latch-based sleep semantics as upstream `TestClock` (effect v4
 * beta.43, see node_modules/effect/src/testing/TestClock.ts), but exposes
 * the pending-sleep queue and a fired-deadline counter so tests can drive
 * a generic auto-pump (`tests/support/pumpAll.ts`) without hand-tuned
 * `adjust` magic numbers.
 *
 * Effect v4 dropped the `sleeps` / `save` / `adjustWith` accessors that v3
 * exposed on the public `TestClock` interface. Reimplementing here is the
 * only way to reach the data without monkey-patching effect itself; the
 * implementation is small (~120 LOC) and tracks upstream's `make`
 * faithfully.
 *
 * The layer registers under TWO service tags:
 *   - `Clock.Clock`: overrides `@effect/vitest`'s default `TestClock.layer()`
 *     so production code's `Effect.sleep` / `Clock.currentTimeMillis` flow
 *     through us.
 *   - `PumpableClock`: the rich query surface used by `pumpAll` and tests.
 *
 * The `liveStack` is untouched — real-clock tests use the real Clock.
 */

import {
  Clock,
  Effect,
  Layer,
  Latch,
  MutableHashMap,
  Order,
  Semaphore,
  ServiceMap,
} from "effect"
import * as Arr from "effect/Array"
import * as Duration from "effect/Duration"
import { TestPace } from "../../src/observability/TestPace.js"

interface SleepEntry {
  readonly sequence: number
  readonly timestamp: number
  readonly durationMillis: number
  readonly latch: Latch.Latch
}

// Mirror upstream `TestClock.ts:185` ordering: descending by timestamp so the
// tail of the array has the smallest deadline (cheap pop()).
const SleepOrder = Order.flip(
  Order.Struct({
    timestamp: Order.Number,
    sequence: Order.Number,
  })
)

export interface PumpableClockShape {
  readonly currentTimeMillisUnsafe: () => number
  readonly currentTimeNanosUnsafe: () => bigint
  readonly currentTimeMillis: Effect.Effect<number>
  readonly currentTimeNanos: Effect.Effect<bigint>
  readonly sleep: (duration: Duration.Duration) => Effect.Effect<void>
  readonly adjust: (duration: Duration.Input) => Effect.Effect<void>
  readonly setTime: (timestamp: number) => Effect.Effect<void>
  readonly withLive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** Snapshot of pending deadlines, ascending. */
  readonly pendingSleeps: () => ReadonlyArray<number>
  /** Total number of latches opened over this clock's lifetime. */
  readonly sleepsFiredCount: () => number
  /**
   * Per-duration fire counts — keyed by the millis arg passed to `sleep`,
   * not the absolute deadline. A self-rearming `sleep(30ms)` produces
   * many entries with the SAME duration; a one-shot fan-out of staggered
   * `sleep`s produces unique durations. This is the right signal for
   * periodic-timer detection.
   */
  readonly firedHistogram: () => ReadonlyArray<{ readonly durationMillis: number; readonly count: number }>

  /**
   * Async-work registry. Any async producer whose work is invisible to
   * the standard `pendingSleeps + network.inFlight` quiescence checks
   * (notably `PerCallDispatcher` workers parked on `Queue.take`) bumps
   * `beginAsyncWork` on submit and `endAsyncWork` on completion.
   * `adjust` drains the counter to zero after each latch fire so the
   * test fiber doesn't race ahead of pending async work.
   *
   * SUT-scoped: a single counter for every worker in a multi-worker
   * stack, because PumpableClock is provided once at the SUT layer.
   */
  readonly beginAsyncWork: () => void
  readonly endAsyncWork: () => void
  readonly asyncWorkPending: () => number
}

export class PumpableClock extends ServiceMap.Service<PumpableClock, PumpableClockShape>()(
  "@sipjsserver/test/PumpableClock",
) {}

// A pinned live Clock impl. Cannot use `Clock.clockWith(Effect.succeed)`
// here — at layer-build time the env's Clock is whatever @effect/vitest
// already wired (its default `TestClock.layer()`), so capturing it as
// "live" would make `withLive(Effect.sleep(...))` re-enter the virtual
// clock instead of waiting on real time. This impl mirrors the upstream
// `ClockImpl` (node_modules/effect/src/internal/effect.ts:5608) but is
// allocated explicitly so it can never be shadowed.
const liveClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => Date.now(),
  currentTimeMillis: Effect.sync(() => Date.now()),
  currentTimeNanosUnsafe: () => BigInt(Date.now()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(Date.now()) * 1_000_000n),
  sleep: (duration: Duration.Duration) => {
    const millis = Duration.toMillis(duration)
    if (millis <= 0) return Effect.yieldNow
    return Effect.callback<void>((resume) => {
      const handle = setTimeout(() => resume(Effect.void), millis)
      return Effect.sync(() => clearTimeout(handle))
    })
  },
}

const buildImpl = Effect.gen(function* () {
  let sequence = 0
  const sleeps: Array<SleepEntry> = []
  const runSemaphore = yield* Semaphore.make(1)
  const histogram = MutableHashMap.empty<number, number>()
  let sleepsFired = 0
  let currentTimestamp = new Date(0).getTime()
  let asyncWorkCounter = 0

  const beginAsyncWork = (): void => {
    asyncWorkCounter++
  }
  const endAsyncWork = (): void => {
    asyncWorkCounter--
  }
  const asyncWorkPending = (): number => asyncWorkCounter

  const currentTimeMillisUnsafe = () => currentTimestamp
  const currentTimeNanosUnsafe = () => BigInt(currentTimestamp * 1_000_000)
  const currentTimeMillis = Effect.sync(currentTimeMillisUnsafe)
  const currentTimeNanos = Effect.sync(currentTimeNanosUnsafe)

  const withLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Clock.Clock, liveClock)

  const sleep = (duration: Duration.Duration): Effect.Effect<void> =>
    Effect.suspend(() => {
      const millis = Duration.toMillis(duration)
      const end = currentTimestamp + millis
      if (end <= currentTimestamp) return Effect.void
      const latch = Latch.makeUnsafe()
      sleeps.push({ sequence: sequence++, timestamp: end, durationMillis: millis, latch })
      sleeps.sort(SleepOrder)
      return latch.await
    })

  // Run one step. `step` returns the new endTimestamp; we drain every sleep
  // whose deadline is <= endTimestamp, in order, opening latches and yielding
  // between each so the resumed fiber gets a chance to enqueue follow-up
  // sleeps before we decide we're done.
  //
  // ADR-0004 — drain dispatcher pending work after each latch fire. The
  // PerCallDispatcher's worker fibers parked on `Queue.take` are invisible
  // to the latch queue, so without this an awakened fiber can be racing
  // a worker fiber and beat it to a downstream assertion (concretely:
  // 100ms pause expires, test fiber blasts through assertions before
  // the worker body completes its DECR). `pendingWork()` counts events
  // offered-but-not-yet-body-completed; we keep yielding until it
  // drains. Resolved via `Effect.serviceOption` so test stacks that
  // omit the dispatcher (cache-only fixtures) still build.
  const run = (step: (currentTimestamp: number) => number): Effect.Effect<void> =>
    Effect.gen(function* () {
      // ADR-0004 — drain async-work registry after each latch fire. The
      // PerCallDispatcher's worker fibers parked on `Queue.take` are
      // invisible to the latch queue, so without this an awakened
      // fiber can race a worker fiber and beat it to a downstream
      // assertion (concrete failure mode: 100ms pause expires, test
      // fiber blasts through to `expectLimiterCount` before the
      // worker body's DECR has run). The counter is shared across all
      // registered producers (multi-worker SUTs included) because
      // PumpableClock is provided once at SUT scope.
      const drainAsyncWork = Effect.gen(function* () {
        // Bounded — a healthy body settles in a few scheduler hops. The
        // cap stops a stuck handler from looping forever; the test
        // assertion that follows will observe the stuck state and fail
        // with a useful message.
        for (let i = 0; i < 32; i++) {
          if (asyncWorkCounter === 0) return
          yield* Effect.yieldNow
        }
      })

      yield* Effect.yieldNow
      const endTimestamp = step(currentTimestamp)
      while (Arr.isArrayNonEmpty(sleeps)) {
        if (Arr.lastNonEmpty(sleeps).timestamp > endTimestamp) break
        const entry = sleeps.pop()!
        currentTimestamp = entry.timestamp
        sleepsFired++
        const prev = MutableHashMap.get(histogram, entry.durationMillis)
        MutableHashMap.set(
          histogram,
          entry.durationMillis,
          (prev._tag === "Some" ? prev.value : 0) + 1,
        )
        entry.latch.openUnsafe()
        yield* Effect.yieldNow
        yield* drainAsyncWork
      }
      currentTimestamp = endTimestamp
      // Tail drain — after the last latch fires, any final async work
      // (worker bodies, etc.) needs to complete before adjust returns.
      yield* drainAsyncWork
    }).pipe(runSemaphore.withPermits(1))

  const adjust = (duration: Duration.Input) => {
    const millis = Duration.toMillis(Duration.fromInputUnsafe(duration))
    return run((timestamp) => timestamp + millis)
  }

  const setTime = (timestamp: number) => run(() => timestamp)

  const pendingSleeps = (): ReadonlyArray<number> => {
    const out = sleeps.map((s) => s.timestamp)
    out.sort((a, b) => a - b)
    return out
  }

  const sleepsFiredCount = () => sleepsFired

  const firedHistogram = (): ReadonlyArray<{ readonly durationMillis: number; readonly count: number }> => {
    const out: Array<{ durationMillis: number; count: number }> = []
    for (const [durationMillis, count] of histogram) {
      out.push({ durationMillis, count })
    }
    out.sort((a, b) => a.durationMillis - b.durationMillis)
    return out
  }

  const impl: PumpableClockShape = {
    currentTimeMillisUnsafe,
    currentTimeNanosUnsafe,
    currentTimeMillis,
    currentTimeNanos,
    sleep,
    adjust,
    setTime,
    withLive,
    pendingSleeps,
    sleepsFiredCount,
    firedHistogram,
    beginAsyncWork,
    endAsyncWork,
    asyncWorkPending,
  }
  return impl
})

/**
 * Layer providing both `Clock.Clock` (overrides the default TestClock that
 * `@effect/vitest` injects via `withTestEnv`) and `PumpableClock` (the
 * introspection surface used by `pumpAll`).
 *
 * Wire this in `tests/support/fakeStack.ts` so every fake-stack scenario
 * gets it. Real-clock tests must NOT pull this layer in.
 */
export const PumpableClockLayer: Layer.Layer<PumpableClock | TestPace> = Layer.effectServices(
  Effect.gen(function* () {
    const impl = yield* buildImpl
    // The Clock service we register also has to satisfy the upstream
    // TestClock interface so existing call sites that do `TestClock.adjust`
    // / `TestClock.setTime` keep working — they reach the service via
    // `testClockWith` (which is `fiber.getRef(Clock.Clock) as TestClock`).
    const clockService = {
      currentTimeMillisUnsafe: impl.currentTimeMillisUnsafe,
      currentTimeNanosUnsafe: impl.currentTimeNanosUnsafe,
      currentTimeMillis: impl.currentTimeMillis,
      currentTimeNanos: impl.currentTimeNanos,
      sleep: impl.sleep,
      adjust: impl.adjust,
      setTime: impl.setTime,
      withLive: impl.withLive,
    } as Clock.Clock
    // TestPace service implementation — shares the same async-work
    // counter as PumpableClock.adjust, so producers (PerCallDispatcher)
    // can register their parked async work and the clock's drain loop
    // sees it. Single shared SUT-scoped instance covers all workers.
    const testPaceService = {
      beginWork: impl.beginAsyncWork,
      endWork: impl.endAsyncWork,
      pendingWork: impl.asyncWorkPending,
    }
    return ServiceMap.empty().pipe(
      ServiceMap.add(PumpableClock, impl),
      ServiceMap.add(Clock.Clock, clockService),
      ServiceMap.add(TestPace, testPaceService),
    )
  }),
)
