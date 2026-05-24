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
 * Safety-net timer delay for `terminating` state. Sized to the SIP
 * retransmission absorption window for an outbound BYE / 2xx response:
 * 32 s = Timer H (INVITE server-txn ACK absorption, RFC 3261 §17.2.1)
 * = Timer J (non-INVITE server-txn ACK absorption, §17.2.2). Beyond
 * 32 s no legitimate retransmit can land — the call is either fully
 * torn down or has used its per-leg refresh budget (see
 * `CallState.update` per-leg refresh contract).
 *
 * Historically 17 min — sized to outlast keepalive gaps under the
 * old always-refresh contract where any incoming OPTIONS arrival
 * could mask a stuck-terminating call. The per-leg refresh budget
 * (Fix A1, 2026-05-23) replaces that contract: each leg gets at most
 * one safety-timer refresh, so adversarial in-dialog floods can no
 * longer keep a terminating call alive. With that gate in place the
 * SIP-derived 32 s is the natural upper bound for legitimate
 * teardown completion.
 */
export const TERMINATING_TIMEOUT_MS = 32_000

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
