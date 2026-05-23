/**
 * Pins the post-redesign invariants for the replication apply path
 * (docs/plan/lets-plan-a-proper-crystalline-emerson.md).
 *
 * Two pillars:
 *
 *   1. **No mirror echo.** After any number of applies, the apply
 *      path MUST NOT have written to the puller's outgoing channel.
 *      Echo is gone because it was both wire noise (warm pullers
 *      skip gen=0 by lex-order) AND a correctness bug — the
 *      "update/delete crossing" scenario: when originator A wrote
 *      UPDATE(X) then DELETE(X), peer B applied UPDATE and echoed
 *      it back to A; A's puller, having already DELETE'd locally,
 *      saw `local=null` for the echo and re-applied it as a
 *      create-if-not-exist, **silently resurrecting the deleted call.**
 *      The "no apply writes to outgoing channel" assertion is what
 *      structurally prevents this from being reachable.
 *
 *   2. **Local-state correctness.** After a DELETE, the body slot
 *      AND every derived idx:* entry MUST be absent — the
 *      resolveFromSipKey hot path relies on idx lookup missing to
 *      drop late retransmits cleanly.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, MutableHashMap } from "effect"
import { ChannelIndex } from "../../src/replication/ChannelIndex.js"
import { makeReplicationApply } from "../../src/replication/EchoApply.js"
import type { DataFrame } from "../../src/replication/ReplicationProtocol.js"
import { bodyBuf } from "../support/codecHelpers.js"
import {
  KvBackend,
  type MemoryStoreEntry,
} from "../../src/storage/KvBackend.js"

const SELF = "worker-B"
const SOURCE = "worker-A"
const SELF_GEN = 11
const COLD = { gen: 0, counter: 0 } as const

const setup = () => {
  const store = MutableHashMap.empty<string, MemoryStoreEntry>()
  const kv = KvBackend.makeMemoryUnsafe(store)
  // Independently constructed outgoing channel — used only to assert
  // the apply path does NOT write to it.
  const outgoing = ChannelIndex.make(
    { self: SELF, peer: SOURCE, gen: SELF_GEN },
    kv,
  )
  const apply = makeReplicationApply({
    bodyTtlSec: 60,
    localKv: kv,
    self: SELF,
    source: SOURCE,
  })
  return { kv, outgoing, apply }
}

const frame = (
  callRef: string,
  topologyGen: number,
  counter: number,
  op: "update" | "delete" = "update",
): DataFrame => ({
  _tag: "Data",
  gen: 1,
  counter,
  op,
  partition: "pri",
  callRef,
  body: op === "delete"
    ? null
    : bodyBuf({ _topology: { gen: topologyGen }, name: callRef }),
  body_ttl_remaining_sec: op === "delete" ? 0 : 60,
  latency_ms: 0,
  callGen: topologyGen,
  indexes: [],
})

describe("apply path — no echo + update/delete crossing safety", () => {
  it.effect(
    "no apply writes to the outgoing channel — independent of frame mix",
    () =>
      Effect.gen(function* () {
        const { outgoing, apply } = setup()
        yield* apply(frame("X", 1, 1))
        yield* apply(frame("Y", 1, 2))
        yield* apply(frame("X", 2, 3))
        yield* apply(frame("X", 0, 4, "delete"))
        yield* apply(frame("Y", 0, 5, "delete"))

        const batch = yield* outgoing.pullBatch(COLD, 1024)
        expect(batch.entries.length).toBe(0)
      }),
  )

  it.effect(
    "delete hard-DELs local body + every cached index (hot-path resolveFromSipKey load-bearing invariant)",
    () =>
      Effect.gen(function* () {
        const { kv, apply } = setup()
        const seed: DataFrame = {
          _tag: "Data",
          gen: 1,
          counter: 1,
          op: "update",
          partition: "pri",
          callRef: "call-with-indexes",
          body: bodyBuf({
            _topology: { gen: 1 },
            aLeg: { callId: "cid1", fromTag: "ftag1", dialogs: [] },
            bLegs: [],
          }),
          body_ttl_remaining_sec: 60,
          latency_ms: 0,
          callGen: 1,
          indexes: ["leg:cid1|ftag1"],
        }
        yield* apply(seed)
        expect(
          yield* kv.bodyGet(`bak:${SOURCE}:call:call-with-indexes`),
        ).not.toBeNull()
        expect(
          (yield* kv.bodyGet(`idx:leg:cid1|ftag1`))?.toString("utf8"),
        ).toBe("call-with-indexes")

        const tomb: DataFrame = {
          _tag: "Data",
          gen: 1,
          counter: 2,
          op: "delete",
          partition: "pri",
          callRef: "call-with-indexes",
          body: null,
          body_ttl_remaining_sec: 0,
          latency_ms: 0,
          callGen: 1,
          indexes: ["leg:cid1|ftag1"],
        }
        yield* apply(tomb)

        expect(
          yield* kv.bodyGet(`bak:${SOURCE}:call:call-with-indexes`),
        ).toBeNull()
        expect(yield* kv.bodyGet(`idx:leg:cid1|ftag1`)).toBeNull()
      }),
  )

})
