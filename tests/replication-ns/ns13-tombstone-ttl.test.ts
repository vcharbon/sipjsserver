/**
 * NS13 — Tombstone is hard-DEL on the body slot.
 *
 * Per docs/plan/lets-plan-a-proper-crystalline-emerson.md, the
 * tombstone primitive no longer writes a JSON marker into the body
 * slot. Body slots are either a real Call JSON or absent. The wire
 * signal of "delete" is the D-member in the channel sorted set;
 * pullers fetching a D-member's body see `null` and apply an
 * implicit DEL.
 *
 * Variant: in-memory `KvBackend`.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, MutableHashMap } from "effect"
import { ChannelIndex } from "../../src/replication/ChannelIndex.js"
import {
  KvBackend,
  type MemoryStoreEntry,
} from "../../src/storage/KvBackend.js"

describe("NS13 — tombstone-hard-DEL", () => {
  it.effect("tombstone leaves body slot empty; D-member's pulled body is null", () =>
    Effect.gen(function* () {
      const store = MutableHashMap.empty<string, MemoryStoreEntry>()
      const kv = KvBackend.makeMemoryUnsafe(store)
      const chan = ChannelIndex.make(
        { self: "worker-A", peer: "worker-B", gen: 1 },
        kv
      )

      yield* chan.write({
        entryGen: chan.gen,
        partition: "pri",
        callRef: "X",
        bodyValue: '{"gen":1}',
        bodyTtlSec: 60,
        indexes: [],
      })
      yield* chan.tombstone({
        entryGen: chan.gen,
        partition: "pri",
        callRef: "X",
        indexesToRemove: [],
      })

      // Body slot is empty as soon as the tombstone is written.
      expect(yield* kv.bodyGet("pri:worker-A:call:X")).toBeNull()

      // D-member is in the channel; its pulled body is null. The
      // puller treats null-body-on-D as delete.
      const pulled = yield* chan.pullBatch({ gen: 0, counter: 0 }, 10)
      const dEntries = pulled.entries.filter((e) => e.member.startsWith("D:"))
      expect(dEntries.length).toBe(1)
      expect(dEntries[0]?.body).toBeNull()
    })
  )

  it.effect("multiple tombstones — all bodies absent; all pulled D-bodies null", () =>
    Effect.gen(function* () {
      const store = MutableHashMap.empty<string, MemoryStoreEntry>()
      const kv = KvBackend.makeMemoryUnsafe(store)
      const chan = ChannelIndex.make(
        { self: "worker-A", peer: "worker-B", gen: 1 },
        kv
      )

      for (const ref of ["a", "b", "c"]) {
        yield* chan.write({
          entryGen: chan.gen,
          partition: "pri",
          callRef: ref,
          bodyValue: `{"gen":1,"ref":"${ref}"}`,
          bodyTtlSec: 60,
          indexes: [],
        })
        yield* chan.tombstone({
          entryGen: chan.gen,
          partition: "pri",
          callRef: ref,
          indexesToRemove: [],
        })
      }

      // All three body slots are empty.
      for (const ref of ["a", "b", "c"]) {
        expect(yield* kv.bodyGet(`pri:worker-A:call:${ref}`)).toBeNull()
      }

      // Channel still carries U+D pairs (six members total). Every
      // body resolves to null — every U was overwritten by its D.
      const pulled = yield* chan.pullBatch({ gen: 0, counter: 0 }, 100)
      expect(pulled.entries.length).toBe(6)
      expect(pulled.entries.every((e) => e.body === null)).toBe(true)
    })
  )
})
