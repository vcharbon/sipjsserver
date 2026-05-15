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
 * Safety-net timer delay for `terminating` state. 2× RFC 3261
 * Timer B/F (32 s each) — covers the maximum window for any
 * outstanding BYE / CANCEL transaction to resolve before we force
 * the call's removal.
 */
export const TERMINATING_TIMEOUT_MS = 64_000

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
