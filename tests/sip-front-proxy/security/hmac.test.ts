/**
 * PR3a — `HmacKeyProvider` (static impl).
 *
 * Coverage:
 *   - sign + verify roundtrip with the current key.
 *   - Rotation: a provider configured with previous=oldKey + current=newKey
 *     accepts MACs signed with EITHER kid (NFR-8 1h overlap window per D14).
 *   - Tamper detection: flipping a single MAC byte causes verify→false.
 *   - Wrong kid: a kid not present in current/previous → verify→false.
 *   - Sign uses the current key (kid in the result matches current).
 *   - Layer build fails on too-short keys / empty kid / kid collision.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import {
  HmacKeyProvider,
  HmacKeyProviderConfigError,
  hmacKeyProviderStaticLayer,
  type HmacKey,
} from "../../../src/sip-front-proxy/index.js"

const fixedKey = (id: string, fillByte: number, length = 32): HmacKey => ({
  id,
  bytes: new Uint8Array(length).fill(fillByte),
})

const KEY_OLD = fixedKey("k1", 0xab)
const KEY_NEW = fixedKey("k2", 0xcd)

describe("sip-front-proxy/security/HmacKeyProvider — static impl", () => {
  it.effect("sign/verify roundtrip with current key only", () =>
    Effect.gen(function* () {
      const p = yield* HmacKeyProvider
      const input = new TextEncoder().encode("call-id-1|w=pod-0")
      const signed = yield* p.sign(input)
      expect(signed.kid).toBe("k1")
      // SHA-256 → 32 bytes.
      expect(signed.mac.byteLength).toBe(32)

      const ok = yield* p.verify(input, signed.kid, signed.mac)
      expect(ok).toBe(true)
    }).pipe(Effect.provide(hmacKeyProviderStaticLayer({ current: KEY_OLD })))
  )

  it.effect("rotation: verify accepts MACs signed with current OR previous", () =>
    Effect.gen(function* () {
      const input = new TextEncoder().encode("call-id-2")

      // Sign the same input under each generation by spinning up two
      // ephemeral providers (pre- and post-rotation single-key state).
      const signWith = (key: HmacKey) =>
        Effect.gen(function* () {
          const p = yield* HmacKeyProvider
          return yield* p.sign(input)
        }).pipe(Effect.provide(hmacKeyProviderStaticLayer({ current: key })))
      const signedOld = yield* signWith(KEY_OLD)
      const signedNew = yield* signWith(KEY_NEW)
      // Sanity: distinct keys produce distinct MACs.
      expect(signedOld.kid).toBe("k1")
      expect(signedNew.kid).toBe("k2")
      expect(Buffer.compare(Buffer.from(signedOld.mac), Buffer.from(signedNew.mac))).not.toBe(0)

      // The post-rotation provider treats k2 as current and k1 as previous.
      const p = yield* HmacKeyProvider
      const okOld = yield* p.verify(input, signedOld.kid, signedOld.mac)
      const okNew = yield* p.verify(input, signedNew.kid, signedNew.mac)
      expect(okOld).toBe(true)
      expect(okNew).toBe(true)

      // sign() always uses the current key, never previous.
      const signed = yield* p.sign(input)
      expect(signed.kid).toBe("k2")
    }).pipe(
      Effect.provide(
        hmacKeyProviderStaticLayer({ current: KEY_NEW, previous: KEY_OLD })
      )
    )
  )

  it.effect("tamper: flipping one MAC byte is rejected", () =>
    Effect.gen(function* () {
      const p = yield* HmacKeyProvider
      const input = new TextEncoder().encode("call-id-3")
      const signed = yield* p.sign(input)
      const tampered = new Uint8Array(signed.mac)
      tampered[0] = (tampered[0]! ^ 0x01) & 0xff
      const ok = yield* p.verify(input, signed.kid, tampered)
      expect(ok).toBe(false)
    }).pipe(Effect.provide(hmacKeyProviderStaticLayer({ current: KEY_OLD })))
  )

  it.effect("tamper: changing the input is rejected", () =>
    Effect.gen(function* () {
      const p = yield* HmacKeyProvider
      const input = new TextEncoder().encode("call-id-4")
      const signed = yield* p.sign(input)
      const ok = yield* p.verify(
        new TextEncoder().encode("call-id-5"),
        signed.kid,
        signed.mac
      )
      expect(ok).toBe(false)
    }).pipe(Effect.provide(hmacKeyProviderStaticLayer({ current: KEY_OLD })))
  )

  it.effect("wrong kid is rejected even if MAC bytes happen to match", () =>
    Effect.gen(function* () {
      const p = yield* HmacKeyProvider
      const input = new TextEncoder().encode("call-id-6")
      const signed = yield* p.sign(input) // kid = k1
      const ok = yield* p.verify(input, "k-unknown", signed.mac)
      expect(ok).toBe(false)
    }).pipe(Effect.provide(hmacKeyProviderStaticLayer({ current: KEY_OLD })))
  )

  it.effect("verify rejects MAC of wrong length", () =>
    Effect.gen(function* () {
      const p = yield* HmacKeyProvider
      const input = new TextEncoder().encode("call-id-7")
      const ok = yield* p.verify(input, "k1", new Uint8Array(8))
      expect(ok).toBe(false)
    }).pipe(Effect.provide(hmacKeyProviderStaticLayer({ current: KEY_OLD })))
  )

  it.effect("layer build fails on a too-short current key", () =>
    Effect.gen(function* () {
      const result = yield* Layer.build(
        hmacKeyProviderStaticLayer({ current: { id: "weak", bytes: new Uint8Array(8) } })
      ).pipe(Effect.scoped, Effect.flip)
      expect(result).toBeInstanceOf(HmacKeyProviderConfigError)
    })
  )

  it.effect("layer build fails on empty kid", () =>
    Effect.gen(function* () {
      const result = yield* Layer.build(
        hmacKeyProviderStaticLayer({ current: { id: "", bytes: new Uint8Array(32) } })
      ).pipe(Effect.scoped, Effect.flip)
      expect(result).toBeInstanceOf(HmacKeyProviderConfigError)
    })
  )

  it.effect("layer build fails when previous and current share a kid", () =>
    Effect.gen(function* () {
      const result = yield* Layer.build(
        hmacKeyProviderStaticLayer({
          current: KEY_OLD,
          previous: { id: KEY_OLD.id, bytes: new Uint8Array(32) },
        })
      ).pipe(Effect.scoped, Effect.flip)
      expect(result).toBeInstanceOf(HmacKeyProviderConfigError)
    })
  )
})
