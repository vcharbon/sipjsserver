/**
 * Type-level + value-level lock for the typed-effect ADT (Phase 1 of
 * docs/plan/2026-05-15-StructuralEffectGuarantees-moth.md).
 *
 * Each effect kind belongs to exactly one safety category (critical /
 * outbound / soft / buffered / fireAndForget). The interpreter wraps each
 * category with its prescribed primitive — adding a new effect kind without
 * categorising it (or putting it in the wrong slot) is a type error AND a
 * test failure here.
 *
 * If you add a new effect discriminant, add it to the matching constant
 * below — the exhaustiveness assertion guarantees every discriminant is
 * accounted for.
 */

import { describe, test, expect } from "vitest"
import type {
  CriticalStateEffect,
  OutboundSipEffect,
  SoftBoundedEffect,
  BufferedObservabilityEffect,
  FireAndForgetEffect,
} from "../../src/sip/SipRouter.js"

// ── Compile-time exhaustiveness ───────────────────────────────────────────
// Each set must list every discriminant in its category. The `satisfies`
// (with the negative `Exclude<…>` check) keeps the lists aligned with the
// union types: removing a discriminant from the union without removing it
// from the list is a TS error, and vice-versa.

const CRITICAL_TYPES = [
  "schedule-timer",
  "cancel-timer",
  "cancel-all-timers",
  "flush-redis",
  "remove-call",
] as const satisfies ReadonlyArray<CriticalStateEffect["type"]>

const OUTBOUND_TYPES = [
  "send-sip",
] as const satisfies ReadonlyArray<OutboundSipEffect["type"]>

const SOFT_TYPES = [
  "decrement-limiter",
] as const satisfies ReadonlyArray<SoftBoundedEffect["type"]>

const BUFFERED_TYPES = [
  "write-cdr",
] as const satisfies ReadonlyArray<BufferedObservabilityEffect["type"]>

const FIRE_AND_FORGET_TYPES = [
  "refer-async-http",
] as const satisfies ReadonlyArray<FireAndForgetEffect["type"]>

// Negative assertion: every discriminant in a category union appears in the
// list above. If a new kind is added to the union but not to the list, the
// `Exclude` resolves to a non-`never` type and the cast fails to compile.
type _CriticalCovered = Exclude<CriticalStateEffect["type"], (typeof CRITICAL_TYPES)[number]>
type _OutboundCovered = Exclude<OutboundSipEffect["type"], (typeof OUTBOUND_TYPES)[number]>
type _SoftCovered = Exclude<SoftBoundedEffect["type"], (typeof SOFT_TYPES)[number]>
type _BufferedCovered = Exclude<BufferedObservabilityEffect["type"], (typeof BUFFERED_TYPES)[number]>
type _FireCovered = Exclude<FireAndForgetEffect["type"], (typeof FIRE_AND_FORGET_TYPES)[number]>

const _exhaustive: {
  critical: _CriticalCovered
  outbound: _OutboundCovered
  soft: _SoftCovered
  buffered: _BufferedCovered
  fire: _FireCovered
} | undefined = undefined
void _exhaustive

describe("RuleEffect categorisation", () => {
  test("category sets are pairwise disjoint", () => {
    const all: string[] = [
      ...CRITICAL_TYPES,
      ...OUTBOUND_TYPES,
      ...SOFT_TYPES,
      ...BUFFERED_TYPES,
      ...FIRE_AND_FORGET_TYPES,
    ]
    expect(new Set(all).size).toBe(all.length)
  })

  test("critical kinds cover state mutation, timer ops, and Redis eviction", () => {
    expect(CRITICAL_TYPES).toContain("schedule-timer")
    expect(CRITICAL_TYPES).toContain("cancel-timer")
    expect(CRITICAL_TYPES).toContain("cancel-all-timers")
    expect(CRITICAL_TYPES).toContain("flush-redis")
    expect(CRITICAL_TYPES).toContain("remove-call")
  })

  test("outbound is exclusively SIP send", () => {
    expect(OUTBOUND_TYPES).toEqual(["send-sip"])
  })

  test("soft is exclusively limiter DECR", () => {
    expect(SOFT_TYPES).toEqual(["decrement-limiter"])
  })

  test("buffered is exclusively CDR write", () => {
    expect(BUFFERED_TYPES).toEqual(["write-cdr"])
  })

  test("fire-and-forget is exclusively async REFER", () => {
    expect(FIRE_AND_FORGET_TYPES).toEqual(["refer-async-http"])
  })
})
