/**
 * Unit tests for `Registrar.inMemoryLayer` — slice 2 of the
 * REGISTER + double-stack proxy work.
 *
 * Acceptance per the plan:
 *   - register / lookup / remove round-trip
 *   - lazy expiry under TestClock
 *
 * Tests run against `inMemoryLayer` (the production-ish v1 store) and
 * against `noopLayer` for the disabled-registrar contract.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { TestClock } from "effect/testing"
import { Registrar } from "../../../src/sip-front-proxy/Registrar.js"

describe("Registrar.inMemoryLayer", () => {
  it.effect("register → lookup returns the live binding", () =>
    Effect.gen(function* () {
      const registrar = yield* Registrar
      const bound = yield* registrar.register(
        "alice",
        "sip:alice@10.20.0.5:5061",
        3600,
      )
      expect(bound.aor).toBe("alice")
      expect(bound.contactUri).toBe("sip:alice@10.20.0.5:5061")
      expect(bound.expiresAtMs).toBeGreaterThan(0)

      const found = yield* registrar.lookup("alice")
      expect(Option.isSome(found)).toBe(true)
      if (Option.isSome(found)) {
        expect(found.value.contactUri).toBe("sip:alice@10.20.0.5:5061")
      }
    }).pipe(Effect.provide(Registrar.inMemoryLayer)),
  )

  it.effect("lookup is case-insensitive on the AOR userpart", () =>
    Effect.gen(function* () {
      const registrar = yield* Registrar
      yield* registrar.register("Alice", "sip:alice@host:5060", 3600)
      const found = yield* registrar.lookup("ALICE")
      expect(Option.isSome(found)).toBe(true)
    }).pipe(Effect.provide(Registrar.inMemoryLayer)),
  )

  it.effect("re-register replaces the previous Contact (single-binding)", () =>
    Effect.gen(function* () {
      const registrar = yield* Registrar
      yield* registrar.register("alice", "sip:alice@10.20.0.5:5061", 3600)
      yield* registrar.register("alice", "sip:alice@10.20.0.6:5062", 3600)
      const found = yield* registrar.lookup("alice")
      expect(Option.isSome(found)).toBe(true)
      if (Option.isSome(found)) {
        expect(found.value.contactUri).toBe("sip:alice@10.20.0.6:5062")
      }
    }).pipe(Effect.provide(Registrar.inMemoryLayer)),
  )

  it.effect("remove drops the binding immediately", () =>
    Effect.gen(function* () {
      const registrar = yield* Registrar
      yield* registrar.register("alice", "sip:alice@10.20.0.5:5061", 3600)
      yield* registrar.remove("alice")
      const found = yield* registrar.lookup("alice")
      expect(Option.isNone(found)).toBe(true)
    }).pipe(Effect.provide(Registrar.inMemoryLayer)),
  )

  it.effect("lookup returns none after the TTL expires (lazy under TestClock)", () =>
    Effect.gen(function* () {
      const registrar = yield* Registrar
      // 60 s TTL — short enough to make the assertion cheap.
      yield* registrar.register("alice", "sip:alice@10.20.0.5:5061", 60)

      // Advance virtual time past the expiry window. Registrar uses
      // `Clock.currentTimeMillis`, so TestClock.adjust deterministically
      // pushes the binding past `expiresAtMs`.
      yield* TestClock.adjust("61 seconds")

      const found = yield* registrar.lookup("alice")
      expect(Option.isNone(found)).toBe(true)
    }).pipe(Effect.provide(Registrar.inMemoryLayer)),
  )

  it.effect("re-register after expiry installs a fresh binding", () =>
    Effect.gen(function* () {
      const registrar = yield* Registrar
      yield* registrar.register("alice", "sip:alice@10.20.0.5:5061", 60)
      yield* TestClock.adjust("61 seconds")
      // First lookup confirms the binding has actually expired.
      const expired = yield* registrar.lookup("alice")
      expect(Option.isNone(expired)).toBe(true)

      yield* registrar.register("alice", "sip:alice@10.20.0.7:5063", 60)
      const refreshed = yield* registrar.lookup("alice")
      expect(Option.isSome(refreshed)).toBe(true)
      if (Option.isSome(refreshed)) {
        expect(refreshed.value.contactUri).toBe("sip:alice@10.20.0.7:5063")
      }
    }).pipe(Effect.provide(Registrar.inMemoryLayer)),
  )
})

describe("Registrar.noopLayer", () => {
  it.effect("lookup always returns none, register/remove are no-ops", () =>
    Effect.gen(function* () {
      const registrar = yield* Registrar
      yield* registrar.register("alice", "sip:alice@host:5060", 3600)
      const found = yield* registrar.lookup("alice")
      expect(Option.isNone(found)).toBe(true)
      // Idempotent — does not throw.
      yield* registrar.remove("alice")
    }).pipe(Effect.provide(Registrar.noopLayer)),
  )
})
