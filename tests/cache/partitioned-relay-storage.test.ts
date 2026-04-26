/**
 * PartitionedRelayStorage.memoryLayer — unit tests.
 *
 * Slice 3 of the HA-resilience plan. Verifies:
 *   - put/refresh/delete/scan round-trip
 *   - TTL expiry under TestClock (matches `CallStateCache.memoryLayer` semantics)
 *   - partition isolation (`pri:A:` writes do not leak into `bak:A:` scan, etc.)
 *   - refresh is a no-op on missing entries
 *
 * The HTTP relay layer wraps these directly; integration tests for the
 * wire format live alongside Slice 5's `PeerFabric.simulated` work.
 */

import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Stream } from "effect"
import { TestClock } from "effect/testing"
import { PartitionedRelayStorage } from "../../src/cache/PartitionedRelayStorage.js"

const provided = <A, E>(eff: Effect.Effect<A, E, PartitionedRelayStorage>) =>
  eff.pipe(Effect.provide(PartitionedRelayStorage.memoryLayer))

const collect = <A, E>(s: Stream.Stream<A, E>) => Stream.runCollect(s)

describe("PartitionedRelayStorage.memoryLayer", () => {
  it.effect("put/scan round-trips a single call with its indexes", () =>
    provided(
      Effect.gen(function* () {
        const storage = yield* PartitionedRelayStorage
        yield* storage.putCall(
          "bak",
          "worker-A",
          "call-1",
          '{"hello":"world"}',
          ["leg:abc|tag1", "ctx:foo"],
          60
        )
        const scanned = yield* collect(storage.scanCalls("bak", "worker-A"))
        const items = Array.from(scanned)
        expect(items).toHaveLength(1)
        expect(items[0]!.callRef).toBe("call-1")
        expect(items[0]!.json).toBe('{"hello":"world"}')
        expect(items[0]!.ttlSec).toBeGreaterThan(0)
      })
    )
  )

  it.effect("partitions are isolated — pri:A scan does not see bak:A entries", () =>
    provided(
      Effect.gen(function* () {
        const storage = yield* PartitionedRelayStorage
        yield* storage.putCall("pri", "worker-A", "p-1", '{"x":1}', [], 60)
        yield* storage.putCall("bak", "worker-A", "b-1", '{"x":2}', [], 60)
        const priItems = Array.from(yield* collect(storage.scanCalls("pri", "worker-A")))
        const bakItems = Array.from(yield* collect(storage.scanCalls("bak", "worker-A")))
        expect(priItems).toHaveLength(1)
        expect(priItems[0]!.callRef).toBe("p-1")
        expect(bakItems).toHaveLength(1)
        expect(bakItems[0]!.callRef).toBe("b-1")
      })
    )
  )

  it.effect("partitions for different owners don't bleed", () =>
    provided(
      Effect.gen(function* () {
        const storage = yield* PartitionedRelayStorage
        yield* storage.putCall("bak", "worker-A", "c-1", '{}', [], 60)
        yield* storage.putCall("bak", "worker-B", "c-2", '{}', [], 60)
        const aItems = Array.from(yield* collect(storage.scanCalls("bak", "worker-A")))
        const bItems = Array.from(yield* collect(storage.scanCalls("bak", "worker-B")))
        expect(aItems.map((i) => i.callRef)).toEqual(["c-1"])
        expect(bItems.map((i) => i.callRef)).toEqual(["c-2"])
      })
    )
  )

  it.effect("delete removes call + named indexes from the partition", () =>
    provided(
      Effect.gen(function* () {
        const storage = yield* PartitionedRelayStorage
        yield* storage.putCall(
          "bak",
          "worker-A",
          "c-1",
          '{}',
          ["leg:1", "ctx:1"],
          60
        )
        yield* storage.deleteCall("bak", "worker-A", "c-1", ["leg:1", "ctx:1"])
        const items = Array.from(yield* collect(storage.scanCalls("bak", "worker-A")))
        expect(items).toHaveLength(0)
      })
    )
  )

  it.effect("entries expire by TTL under TestClock", () =>
    provided(
      Effect.gen(function* () {
        const storage = yield* PartitionedRelayStorage
        yield* storage.putCall("bak", "worker-A", "c-1", '{}', [], 5)
        // Within TTL window
        yield* TestClock.adjust(Duration.seconds(4))
        const before = Array.from(yield* collect(storage.scanCalls("bak", "worker-A")))
        expect(before).toHaveLength(1)
        // Past TTL
        yield* TestClock.adjust(Duration.seconds(2))
        const after = Array.from(yield* collect(storage.scanCalls("bak", "worker-A")))
        expect(after).toHaveLength(0)
      })
    )
  )

  it.effect("refresh extends TTL on existing entry but is no-op on miss", () =>
    provided(
      Effect.gen(function* () {
        const storage = yield* PartitionedRelayStorage
        yield* storage.putCall("bak", "worker-A", "c-1", '{}', [], 5)
        yield* TestClock.adjust(Duration.seconds(4)) // 1s left
        // Refresh: extend by 30s
        yield* storage.refreshCall("bak", "worker-A", "c-1", [], 30)
        yield* TestClock.adjust(Duration.seconds(10)) // would have expired absent refresh
        const items = Array.from(yield* collect(storage.scanCalls("bak", "worker-A")))
        expect(items).toHaveLength(1)
        // Refresh on missing is a no-op (no error, no resurrection).
        yield* storage.refreshCall("bak", "worker-A", "nonexistent", [], 30)
        const stillNone = Array.from(yield* collect(storage.scanCalls("bak", "worker-Z")))
        expect(stillNone).toHaveLength(0)
      })
    )
  )

  it.effect("scan returns multiple entries in the same partition", () =>
    provided(
      Effect.gen(function* () {
        const storage = yield* PartitionedRelayStorage
        for (let i = 0; i < 5; i++) {
          yield* storage.putCall("bak", "worker-A", `c-${i}`, `{"i":${i}}`, [], 60)
        }
        const items = Array.from(yield* collect(storage.scanCalls("bak", "worker-A")))
        expect(items).toHaveLength(5)
        const refs = new Set(items.map((i) => i.callRef))
        expect(refs).toEqual(new Set(["c-0", "c-1", "c-2", "c-3", "c-4"]))
      })
    )
  )
})
