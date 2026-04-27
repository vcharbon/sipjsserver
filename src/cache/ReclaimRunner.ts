/**
 * ReclaimRunner — startup-time recovery of "calls I was primary for"
 * from cluster peers' backup partitions.
 *
 * Slice 6 of the HA-resilience plan. When a worker pod boots (cold
 * start or post-crash restart), it scans every alive peer's
 * `bak:{self}:call:*` partition via `PeerCachePort.scan`, decodes
 * each entry, and copies it back into local `pri:{self}:call:*` so
 * subsequent in-dialog requests can be served from local storage
 * (per `CallState.checkout`).
 *
 * Two reclaim flows in the plan; only Flow 1 ("my primary calls") is
 * implemented here. Flow 2 ("my backup duties") is deliberately
 * skipped — when the original primaries resume their dual-write fan-
 * out, the backup partition repopulates naturally (D14 / accepted
 * small TTL-window loss class).
 *
 * Lifecycle gates around the work:
 *
 *   1. `WorkerReadiness.markReady(false)` — pod stays out of K8s
 *      Service while reclaim runs, so the proxy routes via cookie's
 *      `w_bak` (D8 / D9). The startup readiness gate is
 *      one-way-during-this-call: ready flips back to `true` exactly
 *      once at completion or `maxDuration` timeout.
 *
 *   2. Enumerate currently-Ready peers via `PeerEnumerator`. Self is
 *      excluded by the enumerator. Slice 6 takes one snapshot at
 *      start; periodic re-query during reclaim is a follow-up
 *      enhancement (the natural place to insert it is the
 *      `Effect.forEach` loop below).
 *
 *   3. For each peer, stream `port.scan({peer, role: "bak", owner: self})`,
 *      decode each entry, gen-compare against any existing local
 *      entry (newer-gen wins per D7), and `storage.putCall` into
 *      local `pri:{self}:call:*`. Pacing yields between scan reads
 *      to keep the local Redis from being starved (D10 §scan).
 *
 *   4. `WorkerReadiness.markReady(true)`. Even on `maxDuration`
 *      timeout (D14): the worker comes Ready and answers 481 to
 *      in-dialog requests for unrecovered calls — already the
 *      `CallState.checkout`-returns-undefined fall-through behavior,
 *      no new wiring here.
 *
 * Returns a `ReclaimResult` with counts so callers (production main,
 * tests) can log / assert. Errors during reclaim are caught per-peer
 * and surface as `peersFailed` rather than failing the whole run —
 * partial recovery beats no recovery.
 */

import {
  Clock,
  Duration,
  Effect,
  Layer,
  Ref,
  Result,
  Schema,
  ServiceMap,
  Stream,
} from "effect"
import { AppConfig } from "../config/AppConfig.js"
import {
  Call as CallSchema,
  callIndexKeys,
  parseCallRef,
  type Call,
} from "../call/CallModel.js"
import { PartitionedRelayStorage } from "./PartitionedRelayStorage.js"
import {
  PeerCachePort,
  WorkerOrdinal,
} from "./PeerCachePort.js"
import { PeerEnumerator } from "./PeerEnumerator.js"
import { WorkerReadiness } from "./WorkerReadiness.js"

const JsonCallSchema = Schema.fromJsonString(CallSchema)

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReclaimOptions {
  /**
   * Hard upper bound on a single `run()` call. At expiry the runner
   * marks the worker Ready anyway — D14. Default: 10 minutes.
   */
  readonly maxDuration: Duration.Duration
  /**
   * Concurrency across peers — independent fibers, one per peer.
   * Default: 8. Each fiber is internally serial (one stream of scan
   * entries), so this caps fan-out, not within-peer parallelism.
   */
  readonly peerConcurrency: number
  /**
   * SCAN COUNT hint. Default: 50 — same as
   * `PartitionedRelayStorage.DEFAULT_SCAN_BATCH`. Reserved for the
   * follow-up that wires the value into `port.scan`; today the relay
   * already paces internally and this option is recorded for symmetry
   * with the plan's locked-in defaults table.
   */
  readonly scanBatch: number
  /**
   * Pacing yield between processed scan entries (ms). Default: 50.
   * Keeps the local sidecar Redis from being starved when the peer
   * stream emits faster than we can write.
   */
  readonly scanPacingMs: number
}

export const defaultReclaimOptions: ReclaimOptions = {
  maxDuration: Duration.minutes(10),
  peerConcurrency: 8,
  scanBatch: PartitionedRelayStorage.DEFAULT_SCAN_BATCH,
  scanPacingMs: 50,
}

export interface ReclaimResult {
  /** Calls written into local `pri:{self}:` during this run. */
  readonly recoveredCalls: number
  /**
   * Entries skipped because the local `pri:{self}:` already had an
   * equal-or-newer `_topology.gen` — gen-comparison wins per D7.
   */
  readonly skippedByGen: number
  /** Number of peers the runner attempted to scan. */
  readonly peersScanned: number
  /** Peers whose scan failed completely (mid-stream errors counted too). */
  readonly peersFailed: number
  /** True if `maxDuration` fired before the reclaim completed. */
  readonly timedOut: boolean
  /** Wall-clock duration of the run. */
  readonly durationMs: number
}

export interface ReclaimRunnerApi {
  /** Run reclaim once. Idempotent in steady-state — a no-op when local already has every entry. */
  readonly run: Effect.Effect<ReclaimResult>
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ReclaimRunner extends ServiceMap.Service<
  ReclaimRunner,
  ReclaimRunnerApi
>()("@sipjsserver/cache/ReclaimRunner") {
  /**
   * Build the runner layer. Tunables default to the plan's locked-in
   * values; tests pass tight overrides for fast deterministic runs.
   *
   * Required deps (none of which the layer pulls itself — caller
   * composes them):
   *   - `WorkerReadiness` (slice 6)
   *   - `PeerEnumerator` (slice 6)
   *   - `PeerCachePort` (slice 3)
   *   - `PartitionedRelayStorage` (slice 3)
   *   - `AppConfig` (for `selfOrdinal` + `callContextTtlSec`)
   */
  static readonly layer = (
    opts?: Partial<ReclaimOptions>
  ): Layer.Layer<
    ReclaimRunner,
    never,
    | WorkerReadiness
    | PeerEnumerator
    | PeerCachePort
    | PartitionedRelayStorage
    | AppConfig
  > =>
    Layer.effect(ReclaimRunner)(
      Effect.gen(function* () {
        const options: ReclaimOptions = { ...defaultReclaimOptions, ...opts }
        const readiness = yield* WorkerReadiness
        const enumerator = yield* PeerEnumerator
        const port = yield* PeerCachePort
        const storage = yield* PartitionedRelayStorage
        const config = yield* AppConfig

        // Mirror CallState's selfOrdinal derivation. The cookie names
        // workers by `WorkerId` opaque-string ordinals; production K8s
        // sets `workerOrdinalLabel` from `HOSTNAME` (D17). Without
        // that, fall through to `String(workerIndex)` (clustered
        // mode) and finally `"self"` (single-worker dev).
        const selfOrdinalRaw =
          config.workerOrdinalLabel !== undefined
            ? config.workerOrdinalLabel
            : config.workerIndex >= 0
              ? String(config.workerIndex)
              : "self"
        const selfOrdinal = WorkerOrdinal(selfOrdinalRaw)
        const ttl = config.callContextTtlSec

        // Decode JSON → Call, returning null on malformed/unparseable
        // payloads so the caller can count the entry as "bad" rather
        // than failing the whole reclaim. We don't need the typed
        // ParseError detail — the warning log captures enough for
        // post-mortem.
        const decode = (json: string): Effect.Effect<Call | null> =>
          Effect.gen(function* () {
            const r = yield* Effect.result(
              Schema.decodeUnknownEffect(JsonCallSchema)(json)
            )
            return Result.isSuccess(r) ? r.success : null
          })

        const localGenOf = (
          callRef: string
        ): Effect.Effect<number> =>
          Effect.gen(function* () {
            const r = yield* Effect.result(
              storage.getCall("pri", selfOrdinalRaw, callRef)
            )
            if (Result.isFailure(r)) return -1
            const json = r.success
            if (json === null) return -1
            const call = yield* decode(json)
            if (call === null) return -1
            return call._topology?.gen ?? 0
          })

        // Process a single scanned entry from a peer's `bak:{self}:`
        // partition. Side-effects on the counters bag.
        const ingestEntry = (
          entry: { readonly callRef: string; readonly json: string; readonly ttlSec: number },
          counters: Counters
        ): Effect.Effect<void> =>
          Effect.gen(function* () {
            // Defensive: a peer should never expose calls in
            // `bak:{self}:` whose callRef does not name us as primary,
            // but a buggy or out-of-date peer would bleed wrong rows
            // into our pri:{self}: partition if we trusted it blindly.
            const parsed = parseCallRef(entry.callRef)
            if (parsed === null || parsed.primary !== selfOrdinalRaw) {
              yield* Effect.logWarning(
                `ReclaimRunner: dropping entry ${entry.callRef} — primary segment does not match self ${selfOrdinalRaw}`
              )
              yield* Ref.update(counters.bad, (n) => n + 1)
              return
            }

            const incoming = yield* decode(entry.json)
            if (incoming === null) {
              yield* Effect.logWarning(
                `ReclaimRunner: failed to decode call ${entry.callRef} from peer — skipping`
              )
              yield* Ref.update(counters.bad, (n) => n + 1)
              return
            }
            const incomingGen = incoming._topology?.gen ?? 0

            const existingGen = yield* localGenOf(entry.callRef)
            if (existingGen >= 0 && existingGen >= incomingGen) {
              // Local already has equal-or-newer state — D7 gen-wins.
              yield* Ref.update(counters.skipped, (n) => n + 1)
              return
            }

            const indexes = callIndexKeys(incoming)
            // Use the entry's remaining TTL when copying — preserves
            // the original expiry rather than resetting to a fresh
            // `callContextTtlSec`. When the peer reported `ttlSec=0`
            // (entry on the verge of expiring) we still write with
            // the configured ttl so the recovered worker has time to
            // process the call.
            const writeTtl = entry.ttlSec > 0 ? entry.ttlSec : ttl
            const writeResult = yield* Effect.result(
              storage.putCall(
                "pri",
                selfOrdinalRaw,
                entry.callRef,
                entry.json,
                indexes,
                writeTtl
              )
            )
            if (Result.isFailure(writeResult)) {
              yield* Effect.logWarning(
                `ReclaimRunner: local putCall failed for ${entry.callRef}: ${writeResult.failure.reason}`
              )
              yield* Ref.update(counters.bad, (n) => n + 1)
              return
            }
            yield* Ref.update(counters.recovered, (n) => n + 1)
          })

        // Stream-and-ingest one peer's `bak:{self}:` partition. The
        // pacing yield + sleep between entries gives the local sidecar
        // Redis room to interleave foreground writes (CallState dual-
        // write path may already be live before reclaim ends — the
        // gen-comparison ensures we don't overwrite a fresher local).
        const reclaimPeer = (
          peer: WorkerOrdinal,
          counters: Counters
        ): Effect.Effect<void> =>
          Effect.gen(function* () {
            const stream = port.scan({
              peer,
              role: "bak",
              owner: selfOrdinal,
            })
            const pace = options.scanPacingMs > 0
              ? Effect.sleep(`${options.scanPacingMs} millis`)
              : Effect.void
            const r = yield* Effect.result(
              Stream.runForEach(stream, (entry) =>
                ingestEntry(entry, counters).pipe(
                  Effect.andThen(Effect.yieldNow),
                  Effect.andThen(pace)
                )
              )
            )
            if (Result.isFailure(r)) {
              yield* Effect.logWarning(
                `ReclaimRunner: peer ${peer} scan failed (reason=${r.failure.reason}) — continuing with other peers`
              )
              yield* Ref.update(counters.peersFailed, (n) => n + 1)
            }
          })

        const runReclaim = Effect.gen(function* () {
          yield* readiness.markReady(false)
          const startMs = yield* Clock.currentTimeMillis

          const counters: Counters = {
            recovered: yield* Ref.make(0),
            skipped: yield* Ref.make(0),
            bad: yield* Ref.make(0),
            peersFailed: yield* Ref.make(0),
          }

          const peers = yield* enumerator.currentPeers
          const otherPeers = peers.filter((p) => p !== selfOrdinal)
          const peersScanned = otherPeers.length

          const reclaimAll = Effect.forEach(
            otherPeers,
            (peer) => reclaimPeer(peer, counters),
            { concurrency: options.peerConcurrency, discard: true }
          )

          const timed = yield* reclaimAll.pipe(
            Effect.timeoutOption(options.maxDuration)
          )
          const timedOut = timed._tag === "None"
          if (timedOut) {
            yield* Effect.logWarning(
              `ReclaimRunner: maxDuration ${Duration.toMillis(options.maxDuration)}ms elapsed before reclaim completed — marking worker Ready and accepting 481 fall-through for unrecovered calls`
            )
          }

          // Always mark ready, even on timeout (D14).
          yield* readiness.markReady(true)

          const endMs = yield* Clock.currentTimeMillis
          const recoveredCalls = yield* Ref.get(counters.recovered)
          const skippedByGen = yield* Ref.get(counters.skipped)
          const peersFailed = yield* Ref.get(counters.peersFailed)
          const result: ReclaimResult = {
            recoveredCalls,
            skippedByGen,
            peersScanned,
            peersFailed,
            timedOut,
            durationMs: endMs - startMs,
          }
          yield* Effect.logInfo(
            `ReclaimRunner: completed (recovered=${recoveredCalls} skipped=${skippedByGen} peers=${peersScanned} peersFailed=${peersFailed} timedOut=${timedOut} durationMs=${result.durationMs})`
          )
          return result
        })

        return { run: runReclaim }
      })
    )
}

// ---------------------------------------------------------------------------
// Internal — counters bag
// ---------------------------------------------------------------------------

interface Counters {
  readonly recovered: Ref.Ref<number>
  readonly skipped: Ref.Ref<number>
  readonly bad: Ref.Ref<number>
  readonly peersFailed: Ref.Ref<number>
}
