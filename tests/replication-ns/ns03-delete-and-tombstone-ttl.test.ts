/**
 * NS3 — Delete propagation: hard-DEL body + emit D-member.
 *
 * Scenario:
 *   1. Worker A writes call X with two secondary indexes.
 *   2. Worker A tombstones X (with the same indexes named for removal).
 *   3. The channel has both U-member (score 1) and D-member (score 2);
 *      the body slot is empty (hard-DEL'd); secondary indexes are gone.
 *   4. The D-member's body resolves to null on every pull — the
 *      puller's apply path uses the "D:" prefix as the wire signal,
 *      not a body-shape inspection.
 *
 * Per docs/plan/lets-plan-a-proper-crystalline-emerson.md, body slots
 * are either a real Call JSON or empty. No tombstone payload ever
 * lives in a body slot.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, MutableHashMap } from "effect"
import { ChannelIndex } from "../../src/replication/ChannelIndex.js"
import {
  KvBackend,
  type MemoryStoreEntry,
} from "../../src/storage/KvBackend.js"

describe("NS3 — delete-and-hard-DEL", () => {
  it.effect("tombstone hard-DELs body + indexes; D-member's pulled body is null", () =>
    Effect.gen(function* () {
      const store = MutableHashMap.empty<string, MemoryStoreEntry>()
      const kv = KvBackend.makeMemoryUnsafe(store)
      const chan = ChannelIndex.make(
        { self: "worker-A", peer: "worker-B", gen: 1 },
        kv
      )

      // Step 1: write the call body + two indexes.
      yield* chan.write({
        entryGen: chan.gen,
        partition: "pri",
        callRef: "X",
        bodyValue: Buffer.from('{"gen":1,"state":"active"}'),
        bodyTtlSec: 60,
        indexes: [
          { key: "idx:leg:CID-100", value: "X", ttlSec: 60 },
          { key: "idx:leg:CID-101", value: "X", ttlSec: 60 },
        ],
      })

      // Sanity: body and indexes are present.
      expect(
        (yield* kv.bodyGet("pri:worker-A:call:X"))?.toString("utf8")
      ).toBe('{"gen":1,"state":"active"}')
      expect(
        (yield* kv.bodyGet("idx:leg:CID-100"))?.toString("utf8")
      ).toBe("X")
      expect(
        (yield* kv.bodyGet("idx:leg:CID-101"))?.toString("utf8")
      ).toBe("X")

      // Step 2: tombstone with the indexes named for removal.
      yield* chan.tombstone({
        entryGen: chan.gen,
        partition: "pri",
        callRef: "X",
        indexesToRemove: ["idx:leg:CID-100", "idx:leg:CID-101"],
      })

      // Step 3: body slot empty; indexes gone; channel has both U
      // and D members.
      expect(yield* kv.bodyGet("pri:worker-A:call:X")).toBeNull()
      expect(yield* kv.bodyGet("idx:leg:CID-100")).toBeNull()
      expect(yield* kv.bodyGet("idx:leg:CID-101")).toBeNull()

      // Step 4: pull resolves D-member's body as null — the wire signal
      // is the "D:" member prefix. The puller treats null-body-on-D as
      // delete.
      const afterTombstone = yield* chan.pullBatch({ gen: 0, counter: 0 }, 10)
      expect(afterTombstone.entries.length).toBe(2)
      expect(afterTombstone.entries[0]?.member).toBe("U:pri:worker-A:call:X")
      expect(afterTombstone.entries[1]?.member).toBe("D:pri:worker-A:call:X")
      expect(afterTombstone.entries[1]?.body).toBeNull()
    })
  )
})
