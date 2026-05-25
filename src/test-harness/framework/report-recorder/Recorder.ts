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

import { Clock, Effect, Layer, MutableHashMap, ServiceMap } from "effect"
import type { NetworkTag } from "../types.js"
import {
  type Lane,
  type LaneKey,
  laneKey,
  type Projector,
  type RecordedAnomaly,
  type RecordedReplEntry,
  type RecordedScenario,
  type RecordedSipEntry,
  type RecordedStamps,
  type TaggedChannel,
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

  /**
   * Append a SIP-packet observation to the scenario trace. Callers
   * pass everything except `seq` — the Recorder allocates from its
   * sequencer so all recording layers stamp from the same counter and
   * `(timestamp, seq)` orders deterministically.
   */
  readonly recordSip: (entry: Omit<RecordedSipEntry, "seq">) => Effect.Effect<void>

  /** Append a replication-frame observation to the scenario trace. */
  readonly recordRepl: (entry: Omit<RecordedReplEntry, "seq">) => Effect.Effect<void>

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

  /**
   * Open a typed event channel keyed by `tag.key`. Calling twice with
   * the same tag returns the same underlying buffer.
   *
   * `E` is the layer-specific payload type; the channel stamps `seq` +
   * `atMs` automatically on every `record` call. Helpers in
   * `recordingHelpers.ts` are the intended callers.
   */
  readonly forTag: <S, E>(tag: ServiceMap.Key<S, any>) => TaggedChannel<E>

  /**
   * Register a projector for `tag`'s channel. First registration wins
   * (later registrations on the same tag are ignored). Projectors run
   * at `snapshot` time; their `Partial<RecordedScenario>` outputs are
   * merged with the existing sipTrace/replTrace fields.
   */
  readonly registerProjector: <S, E>(
    tag: ServiceMap.Key<S, any>,
    projector: Projector<E>,
  ) => Effect.Effect<void>

  /**
   * Sugar for `registerLane` — Slice 0 alias that the new helpers use
   * instead of the verbose call site. Forwards to `registerLane` with
   * the network defaulted to `"ext"`.
   */
  readonly labelLane: (
    bindKey: { readonly ip: string; readonly port: number },
    name: string,
    network?: NetworkTag,
  ) => Effect.Effect<void>
}

/**
 * Optional sequencer the harness supplies so the Recorder stamps `seq`
 * from the same monotonic counter as the SIP / replication recording
 * layers (see src/test-harness/framework/EventSequencer.ts).
 */
export interface RecorderSequencer {
  readonly nextSync: () => number
}

export class Recorder extends ServiceMap.Service<Recorder, RecorderApi>()(
  "@sipjsserver/test-harness/Recorder",
) {
  /**
   * Build a Recorder layer with the given transport kind. Prefer the
   * named helpers (`Recorder.fake`, `Recorder.live`, `Recorder.hybrid`)
   * over calling this directly — they make the kind self-documenting
   * at the call site.
   *
   * Pass `sequencer` to share ordering with the other recording
   * layers; omit it when the Recorder is the only recording layer in
   * the scenario (its events still order monotonically among
   * themselves via a per-instance fallback).
   */
  static readonly layer = (
    kind: TransportKind,
    sequencer?: RecorderSequencer,
  ): Layer.Layer<Recorder> => Layer.sync(Recorder, () => makeApi(kind, sequencer))

  static readonly fake: Layer.Layer<Recorder> = Recorder.layer("fake")
  static readonly live: Layer.Layer<Recorder> = Recorder.layer("live")
  static readonly hybrid: Layer.Layer<Recorder> = Recorder.layer("hybrid")
}

/**
 * Build a `RecorderApi` instance synchronously, without going through
 * the Layer. Used by harness call sites that need a stable handle
 * before any Effect runtime is available (e.g. `simulated-backend.ts`
 * materialising the replication-frame channel at SUT-construction
 * time). For tests-as-effects, prefer `Recorder.fake` / `.live` /
 * `.hybrid` and `yield* Recorder` instead.
 */
export const makeRecorderApi = (
  kind: TransportKind,
  sequencer?: RecorderSequencer,
): RecorderApi => makeApi(kind, sequencer)

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

const makeApi = (
  kind: TransportKind,
  sequencer?: RecorderSequencer,
): RecorderApi => {
  const lanes = MutableHashMap.empty<LaneKey, MutableLane>()
  // Pending kills for lanes not yet registered. Merged on registerLane.
  const pendingKills = MutableHashMap.empty<LaneKey, number[]>()
  const sipTrace: RecordedSipEntry[] = []
  const replTrace: RecordedReplEntry[] = []
  const allocSeq: () => number = sequencer !== undefined
    ? sequencer.nextSync
    : (() => {
        let local = 0
        return () => ++local
      })()
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
      sipTrace.push({ ...entry, seq: allocSeq() })
    })

  const recordRepl: RecorderApi["recordRepl"] = (entry) =>
    Effect.sync(() => {
      replTrace.push({ ...entry, seq: allocSeq() })
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

  // Per-Tag typed channels: keyed by `tag.key` string, value is the
  // raw stamped events. Cast happens at `forTag<E>` read time.
  const channels = new Map<string, Array<unknown & RecordedStamps>>()
  const projectors = new Map<string, Projector<unknown>>()

  const ensureChannel = (tagKey: string): Array<unknown & RecordedStamps> => {
    let arr = channels.get(tagKey)
    if (arr === undefined) {
      arr = []
      channels.set(tagKey, arr)
    }
    return arr
  }

  const forTag: RecorderApi["forTag"] = <S, E>(
    tag: ServiceMap.Key<S, any>,
  ): TaggedChannel<E> => {
    const tagKey = tag.key
    return {
      record: (event: E) =>
        Effect.gen(function* () {
          const atMs = yield* Clock.currentTimeMillis
          const arr = ensureChannel(tagKey)
          arr.push({
            ...(event as object),
            seq: allocSeq(),
            atMs,
          } as E & RecordedStamps)
        }),
      snapshot: Effect.sync(
        () =>
          (channels.get(tagKey) ?? []).slice() as unknown as ReadonlyArray<
            E & RecordedStamps
          >,
      ),
    }
  }

  const registerProjector: RecorderApi["registerProjector"] = (tag, projector) =>
    Effect.sync(() => {
      const tagKey = tag.key
      if (projectors.has(tagKey)) return
      projectors.set(tagKey, projector as Projector<unknown>)
    })

  const labelLane: RecorderApi["labelLane"] = (bindKey, name, network) =>
    registerLane({
      ip: bindKey.ip,
      port: bindKey.port,
      name,
      network: network ?? "ext",
    })

  const baseSnapshot = (): RecordedScenario => {
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
  }

  const snapshot: RecorderApi["snapshot"] = Effect.sync(() => {
    const base = baseSnapshot()
    if (projectors.size === 0) return base
    // Merge projector outputs over the base. Projectors may contribute
    // additional sipTrace / replTrace / anomalies entries; lanes are
    // owned by the Recorder and not overridable.
    let sipTraceMerged: ReadonlyArray<RecordedSipEntry> = base.sipTrace
    let replTraceMerged: ReadonlyArray<RecordedReplEntry> = base.replTrace
    let anomaliesMerged: ReadonlyArray<RecordedAnomaly> = base.anomalies
    for (const [tagKey, projector] of projectors) {
      const events = (channels.get(tagKey) ?? []) as ReadonlyArray<
        unknown & RecordedStamps
      >
      const part = projector(events)
      if (part.sipTrace !== undefined) {
        sipTraceMerged = [...sipTraceMerged, ...part.sipTrace]
      }
      if (part.replTrace !== undefined) {
        replTraceMerged = [...replTraceMerged, ...part.replTrace]
      }
      if (part.anomalies !== undefined) {
        anomaliesMerged = [...anomaliesMerged, ...part.anomalies]
      }
    }
    return {
      transportKind: base.transportKind,
      lanes: base.lanes,
      sipTrace: sipTraceMerged,
      replTrace: replTraceMerged,
      anomalies: anomaliesMerged,
    }
  })

  return {
    registerLane,
    recordSip,
    recordRepl,
    markLaneKilled,
    snapshot,
    forTag,
    registerProjector,
    labelLane,
  }
}
