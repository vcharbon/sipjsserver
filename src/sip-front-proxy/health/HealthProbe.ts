/**
 * HealthProbe — D5 (Draining model) of the SIP Front Proxy plan, proxy side.
 *
 * Periodically probes each registered worker with an out-of-dialog SIP
 * `OPTIONS` keepalive (RFC 3261 §11) and translates the response into a
 * `WorkerHealth` annotation on the registry:
 *
 *   200 OK              → `alive`
 *   503 Service Unavailable + `Reason: SIP;cause=503;text="not-ready (boot drain)"`
 *                       → `not-ready`  (Slice E1 of decode-forward-respawn fix:
 *                                       worker process is alive but boot-time
 *                                       replication drain isn't done — its
 *                                       sidecar Redis is empty, so in-dialog
 *                                       traffic to it would 481.)
 *   503 Service Unavailable (`Retry-After: 0` is the canonical drained
 *                            signal — RFC 3261 §21.5.4 + §20.33)
 *                       → `draining`
 *   N consecutive timeouts (default `threshold = 3`)
 *                       → `dead`
 *
 * The probe runs as a long-lived background fiber forked into the
 * Layer's scope (so layer teardown cancels it cleanly). **Probe
 * failures never propagate onto the routing path** (D4 invariant) —
 * every error is logged and the loop continues with the next interval.
 *
 * Implementations:
 *
 *   - `optionsKeepaliveLayer(opts)` — production. Binds its own UDP
 *     endpoint via `SignalingNetwork.bindUdp`, fires OPTIONS at every
 *     worker on the snapshot, waits for responses, updates the
 *     registry through `WorkerRegistryControl`. Per-target consecutive-
 *     timeout counters are kept inside the probe's local state.
 *
 *   - `manualLayer` — test-only. `start` is a no-op; tests drive
 *     health changes via `HealthProbe.setHealth`, which delegates to
 *     `WorkerRegistryControl`. Equivalent in semantics to calling the
 *     simulated control surface directly, but routed through the same
 *     `HealthProbe` interface so transparency suites don't depend on
 *     simulated registry internals.
 *
 * RFC notes:
 *   - §11 (OPTIONS): UAS responds with capabilities. The probe doesn't
 *     parse the body — only the status code matters.
 *   - §21.5.4 (503): UAS uses 503 to signal temporary unavailability.
 *   - §20.33 (Retry-After): the worker-side `DrainingState` handler
 *     always emits `Retry-After: 0`. We treat any 503 from a worker as
 *     `draining`; a future PR may distinguish 503 + `Retry-After: > 0`
 *     (back off) from `Retry-After: 0` (drained).
 */

import {
  Clock,
  Effect,
  Layer,
  MutableHashMap,
  Option,
  Ref,
  ServiceMap,
  Stream,
} from "effect"
import { generateOutOfDialogRequest } from "../../sip/generators.js"
import { getHeader, newBranch, newTag } from "../../sip/MessageHelpers.js"
import { ProxyMetrics, type ProxyMetricsApi } from "../observability/Metrics.js"
import { customParser } from "../../sip/parsers/custom/index.js"
import { serialize } from "../../sip/Serializer.js"
import { SignalingNetwork } from "../../sip/SignalingNetwork.js"
import {
  WorkerRegistry,
  type WorkerHealth,
  type WorkerId,
} from "../registry/WorkerRegistry.js"
import { WorkerRegistryControl } from "./WorkerRegistryControl.js"

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export interface HealthProbeApi {
  /**
   * Start the probe loop. Idempotent — repeat calls are no-ops. Returns
   * immediately; the loop runs in a fiber forked into the layer's scope.
   * For the `manual` impl this is `Effect.void`.
   */
  readonly start: Effect.Effect<void>
  /**
   * Test/operator hook: synchronously set a worker's health. Delegates
   * to `WorkerRegistryControl`. The `manual` impl uses this as the
   * only way health ever changes; the keepalive impl exposes it for
   * tests that want to inject a state directly without simulating an
   * OPTIONS reply.
   */
  readonly setHealth: (id: WorkerId, health: WorkerHealth) => Effect.Effect<void>
}

export class HealthProbe extends ServiceMap.Service<HealthProbe, HealthProbeApi>()(
  "@sipjsserver/sip-front-proxy/HealthProbe"
) {}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OptionsKeepaliveOpts {
  /** Local UDP bind for outgoing probes. */
  readonly bindHost: string
  readonly bindPort: number
  /** Probe interval (ms). Default: 1_000. */
  readonly intervalMs?: number
  /** Per-target response timeout (ms). Default: 1_500. */
  readonly timeoutMs?: number
  /**
   * Consecutive missed responses before marking a worker `dead`.
   * Default: 2. With the 1 s default interval, total detection lag is
   * ≤ 2 s.
   */
  readonly threshold?: number
  /**
   * Inbound queue depth on the probe's bound endpoint. Defaults to 256
   * — N workers × at most 1 outstanding OPTIONS per cycle is plenty.
   */
  readonly queueMax?: number
}

const DEFAULT_INTERVAL_MS = 1_000
const DEFAULT_TIMEOUT_MS = 1_500
const DEFAULT_THRESHOLD = 2
const DEFAULT_QUEUE_MAX = 256

// ---------------------------------------------------------------------------
// optionsKeepalive
// ---------------------------------------------------------------------------

interface PerWorkerState {
  /** Consecutive missed-response counter; reset on any response. */
  consecutiveMisses: number
}

const newPerWorker = (): PerWorkerState => ({ consecutiveMisses: 0 })

/**
 * Production-style probe. Binds a UDP endpoint, sweeps every worker on
 * each tick, classifies each response, updates `WorkerRegistryControl`.
 *
 * The probe is intentionally chatty: it sends OPTIONS to **every**
 * registered worker each interval, even ones currently marked `dead`.
 * That way a worker that comes back without K8s telling us anything
 * (e.g. process restart in-place) gets reclassified `alive` on its
 * first 200.
 */
export const optionsKeepaliveLayer = (
  opts: OptionsKeepaliveOpts
): Layer.Layer<
  HealthProbe,
  never,
  SignalingNetwork | WorkerRegistry | WorkerRegistryControl
> =>
  Layer.effect(
    HealthProbe,
    Effect.gen(function* () {
      const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const threshold = opts.threshold ?? DEFAULT_THRESHOLD
      const queueMax = opts.queueMax ?? DEFAULT_QUEUE_MAX

      const network = yield* SignalingNetwork
      const registry = yield* WorkerRegistry
      const controlRaw = yield* WorkerRegistryControl
      const metrics = yield* (Effect.gen(function* () {
        return yield* ProxyMetrics
      }).pipe(Effect.provide(ProxyMetrics.Default)))
      // Wrap the control's setHealth so EVERY call updates the
      // sip_worker_health gauge — both probe-driven flips and external
      // overrides via HealthProbe.setHealth.
      const control = {
        setHealth: wrapSetHealth(metrics, controlRaw.setHealth),
      }

      // Per-worker miss counters. Plain MutableHashMap keyed on
      // WorkerId — kept inside the probe's closure, not exposed.
      const perWorker = MutableHashMap.empty<WorkerId, PerWorkerState>()
      // Pending probe attempts: Call-ID → WorkerId. Reaped on
      // response or timeout.
      const pendingByCallId = MutableHashMap.empty<string, WorkerId>()

      const startedRef = yield* Ref.make(false)

      // Bind the probe's UDP endpoint into the layer's scope. Releasing
      // the layer (test teardown, process shutdown) closes the socket.
      const endpoint = yield* network
        .bindUdp({
          ip: opts.bindHost,
          port: opts.bindPort,
          queueMax,
        })
        .pipe(Effect.orDie)
      const probeAddr = endpoint.localAddress

      // ── Tick implementation ─────────────────────────────────────────
      const fanOutOptions: Effect.Effect<ReadonlyArray<{ id: WorkerId; callId: string }>> = Effect.gen(function* () {
        const snapshot = yield* registry.snapshot
        const nowMs = yield* Clock.currentTimeMillis
        const issued: Array<{ id: WorkerId; callId: string }> = []
        for (const w of snapshot) {
          const callId = `probe-${w.id}-${nowMs}-${newTag()}@${probeAddr.ip}`
          const req = generateOutOfDialogRequest("OPTIONS", {
            requestUri: `sip:${w.address.host}:${w.address.port}`,
            callId,
            fromUri: `sip:probe@${probeAddr.ip}`,
            fromTag: newTag(),
            toUri: `sip:probe@${w.address.host}:${w.address.port}`,
            cseq: 1,
            via: {
              localIp: probeAddr.ip,
              localPort: probeAddr.port,
              transport: "UDP",
              branch: newBranch(),
            },
            contact: {
              user: "probe",
              host: probeAddr.ip,
              port: probeAddr.port,
            },
          })
          const buf = serialize(req)
          MutableHashMap.set(pendingByCallId, callId, w.id)
          issued.push({ id: w.id, callId })
          // Diagnostic instrumentation (Track A.A1, plan
          // pure-enchanting-forest.md): every OPTIONS send is logged at
          // WARN so the next chaos rerun can disambiguate between
          // "probe stops sending" and "sends but no replies arrive".
          yield* Effect.logWarning(
            `probe-send worker=${w.id} addr=${w.address.host}:${w.address.port} callId=${callId}`
          )
          yield* endpoint
            .send(buf, w.address.port, w.address.host)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  `HealthProbe: send OPTIONS to ${w.id} (${w.address.host}:${w.address.port}) failed`,
                  cause
                )
              )
            )
        }
        return issued
      })

      const reapTimeouts = (
        cycle: ReadonlyArray<{ id: WorkerId; callId: string }>
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          for (const { id, callId } of cycle) {
            const stillPending = MutableHashMap.has(pendingByCallId, callId)
            if (!stillPending) continue
            MutableHashMap.remove(pendingByCallId, callId)
            const existing = Option.getOrUndefined(
              MutableHashMap.get(perWorker, id)
            )
            const next = existing ?? newPerWorker()
            next.consecutiveMisses += 1
            MutableHashMap.set(perWorker, id, next)
            // Track A.A1: miss-counter visibility. Promote every miss
            // increment past 1 to WARN so the cliff-precursor pattern
            // (1 miss → 2 misses → dead) is visible in the proxy log.
            const pendingCount = MutableHashMap.size(pendingByCallId)
            yield* Effect.logWarning(
              `probe-miss worker=${id} consecutive=${next.consecutiveMisses}/${threshold} callIdsPending=${pendingCount}`
            )
            if (next.consecutiveMisses >= threshold) {
              yield* control
                .setHealth(id, "dead")
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      `HealthProbe: setHealth(${id}, dead) failed`,
                      cause
                    )
                  )
                )
            }
          }
        })

      // ── Background fibers — forked into the LAYER scope ─────────────
      // The layer's own Effect runs in a Scope (Layer.effect), so
      // `forkScoped` here ties these fibers' lifetimes to the layer's
      // teardown. We gate them on `startedRef` so they no-op until
      // `start` is invoked — matches the public contract that nothing
      // happens until `start` is called.

      const inboundDrain: Effect.Effect<void> = Stream.runForEach(
        endpoint.messages,
        (pkt) =>
          Effect.gen(function* () {
            const enabled = yield* Ref.get(startedRef)
            if (!enabled) return
            const parseResult = customParser.parse(pkt.raw)
            if (parseResult._tag !== "Success") return
            const msg = parseResult.success
            if (msg.type !== "response") return
            const callId = msg.getHeader("call-id")
            if (callId.length === 0) return

            // ── Identify the worker this reply is for ──────────────────
            // Fast path: the response's Call-ID is still in
            // `pendingByCallId` (i.e. its matching `reapTimeouts` has
            // not yet fired). Use that mapping and remove it so a
            // duplicate reply does not double-credit the same probe.
            //
            // Fallback path: under sustained load, `reapTimeouts` may
            // fire before this handler for a packet that arrived
            // before the reap deadline (Node event-loop ordering); the
            // pending entry is then gone but the reply is still valid.
            // Recover the WorkerId from the Call-ID prefix WE minted
            // (`probe-<id>-<nowMs>-<tag>@<probeAddr>`) so the late
            // reply still resets the miss counter and re-marks the
            // worker `alive`. This MUST NOT trust packets we did not
            // mint, so we require both the `probe-` prefix AND a
            // currently-registered WorkerId.
            const idOpt = MutableHashMap.get(pendingByCallId, callId)
            let id: WorkerId
            if (Option.isSome(idOpt)) {
              id = idOpt.value
              MutableHashMap.remove(pendingByCallId, callId)
            } else {
              const fallback = parseProbeCallId(callId)
              if (fallback === undefined) return
              const reg = yield* registry.resolve(fallback)
              if (Option.isNone(reg)) return
              id = fallback
            }

            // Track A.A1: every accepted OPTIONS reply is logged at
            // WARN with the status + Reason header so we can confirm
            // replies are arriving and being correctly classified.
            const reasonHeader = getHeader(msg.headers, "reason")
            yield* Effect.logWarning(
              `probe-recv worker=${id} status=${msg.status} reasonHeader=${reasonHeader ?? ""}`
            )

            // Reset miss counter on any response, then translate the
            // status into a health value. 200 → alive; 503 → draining
            // OR not-ready, distinguished by the worker's `Reason`
            // header (RFC 3326). Every other status is treated as
            // alive — the worker answered, so it's not dead, and we
            // don't know it's draining.
            const ent = MutableHashMap.get(perWorker, id)
            if (Option.isSome(ent) && ent.value.consecutiveMisses > 0) {
              // Track A.A1: log the actual reset transition so a
              // recovering worker is visible at INFO without grep'ing
              // for a state-change diff.
              yield* Effect.logInfo(
                `probe-miss-reset worker=${id} from=${ent.value.consecutiveMisses}`
              )
              ent.value.consecutiveMisses = 0
            }
            let next: WorkerHealth
            if (msg.status === 200) next = "alive"
            else if (msg.status === 503)
              next = classify503(getHeader(msg.headers, "reason"))
            else next = "alive"
            yield* control
              .setHealth(id, next)
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    `HealthProbe: setHealth(${id}, ${next}) failed`,
                    cause
                  )
                )
              )
          })
      )

      // Tick loop layout:
      //   sleep(intervalMs)  ← idle wait between ticks
      //   if (enabled) fanOut + sleep(timeoutMs) + reap
      //
      // The single `sleep(intervalMs)` at the top makes it trivial for
      // tests to drive ticks with TestClock: one full tick = adjust
      // by `intervalMs + timeoutMs + epsilon`. The previous shape (two
      // sleeps inside the body) made the cursor harder to reason about.
      const tickLoop: Effect.Effect<void> = Effect.forever(
        Effect.gen(function* () {
          // Wait `intervalMs` between ticks. On the very first iteration
          // this means tests need to advance `intervalMs + epsilon`
          // before the probe sends its first OPTIONS — predictable.
          yield* Effect.sleep(`${intervalMs} millis`)
          const enabled = yield* Ref.get(startedRef)
          if (!enabled) return
          const issued = yield* fanOutOptions
          yield* Effect.sleep(`${timeoutMs} millis`)
          yield* reapTimeouts(issued)
        })
      )

      // Track A.A1: fiber-supervision visibility. Both fibers are
      // expected to live for the whole layer scope (i.e. the whole
      // process lifetime). A `probe-fiber-exit` log line firing IS a
      // root cause for "stuck dead" symptoms — the cause field carries
      // the exit reason (success/failure/interrupt).
      const supervised = (
        name: "tickLoop" | "inboundDrain",
        body: Effect.Effect<void>
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* Effect.logInfo(`probe-fiber-start name=${name}`)
          yield* body
        }).pipe(
          Effect.onExit((exit) =>
            exit._tag === "Failure"
              ? Effect.logWarning(
                  `probe-fiber-exit name=${name} exit=Failure`,
                  exit.cause
                )
              : Effect.logWarning(`probe-fiber-exit name=${name} exit=Success`)
          )
        )

      yield* Effect.forkScoped(supervised("inboundDrain", inboundDrain))
      yield* Effect.forkScoped(supervised("tickLoop", tickLoop))

      // ── start ───────────────────────────────────────────────────────
      // Idempotent: flip the gate once. The fibers above are already
      // running and pick up the change on their next iteration.
      const start: Effect.Effect<void> = Ref.set(startedRef, true)

      const setHealth = (id: WorkerId, health: WorkerHealth) =>
        control.setHealth(id, health)

      return { start, setHealth }
    })
  )

// ---------------------------------------------------------------------------
// manual
// ---------------------------------------------------------------------------

/**
 * Test-only no-op probe. `start` is a no-op (no fiber is forked); tests
 * drive health changes via `HealthProbe.setHealth`, which delegates to
 * `WorkerRegistryControl`.
 */
export const manualLayer: Layer.Layer<
  HealthProbe,
  never,
  WorkerRegistryControl
> = Layer.effect(
  HealthProbe,
  Effect.gen(function* () {
    const control = yield* WorkerRegistryControl
    const metrics = yield* (Effect.gen(function* () {
      return yield* ProxyMetrics
    }).pipe(Effect.provide(ProxyMetrics.Default)))
    const wrapped = wrapSetHealth(metrics, control.setHealth)
    return {
      start: Effect.void,
      setHealth: (id, health) => wrapped(id, health),
    }
  })
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Translate a worker's 503 OPTIONS reply into a `WorkerHealth` value.
 *
 * Inspects the `Reason` header (RFC 3326) — the worker stamps
 * `SIP;cause=503;text="not-ready (boot drain)"` while ReadyGate is still
 * draining peers, vs `SIP;cause=503;text="draining"` after SIGTERM. A 503
 * with no `Reason` header (older workers / non-B2BUA UAS) defaults to
 * `draining` to preserve the legacy behaviour: any 503 demotes the worker
 * out of the new-dialog candidate set.
 */
const classify503 = (reasonHeader: string | undefined): WorkerHealth => {
  if (typeof reasonHeader !== "string") return "draining"
  return reasonHeader.toLowerCase().includes("not-ready")
    ? "not-ready"
    : "draining"
}

/**
 * Recover the `WorkerId` from a Call-ID we minted in `fanOutOptions`
 * (`probe-<workerId>-<nowMs>-<tag>@<probeAddr>`). Returns `undefined`
 * for any string that is not in our minted shape — callers MUST treat
 * undefined as "do not trust this packet".
 *
 * The regex anchors on the trailing `-<nowMs>-<tag>@…` so it parses
 * unambiguously even for K8s StatefulSet pod names ending in a digit
 * (e.g. `b2bua-worker-0`): greedy `(.+)` claims "b2bua-worker-0",
 * `\d+` claims the millisecond timestamp, `[^-@]+` claims the base36
 * `newTag()` (which only emits `[0-9a-z]`, no dashes), and `@` pins
 * the boundary to the start of the probe address.
 */
const PROBE_CID_RE = /^probe-(.+)-\d+-[^-@]+@/
const parseProbeCallId = (callId: string): WorkerId | undefined => {
  const m = PROBE_CID_RE.exec(callId)
  const captured = m?.[1]
  if (captured === undefined) return undefined
  return captured as WorkerId
}

/**
 * Decorate a `setHealth` function to additionally tick the
 * `sip_worker_health` gauge. Failures during the metric write do not
 * propagate — the probe's primary job is to update the registry; metrics
 * are best-effort.
 */
const wrapSetHealth = (
  metrics: ProxyMetricsApi,
  inner: (id: WorkerId, health: WorkerHealth) => Effect.Effect<void>
) =>
  (id: WorkerId, health: WorkerHealth): Effect.Effect<void> =>
    inner(id, health).pipe(
      Effect.tap(() => metrics.setWorkerHealth({ workerId: id, health }))
    )
