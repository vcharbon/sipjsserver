/**
 * Slice 4 — ReplPuller convergence + re-entrancy.
 *
 * Asserts:
 *   - Pulling a peer's `/replog` stream applies every entry to the
 *     local sidecar's `bak:{peer}:` partition.
 *   - `replpos:{peer}` advances per-entry; a second pull resumes from
 *     `lastSeq` and skips already-applied entries (idempotent).
 *   - Epoch advance on the producer triggers a full resync (lastSeq=0
 *     reset) on the consumer.
 *
 * Producer side: a real ReplLog wired to a producer-side store. The
 * test pipes `replLog.stream(...)` directly into the puller's
 * `applyStream` — no HTTP, no socket, but the wire format is the
 * actual NDJSON the production HTTP path would carry.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, MutableHashMap, Option, Stream } from "effect"
import {
  AtomicWriter,
  type MemoryStore,
  type MemoryStoreEntry,
} from "../../src/replication/AtomicWriter.js"
import { EpochCounter } from "../../src/replication/EpochCounter.js"
import { PropagateStream } from "../../src/replication/PropagateStream.js"
import { ReplLog } from "../../src/replication/ReplLog.js"
import { ReplPuller } from "../../src/replication/ReplPuller.js"
import { WriteNotifier } from "../../src/replication/WriteNotifier.js"
import { PartitionedRelayStorage } from "../../src/cache/PartitionedRelayStorage.js"

const setupProducer = (owner: string) => {
  const handle = PartitionedRelayStorage.makeMemoryApi()
  const store = handle.store
  const StorageLayer = Layer.sync(
    PartitionedRelayStorage,
    () => handle.api
  )
  const ReadServices = Layer.mergeAll(
    WriteNotifier.layer,
    StorageLayer,
    PropagateStream.memoryLayerFromStore(store),
    EpochCounter.memoryLayerFromStore(store, owner)
  )
  const ReplStack = AtomicWriter.memoryLayerFromStore(store).pipe(
    Layer.provideMerge(ReadServices)
  )
  return {
    store,
    layer: ReplLog.layer.pipe(Layer.provideMerge(ReplStack)),
  }
}

const consumerStore = (): MemoryStore =>
  MutableHashMap.empty<string, MemoryStoreEntry>()

describe("ReplPuller — apply backlog from a peer's /replog stream", () => {
  it.effect("drains the producer's backlog and writes bak: entries on the consumer", () => {
    const producer = setupProducer("worker-A")
    const consumer = consumerStore()
    const consumerWriter = AtomicWriter.makeMemoryUnsafe(consumer)
    const puller = ReplPuller.makeMemoryUnsafe(consumer, consumerWriter, "worker-B")

    return Effect.gen(function* () {
      const writer = yield* AtomicWriter
      yield* writer.put("pri", "worker-A", "ref-1", '{"v":1}', [], 60, {
        peer: "worker-B",
      })
      yield* writer.put("pri", "worker-A", "ref-2", '{"v":2}', [], 60, {
        peer: "worker-B",
      })
      yield* writer.put("pri", "worker-A", "ref-3", '{"v":3}', [], 60, {
        peer: "worker-B",
      })

      const replLog = yield* ReplLog
      const upstream = replLog.stream("worker-B", 0, { drainOnly: true })
      const result = yield* puller.applyStream("worker-A", upstream)

      expect(result.framesApplied).toBe(3)
      expect(result.caughtUpAtSeq).toBe(3)

      // Consumer's bak:worker-A:call:* partition is populated.
      const bak1 = MutableHashMap.get(
        consumer,
        AtomicWriter.callKey("bak", "worker-A", "ref-1")
      )
      expect(Option.isSome(bak1)).toBe(true)
      expect(Option.isSome(bak1) ? bak1.value.value : "").toContain('"v":1')

      // replpos:worker-A persisted with lastSeq=3.
      const pos = yield* puller.readPos("worker-A")
      expect(pos.lastSeq).toBe(3)
    }).pipe(Effect.provide(producer.layer))
  })

  it.effect("resume: a second pull starts at lastSeq and skips already-applied entries", () => {
    const producer = setupProducer("worker-A")
    const consumer = consumerStore()
    const consumerWriter = AtomicWriter.makeMemoryUnsafe(consumer)
    const puller = ReplPuller.makeMemoryUnsafe(consumer, consumerWriter, "worker-B")

    return Effect.gen(function* () {
      const writer = yield* AtomicWriter
      const replLog = yield* ReplLog

      // Round 1 — write 2 entries, pull, verify state.
      yield* writer.put("pri", "worker-A", "ref-1", "{}", [], 60, {
        peer: "worker-B",
      })
      yield* writer.put("pri", "worker-A", "ref-2", "{}", [], 60, {
        peer: "worker-B",
      })
      const r1 = yield* puller.applyStream(
        "worker-A",
        replLog.stream("worker-B", 0, { drainOnly: true })
      )
      expect(r1.framesApplied).toBe(2)

      // Round 2 — write 2 more, pull resuming from lastSeq=2.
      yield* writer.put("pri", "worker-A", "ref-3", "{}", [], 60, {
        peer: "worker-B",
      })
      yield* writer.put("pri", "worker-A", "ref-4", "{}", [], 60, {
        peer: "worker-B",
      })
      const pos = yield* puller.readPos("worker-A")
      const r2 = yield* puller.applyStream(
        "worker-A",
        replLog.stream("worker-B", pos.lastSeq, { drainOnly: true })
      )
      // Only the new entries (seq 3 and 4) are applied this round.
      expect(r2.framesApplied).toBe(2)
      const finalPos = yield* puller.readPos("worker-A")
      expect(finalPos.lastSeq).toBe(4)
    }).pipe(Effect.provide(producer.layer))
  })

  it.effect("idempotent re-apply: replaying an entry whose seq <= lastSeq is a no-op", () => {
    const producer = setupProducer("worker-A")
    const consumer = consumerStore()
    const consumerWriter = AtomicWriter.makeMemoryUnsafe(consumer)
    const puller = ReplPuller.makeMemoryUnsafe(consumer, consumerWriter, "worker-B")

    return Effect.gen(function* () {
      const writer = yield* AtomicWriter
      yield* writer.put("pri", "worker-A", "ref-1", "{}", [], 60, {
        peer: "worker-B",
      })
      const replLog = yield* ReplLog

      // First pull — applies the single entry.
      const r1 = yield* puller.applyStream(
        "worker-A",
        replLog.stream("worker-B", 0, { drainOnly: true })
      )
      expect(r1.framesApplied).toBe(1)

      // Second pull from since=0 — same entry replayed; lastSeq guards
      // it as a no-op (framesApplied=0).
      const r2 = yield* puller.applyStream(
        "worker-A",
        replLog.stream("worker-B", 0, { drainOnly: true })
      )
      expect(r2.framesApplied).toBe(0)
    }).pipe(Effect.provide(producer.layer))
  })
})

describe("ReplPuller — bak-side index reconstruction", () => {
  it.effect("idx:leg:{callId}|{tag} keys are stamped on the consumer when a Call body is streamed", () => {
    const producer = setupProducer("worker-A")
    const consumer = consumerStore()
    const consumerWriter = AtomicWriter.makeMemoryUnsafe(consumer)
    const puller = ReplPuller.makeMemoryUnsafe(consumer, consumerWriter, "worker-B")

    // Minimal Call-shaped JSON exercising every index-key branch
    // `callIndexKeys` produces: a-leg leg, b-leg leg+tag, b-leg
    // call-id, b-leg dialog remoteTag, callbackContext.
    const callRef = "worker-A|cid-A|tag-A"
    const callBody = {
      callRef,
      aLeg: { callId: "cid-A", fromTag: "tag-A" },
      bLegs: [
        {
          callId: "cid-B",
          fromTag: "tag-B",
          dialogs: [{ sip: { remoteTag: "rtag-B" } }],
        },
      ],
      callbackContext: "ctx-Z",
    }

    return Effect.gen(function* () {
      const writer = yield* AtomicWriter
      yield* writer.put(
        "pri",
        "worker-A",
        callRef,
        JSON.stringify(callBody),
        // primary's own index keys — the producer's idx:* set is
        // irrelevant to this test; we only check what arrives on the
        // consumer via the puller.
        ["leg:cid-A|tag-A"],
        60,
        { peer: "worker-B" }
      )

      const replLog = yield* ReplLog
      const result = yield* puller.applyStream(
        "worker-A",
        replLog.stream("worker-B", 0, { drainOnly: true })
      )
      expect(result.framesApplied).toBe(1)

      // Consumer's bak: partition has the call body...
      const bakBody = MutableHashMap.get(
        consumer,
        AtomicWriter.callKey("bak", "worker-A", callRef)
      )
      expect(Option.isSome(bakBody)).toBe(true)

      // ...AND every flat idx:* entry callIndexKeysFromUnknown derives
      // from the body, each pointing at the callRef. This is the
      // property `resolveFromSipKey` relies on for in-dialog routing
      // on a backup worker (see docs/plan/bye-takeover-replicated-
      // indexes-fix.md Slice A).
      for (const idxKey of [
        "leg:cid-A|tag-A",
        "leg:cid-B|tag-B",
        "leg:cid-B",
        "leg:cid-B|rtag-B",
        "ctx:ctx-Z",
      ]) {
        const idx = MutableHashMap.get(consumer, AtomicWriter.indexKey(idxKey))
        expect(Option.isSome(idx)).toBe(true)
        if (Option.isSome(idx)) expect(idx.value.value).toBe(callRef)
      }
    }).pipe(Effect.provide(producer.layer))
  })

  it.effect("delete frames remove the bak: idx:* entries written by the prior put", () => {
    const producer = setupProducer("worker-A")
    const consumer = consumerStore()
    const consumerWriter = AtomicWriter.makeMemoryUnsafe(consumer)
    const puller = ReplPuller.makeMemoryUnsafe(consumer, consumerWriter, "worker-B")

    const callRef = "worker-A|cid-A|tag-A"
    const callBody = {
      callRef,
      aLeg: { callId: "cid-A", fromTag: "tag-A" },
      bLegs: [],
    }

    return Effect.gen(function* () {
      const writer = yield* AtomicWriter
      const replLog = yield* ReplLog

      // Round 1 — put. After this, bak:worker-A:call:{callRef} +
      // idx:leg:cid-A|tag-A are on the consumer.
      yield* writer.put(
        "pri",
        "worker-A",
        callRef,
        JSON.stringify(callBody),
        [],
        60,
        { peer: "worker-B" }
      )
      yield* puller.applyStream(
        "worker-A",
        replLog.stream("worker-B", 0, { drainOnly: true })
      )
      expect(
        Option.isSome(
          MutableHashMap.get(consumer, AtomicWriter.indexKey("leg:cid-A|tag-A"))
        )
      ).toBe(true)

      // Round 2 — delete. The puller should DEL the idx:* entry it
      // previously stamped, not just the call body.
      yield* writer.delete("pri", "worker-A", callRef, [], {
        peer: "worker-B",
      })
      const pos = yield* puller.readPos("worker-A")
      yield* puller.applyStream(
        "worker-A",
        replLog.stream("worker-B", pos.lastSeq, { drainOnly: true })
      )

      expect(
        Option.isSome(
          MutableHashMap.get(consumer, AtomicWriter.callKey("bak", "worker-A", callRef))
        )
      ).toBe(false)
      expect(
        Option.isSome(
          MutableHashMap.get(consumer, AtomicWriter.indexKey("leg:cid-A|tag-A"))
        )
      ).toBe(false)
    }).pipe(Effect.provide(producer.layer))
  })
})

describe("ReplPuller — epoch mismatch resync", () => {
  it.effect("a hello with a different epoch resets lastSeq to 0", () => {
    const producer = setupProducer("worker-A")
    const consumer = consumerStore()
    const consumerWriter = AtomicWriter.makeMemoryUnsafe(consumer)
    const puller = ReplPuller.makeMemoryUnsafe(consumer, consumerWriter, "worker-B")

    return Effect.gen(function* () {
      const writer = yield* AtomicWriter
      const replLog = yield* ReplLog

      // Seed an entry under the current epoch, pull, verify.
      yield* writer.put("pri", "worker-A", "ref-1", "{}", [], 60, {
        peer: "worker-B",
      })
      yield* puller.applyStream(
        "worker-A",
        replLog.stream("worker-B", 0, { drainOnly: true })
      )
      const pos1 = yield* puller.readPos("worker-A")
      expect(pos1.epoch).toBeGreaterThan(0)
      expect(pos1.lastSeq).toBe(1)

      // Forge a stale replpos with the wrong epoch — simulates the
      // case where the producer rebooted (epoch advanced) but our
      // bookkeeping still references the old incarnation.
      MutableHashMap.set(consumer, "replpos:worker-A", {
        value: JSON.stringify({ epoch: 99, lastSeq: 5 }),
        expiresAtMs: Number.MAX_SAFE_INTEGER,
      })

      // Pull again — the hello frame's epoch differs from 99, so the
      // puller resets lastSeq=0 and re-applies the entry from seq=0.
      const r = yield* puller.applyStream(
        "worker-A",
        replLog.stream("worker-B", 0, { drainOnly: true })
      )
      const pos2 = yield* puller.readPos("worker-A")
      expect(pos2.epoch).toBe(pos1.epoch) // adopted producer's epoch
      // After resync, the entry was re-applied (lastSeq=1).
      expect(pos2.lastSeq).toBe(1)
      // framesApplied = 1 because the reset made the seq>lastSeq check pass again.
      expect(r.framesApplied).toBe(1)
    }).pipe(Effect.provide(producer.layer))
  })
})

describe("Slice 2.5 — reverse-direction apply lands in pri:{self}:", () => {
  it.effect(
    "a peer acting as backup-on-our-behalf propagates updates that the consumer applies to pri:{self}:",
    () => {
      // Scenario: the local worker (consumer, "worker-A") was the
      // call's primary. While it was down, peer "worker-B" served
      // requests as backup, writing into bak:worker-A: on its own
      // sidecar and ZADDing reverse-direction entries into
      // propagate:worker-A on its own sidecar. Now worker-A is back
      // up, opens /replog?caller=worker-A against worker-B, and
      // drains. The reverse entries must land in
      // pri:worker-A:call:{ref} on worker-A's sidecar (single-owner
      // invariant: backup never moves the call into its own pri:).
      const producer = setupProducer("worker-B")
      const consumer = consumerStore()
      const consumerWriter = AtomicWriter.makeMemoryUnsafe(consumer)
      const puller = ReplPuller.makeMemoryUnsafe(
        consumer,
        consumerWriter,
        "worker-A"
      )

      // Minimal Call-shaped JSON so callIndexKeysFromUnknown produces
      // a deterministic index list on apply.
      const callRef = "worker-A|cid-A|tag-A"
      const callBody = {
        callRef,
        aLeg: { callId: "cid-A", fromTag: "tag-A" },
        bLegs: [],
      }

      return Effect.gen(function* () {
        const writer = yield* AtomicWriter
        // worker-B writes the call's authoritative state into its own
        // bak:worker-A: partition (it is acting as backup for worker-A's
        // primary call) and announces the update to worker-A via a
        // reverse-direction entry in propagate:worker-A.
        yield* writer.put(
          "bak",
          "worker-A",
          callRef,
          JSON.stringify(callBody),
          [],
          60,
          { peer: "worker-A", direction: "reverse" }
        )

        // worker-A drains worker-B's /replog?caller=worker-A.
        const replLog = yield* ReplLog
        const result = yield* puller.applyStream(
          "worker-B",
          replLog.stream("worker-A", 0, { drainOnly: true })
        )
        expect(result.framesApplied).toBe(1)

        // Reverse entry landed in worker-A's own pri: partition.
        const priBody = MutableHashMap.get(
          consumer,
          AtomicWriter.callKey("pri", "worker-A", callRef)
        )
        expect(Option.isSome(priBody)).toBe(true)

        // It did NOT land in bak:worker-B: (that would be the forward
        // direction's target).
        const bakBody = MutableHashMap.get(
          consumer,
          AtomicWriter.callKey("bak", "worker-B", callRef)
        )
        expect(Option.isSome(bakBody)).toBe(false)
      }).pipe(Effect.provide(producer.layer))
    }
  )

  it.effect(
    "forward and reverse entries from the same peer route to different partitions on the consumer",
    () => {
      const producer = setupProducer("worker-B")
      const consumer = consumerStore()
      const consumerWriter = AtomicWriter.makeMemoryUnsafe(consumer)
      const puller = ReplPuller.makeMemoryUnsafe(
        consumer,
        consumerWriter,
        "worker-A"
      )

      const fwdRef = "worker-B|cid-F|tag-F"
      const revRef = "worker-A|cid-R|tag-R"
      const fwdBody = {
        callRef: fwdRef,
        aLeg: { callId: "cid-F", fromTag: "tag-F" },
        bLegs: [],
      }
      const revBody = {
        callRef: revRef,
        aLeg: { callId: "cid-R", fromTag: "tag-R" },
        bLegs: [],
      }

      return Effect.gen(function* () {
        const writer = yield* AtomicWriter
        // Forward: worker-B is primary for fwdRef, worker-A is its backup.
        yield* writer.put(
          "pri",
          "worker-B",
          fwdRef,
          JSON.stringify(fwdBody),
          [],
          60,
          { peer: "worker-A", direction: "forward" }
        )
        // Reverse: worker-B is acting as backup-on-behalf-of worker-A
        // for revRef.
        yield* writer.put(
          "bak",
          "worker-A",
          revRef,
          JSON.stringify(revBody),
          [],
          60,
          { peer: "worker-A", direction: "reverse" }
        )

        const replLog = yield* ReplLog
        const result = yield* puller.applyStream(
          "worker-B",
          replLog.stream("worker-A", 0, { drainOnly: true })
        )
        expect(result.framesApplied).toBe(2)

        // Forward landed in bak:worker-B: on worker-A.
        expect(
          Option.isSome(
            MutableHashMap.get(
              consumer,
              AtomicWriter.callKey("bak", "worker-B", fwdRef)
            )
          )
        ).toBe(true)
        // Reverse landed in pri:worker-A: on worker-A.
        expect(
          Option.isSome(
            MutableHashMap.get(
              consumer,
              AtomicWriter.callKey("pri", "worker-A", revRef)
            )
          )
        ).toBe(true)
      }).pipe(Effect.provide(producer.layer))
    }
  )
})
