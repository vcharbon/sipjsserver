/**
 * Codec variants for the Call replication pipeline. Each variant exposes
 * four functions matching the four pipeline stages:
 *
 *   encodeCall(call)              → body                    (primary write)
 *   wireEncode(env, body)         → frameLine               (replication encode)
 *   wireDecode(frameLine)         → { env, body }           (replication decode)
 *   decodeCall(body)              → Call                    (recovery / load)
 *
 * Types are deliberately loose (`body` is per-variant) because that's the
 * whole point of the benchmark: V1's body is a JSON string, V5's is a
 * Buffer, V4's is { slim: string, cas: Map<hash, bytes> }.
 *
 * NO Schema validation runs on any variant — V1 still runs the Schema
 * encode/decode transforms (which compute base64 for bytes) but production
 * would gate the validation pass behind a flag.
 */

import { Effect, Schema } from "effect"
import protobuf from "protobufjs"
import { pack as mpPack, unpack as mpUnpack } from "msgpackr"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { Call as CallSchema } from "../../../src/call/CallModel.js"

const requireCjs = createRequire(import.meta.url)
const staticProto: any = requireCjs("./call.proto.gen.cjs")
const StaticCallProto = staticProto.bench.Call as protobuf.Type
const StaticFrameProto = staticProto.bench.Frame as protobuf.Type

const JsonCallSchema = Schema.fromJsonString(CallSchema)

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Reproduce the production allocation pattern at
 * `src/call/CallState.ts:583-584` / `:849-850` — every flush builds a
 * fresh `{ ...bumped, __writtenAtMs }` object before encoding. The
 * spread is a non-trivial slice of the worker's GC pressure under load
 * (see /tmp/handoff-Pmj1v4.md). Each variant pays the same allocation
 * tax so the comparison stays honest. When the production-side fix
 * lands (writtenAtMs moves into the envelope), drop this helper from
 * `encodeCall` on the same PR or budgets become invalid.
 */
export const stampWrittenAt = (call: unknown): unknown => ({
  ...(call as object),
  __writtenAtMs: Date.now(),
})

const bufferReplacer = (_k: string, v: unknown): unknown => {
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64")
  return v
}

const bufferReviverFor = (paths: ReadonlyArray<string>) => {
  const set = new Set(paths)
  return (k: string, v: unknown): unknown => {
    if (set.has(k) && typeof v === "string") return new Uint8Array(Buffer.from(v, "base64"))
    return v
  }
}

const BINARY_FIELDS = ["body", "cachedSdp", "promotedSdp", "policyUpdateBody"]

// ---------------------------------------------------------------------------
// Frame envelope (matches src/replication/ReplicationProtocol.ts shape)
// ---------------------------------------------------------------------------

export interface FrameEnv {
  readonly type: "data"
  readonly gen: number
  readonly counter: number
  readonly op: "update"
  readonly partition: "pri"
  readonly callRef: string
  readonly body_ttl_remaining_sec: number
  readonly latency_ms: number
}

export const sampleEnv = (call: { callRef: string }): FrameEnv => ({
  type: "data",
  gen: 3,
  counter: 4711,
  op: "update",
  partition: "pri",
  callRef: call.callRef,
  body_ttl_remaining_sec: 3600,
  latency_ms: 12,
})

// ---------------------------------------------------------------------------
// V1 — Effect Schema (current production path)
//      Schema.encodeEffect(JsonCallSchema) on encode, decodeUnknownEffect on
//      decode. Replication re-parses the body to inline it in the frame
//      (matches src/replication/ReplicationProtocol.ts:encodeFrame).
// ---------------------------------------------------------------------------

export const v1 = {
  name: "v1-schema",
  encodeCall(call: unknown): string {
    return Effect.runSync(Schema.encodeEffect(JsonCallSchema)(stampWrittenAt(call) as never))
  },
  wireEncode(env: FrameEnv, body: string): string {
    const parsed: unknown = JSON.parse(body)
    return JSON.stringify({ ...env, body: parsed }) + "\n"
  },
  wireDecode(frameLine: string): { env: FrameEnv; body: string } {
    const obj = JSON.parse(frameLine) as Record<string, unknown>
    const { body, ...env } = obj
    const bodyStr = JSON.stringify(body)
    return { env: env as unknown as FrameEnv, body: bodyStr }
  },
  decodeCall(body: string): unknown {
    return Effect.runSync(Schema.decodeUnknownEffect(JsonCallSchema)(body))
  },
}

// ---------------------------------------------------------------------------
// V2 — Raw JSON.stringify (skip Schema validation; matching base64 for bytes)
//      Replication still re-parses + re-stringifies (apples-to-apples vs V1).
// ---------------------------------------------------------------------------

export const v2 = {
  name: "v2-raw-json",
  encodeCall(call: unknown): string {
    return JSON.stringify(stampWrittenAt(call), bufferReplacer)
  },
  wireEncode(env: FrameEnv, body: string): string {
    const parsed: unknown = JSON.parse(body)
    return JSON.stringify({ ...env, body: parsed }) + "\n"
  },
  wireDecode(frameLine: string): { env: FrameEnv; body: string } {
    const obj = JSON.parse(frameLine) as Record<string, unknown>
    const { body, ...env } = obj
    const bodyStr = JSON.stringify(body)
    return { env: env as unknown as FrameEnv, body: bodyStr }
  },
  decodeCall(body: string): unknown {
    return JSON.parse(body, bufferReviverFor(BINARY_FIELDS))
  },
}

// ---------------------------------------------------------------------------
// V3 — V2 + skip replication double-encode. Wire format: `<env JSON>\x1f<body>\n`
//      Envelope and body never need to be parsed/re-stringified on the
//      replication path; the consumer writes `body` straight to its backup
//      Redis after splitting on `\x1f`.
// ---------------------------------------------------------------------------

const US = "\x1f"

export const v3 = {
  name: "v3-no-repl-reparse",
  encodeCall(call: unknown): string {
    return JSON.stringify(stampWrittenAt(call), bufferReplacer)
  },
  wireEncode(env: FrameEnv, body: string): string {
    return JSON.stringify(env) + US + body + "\n"
  },
  wireDecode(frameLine: string): { env: FrameEnv; body: string } {
    const i = frameLine.indexOf(US)
    const env = JSON.parse(frameLine.slice(0, i)) as FrameEnv
    const trimmed = frameLine.endsWith("\n") ? frameLine.slice(0, -1) : frameLine
    const body = trimmed.slice(i + 1)
    return { env, body }
  },
  decodeCall(body: string): unknown {
    return JSON.parse(body, bufferReviverFor(BINARY_FIELDS))
  },
}

// ---------------------------------------------------------------------------
// V4 — V3 + SDP / aLegInvite.headers out-of-band (content-addressed).
//      Large mostly-static fields are hashed; only the hash is stored in
//      the slim body. The actual bytes live in a separate map (in
//      production, Redis CAS keys `cas:{sha256}`). Most flushes only
//      re-encode the slim body; static fields hit the cache.
// ---------------------------------------------------------------------------

export class CasStore {
  private readonly map = new Map<string, Uint8Array>()
  put(bytes: Uint8Array): string {
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32)
    if (!this.map.has(hash)) this.map.set(hash, bytes)
    return hash
  }
  putJson(value: unknown): string {
    return this.put(new TextEncoder().encode(JSON.stringify(value)))
  }
  get(hash: string): Uint8Array | undefined {
    return this.map.get(hash)
  }
  getJson(hash: string): unknown {
    const b = this.map.get(hash)
    if (b === undefined) return undefined
    return JSON.parse(new TextDecoder().decode(b))
  }
}

const HEAVY_MARKER = "__cas__:"

const stripHeavy = (call: any, cas: CasStore): unknown => {
  const c = { ...call }
  if (c.aLegInvite) {
    const inv = { ...c.aLegInvite }
    if (inv.body instanceof Uint8Array) {
      inv.body = HEAVY_MARKER + cas.put(inv.body)
    }
    if (Array.isArray(inv.headers)) {
      inv.headers = HEAVY_MARKER + cas.putJson(inv.headers)
    }
    c.aLegInvite = inv
  }
  if (Array.isArray(c.bLegs)) {
    c.bLegs = c.bLegs.map((leg: any) => ({
      ...leg,
      dialogs: Array.isArray(leg.dialogs)
        ? leg.dialogs.map((d: any) => {
            const next = { ...d, ext: { ...d.ext } }
            if (next.ext.cachedSdp instanceof Uint8Array) {
              next.ext.cachedSdp = HEAVY_MARKER + cas.put(next.ext.cachedSdp)
            }
            return next
          })
        : leg.dialogs,
    }))
  }
  return c
}

const rehydrateHeavy = (call: any, cas: CasStore): unknown => {
  const c = { ...call }
  if (c.aLegInvite) {
    const inv = { ...c.aLegInvite }
    if (typeof inv.body === "string" && inv.body.startsWith(HEAVY_MARKER)) {
      const h = inv.body.slice(HEAVY_MARKER.length)
      inv.body = cas.get(h) ?? new Uint8Array()
    }
    if (typeof inv.headers === "string" && inv.headers.startsWith(HEAVY_MARKER)) {
      const h = inv.headers.slice(HEAVY_MARKER.length)
      inv.headers = cas.getJson(h) ?? []
    }
    c.aLegInvite = inv
  }
  if (Array.isArray(c.bLegs)) {
    c.bLegs = c.bLegs.map((leg: any) => ({
      ...leg,
      dialogs: Array.isArray(leg.dialogs)
        ? leg.dialogs.map((d: any) => {
            const next = { ...d, ext: { ...d.ext } }
            if (typeof next.ext.cachedSdp === "string" && next.ext.cachedSdp.startsWith(HEAVY_MARKER)) {
              const h = next.ext.cachedSdp.slice(HEAVY_MARKER.length)
              next.ext.cachedSdp = cas.get(h)
            }
            return next
          })
        : leg.dialogs,
    }))
  }
  return c
}

export const makeV4 = (cas: CasStore) => ({
  name: "v4-cas-outofband",
  encodeCall(call: unknown): string {
    const slim = stripHeavy(stampWrittenAt(call), cas)
    return JSON.stringify(slim, bufferReplacer)
  },
  wireEncode(env: FrameEnv, body: string): string {
    return JSON.stringify(env) + US + body + "\n"
  },
  wireDecode(frameLine: string): { env: FrameEnv; body: string } {
    const i = frameLine.indexOf(US)
    const env = JSON.parse(frameLine.slice(0, i)) as FrameEnv
    const trimmed = frameLine.endsWith("\n") ? frameLine.slice(0, -1) : frameLine
    const body = trimmed.slice(i + 1)
    return { env, body }
  },
  decodeCall(body: string): unknown {
    const parsed = JSON.parse(body, bufferReviverFor(BINARY_FIELDS))
    return rehydrateHeavy(parsed, cas)
  },
})

// ---------------------------------------------------------------------------
// V5 — Protobuf (no Schema validation; binary wire). Bytes fields stay as
//      raw bytes (no base64 round-trip). Exotic union fields (features,
//      activeRules.params, ruleState.state) fall back to JSON-string.
// ---------------------------------------------------------------------------

const protoRoot = protobuf.Root.fromJSON({
  nested: {
    bench: {
      nested: {
        RemoteInfo: {
          fields: { address: { type: "string", id: 1 }, port: { type: "int32", id: 2 } },
        },
        SipHeader: {
          fields: { name: { type: "string", id: 1 }, value: { type: "string", id: 2 } },
        },
        PendingRequest: {
          fields: {
            method: { type: "string", id: 1 },
            outboundCSeq: { type: "int32", id: 2 },
            inboundCSeq: { type: "int32", id: 3 },
            sourceVias: { rule: "repeated", type: "string", id: 4 },
            sourceCallId: { type: "string", id: 5 },
            sourceFrom: { type: "string", id: 6 },
            sourceTo: { type: "string", id: 7 },
            direction: { type: "string", id: 8 },
          },
        },
        StackDialog: {
          fields: {
            callId: { type: "string", id: 1 },
            localTag: { type: "string", id: 2 },
            remoteTag: { type: "string", id: 3 },
            localUri: { type: "string", id: 4 },
            remoteUri: { type: "string", id: 5 },
            remoteTarget: { type: "string", id: 6 },
            localCSeq: { type: "int32", id: 7 },
            routeSet: { rule: "repeated", type: "string", id: 8 },
          },
        },
        B2buaDialogExt: {
          fields: {
            remoteCSeq: { type: "int32", id: 1 },
            inboundPendingRequests: { rule: "repeated", type: "PendingRequest", id: 2 },
            ackBranch: { type: "string", id: 3 },
            cachedSdp: { type: "bytes", id: 5 },
          },
        },
        Dialog: {
          fields: {
            sip: { type: "StackDialog", id: 1 },
            ext: { type: "B2buaDialogExt", id: 2 },
          },
        },
        Leg: {
          fields: {
            legId: { type: "string", id: 1 },
            callId: { type: "string", id: 2 },
            fromTag: { type: "string", id: 3 },
            source: { type: "RemoteInfo", id: 4 },
            state: { type: "string", id: 5 },
            disposition: { type: "string", id: 6 },
            dialogs: { rule: "repeated", type: "Dialog", id: 7 },
            byeDisposition: { type: "string", id: 8 },
            localUri: { type: "string", id: 9 },
            remoteUri: { type: "string", id: 10 },
            inviteRequestUri: { type: "string", id: 11 },
          },
        },
        ALegInvite: {
          fields: {
            uri: { type: "string", id: 1 },
            headers: { rule: "repeated", type: "SipHeader", id: 2 },
            body: { type: "bytes", id: 3 },
          },
        },
        TagMapping: {
          fields: {
            aTag: { type: "string", id: 1 },
            bLegId: { type: "string", id: 2 },
            bTag: { type: "string", id: 3 },
          },
        },
        CallLimiterState: {
          fields: {
            limiterId: { type: "string", id: 1 },
            limit: { type: "int32", id: 2 },
            originWindow: { type: "double", id: 3 },
            incrementSucceeded: { type: "bool", id: 4 },
          },
        },
        TimerEntry: {
          fields: {
            id: { type: "string", id: 1 },
            type: { type: "string", id: 2 },
            fireAt: { type: "double", id: 3 },
            legId: { type: "string", id: 4 },
          },
        },
        CdrEvent: {
          fields: {
            type: { type: "string", id: 1 },
            timestamp: { type: "double", id: 2 },
            legId: { type: "string", id: 3 },
            statusCode: { type: "int32", id: 4 },
            reason: { type: "string", id: 5 },
          },
        },
        CallTopology: {
          fields: { pri: { type: "string", id: 1 }, bak: { type: "string", id: 2 }, gen: { type: "int32", id: 3 } },
        },
        ActiveRule: {
          fields: {
            id: { type: "string", id: 1 },
            paramsJson: { type: "string", id: 2 },
            active: { type: "bool", id: 3 },
          },
        },
        RuleStateEntry: {
          fields: {
            ruleId: { type: "string", id: 1 },
            stateJson: { type: "string", id: 2 },
          },
        },
        ActivePeer: {
          fields: { legA: { type: "string", id: 1 }, legB: { type: "string", id: 2 } },
        },
        Call: {
          fields: {
            callRef: { type: "string", id: 1 },
            aLeg: { type: "Leg", id: 2 },
            bLegs: { rule: "repeated", type: "Leg", id: 3 },
            activePeer: { type: "ActivePeer", id: 4 },
            callbackContext: { type: "string", id: 5 },
            billingContext: { type: "string", id: 6 },
            aLegInvite: { type: "ALegInvite", id: 7 },
            limiterEntries: { rule: "repeated", type: "CallLimiterState", id: 8 },
            timers: { rule: "repeated", type: "TimerEntry", id: 9 },
            cdrEvents: { rule: "repeated", type: "CdrEvent", id: 10 },
            state: { type: "string", id: 11 },
            createdAt: { type: "double", id: 12 },
            aLegPendingVias: { rule: "repeated", type: "string", id: 13 },
            aLegPendingCSeq: { type: "int32", id: 14 },
            tagMap: { rule: "repeated", type: "TagMapping", id: 15 },
            traceId: { type: "string", id: 16 },
            rootSpanId: { type: "string", id: 17 },
            sampled: { type: "bool", id: 18 },
            workerIndex: { type: "int32", id: 19 },
            topology: { type: "CallTopology", id: 20 },
            emergency: { type: "bool", id: 21 },
            featuresJson: { type: "string", id: 22 },
            policyUpdateHeadersJson: { type: "string", id: 23 },
            policyUpdateBody: { type: "bytes", id: 24 },
            activeRules: { rule: "repeated", type: "ActiveRule", id: 25 },
            ruleState: { rule: "repeated", type: "RuleStateEntry", id: 26 },
            transferJson: { type: "string", id: 27 },
            earlyPromoteJson: { type: "string", id: 28 },
          },
        },
        Frame: {
          fields: {
            gen: { type: "int32", id: 1 },
            counter: { type: "int32", id: 2 },
            op: { type: "string", id: 3 },
            partition: { type: "string", id: 4 },
            callRef: { type: "string", id: 5 },
            body: { type: "bytes", id: 6 },
            bodyTtlRemainingSec: { type: "int32", id: 7 },
            latencyMs: { type: "int32", id: 8 },
          },
        },
      },
    },
  },
})

const CallProto = protoRoot.lookupType("bench.Call")
const FrameProto = protoRoot.lookupType("bench.Frame")

const toProtoCall = (c: any): any => {
  const out: any = { ...c }
  if (c.activeRules) {
    out.activeRules = c.activeRules.map((r: any) => ({
      id: r.id,
      active: r.active,
      paramsJson: r.params === undefined ? undefined : JSON.stringify(r.params),
    }))
  }
  if (c.ruleState) {
    out.ruleState = c.ruleState.map((r: any) => ({
      ruleId: r.ruleId,
      stateJson: r.state === undefined ? undefined : JSON.stringify(r.state),
    }))
  }
  if (c.features !== undefined) out.featuresJson = JSON.stringify(c.features)
  if (c.policyUpdateHeaders !== undefined) out.policyUpdateHeadersJson = JSON.stringify(c.policyUpdateHeaders)
  if (c.transfer !== undefined) out.transferJson = JSON.stringify(c.transfer)
  if (c.earlyPromote !== undefined) out.earlyPromoteJson = JSON.stringify(c.earlyPromote)
  if (c._topology !== undefined) out.topology = c._topology
  delete out.features
  delete out.policyUpdateHeaders
  delete out.transfer
  delete out.earlyPromote
  delete out._topology
  // The production spread stamps __writtenAtMs on the Call before
  // encode. Protobuf has no field for it (it would live in the envelope
  // under Fix #2). Drop here so fromObject doesn't carry the orphan;
  // the spread allocation cost was already paid by stampWrittenAt().
  delete out.__writtenAtMs
  return out
}

const fromProtoCall = (p: any): any => {
  const out: any = { ...p }
  if (Array.isArray(p.activeRules)) {
    out.activeRules = p.activeRules.map((r: any) => ({
      id: r.id,
      active: r.active,
      params: r.paramsJson !== undefined ? JSON.parse(r.paramsJson) : undefined,
    }))
  }
  if (Array.isArray(p.ruleState)) {
    out.ruleState = p.ruleState.map((r: any) => ({
      ruleId: r.ruleId,
      state: r.stateJson !== undefined ? JSON.parse(r.stateJson) : undefined,
    }))
  }
  if (p.featuresJson !== undefined) out.features = JSON.parse(p.featuresJson)
  if (p.policyUpdateHeadersJson !== undefined) out.policyUpdateHeaders = JSON.parse(p.policyUpdateHeadersJson)
  if (p.transferJson !== undefined) out.transfer = JSON.parse(p.transferJson)
  if (p.earlyPromoteJson !== undefined) out.earlyPromote = JSON.parse(p.earlyPromoteJson)
  if (p.topology !== undefined) out._topology = p.topology
  delete out.featuresJson
  delete out.policyUpdateHeadersJson
  delete out.transferJson
  delete out.earlyPromoteJson
  delete out.topology
  return out
}

export const v5 = {
  name: "v5-protobuf",
  encodeCall(call: unknown): Buffer {
    const msg = CallProto.fromObject(toProtoCall(stampWrittenAt(call)))
    return Buffer.from(CallProto.encode(msg).finish())
  },
  wireEncode(env: FrameEnv, body: Buffer): Buffer {
    const msg = FrameProto.fromObject({
      gen: env.gen,
      counter: env.counter,
      op: env.op,
      partition: env.partition,
      callRef: env.callRef,
      body,
      bodyTtlRemainingSec: env.body_ttl_remaining_sec,
      latencyMs: env.latency_ms,
    })
    return Buffer.from(FrameProto.encode(msg).finish())
  },
  wireDecode(frameBytes: Buffer): { env: FrameEnv; body: Buffer } {
    const f = FrameProto.decode(frameBytes) as any
    return {
      env: {
        type: "data",
        gen: f.gen,
        counter: f.counter,
        op: f.op,
        partition: f.partition,
        callRef: f.callRef,
        body_ttl_remaining_sec: f.bodyTtlRemainingSec,
        latency_ms: f.latencyMs,
      },
      body: Buffer.from(f.body),
    }
  },
  decodeCall(body: Buffer): unknown {
    const p = CallProto.decode(body) as any
    return fromProtoCall(CallProto.toObject(p, { defaults: false, bytes: Buffer }))
  },
}

// ---------------------------------------------------------------------------
// V5b — Protobuf STATIC codegen (`pbjs --target static-module`).
//       Same wire format as v5; only the encode/decode path differs (no
//       Runtime reflection, no Root metadata, no JIT compile on first call).
//       Hypothesis: removes per-iteration allocations that the reflective
//       converter still does for intermediate JS objects.
// ---------------------------------------------------------------------------

export const v5b = {
  name: "v5b-protobuf-static",
  encodeCall(call: unknown): Buffer {
    const msg = StaticCallProto.fromObject(toProtoCall(stampWrittenAt(call)))
    return Buffer.from(StaticCallProto.encode(msg).finish())
  },
  wireEncode(env: FrameEnv, body: Buffer): Buffer {
    const msg = StaticFrameProto.fromObject({
      gen: env.gen,
      counter: env.counter,
      op: env.op,
      partition: env.partition,
      callRef: env.callRef,
      body,
      bodyTtlRemainingSec: env.body_ttl_remaining_sec,
      latencyMs: env.latency_ms,
    })
    return Buffer.from(StaticFrameProto.encode(msg).finish())
  },
  wireDecode(frameBytes: Buffer): { env: FrameEnv; body: Buffer } {
    const f = StaticFrameProto.decode(frameBytes) as any
    return {
      env: {
        type: "data",
        gen: f.gen,
        counter: f.counter,
        op: f.op,
        partition: f.partition,
        callRef: f.callRef,
        body_ttl_remaining_sec: f.bodyTtlRemainingSec,
        latency_ms: f.latencyMs,
      },
      body: Buffer.from(f.body),
    }
  },
  decodeCall(body: Buffer): unknown {
    const p = StaticCallProto.decode(body) as any
    return fromProtoCall(StaticCallProto.toObject(p, { defaults: false, bytes: Buffer }))
  },
}

// ---------------------------------------------------------------------------
// V6 — msgpackr (bonus: binary, schemaless, no codegen).
// ---------------------------------------------------------------------------

export const v6 = {
  name: "v6-msgpackr",
  encodeCall(call: unknown): Buffer {
    return mpPack(stampWrittenAt(call)) as Buffer
  },
  wireEncode(env: FrameEnv, body: Buffer): Buffer {
    return mpPack({ ...env, body })
  },
  wireDecode(frameBytes: Buffer): { env: FrameEnv; body: Buffer } {
    const obj = mpUnpack(frameBytes) as any
    const { body, ...env } = obj
    return { env: env as FrameEnv, body: body as Buffer }
  },
  decodeCall(body: Buffer): unknown {
    return mpUnpack(body)
  },
}
