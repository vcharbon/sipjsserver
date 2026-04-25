/**
 * cross-call: limiter-concurrency — verify that no call_limiter id
 * was concurrently held by more calls than its declared limit.
 *
 * Source of truth: every call's outbound A-leg INVITE may carry an
 * `X-Api-Call` JSON header with `call_limiter: [{ id, limit }, ...]`.
 * A call "holds" a slot from when its A-leg sees a 2xx for the INVITE
 * (slot occupied) until the call ends — defined as the last recorded
 * message in the recording.
 *
 * For each limiter id with declared limit N, we form intervals from
 * (firstAlice2xxMs → lastEntryMs) and assert that no point on the
 * timeline is covered by more than N intervals.
 *
 * If a call's INVITE is rejected (no 2xx ever observed), it never
 * holds the slot and is excluded.
 */

import type { CrossCallRule, RuleViolation } from "../types.js"
import type { CallRecording, RecordedMessage } from "../../recording.js"

interface Hold {
  callId: string
  start: number
  end: number
}

interface LimiterDecl {
  id: string
  limit: number
}

function parseLimiterDecls(raw: string): LimiterDecl[] {
  // X-Api-Call value is appended via headers map → looks like a single line
  // such as: {"action":"route","call_limiter":[{"id":"x","limit":1}]}
  // Be lenient — any parse failure means "no decl".
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return []
  }
  if (typeof json !== "object" || json === null) return []
  const obj = json as { call_limiter?: unknown }
  const arr = obj.call_limiter
  if (!Array.isArray(arr)) return []
  const out: LimiterDecl[] = []
  for (const e of arr) {
    if (typeof e !== "object" || e === null) continue
    const r = e as { id?: unknown; limit?: unknown }
    if (typeof r.id === "string" && typeof r.limit === "number") {
      out.push({ id: r.id, limit: r.limit })
    }
  }
  return out
}

function getHeaderRaw(raw: string, name: string): string | null {
  const re = new RegExp(`^${name}\\s*:\\s*(.*?)$`, "im")
  const m = re.exec(raw)
  return m?.[1]?.trim() ?? null
}

function aliceInvite(rec: CallRecording): RecordedMessage | null {
  for (const e of rec.entries) {
    if (e.kind !== "message") continue
    if (e.direction !== "sent") continue
    if (!e.raw.startsWith("INVITE ")) continue
    return e
  }
  return null
}

function aliceFirst2xx(rec: CallRecording): RecordedMessage | null {
  for (const e of rec.entries) {
    if (e.kind !== "message") continue
    if (e.direction !== "received") continue
    // alice's perspective on the A-leg INVITE response
    const m = /^SIP\/2\.0\s+(\d{3})/i.exec(e.raw)
    if (!m) continue
    const code = parseInt(m[1]!, 10)
    if (code >= 200 && code < 300) return e
  }
  return null
}

function lastEntryMs(rec: CallRecording): number {
  let last = rec.startMs
  for (const e of rec.entries) {
    if (e.kind === "message") last = Math.max(last, e.receivedMs)
    else if (e.kind === "timeout" || e.kind === "marker") last = Math.max(last, e.atMs)
  }
  return last
}

function maxOverlap(holds: ReadonlyArray<Hold>): number {
  if (holds.length === 0) return 0
  // Sweep-line: +1 at each start, -1 at each (end + ε).
  const points: Array<{ t: number; delta: number }> = []
  for (const h of holds) {
    points.push({ t: h.start, delta: +1 })
    points.push({ t: h.end + 1, delta: -1 })
  }
  points.sort((a, b) => (a.t === b.t ? a.delta - b.delta : a.t - b.t))
  let cur = 0
  let peak = 0
  for (const p of points) {
    cur += p.delta
    if (cur > peak) peak = cur
  }
  return peak
}

export const limiterConcurrencyRule: CrossCallRule = {
  name: "cross-call.limiter-concurrency",
  family: "cross-call",
  description: "X-Api-Call call_limiter slots are never concurrently exceeded",
  evaluate({ recordings }) {
    const violations: RuleViolation[] = []
    // limiterId → declared limit (latest wins; all should agree in practice).
    const limits = new Map<string, number>()
    // limiterId → list of holds.
    const holds = new Map<string, Hold[]>()

    for (const rec of recordings) {
      const invite = aliceInvite(rec)
      if (!invite) continue
      const xApi = getHeaderRaw(invite.raw, "X-Api-Call")
      if (!xApi) continue
      const decls = parseLimiterDecls(xApi)
      if (decls.length === 0) continue

      const okMs = aliceFirst2xx(rec)?.receivedMs
      if (okMs === undefined) continue // never confirmed → never held the slot
      const endMs = lastEntryMs(rec)

      for (const d of decls) {
        limits.set(d.id, d.limit)
        const arr = holds.get(d.id) ?? []
        arr.push({ callId: rec.callId, start: okMs, end: endMs })
        holds.set(d.id, arr)
      }
    }

    for (const [id, arr] of holds.entries()) {
      const limit = limits.get(id) ?? 0
      const peak = maxOverlap(arr)
      if (peak > limit) {
        violations.push({
          message: `limiter "${id}": peak concurrent holds=${peak} exceeds limit=${limit}`,
          details: { id, limit, peak },
        })
      }
    }
    return violations
  },
}
