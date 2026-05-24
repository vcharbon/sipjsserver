/**
 * NS12 — Body TTL natural cleanup (no explicit refresh, no termination).
 *
 * Scenario:
 *   1. Worker A writes call X with body TTL 5 s.
 *   2. No further refreshes or writes for 6 s.
 *   3. The body has TTL'd: bodyGet returns null.
 *   4. The channel index entry still exists (orphan U-member) — the
 *      design accepts this within the active-call ceiling. The puller
 *      will see U-member with null body and treat it as "no info; rely
 *      on local body's own TTL to clean up".
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

describe("NS12 — body-ttl-natural-cleanup", () => {
  it.effect("body TTLs out without explicit refresh; index entry remains as orphan U-member", () =>
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
        bodyValue: Buffer.from('{"gen":1,"state":"active"}'),
        bodyTtlSec: 5,
        indexes: [{ key: "idx:leg:CID-100", value: "X", ttlSec: 5 }],
      })

      // Verify body and index are present immediately.
      expect(
        (yield* kv.bodyGet("pri:worker-A:call:X"))?.toString("utf8")
      ).toBe('{"gen":1,"state":"active"}')
      expect(
        (yield* kv.bodyGet("idx:leg:CID-100"))?.toString("utf8")
      ).toBe("X")

      // Advance past the body TTL without refreshing.
      yield* TestClock.adjust("6 seconds")

      // Body and index have both TTL'd.
      expect(yield* kv.bodyGet("pri:worker-A:call:X")).toBeNull()
      expect(yield* kv.bodyGet("idx:leg:CID-100")).toBeNull()

      // Channel index entry remains as orphan U-member with null body.
      // Pull-batch must still return it (with body=null) so the puller
      // can observe the inconsistency for diagnostics.
      const pulled = yield* chan.pullBatch({ gen: 0, counter: 0 }, 10)
      expect(pulled.entries.length).toBe(1)
      expect(pulled.entries[0]?.member).toBe("U:pri:worker-A:call:X")
      expect(pulled.entries[0]?.body).toBeNull()
    })
  )
})
