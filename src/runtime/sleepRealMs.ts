/**
 * `sleepRealMs(ms)` — Effect-wrapped real-wall-clock sleep.
 *
 * Always fires on actual wall-clock via `setTimeout`, regardless of
 * whether the surrounding fiber runs under `TestClock` or the real
 * `Clock`. Use when `Effect.sleep` is the wrong tool:
 *
 *   - Inside a layer-close finalizer. TestClock has no driver during
 *     finalizer execution, so `Effect.sleep("5 millis")` blocks
 *     forever under fake-clock. Wall-clock setTimeout always fires.
 *   - Bounded polls of external state (file presence, RSS targets,
 *     queue depths) where virtual time is meaningless.
 *
 * Cleanup-safe: the returned Effect clears its timeout on interrupt.
 *
 * See `docs/typescript-effect.md` "Wall-clock waits in finalizers"
 * and SURPRISES T14.
 */

import { Effect } from "effect"

export const sleepRealMs = (ms: number): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const id = setTimeout(() => resume(Effect.void), ms)
    return Effect.sync(() => clearTimeout(id))
  })
