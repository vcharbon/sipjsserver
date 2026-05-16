/**
 * Shared timer-list helpers used by both the rule framework
 * (`ActionExecutor`) and the call-state layer (`CallState.update`).
 *
 * Lived in `ActionExecutor.ts` historically; lifted here so the
 * structural safety-net install in `CallState.update` can reuse the
 * same append-or-replace semantics without circular imports.
 */

import type { TimerEntry } from "./CallModel.js"

/**
 * Safety-net timer delay for `terminating` state. Sized so that no
 * inter-peer-activity gap is mistaken for "call is dead": must exceed
 * `keepaliveIntervalSec * 1000 + 60_000` per the AppConfig validator
 * (see ADR-0004). Refreshed on every `CallState.update` while in
 * `terminating`, so the timer effectively fires only when the call
 * has been silent for `TERMINATING_TIMEOUT_MS` from any source.
 *
 * 17 min covers both the production default (KEEPALIVE_INTERVAL_SEC=300
 * → required > 360 s) and the longer test / fake-stack default
 * (`testAppConfigDefaults.keepaliveIntervalSec = 900` → required > 960 s).
 */
export const TERMINATING_TIMEOUT_MS = 1_020_000

/**
 * Replace any existing entry with the same id, then append the new
 * one. Asserts in non-production builds that no two persisted
 * entries share an id — a duplicate slipping in means some upstream
 * code path appended directly and bypassed this helper.
 */
export function replaceTimerById(
  existing: ReadonlyArray<TimerEntry>,
  entry: TimerEntry,
): TimerEntry[] {
  const next = [...existing.filter((t) => t.id !== entry.id), entry]
  if (process.env.NODE_ENV !== "production") {
    const seen = new Set<string>()
    for (const t of next) {
      if (seen.has(t.id)) {
        throw new Error(
          `replaceTimerById invariant violated: duplicate timer id ${t.id} in ` +
            `[${next.map((x) => x.id).join(", ")}] — some call site is bypassing replaceTimerById`,
        )
      }
      seen.add(t.id)
    }
  }
  return next
}
