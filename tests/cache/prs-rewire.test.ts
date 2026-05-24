/**
 * PRS rewire — SIP-facing surface contract.
 *
 * Slice 7b regression suite. The legacy `PartitionedRelayStorage.memoryLayer`
 * is being replaced by `kvBackedMemoryLayer` (new internals over
 * `KvBackend` + `ChannelIndex`). The SIP-facing surface
 * (`putCall` / `getCall` / `deleteCall` / `refreshCall` / `scanCalls`
 * / `getIndex`) MUST be byte-for-byte identical so `CallState`,
 * `PeerCacheClient`, and the rest of the SIP path keep working
 * without a single call-site change.
 *
 * Strategy: a single `runScenarios(layer)` function that exercises
 * every public method against an arbitrary PRS layer. Both the
 * legacy and KV-backed layers are run through it. If both pass,
 * the cutover is safe to flip in `main.ts`.
 */

import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { PartitionedRelayStorage } from "../../src/cache/PartitionedRelayStorage.js"
import { kvBackedMemoryLayer } from "../../src/cache/PartitionedRelayStorageKvBacked.js"
import { bodyBuf, decodeBuf } from "../support/codecHelpers.js"

const collect = <A, E>(s: Stream.Stream<A, E>) => Stream.runCollect(s)

// ---------------------------------------------------------------------------
// Shared scenarios — run identically against any PartitionedRelayStorage layer
// ---------------------------------------------------------------------------

const scenarios: ReadonlyArray<{
  readonly name: string
  readonly run: () => Effect.Effect<void, unknown, PartitionedRelayStorage>
}> = [
  {
    name: "put/scan round-trip — single call with indexes (no peer)",
    run: () =>
      Effect.gen(function* () {
        const s = yield* PartitionedRelayStorage
        yield* s.putCall(
          "bak",
          "worker-A",
          "c-1",
          bodyBuf({ hello: "world" }),
          ["leg:abc|tag1", "ctx:foo"],
          60
        )
        const items = Array.from(yield* collect(s.scanCalls("bak", "worker-A")))
        expect(items).toHaveLength(1)
        expect(items[0]!.callRef).toBe("c-1")
        // Bodies are msgpack-encoded post-migration; decode via the
        // auto-detect helper to recover the original JS shape.
        const parsed = decodeBuf(items[0]!.body) as Record<string, unknown>
        expect(parsed["hello"]).toBe("world")
        expect(items[0]!.ttlSec).toBeGreaterThan(0)
      }),
  },
  {
    name: "partitions are isolated — pri:A scan does not see bak:A entries",
    run: () =>
      Effect.gen(function* () {
        const s = yield* PartitionedRelayStorage
        yield* s.putCall("pri", "worker-A", "p-1", bodyBuf({ x: 1 }), [], 60)
        yield* s.putCall("bak", "worker-A", "b-1", bodyBuf({ x: 2 }), [], 60)
        const priItems = Array.from(yield* collect(s.scanCalls("pri", "worker-A")))
        const bakItems = Array.from(yield* collect(s.scanCalls("bak", "worker-A")))
        expect(priItems.map((i) => i.callRef)).toEqual(["p-1"])
        expect(bakItems.map((i) => i.callRef)).toEqual(["b-1"])
      }),
  },
  {
    name: "partitions for different owners don't bleed",
    run: () =>
      Effect.gen(function* () {
        const s = yield* PartitionedRelayStorage
        yield* s.putCall("bak", "worker-A", "c-1", bodyBuf({}), [], 60)
        yield* s.putCall("bak", "worker-B", "c-2", bodyBuf({}), [], 60)
        const aRefs = Array.from(yield* collect(s.scanCalls("bak", "worker-A"))).map(
          (i) => i.callRef
        )
        const bRefs = Array.from(yield* collect(s.scanCalls("bak", "worker-B"))).map(
          (i) => i.callRef
        )
        expect(aRefs).toEqual(["c-1"])
        expect(bRefs).toEqual(["c-2"])
      }),
  },
  {
    name: "delete removes call body + named indexes",
    run: () =>
      Effect.gen(function* () {
        const s = yield* PartitionedRelayStorage
        yield* s.putCall(
          "bak",
          "worker-A",
          "c-1",
          bodyBuf({}),
          ["leg:1", "ctx:1"],
          60
        )
        // Indexes are visible via getIndex.
        expect(yield* s.getIndex("leg:1")).toBe("c-1")
        expect(yield* s.getIndex("ctx:1")).toBe("c-1")

        yield* s.deleteCall("bak", "worker-A", "c-1", ["leg:1", "ctx:1"])
        const items = Array.from(yield* collect(s.scanCalls("bak", "worker-A")))
        expect(items).toHaveLength(0)
        expect(yield* s.getIndex("leg:1")).toBeNull()
        expect(yield* s.getIndex("ctx:1")).toBeNull()
      }),
  },
  {
    name: "entries expire by TTL under TestClock",
    run: () =>
      Effect.gen(function* () {
        const s = yield* PartitionedRelayStorage
        yield* s.putCall("bak", "worker-A", "c-1", bodyBuf({}), [], 5)
        yield* TestClock.adjust(Duration.seconds(4))
        const before = Array.from(yield* collect(s.scanCalls("bak", "worker-A")))
        expect(before).toHaveLength(1)
        yield* TestClock.adjust(Duration.seconds(2))
        const after = Array.from(yield* collect(s.scanCalls("bak", "worker-A")))
        expect(after).toHaveLength(0)
      }),
  },
  {
    name: "refresh extends TTL on existing entry; no-op on missing",
    run: () =>
      Effect.gen(function* () {
        const s = yield* PartitionedRelayStorage
        yield* s.putCall("bak", "worker-A", "c-1", bodyBuf({}), [], 5)
        yield* TestClock.adjust(Duration.seconds(4)) // 1s left
        yield* s.refreshCall("bak", "worker-A", "c-1", [], 30)
        yield* TestClock.adjust(Duration.seconds(10)) // would have expired
        const items = Array.from(yield* collect(s.scanCalls("bak", "worker-A")))
        expect(items).toHaveLength(1)

        // Refresh on missing — no error, no resurrection.
        yield* s.refreshCall("bak", "worker-A", "nonexistent", [], 30)
        const stillNone = Array.from(
          yield* collect(s.scanCalls("bak", "worker-Z"))
        )
        expect(stillNone).toHaveLength(0)
      }),
  },
  {
    name: "scan returns multiple entries in the same partition",
    run: () =>
      Effect.gen(function* () {
        const s = yield* PartitionedRelayStorage
        for (let i = 0; i < 5; i++) {
          yield* s.putCall(
            "bak",
            "worker-A",
            `c-${i}`,
            bodyBuf({ i }),
            [],
            60
          )
        }
        const items = Array.from(yield* collect(s.scanCalls("bak", "worker-A")))
        expect(items).toHaveLength(5)
        const refs = new Set(items.map((i) => i.callRef))
        expect(refs).toEqual(new Set(["c-0", "c-1", "c-2", "c-3", "c-4"]))
      }),
  },
  {
    name: "getCall returns null for missing entries",
    run: () =>
      Effect.gen(function* () {
        const s = yield* PartitionedRelayStorage
        const result = yield* s.getCall("pri", "worker-A", "nonexistent")
        expect(result).toBeNull()
      }),
  },
  {
    name: "getCall returns the body for an existing entry",
    run: () =>
      Effect.gen(function* () {
        const s = yield* PartitionedRelayStorage
        yield* s.putCall("pri", "worker-A", "X", bodyBuf({ v: 42 }), [], 60)
        const body = yield* s.getCall("pri", "worker-A", "X")
        expect(body).not.toBeNull()
        const parsed = decodeBuf(body!) as Record<string, unknown>
        expect(parsed["v"]).toBe(42)
      }),
  },
  {
    name: "peer-bearing put + delete: body lands and gets cleaned up",
    run: () =>
      Effect.gen(function* () {
        const s = yield* PartitionedRelayStorage
        yield* s.putCall(
          "pri",
          "worker-A",
          "X",
          bodyBuf({ v: 1 }),
          ["leg:abc"],
          60,
          { peer: "worker-B" }
        )
        const beforeDel = yield* s.getCall("pri", "worker-A", "X")
        expect(beforeDel).not.toBeNull()
        const beforeIdx = yield* s.getIndex("leg:abc")
        expect(beforeIdx).toBe("X")

        yield* s.deleteCall("pri", "worker-A", "X", ["leg:abc"], {
          peer: "worker-B",
        })
        // After tombstone: getIndex returns null (idx removed).
        expect(yield* s.getIndex("leg:abc")).toBeNull()
        // Body itself becomes a tombstone marker (not the original v:1).
        const afterDel = yield* s.getCall("pri", "worker-A", "X")
        // The legacy hard-deletes; the new layer writes a tombstone.
        // Both satisfy "the original body content is gone".
        if (afterDel !== null) {
          const parsed = decodeBuf(afterDel) as Record<string, unknown>
          expect(parsed["v"]).toBeUndefined()
        }
      }),
  },
]

// ---------------------------------------------------------------------------
// Run scenarios against legacy memoryLayer
// ---------------------------------------------------------------------------

// Slice 7c: the legacy AtomicWriter-backed memoryLayer was removed
// in the final cutover. The new `kvBackedMemoryLayer` is the only
// implementation — running both describe blocks pre-cutover proved
// parity; post-cutover the second describe block below is the sole
// surviving regression suite.

// ---------------------------------------------------------------------------
// Run the same scenarios against the new kvBackedMemoryLayer
// ---------------------------------------------------------------------------

const kvBackedTestLayer: Layer.Layer<PartitionedRelayStorage> =
  kvBackedMemoryLayer({ self: "worker-A", gen: 1 })

describe("PartitionedRelayStorage — kvBackedMemoryLayer (Slice 7b cutover candidate)", () => {
  for (const scn of scenarios) {
    it.effect(scn.name, () => scn.run().pipe(Effect.provide(kvBackedTestLayer)))
  }
})
