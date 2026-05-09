/**
 * NS13 — Tombstone TTL across both ends.
 *
 * Scenario:
 *   1. Worker A writes call X.
 *   2. Worker A tombstones X.
 *   3. Advance past tombstone TTL (180 s + headroom).
 *   4. Tombstone body is gone on A's side. The D-member is still
 *      indexed (orphan tolerated up to ~30K active calls).
 *   5. Subsequent pull on A returns D-member with null body — the
 *      puller's apply path treats null-body-on-D as "tombstone TTL'd,
 *      DEL anyway", so applying side converges with no further data.
 *
 * Note: this test asserts only the SOURCE-side behavior (TTL'd
 * tombstone body, orphan member surface). The receiver-side apply
 * behavior under tombstone-TTL races is exercised in Slice 5+ with
 * a real puller fiber.
 *
 * Variant: in-memory `KvBackend` + fake clock.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, MutableHashMap } from "effect"
import { TestClock } from "effect/testing"
import { ChannelIndex } from "../../src/replication/ChannelIndex.js"
import {
  KvBackend,
  type MemoryStoreEntry,
} from "../../src/storage/KvBackend.js"

describe("NS13 — tombstone-ttl-cleanup", () => {
  it.effect("tombstone body TTLs to null while D-member survives in the channel", () =>
    Effect.gen(function* () {
      const store = MutableHashMap.empty<string, MemoryStoreEntry>()
      const kv = KvBackend.makeMemoryUnsafe(store)
      const chan = ChannelIndex.make(
        { self: "worker-A", peer: "worker-B", gen: 1 },
        kv
      )

      yield* chan.write({
        partition: "pri",
        callRef: "X",
        bodyValue: '{"gen":1}',
        bodyTtlSec: 60,
        indexes: [],
      })
      yield* chan.tombstone({
        partition: "pri",
        callRef: "X",
        indexesToRemove: [],
      })

      // Sanity: tombstone is the current body before TTL.
      expect(yield* kv.bodyGet("pri:worker-A:call:X")).toBe(
        '{"tombstone":true,"gen":1}'
      )

      // Advance just past the tombstone TTL (180 s default).
      yield* TestClock.adjust("181 seconds")

      // Tombstone body has TTL'd.
      expect(yield* kv.bodyGet("pri:worker-A:call:X")).toBeNull()

      // D-member is still in the channel — caller (the puller) sees
      // null body and applies an implicit DEL.
      const pulled = yield* chan.pullBatch(0, 10)
      const dEntries = pulled.entries.filter((e) => e.member.startsWith("D:"))
      expect(dEntries.length).toBe(1)
      expect(dEntries[0]?.body).toBeNull()
    })
  )

  it.effect("multiple tombstones share the TTL window; all expire after 180 s", () =>
    Effect.gen(function* () {
      const store = MutableHashMap.empty<string, MemoryStoreEntry>()
      const kv = KvBackend.makeMemoryUnsafe(store)
      const chan = ChannelIndex.make(
        { self: "worker-A", peer: "worker-B", gen: 1 },
        kv
      )

      for (const ref of ["a", "b", "c"]) {
        yield* chan.write({
          partition: "pri",
          callRef: ref,
          bodyValue: `{"gen":1,"ref":"${ref}"}`,
          bodyTtlSec: 60,
          indexes: [],
        })
        yield* chan.tombstone({
          partition: "pri",
          callRef: ref,
          indexesToRemove: [],
        })
      }

      yield* TestClock.adjust("181 seconds")

      // All three tombstone bodies have TTL'd.
      for (const ref of ["a", "b", "c"]) {
        expect(yield* kv.bodyGet(`pri:worker-A:call:${ref}`)).toBeNull()
      }

      // Channel still carries the U+D pairs (six members total) but
      // every body resolves to null.
      const pulled = yield* chan.pullBatch(0, 100)
      expect(pulled.entries.length).toBe(6)
      expect(pulled.entries.every((e) => e.body === null)).toBe(true)
    })
  )
})
