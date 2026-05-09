/**
 * NS3 — Delete propagation + TTL-driven tombstone cleanup.
 *
 * Scenario:
 *   1. Worker A writes call X with two secondary indexes.
 *   2. Worker A tombstones X (with the same indexes named for removal).
 *   3. The channel has both U-member (score 1) and D-member (score 2);
 *      the body is now a tombstone marker; secondary indexes are gone.
 *   4. Wall-clock advances past the tombstone TTL (~3 min).
 *   5. The tombstone body has TTL'd to null; the D-member is still in
 *      the channel (the design accepts orphan D-members within the
 *      ~30K-active-call ceiling).
 *
 * Variant covered: in-memory `KvBackend` + fake clock. The Redis +
 * hybrid-clock variant lands when the hybrid pump arrives.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, MutableHashMap } from "effect"
import { TestClock } from "effect/testing"
import { ChannelIndex } from "../../src/replication/ChannelIndex.js"
import {
  KvBackend,
  type MemoryStoreEntry,
} from "../../src/storage/KvBackend.js"

describe("NS3 — delete-and-tombstone-ttl", () => {
  it.effect("tombstone replaces body, removes indexes, then body TTLs out leaving D-member orphan", () =>
    Effect.gen(function* () {
      const store = MutableHashMap.empty<string, MemoryStoreEntry>()
      const kv = KvBackend.makeMemoryUnsafe(store)
      const chan = ChannelIndex.make(
        { self: "worker-A", peer: "worker-B", gen: 1 },
        kv
      )

      // Step 1: write the call body + two indexes.
      yield* chan.write({
        partition: "pri",
        callRef: "X",
        bodyValue: '{"gen":1,"state":"active"}',
        bodyTtlSec: 60,
        indexes: [
          { key: "idx:leg:CID-100", value: "X", ttlSec: 60 },
          { key: "idx:leg:CID-101", value: "X", ttlSec: 60 },
        ],
      })

      // Sanity: body and indexes are present, channel head = 1.
      expect(yield* kv.bodyGet("pri:worker-A:call:X")).toBe(
        '{"gen":1,"state":"active"}'
      )
      expect(yield* kv.bodyGet("idx:leg:CID-100")).toBe("X")
      expect(yield* kv.bodyGet("idx:leg:CID-101")).toBe("X")

      // Step 2: tombstone with the indexes named for removal.
      yield* chan.tombstone({
        partition: "pri",
        callRef: "X",
        indexesToRemove: ["idx:leg:CID-100", "idx:leg:CID-101"],
      })

      // Step 3: body is now the tombstone marker; indexes gone; channel
      // has both U and D members.
      expect(yield* kv.bodyGet("pri:worker-A:call:X")).toBe(
        '{"tombstone":true,"gen":1}'
      )
      expect(yield* kv.bodyGet("idx:leg:CID-100")).toBeNull()
      expect(yield* kv.bodyGet("idx:leg:CID-101")).toBeNull()

      const afterTombstone = yield* chan.pullBatch(0, 10)
      expect(afterTombstone.entries.length).toBe(2)
      expect(afterTombstone.entries[0]?.member).toBe("U:pri:worker-A:call:X")
      expect(afterTombstone.entries[1]?.member).toBe("D:pri:worker-A:call:X")

      // Step 4: advance past the 180-second tombstone TTL.
      yield* TestClock.adjust("181 seconds")

      // Step 5: body has TTL'd → null. D-member is still in the channel
      // (orphan-D entries are accepted; cleanup is "next-write sweeps").
      const afterTtl = yield* chan.pullBatch(0, 10)
      expect(afterTtl.entries.length).toBe(2)
      // Both U-member and D-member are still indexed but the body is
      // gone — the puller treats null-body-on-D as "DEL anyway".
      expect(afterTtl.entries[1]?.member).toBe("D:pri:worker-A:call:X")
      expect(afterTtl.entries[1]?.body).toBeNull()
    })
  )
})
