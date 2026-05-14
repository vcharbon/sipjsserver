/**
 * Recorder service (Slice 1) — single source of truth for what crossed
 * the test fabric during a scenario. Backed by per-scenario in-memory
 * state; no transport wiring yet (that's Slice 2 for fake and Slice 3
 * for live).
 *
 * Instantiation: pick one of `Recorder.fake`, `Recorder.live`, or
 * `Recorder.hybrid`. The transport kind is structural — recorded into
 * the layer at construction, propagated through `snapshot.transportKind`
 * to the renderer. Impossible to misreport from the call site.
 */

import { Effect, Layer, MutableHashMap, ServiceMap } from "effect"
import type { NetworkTag } from "../types.js"
import {
  type Lane,
  type LaneKey,
  laneKey,
  type RecordedAnomaly,
  type RecordedReplEntry,
  type RecordedScenario,
  type RecordedSipEntry,
  type TransportKind,
} from "./types.js"

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export interface RecorderApi {
  /**
   * Register a `(ip, port) → name` lane mapping. Idempotent on the
   * name (re-registering the same name is a no-op). Registering a
   * different name on an existing lane records both names and queues a
   * `nameConflict` anomaly.
   *
   * The `network` of an existing lane is preserved on re-register; the
   * first registration wins. A mismatched `network` on a subsequent
   * register is treated as a no-op (logged in a future slice's
   * diagnostics — not currently surfaced).
   */
  readonly registerLane: (args: {
    readonly ip: string
    readonly port: number
    readonly name: string
    readonly network: NetworkTag
  }) => Effect.Effect<void>

  /** Append a SIP-packet observation to the scenario trace. */
  readonly recordSip: (entry: RecordedSipEntry) => Effect.Effect<void>

  /** Append a replication-frame observation to the scenario trace. */
  readonly recordRepl: (entry: RecordedReplEntry) => Effect.Effect<void>

  /**
   * Mark a lane as killed at `at` (virtual or wall-clock ms). The
   * renderer paints a red dashed band on the lifeline at that
   * timestamp. Multiple kills on the same lane accumulate.
   *
   * Calling on an unregistered `(ip,port)` is a no-op — the K8s harness
   * may emit kill events before the lane has seen any SIP traffic; the
   * lane will pick up the timestamp once it's registered (Slice 2's
   * registerLane merges any pending kills).
   */
  readonly markLaneKilled: (args: {
    readonly ip: string
    readonly port: number
    readonly at: number
  }) => Effect.Effect<void>

  /** Drain the recorder into the shape the renderer consumes. */
  readonly snapshot: Effect.Effect<RecordedScenario>
}

export class Recorder extends ServiceMap.Service<Recorder, RecorderApi>()(
  "@sipjsserver/test-harness/Recorder",
) {
  /**
   * Build a Recorder layer with the given transport kind. Prefer the
   * named helpers (`Recorder.fake`, `Recorder.live`, `Recorder.hybrid`)
   * over calling this directly — they make the kind self-documenting
   * at the call site.
   */
  static readonly layer = (kind: TransportKind): Layer.Layer<Recorder> =>
    Layer.sync(Recorder, () => makeApi(kind))

  static readonly fake: Layer.Layer<Recorder> = Recorder.layer("fake")
  static readonly live: Layer.Layer<Recorder> = Recorder.layer("live")
  static readonly hybrid: Layer.Layer<Recorder> = Recorder.layer("hybrid")
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface MutableLane {
  readonly ip: string
  readonly port: number
  readonly names: string[]
  readonly network: NetworkTag
  readonly killedAt: number[]
}

const makeApi = (kind: TransportKind): RecorderApi => {
  const lanes = MutableHashMap.empty<LaneKey, MutableLane>()
  // Pending kills for lanes not yet registered. Merged on registerLane.
  const pendingKills = MutableHashMap.empty<LaneKey, number[]>()
  const sipTrace: RecordedSipEntry[] = []
  const replTrace: RecordedReplEntry[] = []
  // Lane keys that already produced a nameConflict anomaly. Avoids
  // emitting one anomaly per re-register on the same lane.
  const conflictsAlreadyReported = new Set<LaneKey>()
  const anomalies: RecordedAnomaly[] = []

  const registerLane: RecorderApi["registerLane"] = (args) =>
    Effect.sync(() => {
      const key = laneKey(args.ip, args.port)
      const existing = MutableHashMap.get(lanes, key)
      if (existing._tag === "None") {
        const pending = MutableHashMap.get(pendingKills, key)
        const initialKills = pending._tag === "Some" ? [...pending.value] : []
        if (pending._tag === "Some") {
          MutableHashMap.remove(pendingKills, key)
        }
        MutableHashMap.set(lanes, key, {
          ip: args.ip,
          port: args.port,
          names: [args.name],
          network: args.network,
          killedAt: initialKills,
        })
        return
      }
      const lane = existing.value
      if (lane.names.includes(args.name)) return
      lane.names.push(args.name)
      if (!conflictsAlreadyReported.has(key)) {
        conflictsAlreadyReported.add(key)
        anomalies.push({
          kind: "nameConflict",
          laneKey: key,
          names: lane.names.slice(),
        })
      } else {
        // Replace the existing anomaly with the up-to-date names list
        // so the report always shows every conflicting name, not just
        // the first two.
        const idx = anomalies.findIndex(
          (a) => a.kind === "nameConflict" && a.laneKey === key,
        )
        if (idx >= 0) {
          anomalies[idx] = {
            kind: "nameConflict",
            laneKey: key,
            names: lane.names.slice(),
          }
        }
      }
    })

  const recordSip: RecorderApi["recordSip"] = (entry) =>
    Effect.sync(() => {
      sipTrace.push(entry)
    })

  const recordRepl: RecorderApi["recordRepl"] = (entry) =>
    Effect.sync(() => {
      replTrace.push(entry)
    })

  const markLaneKilled: RecorderApi["markLaneKilled"] = (args) =>
    Effect.sync(() => {
      const key = laneKey(args.ip, args.port)
      const existing = MutableHashMap.get(lanes, key)
      if (existing._tag === "Some") {
        existing.value.killedAt.push(args.at)
        return
      }
      const pending = MutableHashMap.get(pendingKills, key)
      if (pending._tag === "Some") {
        pending.value.push(args.at)
      } else {
        MutableHashMap.set(pendingKills, key, [args.at])
      }
    })

  const snapshot: RecorderApi["snapshot"] = Effect.sync(() => {
    const out: Lane[] = []
    for (const [, lane] of lanes) {
      out.push({
        ip: lane.ip,
        port: lane.port,
        names: lane.names.slice(),
        network: lane.network,
        killedAt: lane.killedAt.slice(),
      })
    }
    return {
      transportKind: kind,
      lanes: out,
      sipTrace: sipTrace.slice(),
      replTrace: replTrace.slice(),
      anomalies: anomalies.slice(),
    }
  })

  return {
    registerLane,
    recordSip,
    recordRepl,
    markLaneKilled,
    snapshot,
  }
}
