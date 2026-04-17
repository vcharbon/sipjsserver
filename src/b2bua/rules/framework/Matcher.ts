/**
 * Matcher — pure, declarative rule selection over the `Match` discriminated
 * union. Picks the strictly-most-specific rule whose match descriptor accepts
 * the event.
 *
 * The Matcher is deliberately plain — no Effect. It is invoked from inside
 * RuleExecutor (which handles state, effects, action execution) and from
 * registry validators at startup.
 */

import type {
  AnyRuleDefinition,
  CancelledMatch,
  InternalEventMatch,
  Match,
  MatchFilter,
  RequestMatch,
  ResponseMatch,
  RuleContext,
  SipMethod,
  StatusClass,
  TimerMatch,
  TimeoutMatch,
  TransferPhaseGate,
} from "./RuleDefinition.js"
import type { SipResponse } from "../../../sip/types.js"
import type { TransferPhase } from "../../../call/CallModel.js"

// ── Helpers ───────────────────────────────────────────────────────────────

/** Enum column subsumption — undefined means "accept anything". */
function enumColMatch<T>(col: T | ReadonlyArray<T> | undefined, value: T): boolean {
  if (col === undefined) return true
  if (Array.isArray(col)) return (col as ReadonlyArray<T>).includes(value)
  return col === value
}

/**
 * Transfer-phase column match.
 *
 * - gate === undefined: accept anything (rule is transfer-agnostic).
 * - gate === null: require absence of transfer (call.transfer is null/undefined).
 * - gate is a phase literal: require exact phase match.
 * - gate is an array: accept if any member matches the current phase, where
 *   `null` in the array matches the transfer-absent case.
 */
function transferPhaseMatch(gate: TransferPhaseGate | undefined, ctx: RuleContext): boolean {
  if (gate === undefined) return true
  const actual: TransferPhase | null = ctx.call.transfer?.phase ?? null
  if (gate === null) return actual === null
  if (Array.isArray(gate)) {
    return (gate as ReadonlyArray<TransferPhase | null>).includes(actual)
  }
  return gate === actual
}

/** Map a numeric SIP status to its class bucket. */
export function statusClassFor(status: number): StatusClass {
  if (status < 200) return "1xx"
  if (status < 300) return "2xx"
  if (status < 400) return "3xx"
  if (status < 500) return "4xx"
  if (status < 600) return "5xx"
  return "6xx"
}

/** Extract CSeq method from a response's CSeq header. */
export function cseqMethodOf(resp: SipResponse): string {
  const h = resp.headers.find((h) => h.name.toLowerCase() === "cseq")?.value ?? ""
  return h.split(/\s+/)[1]?.toUpperCase() ?? "INVITE"
}

// ── Column matching (no filter) ───────────────────────────────────────────

function requestColumns(m: RequestMatch, ctx: RuleContext): boolean {
  const event = ctx.event
  if (event.type !== "sip") return false
  const msg = event.message
  if (msg.type !== "request") return false
  if (!enumColMatch(m.method, msg.method as SipMethod)) return false
  if (m.direction !== undefined && ctx.direction !== m.direction) return false
  if (!enumColMatch(m.callState, ctx.call.state)) return false
  if (!enumColMatch(m.legState, ctx.sourceLeg.state)) return false
  if (!enumColMatch(m.legDisposition, ctx.sourceLeg.disposition)) return false
  if (!transferPhaseMatch(m.transferPhase, ctx)) return false
  return true
}

function responseColumns(m: ResponseMatch, ctx: RuleContext): boolean {
  const event = ctx.event
  if (event.type !== "sip") return false
  const msg = event.message
  if (msg.type !== "response") return false
  const cm = cseqMethodOf(msg) as SipMethod
  if (!enumColMatch(m.cseqMethod, cm)) return false
  if (m.status !== undefined && msg.status !== m.status) return false
  if (m.statusClass !== undefined) {
    if (!enumColMatch(m.statusClass, statusClassFor(msg.status))) return false
  }
  if (m.direction !== undefined && ctx.direction !== m.direction) return false
  if (!enumColMatch(m.callState, ctx.call.state)) return false
  if (!enumColMatch(m.legState, ctx.sourceLeg.state)) return false
  if (!enumColMatch(m.legDisposition, ctx.sourceLeg.disposition)) return false
  if (!transferPhaseMatch(m.transferPhase, ctx)) return false
  return true
}

function timerColumns(m: TimerMatch, ctx: RuleContext): boolean {
  if (ctx.event.type !== "timer") return false
  if (!enumColMatch(m.timerType, ctx.event.timerType)) return false
  if (!enumColMatch(m.callState, ctx.call.state)) return false
  if (!transferPhaseMatch(m.transferPhase, ctx)) return false
  return true
}

function timeoutColumns(m: TimeoutMatch, ctx: RuleContext): boolean {
  if (ctx.event.type !== "timeout") return false
  if (m.method !== undefined) {
    if (ctx.event.method === undefined) return false
    if (!enumColMatch(m.method, ctx.event.method as SipMethod)) return false
  }
  if (!enumColMatch(m.callState, ctx.call.state)) return false
  if (!transferPhaseMatch(m.transferPhase, ctx)) return false
  return true
}

function cancelledColumns(m: CancelledMatch, ctx: RuleContext): boolean {
  if (ctx.event.type !== "cancelled") return false
  if (!enumColMatch(m.callState, ctx.call.state)) return false
  if (!transferPhaseMatch(m.transferPhase, ctx)) return false
  return true
}

function internalEventColumns(m: InternalEventMatch, ctx: RuleContext): boolean {
  if (ctx.event.type !== "internal-event") return false
  if (!enumColMatch(m.topic, ctx.event.topic)) return false
  if (!enumColMatch(m.outcome, ctx.event.outcome)) return false
  if (!enumColMatch(m.callState, ctx.call.state)) return false
  if (!transferPhaseMatch(m.transferPhase, ctx)) return false
  return true
}

function columnMatches(match: Match, ctx: RuleContext): boolean {
  switch (match.kind) {
    case "request":        return requestColumns(match, ctx)
    case "response":       return responseColumns(match, ctx)
    case "timer":          return timerColumns(match, ctx)
    case "timeout":        return timeoutColumns(match, ctx)
    case "cancelled":      return cancelledColumns(match, ctx)
    case "internal-event": return internalEventColumns(match, ctx)
  }
}

/** Full match test: columns first, then the optional corner-case filter. */
export function matchAccepts(match: Match, ctx: RuleContext): boolean {
  if (!columnMatches(match, ctx)) return false
  const filter: MatchFilter | undefined = match.filter
  if (filter !== undefined && !filter(ctx)) return false
  return true
}

// ── Specificity score ─────────────────────────────────────────────────────
//
// Higher score = more specific = smaller match set = wins when both match.
// Singleton value on a column is stricter than an array of values; exact
// status beats statusClass; filter presence narrows further.

function colScore(v: unknown): number {
  if (v === undefined) return 0
  if (Array.isArray(v)) return 1
  return 2
}

/**
 * Transfer-phase gate scoring — singleton phase or `null` beats an array;
 * undefined contributes nothing. Mirrors colScore so `transferPhase:"c-ringing"`
 * outranks `transferPhase:["c-ringing","a-realigning"]`.
 */
function transferPhaseScore(gate: TransferPhaseGate | undefined): number {
  if (gate === undefined) return 0
  if (Array.isArray(gate)) return 1
  return 2
}

export function specificityScore(m: Match): number {
  let score = 0
  switch (m.kind) {
    case "request":
      score += colScore(m.method)
      score += colScore(m.callState)
      score += colScore(m.legState)
      score += colScore(m.legDisposition)
      score += colScore(m.direction)
      score += transferPhaseScore(m.transferPhase)
      break
    case "response":
      score += colScore(m.cseqMethod)
      // Exact status beats statusClass: +1 bonus on top of colScore.
      if (m.status !== undefined) {
        score += 3 // singleton (2) + exact-beats-class bonus (1)
      } else {
        score += colScore(m.statusClass)
      }
      score += colScore(m.callState)
      score += colScore(m.legState)
      score += colScore(m.legDisposition)
      score += colScore(m.direction)
      score += transferPhaseScore(m.transferPhase)
      break
    case "timer":
      score += colScore(m.timerType)
      score += colScore(m.callState)
      score += transferPhaseScore(m.transferPhase)
      break
    case "timeout":
      score += colScore(m.method)
      score += colScore(m.callState)
      score += transferPhaseScore(m.transferPhase)
      break
    case "cancelled":
      score += colScore(m.callState)
      score += transferPhaseScore(m.transferPhase)
      break
    case "internal-event":
      score += colScore(m.topic)
      score += colScore(m.outcome)
      score += colScore(m.callState)
      score += transferPhaseScore(m.transferPhase)
      break
  }
  if (m.filter !== undefined) score += 1
  return score
}

// ── Pick ──────────────────────────────────────────────────────────────────

/**
 * Pick the winning rule for an event.
 *
 * Contract:
 * 1. Only rules whose `match` accepts the event are candidates.
 * 2. `overrides` is applied first: if rule X declares `overrides: Y` and
 *    X is in the candidate set, Y is removed from the candidate set.
 * 3. Among remaining candidates, the one with the highest specificity
 *    score wins. Ties fall back to `defaultPriority` (lower = earlier,
 *    matching legacy convention).
 *
 * Caller is responsible for filtering the input list to rules that are
 * active for THIS call (always-active + per-call actives), exactly as
 * buildRuleList in RuleExecutor does today.
 */
export function pick(
  rules: ReadonlyArray<AnyRuleDefinition>,
  ctx: RuleContext,
): AnyRuleDefinition | undefined {
  const ranked = pickRanked(rules, ctx)
  return ranked.length > 0 ? ranked[0] : undefined
}

/**
 * Return all candidate rules for an event, ordered by [specificity desc,
 * priority asc]. Consumers iterate this list to implement handle()
 * passthrough semantics — when a winning rule's `handle` returns undefined
 * the executor moves on to the next candidate.
 */
export function pickRanked(
  rules: ReadonlyArray<AnyRuleDefinition>,
  ctx: RuleContext,
  priorityOf: (rule: AnyRuleDefinition) => number = (r) => r.defaultPriority ?? 900,
): AnyRuleDefinition[] {
  if (rules.length === 0) return []

  // Apply `overrides`: drop any rule whose id is overridden by a still-active rule.
  const overriddenIds = new Set<string>()
  for (const r of rules) {
    if (r.overrides !== undefined && matchAccepts(r.match, ctx)) {
      overriddenIds.add(r.overrides)
    }
  }

  const accepted: AnyRuleDefinition[] = []
  for (const rule of rules) {
    if (overriddenIds.has(rule.id)) continue
    if (!matchAccepts(rule.match, ctx)) continue
    accepted.push(rule)
  }

  accepted.sort((a, b) => {
    const sa = specificityScore(a.match)
    const sb = specificityScore(b.match)
    if (sa !== sb) return sb - sa
    return priorityOf(a) - priorityOf(b)
  })

  return accepted
}
