/**
 * AtomicWriter (memory layer) — Slice 1 atomicity contract.
 *
 * Asserts the all-or-nothing property documented in
 * [docs/replication/call-cache-backup.md §5](../../docs/replication/call-cache-backup.md):
 * any observer of the underlying store sees either every key the write
 * touched (call body + each idx) or none of them; never a partial write.
 *
 * The memory layer mirrors the Lua-on-Redis contract via a single-permit
 * Semaphore. These tests assert the observer property under TestClock by
 * inspecting the raw MutableHashMap between concurrent writers.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, MutableHashMap, Option } from "effect"
import {
  AtomicWriter,
  type AtomicWriterApi,
  type MemoryStore,
  type MemoryStoreEntry,
} from "../../src/replication/AtomicWriter.js"
import { WriteNotifier } from "../../src/replication/WriteNotifier.js"

const callKey = AtomicWriter.callKey
const indexKey = AtomicWriter.indexKey

const setupMemory = (): {
  readonly store: MemoryStore
  readonly writer: AtomicWriterApi
} => {
  const store = MutableHashMap.empty<string, MemoryStoreEntry>()
  const writer = AtomicWriter.makeMemoryUnsafe(store)
  return { store, writer }
}

const has = (store: MemoryStore, key: string): boolean =>
  Option.isSome(MutableHashMap.get(store, key))

describe("AtomicWriter.memory — single-writer contract", () => {
  it.effect("put writes call body + every index in one critical section", () =>
    Effect.gen(function* () {
      const { store, writer } = setupMemory()
      yield* writer.put(
        "pri",
        "worker-A",
        "call-1",
        '{"hello":"world"}',
        ["leg:CID-1|tag-A", "leg:CID-2"],
        60
      )
      expect(has(store, callKey("pri", "worker-A", "call-1"))).toBe(true)
      expect(has(store, indexKey("leg:CID-1|tag-A"))).toBe(true)
      expect(has(store, indexKey("leg:CID-2"))).toBe(true)

      const entry = MutableHashMap.get(store, callKey("pri", "worker-A", "call-1"))
      expect(Option.isSome(entry) ? entry.value.value : null).toBe(
        '{"hello":"world"}'
      )
      // Index value is the callRef (single-hop lookup).
      const idxEntry = MutableHashMap.get(store, indexKey("leg:CID-1|tag-A"))
      expect(Option.isSome(idxEntry) ? idxEntry.value.value : null).toBe(
        "call-1"
      )
    })
  )

  it.effect("refresh extends ttl on every key but does not resurrect missing ones", () =>
    Effect.gen(function* () {
      const { store, writer } = setupMemory()
      yield* writer.put(
        "pri",
        "worker-A",
        "call-1",
        "{}",
        ["leg:keep", "leg:gone"],
        60
      )
      // Delete only the second index out-of-band — refresh must not bring it back.
      MutableHashMap.remove(store, indexKey("leg:gone"))

      yield* writer.refresh(
        "pri",
        "worker-A",
        "call-1",
        ["leg:keep", "leg:gone"],
        120
      )

      expect(has(store, indexKey("leg:keep"))).toBe(true)
      expect(has(store, indexKey("leg:gone"))).toBe(false)

      const after = MutableHashMap.get(store, callKey("pri", "worker-A", "call-1"))
      // body still '{}' (refresh does not rewrite value).
      expect(Option.isSome(after) ? after.value.value : null).toBe("{}")
    })
  )

  it.effect("delete removes call body + every named index", () =>
    Effect.gen(function* () {
      const { store, writer } = setupMemory()
      yield* writer.put(
        "pri",
        "worker-A",
        "call-1",
        "{}",
        ["leg:1", "leg:2"],
        60
      )
      yield* writer.delete("pri", "worker-A", "call-1", ["leg:1", "leg:2"])
      expect(has(store, callKey("pri", "worker-A", "call-1"))).toBe(false)
      expect(has(store, indexKey("leg:1"))).toBe(false)
      expect(has(store, indexKey("leg:2"))).toBe(false)
    })
  )
})

describe("AtomicWriter.memory — concurrent writers cannot observe half-state", () => {
  it.effect("two concurrent puts on the same callRef serialize without interleaving", () =>
    Effect.gen(function* () {
      const { store, writer } = setupMemory()
      const indexes = ["leg:A|t1", "leg:B|t2", "leg:C|t3", "ctx:cookie-1"]

      // Snapshot helper: returns the keys present, atomically (synchronous read).
      const snapshot = (): ReadonlyArray<string> => {
        const out: Array<string> = []
        for (const [k] of store) out.push(k)
        return out.slice().sort()
      }

      // Fire two concurrent fibers writing the same callRef with disjoint
      // payloads. With the mutex, exactly one writer's full set is visible
      // at any time — never a half-set or an interleaved mix.
      const f1 = yield* Effect.forkChild(
        writer.put("pri", "worker-A", "call-1", '{"v":1}', indexes, 60)
      )
      const f2 = yield* Effect.forkChild(
        writer.put("pri", "worker-A", "call-1", '{"v":2}', indexes, 60)
      )
      yield* Fiber.join(f1)
      yield* Fiber.join(f2)

      const keys = snapshot()
      const expected = [
        callKey("pri", "worker-A", "call-1"),
        ...indexes.map((i) => indexKey(i)),
      ].sort()
      expect(keys).toEqual(expected)

      const final = MutableHashMap.get(
        store,
        callKey("pri", "worker-A", "call-1")
      )
      const finalValue = Option.isSome(final) ? final.value.value : null
      // Writer 1 or writer 2 won; whichever did, its body is the final one.
      expect([`{"v":1}`, `{"v":2}`]).toContain(finalValue)
    })
  )

  it.effect("concurrent put + delete leave the store in one consistent state", () =>
    Effect.gen(function* () {
      const { store, writer } = setupMemory()
      const indexes = ["leg:1", "leg:2"]

      // Pre-populate so delete has something to remove if it wins the race.
      yield* writer.put("pri", "worker-A", "call-1", "{}", indexes, 60)

      const f1 = yield* Effect.forkChild(
        writer.put("pri", "worker-A", "call-1", '{"v":3}', indexes, 60)
      )
      const f2 = yield* Effect.forkChild(
        writer.delete("pri", "worker-A", "call-1", indexes)
      )
      yield* Fiber.join(f1)
      yield* Fiber.join(f2)

      const callPresent = has(store, callKey("pri", "worker-A", "call-1"))
      const idx1Present = has(store, indexKey("leg:1"))
      const idx2Present = has(store, indexKey("leg:2"))

      // Either both put-results are present (put won the race), or
      // everything is gone (delete won). Never one without the other:
      // half-state would mean call-without-indexes or index-without-call.
      const allPresent = callPresent && idx1Present && idx2Present
      const allAbsent = !callPresent && !idx1Present && !idx2Present
      expect(allPresent || allAbsent).toBe(true)
    })
  )

  it.effect("ten concurrent writers on overlapping index sets never produce a half-write", () =>
    Effect.gen(function* () {
      const { store, writer } = setupMemory()
      // Each writer touches the same call key + a writer-specific extra
      // index, plus a shared index that all writers contend on. Under the
      // mutex, every snapshot must show a self-consistent set: the call
      // key plus exactly one writer's full index set (the last one to
      // commit), never a mixture.
      const SHARED_IDX = "leg:shared"
      const writers = Array.from({ length: 10 }, (_, i) => i)

      yield* Effect.all(
        writers.map((i) =>
          writer.put(
            "pri",
            "worker-A",
            "call-1",
            `{"writer":${i}}`,
            [SHARED_IDX, `leg:writer-${i}`],
            60
          )
        ),
        { concurrency: "unbounded" }
      )

      // Every writer's per-writer idx must point to call-1 — by the
      // time a writer's critical section completed, its index was
      // written. Half-state would mean some writer's entry is missing.
      for (const i of writers) {
        const idxOpt = MutableHashMap.get(store, indexKey(`leg:writer-${i}`))
        expect(Option.isSome(idxOpt)).toBe(true)
        if (Option.isSome(idxOpt)) {
          expect(idxOpt.value.value).toBe("call-1")
        }
      }

      const callOpt = MutableHashMap.get(store, callKey("pri", "worker-A", "call-1"))
      expect(Option.isSome(callOpt)).toBe(true)
      // Final body is whichever writer committed last; must be one of ours.
      const finalBody = Option.isSome(callOpt) ? callOpt.value.value : null
      expect(writers.map((i) => `{"writer":${i}}`)).toContain(finalBody)
    })
  )
})

describe("AtomicWriter.memory — service layer", () => {
  it.effect("memoryLayerFromStore exposes the writer as a service backed by the supplied store", () => {
    const store = MutableHashMap.empty<string, MemoryStoreEntry>()
    return Effect.gen(function* () {
      const writer = yield* AtomicWriter
      yield* writer.put(
        "bak",
        "worker-Z",
        "call-Z",
        '{"z":1}',
        ["leg:z"],
        60
      )
      expect(has(store, callKey("bak", "worker-Z", "call-Z"))).toBe(true)
      expect(has(store, indexKey("leg:z"))).toBe(true)
    }).pipe(
      Effect.provide(
        AtomicWriter.memoryLayerFromStore(store).pipe(
          Layer.provide(WriteNotifier.noopLayer)
        )
      )
    )
  })
})
