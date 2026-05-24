/**
 * Subprocess entry point. One variant per process — fresh V8 heap, no JIT
 * carry-over, no shared optimisation profile between variants.
 *
 *   tsx worker.ts <variantName> <iterations>
 *
 * Output (last stdout line): single JSON object with timings + bytes +
 * GC pressure (counts, total pause time, per-kind breakdown) for each
 * stage, plus a `fixtureMix` tally so the driver can show what
 * distribution the numbers were measured against.
 *
 * Stages:
 *   A          encodeCall(call)                          [body pack]
 *   B          wireEncode(env, body)                     [envelope pack]
 *   C          wireDecode(frame)
 *   D          decodeCall(body)
 *   fullFlush  encodeCall + wireEncode                   [PRODUCTION HOT LOOP]
 *   FULL       encodeCall + wireEncode + wireDecode + decodeCall
 */

import { PerformanceObserver, constants as perfConstants } from "node:perf_hooks"
import * as v8 from "node:v8"
import { sampleEnv, v1, v2, v3, v5, v5b, v6, makeV4, CasStore } from "./codec.js"
import { buildFixturePool, DEFAULT_MIX, tallyKinds } from "./fixtureMix.js"

const variantName = process.argv[2]
const iterations = parseInt(process.argv[3] ?? "10000", 10)
if (!variantName || !Number.isFinite(iterations) || iterations < 1) {
  console.error("usage: worker.ts <variant> <iterations>")
  process.exit(2)
}

const cas = new CasStore()
const variants: Record<string, any> = {
  [v1.name]: v1,
  [v2.name]: v2,
  [v3.name]: v3,
  [v5.name]: v5,
  [v5b.name]: v5b,
  [v6.name]: v6,
}
variants["v4-cas-outofband"] = makeV4(cas)

const variant = variants[variantName]
if (!variant) {
  console.error(`unknown variant: ${variantName}. known: ${Object.keys(variants).join(", ")}`)
  process.exit(2)
}

// ── Fixture mix ────────────────────────────────────────────────────────────
// Cap the pool size so setup stays cheap; high iteration counts cycle
// through the pool multiple times. 2048 unique shapes is enough to
// exercise the full distribution without dominating wall time.
const POOL_SIZE = Math.min(2048, Math.max(64, iterations))
const fixturePool = buildFixturePool(DEFAULT_MIX, POOL_SIZE)
const kindTally = tallyKinds(fixturePool)

// Pre-build (body, frame) per fixture for downstream stages. These pay
// the same encode cost the worker would pay — but only once per
// fixture, then cached, so the C/D stages measure decode alone.
const preBuiltBodies: any[] = new Array(POOL_SIZE)
const preBuiltFrames: any[] = new Array(POOL_SIZE)
for (let i = 0; i < POOL_SIZE; i++) {
  const call = fixturePool[i]!
  const env = sampleEnv(call)
  const body = variant.encodeCall(call)
  preBuiltBodies[i] = body
  preBuiltFrames[i] = variant.wireEncode(env, body)
}

// Sanity round-trip on the first fixture so the worker fails fast on
// obvious bugs instead of producing garbage numbers.
const sanity = variant.decodeCall(preBuiltBodies[0])
if (typeof sanity !== "object" || sanity === null) {
  console.error(`[${variantName}] decodeCall did not produce object`)
  process.exit(3)
}

const WARMUP = Math.max(1, Math.min(1000, Math.floor(iterations / 10)))

// ── GC pressure recorder ───────────────────────────────────────────────────
// PerformanceObserver with entryTypes:['gc'] gives us one entry per GC pause,
// including kind (minor/major/incremental/weakcb) and duration in ms.
// Combined with v8.getHeapStatistics().total_heap_size deltas, this captures
// allocation pressure independent of wall-clock timing.

type GcEntry = { kind: number; durationMs: number }
const gcByPhase: Record<string, GcEntry[]> = {}
let currentPhase: string | null = null
const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    if (currentPhase === null) continue
    ;(gcByPhase[currentPhase] ??= []).push({
      kind: (e as any).detail?.kind ?? (e as any).kind ?? 0,
      durationMs: e.duration,
    })
  }
})
obs.observe({ entryTypes: ["gc"], buffered: false })

const GC_KIND_LABEL: Record<number, string> = {
  [perfConstants.NODE_PERFORMANCE_GC_MAJOR]: "major",
  [perfConstants.NODE_PERFORMANCE_GC_MINOR]: "minor",
  [perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
  [perfConstants.NODE_PERFORMANCE_GC_WEAKCB]: "weakcb",
}

const summariseGc = (entries: GcEntry[] | undefined) => {
  if (!entries || entries.length === 0) {
    return { count: 0, totalMs: 0, byKind: {} as Record<string, { count: number; totalMs: number }> }
  }
  const byKind: Record<string, { count: number; totalMs: number }> = {}
  let totalMs = 0
  for (const e of entries) {
    const k = GC_KIND_LABEL[e.kind] ?? `kind-${e.kind}`
    const slot = (byKind[k] ??= { count: 0, totalMs: 0 })
    slot.count++
    slot.totalMs += e.durationMs
    totalMs += e.durationMs
  }
  return { count: entries.length, totalMs, byKind }
}

const sleep = () => new Promise<void>((r) => setImmediate(r))

const ns = (start: bigint, end: bigint): number => Number(end - start)

const measure = async (name: string, fn: (i: number) => void, iter: number, warmup: number) => {
  // Warm up + GC quiesce, then start recording GC for THIS phase only.
  for (let i = 0; i < warmup; i++) fn(i)
  if (typeof (globalThis as any).gc === "function") (globalThis as any).gc()
  await sleep()

  const heapBefore = v8.getHeapStatistics()
  currentPhase = name
  const samples: number[] = new Array(iter)
  let total = 0n
  const t0Phase = process.hrtime.bigint()
  for (let i = 0; i < iter; i++) {
    const t0 = process.hrtime.bigint()
    fn(i)
    const t1 = process.hrtime.bigint()
    samples[i] = ns(t0, t1)
    total += t1 - t0
  }
  const t1Phase = process.hrtime.bigint()
  await sleep()
  currentPhase = null
  const heapAfter = v8.getHeapStatistics()

  samples.sort((a, b) => a - b)
  const gc = summariseGc(gcByPhase[name])
  const wallNs = Number(t1Phase - t0Phase)
  return {
    name,
    iter,
    totalNs: Number(total),
    wallNs,
    meanNs: Number(total) / iter,
    p50Ns: samples[Math.floor(iter * 0.5)],
    p95Ns: samples[Math.floor(iter * 0.95)],
    p99Ns: samples[Math.floor(iter * 0.99)],
    gc: {
      count: gc.count,
      totalMs: gc.totalMs,
      pctOfWall: wallNs > 0 ? (gc.totalMs * 1e6) / wallNs * 100 : 0,
      perIterCount: gc.count / iter,
      byKind: gc.byKind,
    },
    heap: {
      deltaMb: (heapAfter.used_heap_size - heapBefore.used_heap_size) / 1_048_576,
      totalDeltaMb: (heapAfter.total_heap_size - heapBefore.total_heap_size) / 1_048_576,
      mallocedDeltaMb: (heapAfter.malloced_memory - heapBefore.malloced_memory) / 1_048_576,
    },
  }
}

const sizeOf = (x: unknown): number => {
  if (typeof x === "string") return Buffer.byteLength(x, "utf8")
  if (Buffer.isBuffer(x)) return x.length
  if (x instanceof Uint8Array) return x.length
  return -1
}

// Headline "bytes" numbers — averaged across the pool (each fixture
// shape encodes to different sizes). Reported as both mean and max so
// reviewers see both the typical case and the abuse outliers.
const bytesStats = () => {
  let bodyTotal = 0
  let bodyMax = 0
  let frameTotal = 0
  let frameMax = 0
  for (let i = 0; i < POOL_SIZE; i++) {
    const bs = sizeOf(preBuiltBodies[i])
    const fs = sizeOf(preBuiltFrames[i])
    if (bs > 0) { bodyTotal += bs; if (bs > bodyMax) bodyMax = bs }
    if (fs > 0) { frameTotal += fs; if (fs > frameMax) frameMax = fs }
  }
  return {
    bodyMean: Math.round(bodyTotal / POOL_SIZE),
    bodyMax,
    frameMean: Math.round(frameTotal / POOL_SIZE),
    frameMax,
  }
}

const memBefore = process.memoryUsage()

const main = async () => {
  // Per-fixture envelopes cached up-front so wireEncode doesn't pay
  // sampleEnv allocation per iteration.
  const envs = fixturePool.map(sampleEnv)

  // Stages reach into the pool by `i % POOL_SIZE`. The same iteration
  // index hits matching (call, body, frame) so cross-stage correctness
  // is preserved without per-iter reassembly.
  const pick = (i: number) => i % POOL_SIZE

  const stageA = await measure("A.encodeCall", (i) => {
    const j = pick(i)
    variant.encodeCall(fixturePool[j]!)
  }, iterations, WARMUP)

  const stageB = await measure("B.wireEncode", (i) => {
    const j = pick(i)
    variant.wireEncode(envs[j]!, preBuiltBodies[j])
  }, iterations, WARMUP)

  const stageC = await measure("C.wireDecode", (i) => {
    variant.wireDecode(preBuiltFrames[pick(i)])
  }, iterations, WARMUP)

  const stageD = await measure("D.decodeCall", (i) => {
    variant.decodeCall(preBuiltBodies[pick(i)])
  }, iterations, WARMUP)

  // Production hot loop: every state-mutating SIP message fires both
  // packs back-to-back. The cumulative cost is what the May 2026
  // endurance run revealed as ~25 % CPU. This is the headline number.
  const fullFlushIter = Math.min(iterations, 10000)
  const stageFullFlush = await measure("fullFlush", (i) => {
    const j = pick(i)
    const body = variant.encodeCall(fixturePool[j]!)
    variant.wireEncode(envs[j]!, body)
  }, fullFlushIter, Math.max(1, Math.min(WARMUP, 1000)))

  // Full round-trip — what the replication receiver pays. Includes
  // wire-decode + body-decode on top of the producer side.
  const stageFull = await measure("FULL.pipeline", (i) => {
    const j = pick(i)
    const body = variant.encodeCall(fixturePool[j]!)
    const frame = variant.wireEncode(envs[j]!, body)
    const { body: backBody } = variant.wireDecode(frame)
    variant.decodeCall(backBody)
  }, Math.min(iterations, 10000), Math.max(1, Math.min(WARMUP, 1000)))

  const memAfter = process.memoryUsage()
  const bytes = bytesStats()

  const result = {
    variant: variantName,
    iterations,
    poolSize: POOL_SIZE,
    fixtureMix: kindTally,
    bytes,
    stages: {
      A: stageA,
      B: stageB,
      C: stageC,
      D: stageD,
      fullFlush: stageFullFlush,
      FULL: stageFull,
    },
    mem: {
      rssDeltaMb: (memAfter.rss - memBefore.rss) / 1_048_576,
      heapDeltaMb: (memAfter.heapUsed - memBefore.heapUsed) / 1_048_576,
      externalDeltaMb: (memAfter.external - memBefore.external) / 1_048_576,
    },
  }

  obs.disconnect()
  console.log("__RESULT__" + JSON.stringify(result))
}

main().catch((e) => { console.error(e); process.exit(1) })
