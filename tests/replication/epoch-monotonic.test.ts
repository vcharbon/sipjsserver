/**
 * Slice 2 — EpochCounter monotonicity across simulated worker reboots.
 *
 * Spec: [docs/replication/call-cache-backup.md §8.1](../../docs/replication/call-cache-backup.md).
 *
 * Asserts:
 *   - First "boot" of a fresh sidecar yields epoch=1.
 *   - Each subsequent layer construction (= one worker process restart
 *     against a persistent sidecar) bumps the counter.
 *   - The atomic writer's PUT_WITH_PEER_LUA path returns the epoch
 *     witnessed at write time, matching the EpochCounter's value.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, MutableHashMap } from "effect"
import {
  AtomicWriter,
  type MemoryStore,
  type MemoryStoreEntry,
} from "../../src/replication/AtomicWriter.js"
import { EpochCounter } from "../../src/replication/EpochCounter.js"

describe("EpochCounter (memory)", () => {
  it.effect("first boot of a fresh sidecar emits epoch=1", () => {
    const store: MemoryStore = MutableHashMap.empty<string, MemoryStoreEntry>()
    return Effect.gen(function* () {
      const counter = yield* EpochCounter
      const epoch = yield* counter.current
      expect(epoch).toBe(1)
      expect(counter.owner).toBe("worker-A")
    }).pipe(
      Effect.provide(EpochCounter.memoryLayerFromStore(store, "worker-A"))
    )
  })

  it.effect("each layer construction bumps the persistent counter", () => {
    const store: MemoryStore = MutableHashMap.empty<string, MemoryStoreEntry>()
    return Effect.gen(function* () {
      // Boot 1
      const e1 = yield* Effect.gen(function* () {
        const c = yield* EpochCounter
        return yield* c.current
      }).pipe(Effect.provide(EpochCounter.memoryLayerFromStore(store, "worker-A")))
      // Boot 2 (same sidecar / store)
      const e2 = yield* Effect.gen(function* () {
        const c = yield* EpochCounter
        return yield* c.current
      }).pipe(Effect.provide(EpochCounter.memoryLayerFromStore(store, "worker-A")))
      // Boot 3
      const e3 = yield* Effect.gen(function* () {
        const c = yield* EpochCounter
        return yield* c.current
      }).pipe(Effect.provide(EpochCounter.memoryLayerFromStore(store, "worker-A")))

      expect(e1).toBe(1)
      expect(e2).toBe(2)
      expect(e3).toBe(3)
    })
  })

  it.effect("epoch counter is per-owner: different owners do not share state", () => {
    const store: MemoryStore = MutableHashMap.empty<string, MemoryStoreEntry>()
    return Effect.gen(function* () {
      const eA = yield* Effect.gen(function* () {
        return yield* (yield* EpochCounter).current
      }).pipe(Effect.provide(EpochCounter.memoryLayerFromStore(store, "worker-A")))
      const eB = yield* Effect.gen(function* () {
        return yield* (yield* EpochCounter).current
      }).pipe(Effect.provide(EpochCounter.memoryLayerFromStore(store, "worker-B")))
      expect(eA).toBe(1)
      expect(eB).toBe(1)
    })
  })

  it.effect("AtomicWriter put-with-peer returns the same epoch the EpochCounter cached", () => {
    const store: MemoryStore = MutableHashMap.empty<string, MemoryStoreEntry>()
    const writer = AtomicWriter.makeMemoryUnsafe(store)
    return Effect.gen(function* () {
      const counter = yield* EpochCounter
      const epoch = yield* counter.current
      const result = yield* writer.put(
        "pri",
        "worker-A",
        "call-1",
        "{}",
        ["leg:abc"],
        60,
        { peer: "worker-B" }
      )
      expect(result).not.toBeNull()
      expect(result!.epoch).toBe(epoch)
      expect(result!.seq).toBe(1)
    }).pipe(
      Effect.provide(EpochCounter.memoryLayerFromStore(store, "worker-A"))
    )
  })
})
