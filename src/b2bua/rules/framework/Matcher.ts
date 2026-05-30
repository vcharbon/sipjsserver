/**
 * Matcher — pure, declarative rule selection over the `Match` discriminated
 * union. Keeps every rule whose match descriptor (and optional filter) accepts
 * the event, then orders survivors by precedence layer (service above core)
 * and registration order — first-match-wins. No per-rule priority scoring.
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
} from "./RuleDefinition.js"
import { CORE_LAYER } from "./RuleDefinition.js"
import type { SipResponse } from "../../../sip/types.js"

// ── Helpers ───────────────────────────────────────────────────────────────

/** Enum column subsumption — undefined means "accept anything". */
function enumColMatch<T>(col: T | ReadonlyArray<T> | undefined, value: T): boolean {
  if (col === undefined) return true
  if (Array.isArray(col)) return (col as ReadonlyArray<T>).includes(value)
  return col === value
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
  const method = resp.getHeader("cseq").method
  return method.length > 0 ? method.toUpperCase() : "INVITE"
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
  return true
}

function timerColumns(m: TimerMatch, ctx: RuleContext): boolean {
  if (ctx.event.type !== "timer") return false
  if (!enumColMatch(m.timerType, ctx.event.timerType)) return false
  if (!enumColMatch(m.callState, ctx.call.state)) return false
  return true
}

function timeoutColumns(m: TimeoutMatch, ctx: RuleContext): boolean {
  if (ctx.event.type !== "timeout") return false
  if (m.method !== undefined) {
    if (ctx.event.method === undefined) return false
    if (!enumColMatch(m.method, ctx.event.method as SipMethod)) return false
  }
  if (!enumColMatch(m.callState, ctx.call.state)) return false
  return true
}

function cancelledColumns(m: CancelledMatch, ctx: RuleContext): boolean {
  if (ctx.event.type !== "cancelled") return false
  if (!enumColMatch(m.callState, ctx.call.state)) return false
  return true
}

function internalEventColumns(m: InternalEventMatch, ctx: RuleContext): boolean {
  if (ctx.event.type !== "internal-event") return false
  if (!enumColMatch(m.topic, ctx.event.topic)) return false
  if (!enumColMatch(m.outcome, ctx.event.outcome)) return false
  if (!enumColMatch(m.callState, ctx.call.state)) return false
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
  // Each match shape now declares its filter as `MatchFilter<RequestMatch>` etc.,
  // so `match.filter` is the contravariant union of those — TS can't prove the
  // wide `RuleContext` is assignable. At call time `match.filter` corresponds
  // to the actual `match` shape (columnMatches verified the kind), so the cast
  // is sound.
  const filter = match.filter as MatchFilter | undefined
  if (filter !== undefined && !filter(ctx)) return false
  return true
}

// ── Pick ──────────────────────────────────────────────────────────────────

/**
 * Pick the winning rule for an event.
 *
 * Contract:
 * 1. Only rules whose `match` (+ optional `filter`) accepts the event are
 *    candidates.
 * 2. `overrides` is applied first: if rule X declares `overrides: Y` and
 *    X is in the candidate set, Y is removed from the candidate set. This is
 *    layer-agnostic — it is how a lower-layer rule can deliberately trump a
 *    higher-layer one.
 * 3. Among remaining candidates the winner is the one in the highest layer;
 *    ties within a layer are broken by registration order (first wins).
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
 * Return all candidate rules for an event in precedence order — higher layer
 * first, registration order within a layer. Consumers iterate this list to
 * implement handle() passthrough semantics: when a winning rule's `handle`
 * returns undefined the executor moves on to the next candidate (the next
 * rule in the same layer, then lower layers).
 */
export function pickRanked(
  rules: ReadonlyArray<AnyRuleDefinition>,
  ctx: RuleContext,
): AnyRuleDefinition[] {
  if (rules.length === 0) return []

  // Apply `overrides`: drop any rule whose id is overridden by a still-active rule.
  const overriddenIds = new Set<string>()
  for (const r of rules) {
    if (r.overrides !== undefined && matchAccepts(r.match, ctx)) {
      for (const id of (Array.isArray(r.overrides) ? r.overrides : [r.overrides])) {
        overriddenIds.add(id)
      }
    }
  }

  const accepted: AnyRuleDefinition[] = []
  for (const rule of rules) {
    if (overriddenIds.has(rule.id)) continue
    if (!matchAccepts(rule.match, ctx)) continue
    accepted.push(rule)
  }

  // Layered precedence: higher layer wins. Within a layer the input order
  // (registration / array order) is the tiebreak — relied on via stable sort
  // (Node/V8 Array.sort is stable), so equal-layer rules keep their relative
  // order. No per-rule specificity scoring.
  accepted.sort((a, b) => (b.layer ?? CORE_LAYER) - (a.layer ?? CORE_LAYER))

  return accepted
}
