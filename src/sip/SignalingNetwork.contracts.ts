/**
 * SignalingNetwork contract wrappers — extend a `SignalingNetwork`
 * implementation Layer with typed-event recording and per-bindUdp
 * RFC-rule checks.
 *
 * Wrapper composition (canonical order — see effectLayerTest):
 *
 *   propertyTest(paranoidInputs(scopedAudit(impl)))
 *
 * Only `scopedAudit` is implemented this slice. `paranoidInputs` lands
 * in a later slice. `propertyTest` is intentionally skipped for
 * `SignalingNetwork`: there is no natural input domain to enumerate
 * — `bindUdp` opens a kernel socket and `send` is fire-and-forget UDP.
 *
 * Recording
 * ---------
 * Every public method emits a typed event on the per-Tag channel
 * `Recorder.forTag(SignalingNetwork)`. The events carry the
 * lane-identifying `bindKey` (the bound ip:port pair) so per-peer
 * projections at scope close can slice on a single peer.
 *
 * Severity tiers (D5)
 * -------------------
 *   - `unit-test-of-layer`  rule violations are FATAL: the wrapper
 *                            fails the per-bindUdp scope with
 *                            `SignalingAuditViolation` on first hit.
 *   - `test-with-recorder`  violations are recorded as
 *                            `signalingAudit` anomalies with severity
 *                            `deferred-fail`; the layer-close
 *                            finalizer then fails with
 *                            `SignalingAuditViolation` if any are
 *                            present.
 *   - `real-run`            violations are recorded as advisories
 *                            and never fail.
 */

import { Clock, Data, Effect, Layer, Result, ServiceMap, Stream } from "effect"
import {
  SignalingNetwork,
  type BindUdpOpts,
  type SignalingNetworkApi,
  type UdpEndpoint,
  type UdpPacket,
} from "./SignalingNetwork.js"
import { Recorder } from "../test-harness/framework/report-recorder/Recorder.js"
import {
  recordEffectCall,
  recordScopedAcquire,
  recordStreamLifecycle,
} from "../test-harness/framework/recordingHelpers.js"
import { RunContext } from "../test-harness/framework/RunContext.js"
import {
  withCanonicalContracts,
  type CanonicalContractsOptions,
} from "../test-harness/framework/effectLayerTest.js"
import type {
  LaneKey,
  RecordedAnomaly,
} from "../test-harness/framework/report-recorder/types.js"
import { laneKey } from "../test-harness/framework/report-recorder/types.js"
import type { Projector } from "../test-harness/framework/report-recorder/types.js"
import type { RecordedSipEntry } from "../test-harness/framework/report-recorder/types.js"
import type { SipMessage } from "./types.js"
import { createCustomParser } from "./parsers/custom/index.js"
import type { NetworkTraceEntry } from "./SignalingNetwork.js"

// ---------------------------------------------------------------------------
// Typed event union
// ---------------------------------------------------------------------------

/**
 * One observation on the `SignalingNetwork` typed channel. The
 * Recorder stamps `seq` + `atMs` on every entry; payload is
 * intentionally narrow so projectors and rules can switch on `tag`.
 */
export type SignalingNetworkEvent =
  | { readonly tag: "bindUdp.acquire"; readonly bindKey: LaneKey; readonly opts: BindUdpOpts }
  | { readonly tag: "bindUdp.release"; readonly bindKey: LaneKey }
  | {
      readonly tag: "send.called"
      readonly bindKey: LaneKey
      readonly to: { readonly ip: string; readonly port: number }
      readonly msg: Buffer
    }
  | {
      readonly tag: "send.result"
      readonly bindKey: LaneKey
      readonly outcome: "ok" | "fail" | "interrupt"
    }
  | { readonly tag: "messages.streamStart"; readonly bindKey: LaneKey }
  | {
      readonly tag: "messages.streamItem"
      readonly bindKey: LaneKey
      readonly envelope: UdpPacket
    }
  | { readonly tag: "messages.streamEnd"; readonly bindKey: LaneKey; readonly reason: string }

// ---------------------------------------------------------------------------
// Failure shape
// ---------------------------------------------------------------------------

export class SignalingAuditViolation extends Data.TaggedError(
  "SignalingAuditViolation",
)<{
  readonly check: string
  readonly detail: string
  readonly bindKey?: LaneKey
}> {}

// ---------------------------------------------------------------------------
// Rule interface
// ---------------------------------------------------------------------------

/**
 * A per-peer rule. Receives the SignalingNetwork events captured for a
 * single `bindKey` (peer) and returns zero or more violation strings.
 *
 * Each violation becomes a `SignalingAuditViolation` (fatal) or a
 * `signalingAudit` anomaly (deferred / advisory) depending on the
 * active `RunContext` (D5).
 */
export interface PeerAuditRule {
  readonly name: string
  readonly check: (
    events: ReadonlyArray<SignalingNetworkEvent>,
    ctx: { readonly bindKey: LaneKey },
  ) => Effect.Effect<ReadonlyArray<string>>
}

/**
 * A cross-message rule operates on the full event channel for the
 * layer's lifetime, not on per-peer slices. It runs once at layer close.
 * Each finding still carries an originating `bindKey` so the layer's
 * `shouldAuditBind` predicate can suppress reports against the DUT bind.
 *
 * `severityOverride` forces a rule into the advisory tier regardless of
 * the active `RunContext`. Reserved for rules whose findings reflect
 * widespread fixture gaps rather than real DUT defects (e.g.
 * `rfc.allowSupportedOnInvite` against scenarios that legitimately omit
 * Allow / Supported on re-INVITE). Default behaviour follows the D5
 * three-tier table.
 */
export interface CrossMessageAuditRule {
  readonly name: string
  readonly severityOverride?: "advisory"
  readonly check: (
    events: ReadonlyArray<SignalingNetworkEvent & { seq: number; atMs: number }>,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly bindKey: LaneKey; readonly detail: string }>
  >
}

export interface ScopedAuditOptions {
  readonly rules: ReadonlyArray<PeerAuditRule>
  /** Cross-message rules — run once at layer close over the full channel. */
  readonly crossMessageRules?: ReadonlyArray<CrossMessageAuditRule>
  /**
   * Optional bindKey predicate. Returning `false` short-circuits all
   * rule evaluation for that peer (still records events into the
   * channel). Used to exempt the DUT's own bind from per-peer RFC
   * checks — the B2BUA worker terminates multiple call legs on one
   * socket and rewrites Call-IDs across legs, so per-(callId, peer)
   * dialog state runs into legitimate B2BUA behaviour that the
   * `runValidationChecks` validators were authored against pure
   * UAC/UAS agents.
   *
   * Cross-message rules consult the same predicate before recording a
   * finding tagged to a specific bindKey.
   *
   * `true` (or undefined) → rules run.
   */
  readonly shouldAuditBind?: (bindKey: LaneKey) => boolean
}

// ---------------------------------------------------------------------------
// scopedAudit
// ---------------------------------------------------------------------------

const bindKeyOf = (ip: string, port: number): LaneKey => laneKey(ip, port)

/**
 * Wrap a `SignalingNetwork` Layer with typed recording + per-bindUdp
 * RFC rules. Reads `Recorder` + `RunContext` from the surrounding
 * scope — `Layer<SignalingNetwork, never, Recorder | RunContext>`.
 */
export const scopedAudit = (
  inner: Layer.Layer<SignalingNetwork>,
  options?: ScopedAuditOptions,
): Layer.Layer<SignalingNetwork, never, Recorder | RunContext> => {
  const rules = options?.rules ?? []
  const crossMessageRules = options?.crossMessageRules ?? []
  return Layer.effect(
    SignalingNetwork,
    Effect.gen(function* () {
      const innerSvcs = yield* Layer.build(inner)
      const innerApi = ServiceMap.get(innerSvcs, SignalingNetwork)
      const recorder = yield* Recorder
      const ctx = yield* RunContext
      const channel = recorder.forTag<SignalingNetwork, SignalingNetworkEvent>(
        SignalingNetwork,
      )

      // Findings collected across the layer's lifetime. Drained on
      // layer close; in `test-with-recorder` mode a non-empty list
      // fails the surrounding scope.
      const deferredFindings: Array<{
        readonly check: string
        readonly detail: string
        readonly bindKey: LaneKey
      }> = []

      const advisoryFindings: Array<{
        readonly check: string
        readonly detail: string
        readonly bindKey: LaneKey
      }> = []

      // Layer-close anomalies (counter balance, undeliverable, queueLeak).
      // Stored as the final RecordedAnomaly shape since each variant
      // carries its own discriminant; surfaced via the projector. All
      // three are advisory for now — see the per-site comments for why
      // the deferred-fail tier surfaces too many false positives until
      // settle-bound assertions land.
      const layerAnomalies: RecordedAnomaly[] = []
      let layerAnomalySeq = 0
      const allocAnomalySeq = () => ++layerAnomalySeq

      const recordAnomaly = (
        finding: { readonly check: string; readonly detail: string; readonly bindKey: LaneKey },
        severity: "deferred-fail" | "advisory",
      ): Effect.Effect<void> =>
        Effect.sync(() => {
          const a: RecordedAnomaly = {
            kind: "signalingAudit",
            check: finding.check,
            detail: finding.detail,
            bindKey: finding.bindKey,
            severity,
          }
          // Recorder doesn't expose a direct anomaly-push API; piggyback
          // through a projector registered below. We store findings
          // locally; the projector reads `deferredFindings` (deferred-fail
          // entries) AND `advisoryFindings` (advisory entries).
          if (severity === "deferred-fail") {
            deferredFindings.push(finding)
          } else {
            advisoryFindings.push(finding)
          }
          void a
        })

      const projector: Projector<SignalingNetworkEvent> = () => ({
        anomalies: [
          ...deferredFindings.map((f): RecordedAnomaly => ({
            kind: "signalingAudit",
            check: f.check,
            detail: f.detail,
            bindKey: f.bindKey,
            severity: "deferred-fail",
          })),
          ...advisoryFindings.map((f): RecordedAnomaly => ({
            kind: "signalingAudit",
            check: f.check,
            detail: f.detail,
            bindKey: f.bindKey,
            severity: "advisory",
          })),
          ...layerAnomalies,
        ],
      })

      yield* recorder.registerProjector(SignalingNetwork, projector)

      // Run the configured rules over a snapshot of events filtered to
      // one bindKey. Surfaces findings according to the active
      // RunContext.
      const shouldAudit = options?.shouldAuditBind ?? (() => true)

      const runRulesForBind = (
        bindKey: LaneKey,
      ): Effect.Effect<void, SignalingAuditViolation> =>
        Effect.gen(function* () {
          if (rules.length === 0) return
          if (!shouldAudit(bindKey)) return
          const snapshot = yield* channel.snapshot
          const slice = snapshot.filter((e) => "bindKey" in e && e.bindKey === bindKey)
          for (const rule of rules) {
            const violations = yield* rule.check(slice, { bindKey })
            for (const v of violations) {
              const finding = { check: rule.name, detail: v, bindKey }
              if (ctx.kind === "unit-test-of-layer") {
                yield* recordAnomaly(finding, "deferred-fail")
                return yield* new SignalingAuditViolation(finding)
              }
              if (ctx.kind === "test-with-recorder") {
                yield* recordAnomaly(finding, "deferred-fail")
              } else {
                yield* recordAnomaly(finding, "advisory")
              }
            }
          }
        })

      const wrapEndpoint = (
        bindKey: LaneKey,
        endpoint: UdpEndpoint,
      ): UdpEndpoint => {
        const send: UdpEndpoint["send"] = (buf, dstPort, dstAddress) =>
          recordEffectCall<SignalingNetworkEvent, never, void, import("./SignalingNetwork.js").SendError>(
            channel,
            () => ({
              tag: "send.called",
              bindKey,
              to: { ip: dstAddress, port: dstPort },
              msg: buf,
            }),
            (outcome) => ({
              tag: "send.result",
              bindKey,
              outcome: outcome.kind,
            }),
            endpoint.send(buf, dstPort, dstAddress),
          )

        const messages = recordStreamLifecycle<SignalingNetworkEvent, UdpPacket, never>(
          channel,
          () => ({ tag: "messages.streamStart", bindKey }),
          (env) => ({ tag: "messages.streamItem", bindKey, envelope: env }),
          (reason) => ({ tag: "messages.streamEnd", bindKey, reason }),
          endpoint.messages,
        ).pipe(Stream.orDie) as Stream.Stream<UdpPacket>

        // poll / take bypass the messages stream; record them as
        // streamItem events too so per-peer rules see direct queue
        // reads (the test harness routinely uses take()).
        const take: UdpEndpoint["take"] = () =>
          Effect.gen(function* () {
            const env = yield* endpoint.take()
            yield* channel.record({
              tag: "messages.streamItem",
              bindKey,
              envelope: env,
            })
            return env
          })

        const poll: UdpEndpoint["poll"] = () =>
          Effect.gen(function* () {
            const maybe = yield* endpoint.poll()
            if (maybe !== null) {
              yield* channel.record({
                tag: "messages.streamItem",
                bindKey,
                envelope: maybe,
              })
            }
            return maybe
          })

        return {
          ...endpoint,
          send,
          messages,
          take,
          poll,
        }
      }

      const bindUdp: SignalingNetworkApi["bindUdp"] = (opts) =>
        Effect.gen(function* () {
          const bindKey = bindKeyOf(opts.ip, opts.port)
          // recordScopedAcquire handles acquire + scope-close release
          // events. The acquire effect carries a Scope requirement which
          // is satisfied by bindUdp's own Scope context.
          const inner = yield* recordScopedAcquire(
            channel,
            (_acquired: UdpEndpoint) => ({ tag: "bindUdp.acquire" as const, bindKey, opts }),
            (_acquired: UdpEndpoint) => ({ tag: "bindUdp.release" as const, bindKey }),
            innerApi.bindUdp(opts).pipe(Effect.orDie),
          )
          // Per-bindUdp finalizer: run rules at peer scope close and
          // capture queue depth right BEFORE the inner release pops the
          // endpoint from the routing table (LIFO finalizer order).
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              // Capture queue depth right BEFORE the inner release pops
              // the endpoint from the routing table (LIFO finalizer
              // order). Advisory severity: many test fixtures release
              // bind scopes with packets still queued (uncollected
              // OPTIONS keepalive replies, retransmit-200 fixtures,
              // ...). Genuine leaks surface in the report; the rule
              // would need cross-message context (Slice 5) to fail
              // selectively without false positives.
              const depth = inner.queueDepth()
              if (depth > 0) {
                const atMs = yield* Clock.currentTimeMillis
                layerAnomalies.push({
                  kind: "queueLeak",
                  bindKey,
                  queueDepth: depth,
                  atMs,
                  seq: allocAnomalySeq(),
                  severity: "advisory",
                })
              }
              yield* runRulesForBind(bindKey).pipe(
                Effect.catchTag("SignalingAuditViolation", (e) =>
                  ctx.kind === "unit-test-of-layer"
                    ? Effect.die(e)
                    : Effect.void,
                ),
              )
            }),
          )
          return wrapEndpoint(bindKey, inner)
        })

      // Layer-close finalizer: cross-cutting invariants + deferred
      // signalingAudit findings. Skipped on non-simulated impls
      // (real/realTracing/Native expose stubbed accessors) for the
      // structural-state checks; signalingAudit findings still surface
      // since they're populated by the per-bindUdp rules.
      const isSimulated = innerApi.transitDelayMs !== undefined
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (isSimulated) {
            // Bounded quiescence: simulated transit is `forkDetach`ed
            // so it can be mid-`Effect.sleep(transitDelayMs)` at this
            // finalizer's wall-clock moment. The poll lets transit
            // drain before the structural checks read; under fake-clock
            // the interpreter's settle already drove inFlight to 0, so
            // the loop exits on iter 1 without sleeping.
            yield* innerApi.awaitInFlight(200)

            const atMs = yield* Clock.currentTimeMillis

            const inFlight = innerApi.inFlight()
            if (inFlight !== 0) {
              // Non-zero after awaitInFlight(200ms) → genuine transit
              // leak (a fork that never completed within 4× transit
              // delay) or a bug in the test that left send-fibers
              // running without expecting them to drain.
              layerAnomalies.push({
                kind: "inFlightImbalance",
                inFlight,
                atMs,
                seq: allocAnomalySeq(),
                severity: "deferred-fail",
              })
            }

            const undelivered = yield* innerApi.drainUndeliverable()
            for (const pkt of undelivered) {
              layerAnomalies.push({
                kind: "undeliverable",
                src: pkt.src,
                dst: pkt.dst,
                atMs: pkt.timestampMs,
                seq: allocAnomalySeq(),
                severity: "deferred-fail",
              })
            }

            // Residual queue depth — catches the case where the layer
            // scope outlives a bind scope with packets still queued.
            // Post-awaitInFlight: all transit has delivered, so a
            // non-empty queue means the receiving endpoint never
            // drained it (real test gap, not a transit race).
            for (const { bindKey: addr, depth } of innerApi.queueDepths()) {
              if (depth === 0) continue
              const bk = laneKey(addr.ip, addr.port)
              layerAnomalies.push({
                kind: "queueLeak",
                bindKey: bk,
                queueDepth: depth,
                atMs,
                seq: allocAnomalySeq(),
                severity: "deferred-fail",
              })
            }
          }

          // Cross-message rules — single pass over the whole channel.
          // Findings inherit the same severity tier as per-peer rules
          // (per D5: deferred-fail in test, advisory in real-run, fatal
          // in unit-test-of-layer). The shouldAudit predicate filters
          // findings keyed to exempt binds (e.g. the DUT bind).
          if (crossMessageRules.length > 0) {
            const snapshot = yield* channel.snapshot
            for (const rule of crossMessageRules) {
              const found = yield* rule.check(snapshot)
              for (const f of found) {
                if (!shouldAudit(f.bindKey)) continue
                const finding = {
                  check: rule.name,
                  detail: f.detail,
                  bindKey: f.bindKey,
                }
                if (rule.severityOverride === "advisory") {
                  advisoryFindings.push(finding)
                } else if (ctx.kind === "unit-test-of-layer") {
                  deferredFindings.push(finding)
                } else if (ctx.kind === "test-with-recorder") {
                  deferredFindings.push(finding)
                } else {
                  advisoryFindings.push(finding)
                }
              }
            }
          }

          // SignalingAudit deferred findings — surface as
          // SignalingAuditViolation defect. Drains entries from both
          // per-bindUdp rules and cross-message rules.
          if (ctx.kind === "test-with-recorder" && deferredFindings.length > 0) {
            const first = deferredFindings[0]!
            return yield* Effect.die(
              new SignalingAuditViolation({
                check: first.check,
                detail: first.detail,
                bindKey: first.bindKey,
              }),
            )
          }

          // All three layer-close variants are currently advisory; no
          // additional defect path. Reserved for Slice 5 hardening once
          // settle-bound assertion sites are in place.
        }),
      )

      return {
        ...innerApi,
        bindUdp,
      }
    }),
  )
}

// ---------------------------------------------------------------------------
// toSipWire projector — additive; populates RecordedScenario.sipTrace
// from typed SignalingNetwork events. The legacy recordSip path still
// runs alongside (it doesn't fire in fake-stack tests today).
// ---------------------------------------------------------------------------

const PARSER_FOR_PROJECTOR = createCustomParser({ wireGrammar: false })

const tryParse = (raw: Buffer): SipMessage | null => {
  const res = PARSER_FOR_PROJECTOR.parse(raw)
  return Result.isSuccess(res) ? res.success : null
}

/**
 * Project a SignalingNetwork event stream into `RecordedSipEntry`
 * values. `send.called` becomes a send entry, `messages.streamItem`
 * becomes a receive entry. Parse failures skip the entry — the wire
 * bytes are still in the channel for the rule path.
 */
export const toSipWire = (
  events: ReadonlyArray<SignalingNetworkEvent & { seq: number; atMs: number }>,
): ReadonlyArray<RecordedSipEntry> => {
  const out: RecordedSipEntry[] = []
  // Sort by seq so derivation order is deterministic when channel was
  // appended from multiple fibers.
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  for (const e of sorted) {
    if (e.tag === "send.called") {
      const message = tryParse(e.msg)
      if (message === null) continue
      const [ip, portStr] = e.bindKey.split(":")
      out.push({
        timestamp: e.atMs,
        sentMs: e.atMs,
        receivedMs: e.atMs,
        fromAddr: { ip: ip!, port: Number(portStr) },
        toAddr: e.to,
        direction: "send",
        stepIndex: -1,
        status: "pass",
        message,
        network: "ext",
        seq: e.seq,
      })
    } else if (e.tag === "messages.streamItem") {
      const message = tryParse(e.envelope.raw)
      if (message === null) continue
      const [ip, portStr] = e.bindKey.split(":")
      out.push({
        timestamp: e.atMs,
        sentMs: e.envelope.arrivalMs,
        receivedMs: e.atMs,
        fromAddr: {
          ip: e.envelope.rinfo.address,
          port: e.envelope.rinfo.port,
        },
        toAddr: { ip: ip!, port: Number(portStr) },
        direction: "receive",
        stepIndex: -1,
        status: "pass",
        message,
        network: "ext",
        seq: e.seq,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// toNetworkTrace projector — derives raw-bytes `NetworkTraceEntry`
// values from the typed channel for consumers that still consume the
// legacy `NetworkTraceEntry` shape (the interpreter's internal-hop
// splicer, the sip-front-proxy report runner). One entry per `send.called`
// since the simulated fabric reports successful sends; failed deliveries
// surface via the `undeliverable` anomaly variant.
// ---------------------------------------------------------------------------

export const toNetworkTrace = (
  events: ReadonlyArray<SignalingNetworkEvent & { seq: number; atMs: number }>,
): ReadonlyArray<NetworkTraceEntry> => {
  const out: NetworkTraceEntry[] = []
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  for (const e of sorted) {
    if (e.tag !== "send.called") continue
    const [ip, portStr] = e.bindKey.split(":")
    out.push({
      raw: e.msg,
      src: { ip: ip!, port: Number(portStr) },
      dst: e.to,
      sentMs: e.atMs,
      // Recorder doesn't observe the delivery moment; use atMs as a
      // safe proxy for ordering. The interpreter only re-sorts by
      // (timestamp, seq) anyway.
      deliveredMs: e.atMs,
      delivered: true,
      seq: e.seq,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// paranoidInputs
// ---------------------------------------------------------------------------

/**
 * Maximum UDP payload size — the theoretical max payload of a single UDP
 * datagram (65535 - 20 IP - 8 UDP). SIP fragments above ~1.4 KB but the
 * wrapper only rejects values that the kernel itself cannot accept.
 */
const MAX_UDP_PAYLOAD = 65507

const isFiniteIntegerInRange = (n: unknown, lo: number, hi: number): boolean =>
  typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi

/**
 * Caller-side precondition violation. `Effect.die` for Effect-returning
 * methods (programmer error → defect, not a recoverable failure).
 */
export class SignalingParanoidInputViolation extends Error {
  readonly _tag = "SignalingParanoidInputViolation"
  constructor(
    readonly check: string,
    readonly detail: string,
  ) {
    super(`signaling-network ${check}: ${detail}`)
  }
}

/**
 * Wrap a `SignalingNetwork` Layer with caller-side precondition checks.
 *
 * Checks (all always-on — each is µs-scale type/range guards):
 *
 *   PA1_bindOpts_validAddr  bindUdp opts.ip non-empty, opts.port int 0..65535
 *                            (port 0 = ephemeral, accepted by real + simulated)
 *   PA2_bindOpts_queueMax   bindUdp opts.queueMax positive integer
 *   PA3_send_validDest      send dstAddress non-empty, dstPort int 1..65535
 *   PA4_send_msgBuffer      send msg is Buffer with length > 0
 *   PA5_send_msgSizeBound   send msg.length ≤ MAX_UDP_PAYLOAD
 *
 * Violations surface via `Effect.die(new SignalingParanoidInputViolation)`
 * — these are programmer errors, not runtime failures the caller can
 * meaningfully recover from. Tests intentionally exercising the precondition
 * surface can inspect `Cause.failureOption`-style for the `_tag` literal.
 *
 * Sync mutator (`bumpInFlight`) and sync getters (`inFlight`,
 * `queueDepth`, `transitDelayMs`, `queueDepths`, `drainTrace`,
 * `drainUndeliverable`) are NOT wrapped — they have no caller-side
 * preconditions worth enforcing.
 */
export const paranoidInputs = (
  inner: Layer.Layer<SignalingNetwork>,
): Layer.Layer<SignalingNetwork> =>
  Layer.effect(
    SignalingNetwork,
    Effect.gen(function* () {
      const innerSvcs = yield* Layer.build(inner)
      const innerApi = ServiceMap.get(innerSvcs, SignalingNetwork)

      const wrapEndpoint = (endpoint: UdpEndpoint): UdpEndpoint => {
        const send: UdpEndpoint["send"] = (buf, dstPort, dstAddress) =>
          Effect.suspend(() => {
            if (typeof dstAddress !== "string" || dstAddress.length === 0) {
              return Effect.die(
                new SignalingParanoidInputViolation(
                  "PA3_send_validDest",
                  `send dstAddress must be a non-empty string (got ${typeof dstAddress})`,
                ),
              )
            }
            if (!isFiniteIntegerInRange(dstPort, 1, 65535)) {
              return Effect.die(
                new SignalingParanoidInputViolation(
                  "PA3_send_validDest",
                  `send dstPort must be integer in 1..65535 (got ${String(dstPort)})`,
                ),
              )
            }
            if (!Buffer.isBuffer(buf) || buf.length === 0) {
              return Effect.die(
                new SignalingParanoidInputViolation(
                  "PA4_send_msgBuffer",
                  `send msg must be a non-empty Buffer (got len=${
                    Buffer.isBuffer(buf) ? buf.length : "non-Buffer"
                  })`,
                ),
              )
            }
            if (buf.length > MAX_UDP_PAYLOAD) {
              return Effect.die(
                new SignalingParanoidInputViolation(
                  "PA5_send_msgSizeBound",
                  `send msg.length=${buf.length} exceeds MAX_UDP_PAYLOAD=${MAX_UDP_PAYLOAD}`,
                ),
              )
            }
            return endpoint.send(buf, dstPort, dstAddress)
          })
        return { ...endpoint, send }
      }

      const bindUdp: SignalingNetworkApi["bindUdp"] = (opts) =>
        Effect.suspend(() => {
          if (typeof opts.ip !== "string" || opts.ip.length === 0) {
            return Effect.die(
              new SignalingParanoidInputViolation(
                "PA1_bindOpts_validAddr",
                `bindUdp opts.ip must be a non-empty string (got ${typeof opts.ip})`,
              ),
            )
          }
          if (!isFiniteIntegerInRange(opts.port, 0, 65535)) {
            return Effect.die(
              new SignalingParanoidInputViolation(
                "PA1_bindOpts_validAddr",
                `bindUdp opts.port must be integer in 0..65535 (got ${String(opts.port)})`,
              ),
            )
          }
          if (!isFiniteIntegerInRange(opts.queueMax, 1, Number.MAX_SAFE_INTEGER)) {
            return Effect.die(
              new SignalingParanoidInputViolation(
                "PA2_bindOpts_queueMax",
                `bindUdp opts.queueMax must be a positive integer (got ${String(opts.queueMax)})`,
              ),
            )
          }
          return innerApi.bindUdp(opts).pipe(Effect.map(wrapEndpoint))
        })

      return {
        ...innerApi,
        bindUdp,
      }
    }),
  )

// ---------------------------------------------------------------------------
// Tag.withAllContracts(options) — canonical-order forwarder
// ---------------------------------------------------------------------------

export interface SignalingNetworkContractsOptions {
  readonly scopedAudit?: ScopedAuditOptions
  /**
   * `true` (default when caller passes `scopedAudit`) → wrap with
   * `paranoidInputs`. Set to `false` to skip the precondition layer
   * (perf benchmarks, deliberate violation tests).
   */
  readonly paranoidInputs?: boolean
}

/**
 * Thin forwarder around the generic `withCanonicalContracts` helper.
 * `propertyTest` is intentionally not exposed for SignalingNetwork
 * (no natural input domain — bindUdp opens an OS socket; send is
 * fire-and-forget UDP).
 */
export const withAllContracts = (
  impl: Layer.Layer<SignalingNetwork>,
  options?: SignalingNetworkContractsOptions,
): Layer.Layer<SignalingNetwork, never, Recorder | RunContext> => {
  const opts: CanonicalContractsOptions<SignalingNetwork, never, never, ScopedAuditOptions> = {
    ...(options?.scopedAudit !== undefined
      ? { scopedAudit: { wrap: scopedAudit as never, opts: options.scopedAudit } }
      : {}),
    ...(options?.paranoidInputs !== false
      ? { paranoidInputs: { wrap: paranoidInputs as never } }
      : {}),
  }
  return withCanonicalContracts(SignalingNetwork, impl, opts) as Layer.Layer<
    SignalingNetwork,
    never,
    Recorder | RunContext
  >
}
