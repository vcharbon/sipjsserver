/**
 * ReclaimRunner — hard timeout + 481 fall-through.
 *
 * Asserts D14: when `reclaim.maxDuration` fires before the reclaim
 * completes, the runner:
 *   1. Logs a warning (not asserted; behavior verified by branch).
 *   2. Marks the worker `ready=true` anyway, so K8s starts routing.
 *   3. Returns `timedOut=true` with whatever counts were accumulated
 *      up to that moment.
 *
 * The 481 Call/Transaction Does Not Exist response itself is the
 * pre-existing `CallState.checkout`-returns-undefined fall-through —
 * not new code in slice 6. We assert it indirectly by confirming the
 * un-recovered call is NOT in local storage after the timeout, so a
 * subsequent in-dialog request lookup would hit the fall-through.
 */

import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { AppConfig, type AppConfigData } from "../../src/config/AppConfig.js"
import { PartitionedRelayStorage } from "../../src/cache/PartitionedRelayStorage.js"
import { PeerFabric } from "../../src/cache/PeerFabric.js"
import { WorkerOrdinal } from "../../src/cache/PeerCachePort.js"
import { PeerEnumerator } from "../../src/cache/PeerEnumerator.js"
import { WorkerReadiness } from "../../src/cache/WorkerReadiness.js"
import { ReclaimRunner } from "../../src/cache/ReclaimRunner.js"
import { CallLimiter } from "../../src/call/CallLimiter.js"
import { CallState } from "../../src/call/CallState.js"
import {
  Call as CallSchema,
  callIndexKeys,
  deriveCallRef,
  type Call,
  type Leg,
} from "../../src/call/CallModel.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"
import { NoOpCdrLayer } from "../support/networkLeaves.js"

const A = WorkerOrdinal("A")
const B = WorkerOrdinal("B")

const JsonCallSchema = Schema.fromJsonString(CallSchema)

const makeLeg = (callId: string, fromTag: string): Leg => ({
  legId: "a",
  callId,
  fromTag,
  source: { address: "127.0.0.1", port: 5060 },
  state: "trying",
  disposition: "pending",
  dialogs: [],
})

const makeCall = (
  primary: WorkerOrdinal,
  backup: WorkerOrdinal,
  callId: string,
  fromTag: string,
  gen = 1
): Call => ({
  callRef: deriveCallRef(primary, callId, fromTag),
  aLeg: makeLeg(callId, fromTag),
  bLegs: [],
  activePeer: null,
  limiterEntries: [],
  timers: [],
  cdrEvents: [],
  state: "active",
  createdAt: 0,
  aLegInvite: {
    uri: "sip:test@example.com",
    headers: [],
    body: new Uint8Array(),
  },
  tagMap: [],
  _topology: { pri: primary, bak: backup, gen },
})

const harnessBuilt = (
  self: WorkerOrdinal,
  workers: ReadonlyArray<WorkerOrdinal>,
  reclaimOpts?: Partial<{
    maxDuration: Duration.Duration
    peerConcurrency: number
    scanBatch: number
    scanPacingMs: number
  }>
) => {
  const fabricBuilt = PeerFabric.simulatedBuilt(workers)
  const config: AppConfigData = testAppConfigDefaults({
    workerOrdinalLabel: self,
  })
  const AppConfigLayer = Layer.succeed(AppConfig, config)
  const StorageLayer = fabricBuilt.fabric.storageLayerOf(self)
  const PortLayer = fabricBuilt.fabric.cachePortLayerOf(self)
  const ReadinessLayer = WorkerReadiness.Default
  const EnumeratorLayer = PeerEnumerator.fromFabric(fabricBuilt, self)

  const ReclaimLayer = ReclaimRunner.layer(reclaimOpts).pipe(
    Layer.provide(ReadinessLayer),
    Layer.provide(EnumeratorLayer),
    Layer.provide(StorageLayer),
    Layer.provide(PortLayer),
    Layer.provide(AppConfigLayer)
  )

  const layer = Layer.mergeAll(
    ReclaimLayer,
    ReadinessLayer,
    StorageLayer,
    fabricBuilt.layer
  )
  return { layer, fabricBuilt }
}

describe("ReclaimRunner — hard timeout (D14)", () => {
  it.effect("maxDuration fires → timedOut=true, ready flipped, no recovery", () =>
    Effect.gen(function* () {
      // Tight maxDuration. Peer is given 60s of latency so the scan
      // dispatch sleeps far past the deadline. Reclaim must time out
      // BEFORE A's scan returns.
      const { layer, fabricBuilt } = harnessBuilt(B, [A, B], {
        maxDuration: Duration.seconds(1),
        scanPacingMs: 0,
      })

      // Seed peer A with an entry that *would* be recovered if the
      // scan completed — we use it to assert "not recovered" later.
      const call = makeCall(B, A, "cid-stuck", "ft-stuck", 1)
      const json = yield* Schema.encodeEffect(JsonCallSchema)(call).pipe(
        Effect.orDie
      )
      yield* Effect.gen(function* () {
        const storage = yield* PartitionedRelayStorage
        yield* storage.putCall(
          "bak",
          B,
          call.callRef,
          json,
          callIndexKeys(call),
          600
        )
      }).pipe(Effect.provide(fabricBuilt.fabric.storageLayerOf(A)))

      // Massive latency on A — the scan dispatch will park for 60s.
      yield* fabricBuilt.control.setLatency(A, 60_000)

      // Run everything inside ONE provide(layer) so the same
      // WorkerReadiness instance answers before/during/after the run.
      const { result, readyAfter } = yield* Effect.gen(function* () {
        const readiness = yield* WorkerReadiness
        const runner = yield* ReclaimRunner

        const fiber = yield* Effect.forkChild(runner.run)

        // Advance virtual time past maxDuration but BEFORE the
        // latency would unblock. The timeout should fire.
        yield* TestClock.adjust(Duration.seconds(2))
        yield* Effect.yieldNow

        const r = yield* Fiber.join(fiber)
        const ready = yield* readiness.currentReady
        return { result: r, readyAfter: ready }
      }).pipe(Effect.provide(layer))

      expect(result.timedOut).toBe(true)
      expect(result.recoveredCalls).toBe(0)
      // Even on timeout the worker comes ready — D14 / D9.
      expect(readyAfter).toBe(true)

      // The call is NOT in B's local storage → CallState.checkout()
      // for this callRef would fall through to undefined → handler
      // responds 481 (existing behavior, no slice-6 wiring needed).
      const snapB = yield* fabricBuilt.control.snapshotPeer(B)
      expect(
        snapB.entries.find(
          (e) =>
            e.key === PartitionedRelayStorage.callKey("pri", B, call.callRef)
        )
      ).toBeUndefined()
    })
  )

  it.effect("CallState.checkout falls through to undefined for an unrecovered call (the 481 path)", () =>
    Effect.gen(function* () {
      // This test wires CallState on top of the harnessed storage to
      // close the loop on the 481 fall-through. We don't run reclaim
      // at all — just assert the existing behavior so the contract
      // ReclaimRunner relies on at timeout is documented in-line.
      const fabricBuilt = PeerFabric.simulatedBuilt([B])
      const config: AppConfigData = testAppConfigDefaults({
        workerOrdinalLabel: B,
      })
      const AppConfigLayer = Layer.succeed(AppConfig, config)
      const StorageLayer = fabricBuilt.fabric.storageLayerOf(B)

      const callStateLayer = CallState.layer.pipe(
        Layer.provide(StorageLayer),
        Layer.provide(NoOpCdrLayer),
        Layer.provide(CallLimiter.memoryLayer),
        Layer.provideMerge(AppConfigLayer)
      )
      const result = yield* Effect.gen(function* () {
        const cs = yield* CallState
        // No call seeded — neither in memory nor in storage.
        return yield* cs.checkout("nonexistent-callref")
      }).pipe(Effect.provide(callStateLayer))
      expect(result).toBeUndefined()
    })
  )
})
