/**
 * Slice 2 — propagate:{peer} compaction & sliding-TTL semantics
 * (memory-layer parity with Redis ZADD + sliding EXPIRE).
 *
 * Spec: [docs/replication/call-cache-backup.md §4.2 / §6](../../docs/replication/call-cache-backup.md).
 *
 * Asserts:
 *   - 50 writes against the same callRef compact to a single member
 *     (ZADD-replaces-score semantics).
 *   - The set's sliding TTL extends on every write — a long sequence
 *     of writes spread over time keeps the set live, matching the
 *     Redis `EXPIRE propagate:{peer} long_ttl` on every Lua tick.
 *   - When the LB has not assigned a backup (peer=undefined), no
 *     `propagate:{peer}` set is created — the no-peer path is silent.
 */

import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, MutableHashMap, Option } from "effect"
import { TestClock } from "effect/testing"
import {
  AtomicWriter,
  DEFAULT_PROPAGATE_SET_TTL_SEC,
  type AtomicWriteResult,
  type MemoryStore,
  type MemoryStoreEntry,
} from "../../src/replication/AtomicWriter.js"
import { PropagateStream } from "../../src/replication/PropagateStream.js"

const setupMemory = () => {
  const store = MutableHashMap.empty<string, MemoryStoreEntry>()
  const writer = AtomicWriter.makeMemoryUnsafe(store)
  return { store, writer }
}

const readSet = (store: MemoryStore, peer: string): Record<string, number> => {
  const opt = MutableHashMap.get(store, AtomicWriter.propagateSetKey(peer))
  if (Option.isNone(opt)) return {}
  const parsed = JSON.parse(opt.value.value) as { entries?: Record<string, number> }
  return parsed.entries ?? {}
}

const setExpiresAtMs = (
  store: MemoryStore,
  peer: string
): number | null => {
  const opt = MutableHashMap.get(store, AtomicWriter.propagateSetKey(peer))
  return Option.isSome(opt) ? opt.value.expiresAtMs : null
}

describe("AtomicWriter (memory) — propagate ZADD compaction", () => {
  it.effect("50 writes against one callRef leave exactly one member with the latest seq", () =>
    Effect.gen(function* () {
      const { store, writer } = setupMemory()
      let lastResult: AtomicWriteResult | null = null
      for (let i = 0; i < 50; i++) {
        const result = yield* writer.put(
          "pri",
          "worker-A",
          "call-1",
          `{"i":${i}}`,
          ["leg:CID|tag"],
          60,
          { peer: "worker-B" }
        )
        lastResult = result
      }
      const set = readSet(store, "worker-B")
      // Slice 2.4: members are direction-tagged (`f:` for forward).
      // 50 forward writes still compact to a single member.
      expect(Object.keys(set)).toEqual(["f:call-1"])
      expect(set["f:call-1"]).toBe(50)
      expect(lastResult).not.toBeNull()
      expect(lastResult!.seq).toBe(50)
    })
  )

  it.effect("distinct callRefs each get their own member; seq is shared per peer-direction", () =>
    Effect.gen(function* () {
      const { store, writer } = setupMemory()
      yield* writer.put("pri", "worker-A", "ref-1", "{}", [], 60, {
        peer: "worker-B",
      })
      yield* writer.put("pri", "worker-A", "ref-2", "{}", [], 60, {
        peer: "worker-B",
      })
      yield* writer.put("pri", "worker-A", "ref-1", "{}", [], 60, {
        peer: "worker-B",
      })
      const set = readSet(store, "worker-B")
      expect(set["f:ref-1"]).toBe(3)
      expect(set["f:ref-2"]).toBe(2)
    })
  )

  it.effect("a peer-less write leaves no propagate set behind", () =>
    Effect.gen(function* () {
      const { store, writer } = setupMemory()
      const result = yield* writer.put(
        "pri",
        "worker-A",
        "call-1",
        "{}",
        ["leg:abc"],
        60
      )
      expect(result).toBeNull()
      // No propagate:* keys exist in the store.
      let propagateKeyCount = 0
      for (const [k] of store) {
        if (k.startsWith("propagate:") || k.startsWith("propagate_seq:")) {
          propagateKeyCount++
        }
      }
      expect(propagateKeyCount).toBe(0)
    })
  )

  it.effect("sliding TTL: every write extends the propagate set's expiry", () =>
    Effect.gen(function* () {
      const { store, writer } = setupMemory()

      yield* writer.put("pri", "worker-A", "call-1", "{}", [], 60, {
        peer: "worker-B",
      })
      const t0 = setExpiresAtMs(store, "worker-B")!
      // Advance time but stay within the set TTL window so the next
      // write actually extends a live set rather than creating a fresh one.
      yield* TestClock.adjust(Duration.minutes(30))
      yield* writer.put("pri", "worker-A", "call-1", "{}", [], 60, {
        peer: "worker-B",
      })
      const t1 = setExpiresAtMs(store, "worker-B")!
      // Sliding TTL: the absolute expiry advanced by ~30 minutes.
      expect(t1).toBeGreaterThan(t0)
      expect(t1 - t0).toBeGreaterThanOrEqual(Duration.toMillis(Duration.minutes(29)))
    })
  )

  it.effect("propagate set expires when no write occurs within the TTL window", () => {
    const { store, writer } = setupMemory()
    return Effect.gen(function* () {
      yield* writer.put("pri", "worker-A", "call-1", "{}", [], 60, {
        peer: "worker-B",
      })
      // Advance past the default sliding TTL.
      yield* TestClock.adjust(
        Duration.seconds(DEFAULT_PROPAGATE_SET_TTL_SEC + 1)
      )
      // PropagateStream.read goes through the sweep-on-touch path that
      // mirrors Redis' lazy TTL eviction; once swept, the set is gone.
      const stream = yield* PropagateStream
      const entries = yield* stream.read("worker-B", 0)
      expect(entries).toEqual([])
    }).pipe(Effect.provide(PropagateStream.memoryLayerFromStore(store)))
  })
})

describe("PropagateStream — read-side over the same store", () => {
  it.effect("read returns all entries above sinceSeq in seq-ascending order", () => {
    const { store, writer } = setupMemory()
    return Effect.gen(function* () {
      yield* writer.put("pri", "worker-A", "ref-A", "{}", [], 60, {
        peer: "worker-B",
      })
      yield* writer.put("pri", "worker-A", "ref-B", "{}", [], 60, {
        peer: "worker-B",
      })
      yield* writer.put("pri", "worker-A", "ref-C", "{}", [], 60, {
        peer: "worker-B",
      })

      const stream = yield* PropagateStream
      const entries = yield* stream.read("worker-B", 0)
      expect(entries.map((e) => e.callRef)).toEqual(["ref-A", "ref-B", "ref-C"])
      expect(entries.map((e) => e.seq)).toEqual([1, 2, 3])

      const tail = yield* stream.read("worker-B", 1)
      expect(tail.map((e) => e.callRef)).toEqual(["ref-B", "ref-C"])
    }).pipe(Effect.provide(PropagateStream.memoryLayerFromStore(store)))
  })

  it.effect("head returns the largest seq currently in the set", () => {
    const { store, writer } = setupMemory()
    return Effect.gen(function* () {
      yield* writer.put("pri", "worker-A", "ref-A", "{}", [], 60, {
        peer: "worker-B",
      })
      yield* writer.put("pri", "worker-A", "ref-B", "{}", [], 60, {
        peer: "worker-B",
      })
      const stream = yield* PropagateStream
      const head = yield* stream.head("worker-B")
      expect(head).toBe(2)
    }).pipe(Effect.provide(PropagateStream.memoryLayerFromStore(store)))
  })

  it.effect("head returns 0 when the set is empty / never written", () => {
    const { store } = setupMemory()
    return Effect.gen(function* () {
      const stream = yield* PropagateStream
      expect(yield* stream.head("worker-B")).toBe(0)
    }).pipe(Effect.provide(PropagateStream.memoryLayerFromStore(store)))
  })
})

describe("Slice 2.4 — direction-tagged propagate members", () => {
  it.effect("forward and reverse writes for the same callRef coexist as distinct members", () =>
    Effect.gen(function* () {
      const { store, writer } = setupMemory()
      // Forward: this worker is primary for "call-1" with backup "worker-B".
      yield* writer.put("pri", "worker-A", "call-1", "{}", [], 60, {
        peer: "worker-B",
        direction: "forward",
      })
      // Reverse: this worker is acting as backup for some other primary
      // "worker-Z" on a different call "call-Z", propagating back so
      // worker-Z recovers it on reboot.
      yield* writer.put("bak", "worker-Z", "call-Z", "{}", [], 60, {
        peer: "worker-Z",
        direction: "reverse",
      })
      const setB = readSet(store, "worker-B")
      const setZ = readSet(store, "worker-Z")
      expect(setB["f:call-1"]).toBe(1)
      expect(setZ["r:call-Z"]).toBe(1)
    })
  )

  it.effect("PropagateStream.read surfaces direction decoded from the member prefix", () =>
    Effect.gen(function* () {
      const { store, writer } = setupMemory()
      yield* writer.put("pri", "worker-A", "fwd-1", "{}", [], 60, {
        peer: "worker-B",
        direction: "forward",
      })
      yield* writer.put("bak", "worker-B", "rev-1", "{}", [], 60, {
        peer: "worker-B",
        direction: "reverse",
      })
      yield* Effect.provide(
        Effect.gen(function* () {
          const stream = yield* PropagateStream
          const entries = yield* stream.read("worker-B", 0)
          // Both entries are present; each carries its decoded direction.
          const byRef = new Map(entries.map((e) => [e.callRef, e]))
          expect(byRef.get("fwd-1")?.direction).toBe("forward")
          expect(byRef.get("rev-1")?.direction).toBe("reverse")
          expect(byRef.get("fwd-1")?.seq).toBe(1)
          expect(byRef.get("rev-1")?.seq).toBe(2)
        }),
        PropagateStream.memoryLayerFromStore(store)
      )
    })
  )
})
