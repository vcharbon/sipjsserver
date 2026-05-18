/**
 * Endurance run timeline renderer (CLI).
 *
 *   npm run test:k8s:endurance:render -- <run-dir>
 *
 * Reads the artifact directory of a finished endurance run and emits a
 * single self-contained HTML page (`<run-dir>/timeline.html`) plotting,
 * on a shared time axis:
 *
 *   - Limiter inflight (limiter-probe.ndjson) with cap reference
 *   - Per-worker concurrent calls (derived from proxy logs:
 *     "routed INVITE …→<workerIp>" minus matching "routed BYE …")
 *   - Per-proxy concurrent calls (same rule, scoped per proxy pod log)
 *   - Sipp calls/sec and failures/sec per stream (from sipp stat.csv)
 *   - Proxy "no alive workers" warning rate (from proxy logs)
 *   - Chaos windows shaded as background bands across every chart
 *
 * Visualisation is uPlot, vendored at
 * `tests/k8s/endurance/assets/uplot/`. The renderer copies those two
 * files next to the generated HTML so the report stays self-contained
 * (no CDN required at view time).
 *
 * The metrics/ directory in our endurance runs is currently empty
 * (the in-pod /metrics scrape produces zero rows), so per-pod inflight
 * is derived from proxy log INVITE/BYE pairs rather than a true gauge.
 */

import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import * as readline from "node:readline"

const SAMPLE_PERIOD_SEC = 5
const ASSET_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "assets",
  "uplot",
)

interface MetadataFile {
  readonly runId: string
  readonly tStart: string
  readonly args: { readonly limiterCap: number }
  readonly phase: {
    readonly tWarmupStart: string
    readonly tSoakStart: string
    readonly tSoakEnd: string
    readonly tCooldownEnd: string
    readonly tDrainEnd: string
  }
  /** uname -r captured at run start (undefined for older runs). */
  readonly kernel?: string
}

interface SippStalenessRow {
  readonly tDetected: string
  readonly name: string
  readonly scenario: string
  readonly lastElapsed: string
}

interface PlatformHealth {
  readonly kernel: string | undefined
  readonly isWsl2: boolean
  readonly stalenessEvents: ReadonlyArray<SippStalenessRow>
}

interface ChaosRow {
  readonly type: string
  readonly status: "executed" | "skipped"
  readonly target?: string
  readonly tFire: string
  readonly tRecovered?: string
}

interface LimiterRow {
  readonly tScrape: string
  readonly inflight: number
  readonly redisReady: boolean
}

interface SippStream {
  readonly name: string
  readonly t: ReadonlyArray<number>
  readonly callsPerSec: ReadonlyArray<number | null>
  readonly failsPerSec: ReadonlyArray<number | null>
  readonly currentCall: ReadonlyArray<number | null>
  /**
   * Cumulative failure counts straight from sipp's stat.csv `(C)`
   * columns — monotonically increasing. `failsTotal` is `FailedCall(C)`;
   * the breakdown buckets sum to ≤ total (sipp also has long-tail
   * categories like regexp / cmd-not-sent which we lump into "other"
   * implicitly = total − the named buckets).
   */
  readonly failsCumTotal: ReadonlyArray<number | null>
  readonly failsCumTimeout: ReadonlyArray<number | null>
  readonly failsCumUnexpected: ReadonlyArray<number | null>
  readonly failsCumRejected: ReadonlyArray<number | null>
}

/**
 * Per-worker / per-proxy traffic distribution as INVITE rate (calls/sec
 * routed). True per-pod inflight would require the in-pod /metrics
 * scrape (which currently produces no rows in our endurance artifacts);
 * deriving "concurrent calls" from proxy logs alone is unreliable
 * because pod-log capture only retains the original incarnation per
 * pod name, so BYEs handled after a pod restart are lost — leaking the
 * INVITE − BYE counter monotonically. The INVITE rate is leak-free
 * because each event is counted exactly once in its time bucket.
 */
interface PerWorkerSeries {
  readonly t: ReadonlyArray<number>
  readonly perIp: Readonly<Record<string, ReadonlyArray<number>>>
}

interface PerProxySeries {
  readonly t: ReadonlyArray<number>
  readonly perPod: Readonly<Record<string, ReadonlyArray<number>>>
}

interface WarningSeries {
  readonly t: ReadonlyArray<number>
  readonly ratePerSec: ReadonlyArray<number>
}

/**
 * Replication queue depth, sampled from worker logs at the
 * `repl: sampler-window` cadence (~1 sample/sec). One series per
 * (source-worker → peer) pair, bucketed to the chart period using the
 * mean of the period's `queue_depth_mean` readings. Rising queue depth
 * is the leading indicator that replication is falling behind, which
 * the 1h chaos run revealed runs in lockstep with the proxy's stuck
 * "no alive workers" state.
 */
interface QueueDepthSeries {
  readonly t: ReadonlyArray<number>
  readonly perPair: Readonly<Record<string, ReadonlyArray<number>>>
}

/**
 * One series per (metric × pod × labels-without-`pod`-key). Each
 * series shares the report's master time grid so all metric charts
 * pan/zoom together. The `label` is what shows in the chart legend
 * (e.g. `worker-0[reason=request_invite]`).
 */
interface MetricSeries {
  readonly label: string
  readonly values: ReadonlyArray<number>
}

interface MetricSeriesGrid {
  readonly t: ReadonlyArray<number>
  readonly series: ReadonlyArray<MetricSeries>
}

/**
 * Snapshot of the worker-side Prometheus metrics that the recorder
 * collects in `metrics/<pod>.ndjson`. Only the metrics that materially
 * help diagnose the freeze / overload classes are charted; everything
 * else stays in the CSVs for ad-hoc inspection.
 */
interface WorkerMetricCharts {
  readonly gcWindowPause: MetricSeriesGrid
  readonly loopLagP95: MetricSeriesGrid
  readonly eventQueueDepth: MetricSeriesGrid
  readonly eventQueueDropsRate: MetricSeriesGrid
  readonly terminatingByBucket: MetricSeriesGrid
  readonly activeTimers: MetricSeriesGrid
  readonly forcePurgeTotal: MetricSeriesGrid
  readonly handlerTimeoutsRate: MetricSeriesGrid
  readonly udpQueueDepth: MetricSeriesGrid
  readonly udpDropsRate: MetricSeriesGrid
  readonly overloadFraction: MetricSeriesGrid
  readonly overloadShedProb: MetricSeriesGrid
  readonly otelBspQueueDepth: MetricSeriesGrid
  readonly otelBspDroppedRate: MetricSeriesGrid
  readonly procVmRss: MetricSeriesGrid
  readonly procThreads: MetricSeriesGrid
}

interface ReportData {
  readonly runId: string
  readonly tStart: number
  readonly tEnd: number
  readonly limiterCap: number
  readonly phase: {
    readonly tSoakStart: number
    readonly tSoakEnd: number
    readonly tCooldownEnd: number
    readonly tDrainEnd: number
  }
  readonly chaos: ReadonlyArray<{
    readonly type: string
    readonly target: string
    readonly tFire: number
    readonly tRecovered: number
    /**
     * True for events the harness did not schedule — currently only
     * sipp-staleness-derived `kernel-stall` rows. Rendered with an
     * "unsolicited" badge so they don't get mistaken for a planned cut.
     */
    readonly unsolicited?: boolean
  }>
  readonly limiter: {
    readonly t: ReadonlyArray<number>
    readonly inflight: ReadonlyArray<number>
  }
  readonly perWorker: PerWorkerSeries
  readonly perProxy: PerProxySeries
  readonly streams: ReadonlyArray<SippStream>
  readonly proxyWarnings: WarningSeries
  readonly queueDepth: QueueDepthSeries
  readonly workerMetrics: WorkerMetricCharts
  readonly platform: PlatformHealth
}

/* -------------------------------------------------------------------- */
/* IO helpers                                                            */
/* -------------------------------------------------------------------- */

const readJson = async <T>(p: string): Promise<T> =>
  JSON.parse(await fsp.readFile(p, "utf8")) as T

const readNdjson = async <T>(p: string): Promise<Array<T>> => {
  const raw = await fsp.readFile(p, "utf8").catch(() => "")
  const out: Array<T> = []
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      // skip partial / corrupt rows
    }
  }
  return out
}

const epoch = (iso: string): number => new Date(iso).getTime() / 1000

/* -------------------------------------------------------------------- */
/* Sipp stat.csv parser                                                  */
/* -------------------------------------------------------------------- */

const parseSippStatCsv = async (
  filePath: string,
  name: string,
): Promise<SippStream | undefined> => {
  const text = await fsp.readFile(filePath, "utf8").catch(() => "")
  if (text === "") return undefined
  const lines = text.split("\n").filter((l) => l.length > 0)
  if (lines.length < 2) return undefined
  const header = (lines[0] ?? "").split(";")
  const idxCurrentTime = header.indexOf("CurrentTime")
  const idxSuccessP = header.indexOf("SuccessfulCall(P)")
  const idxFailedP = header.indexOf("FailedCall(P)")
  const idxCallRateP = header.indexOf("CallRate(P)")
  const idxCurrentCall = header.indexOf("CurrentCall")
  const idxFailedC = header.indexOf("FailedCall(C)")
  const idxTORecvC = header.indexOf("FailedTimeoutOnRecv(C)")
  const idxTOSendC = header.indexOf("FailedTimeoutOnSend(C)")
  const idxUnexpC = header.indexOf("FailedUnexpectedMessage(C)")
  const idxRejC = header.indexOf("FailedCallRejected(C)")
  if (idxCurrentTime < 0 || idxFailedP < 0) return undefined
  const t: Array<number> = []
  const callsPerSec: Array<number> = []
  const failsPerSec: Array<number> = []
  const currentCall: Array<number> = []
  const failsCumTotal: Array<number> = []
  const failsCumTimeout: Array<number> = []
  const failsCumUnexpected: Array<number> = []
  const failsCumRejected: Array<number> = []
  for (let i = 1; i < lines.length; i++) {
    const cols = (lines[i] ?? "").split(";")
    // CurrentTime is "YYYY-MM-DD\tHH:MM:SS.ffffff\t<unixSecondsWithFraction>"
    const ct = cols[idxCurrentTime] ?? ""
    const parts = ct.split("\t")
    const unix = parseFloat(parts[2] ?? "")
    if (!Number.isFinite(unix)) continue
    // Per-period counts. CallRate(P) is calls launched per second in the
    // period; SuccessfulCall(P)/FailedCall(P) are absolute counts in the
    // period. With 10s periods we divide by the period length to get
    // calls/sec; using CallRate(P) directly is cleaner for the rate
    // series.
    const callRate = idxCallRateP >= 0 ? parseFloat(cols[idxCallRateP] ?? "0") : 0
    const failedP = parseFloat(cols[idxFailedP] ?? "0")
    const successP = idxSuccessP >= 0 ? parseFloat(cols[idxSuccessP] ?? "0") : 0
    // Sipp writes one trailing cumulative-only row at shutdown whose
    // period counters are all zero. Drop ONLY that final row — never
    // mid-test rows: under saturation a SIPP stream may legitimately
    // launch zero new calls and see zero answers in a 10s period
    // while still holding thousands of calls in CurrentCall, and
    // those rows are exactly the "wedged" plateau the report needs.
    if (
      i === lines.length - 1 &&
      callRate === 0 &&
      failedP === 0 &&
      successP === 0
    ) {
      break
    }
    t.push(unix)
    callsPerSec.push(Number.isFinite(callRate) ? callRate : 0)
    // FailedCall(P) is over a 10s period; convert to per-sec for the
    // y-axis.
    failsPerSec.push(Number.isFinite(failedP) ? failedP / 10 : 0)
    const cc = idxCurrentCall >= 0 ? parseFloat(cols[idxCurrentCall] ?? "0") : 0
    currentCall.push(Number.isFinite(cc) ? cc : 0)
    const fnum = (idx: number): number => {
      if (idx < 0) return 0
      const v = parseFloat(cols[idx] ?? "0")
      return Number.isFinite(v) ? v : 0
    }
    failsCumTotal.push(fnum(idxFailedC))
    failsCumTimeout.push(fnum(idxTORecvC) + fnum(idxTOSendC))
    failsCumUnexpected.push(fnum(idxUnexpC))
    failsCumRejected.push(fnum(idxRejC))
  }
  return {
    name,
    t,
    callsPerSec,
    failsPerSec,
    currentCall,
    failsCumTotal,
    failsCumTimeout,
    failsCumUnexpected,
    failsCumRejected,
  }
}

/**
 * Resample a sipp stream onto the global tStart..tEnd grid so every
 * stream shares the same X axis. Sipp emits one CSV row per ~10s
 * period and bursts run for only a minute or two, so each raw stream
 * has a different length and time domain. Plotting them against
 * `streams[0].t` previously aligned everything to whichever stream
 * the filesystem returned first.
 *
 * Within the stream's observation window [tFirst, tLast+periodSec],
 * carry the latest sipp sample forward into every bucket. Outside it,
 * emit null so uPlot draws gaps instead of zero lines for streams
 * that aren't running.
 */
const resampleSippStream = (
  s: SippStream,
  tStart: number,
  tEnd: number,
  periodSec: number,
): SippStream => {
  const buckets = Math.max(1, Math.ceil((tEnd - tStart) / periodSec))
  const t: Array<number> = new Array(buckets)
  for (let i = 0; i < buckets; i++) t[i] = tStart + i * periodSec
  const cc: Array<number | null> = new Array(buckets).fill(null)
  const cps: Array<number | null> = new Array(buckets).fill(null)
  const fps: Array<number | null> = new Array(buckets).fill(null)
  const fcTotal: Array<number | null> = new Array(buckets).fill(null)
  const fcTO: Array<number | null> = new Array(buckets).fill(null)
  const fcUnexp: Array<number | null> = new Array(buckets).fill(null)
  const fcRej: Array<number | null> = new Array(buckets).fill(null)
  if (s.t.length === 0) {
    return {
      name: s.name,
      t,
      currentCall: cc,
      callsPerSec: cps,
      failsPerSec: fps,
      failsCumTotal: fcTotal,
      failsCumTimeout: fcTO,
      failsCumUnexpected: fcUnexp,
      failsCumRejected: fcRej,
    }
  }
  const tFirst = s.t[0]!
  const tLast = s.t[s.t.length - 1]!
  let j = 0
  for (let i = 0; i < buckets; i++) {
    const bs = t[i]!
    if (bs < tFirst || bs > tLast + periodSec) continue
    while (j + 1 < s.t.length && s.t[j + 1]! <= bs + periodSec) j++
    cc[i] = s.currentCall[j] ?? null
    cps[i] = s.callsPerSec[j] ?? null
    fps[i] = s.failsPerSec[j] ?? null
    fcTotal[i] = s.failsCumTotal[j] ?? null
    fcTO[i] = s.failsCumTimeout[j] ?? null
    fcUnexp[i] = s.failsCumUnexpected[j] ?? null
    fcRej[i] = s.failsCumRejected[j] ?? null
  }
  return {
    name: s.name,
    t,
    currentCall: cc,
    callsPerSec: cps,
    failsPerSec: fps,
    failsCumTotal: fcTotal,
    failsCumTimeout: fcTO,
    failsCumUnexpected: fcUnexp,
    failsCumRejected: fcRej,
  }
}

/* -------------------------------------------------------------------- */
/* Proxy-log parsing — concurrent calls per worker / per proxy + warns   */
/* -------------------------------------------------------------------- */

const PROXY_LINE_RE =
  /^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]\s+(\w+)\s+\(#\d+\):\s+(.*)$/
const ROUTED_RE =
  /^routed\s+(INVITE|BYE)\s+(\S+)\s+→\s+(\d+\.\d+\.\d+\.\d+):\d+\s+\(.*?result=forwarded/
const NO_ALIVE_RE = /no alive workers among/
const REPL_SAMPLER_OPEN_RE = /repl: sampler-window\s*\{/
const REPL_PEER_RE = /peer:\s*'([^']+)'/
const REPL_QDEPTH_MEAN_RE = /queue_depth_mean:\s*([0-9.]+)/

interface RoutedEvent {
  readonly t: number
  readonly method: "INVITE" | "BYE"
  readonly callId: string
  readonly ip: string
  readonly proxyPod: string
}

interface ProxyLogResult {
  readonly events: ReadonlyArray<RoutedEvent>
  readonly warnTimestamps: ReadonlyArray<number>
}

interface QueueDepthSample {
  readonly t: number
  readonly source: string
  readonly peer: string
  readonly queueDepthMean: number
}

const parseProxyLog = async (
  filePath: string,
  proxyPod: string,
  baseDayMs: number,
): Promise<ProxyLogResult> => {
  const events: Array<RoutedEvent> = []
  const warnTimestamps: Array<number> = []
  const stream = fs.createReadStream(filePath)
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let prevSec = -1
  let dayOffsetMs = 0
  for await (const rawLine of rl) {
    const line = rawLine.replace(/\r$/, "")
    const m = PROXY_LINE_RE.exec(line)
    if (!m) continue
    const hh = parseInt(m[1] ?? "", 10)
    const mm = parseInt(m[2] ?? "", 10)
    const ss = parseInt(m[3] ?? "", 10)
    const ms = parseInt(m[4] ?? "", 10)
    const level = m[5] ?? ""
    const rest = m[6] ?? ""
    const dailySec = hh * 3600 + mm * 60 + ss
    // Pino emits lines from multiple fibers / workers and they can land
    // a few seconds out of order, so the midnight-rollover threshold has
    // to be far larger than that jitter to avoid false-detecting a
    // rollover and shifting half the run into "tomorrow". 12 h is a
    // safe gap: real midnight rollover jumps backward by ~24h, log
    // jitter is at most a handful of seconds.
    const HALF_DAY_SEC = 12 * 3600
    if (prevSec >= 0 && dailySec + HALF_DAY_SEC < prevSec) {
      dayOffsetMs += 86_400_000
    }
    prevSec = dailySec
    const tMs = baseDayMs + dayOffsetMs + dailySec * 1000 + ms
    const tSec = tMs / 1000
    if (level === "WARN" && NO_ALIVE_RE.test(rest)) {
      warnTimestamps.push(tSec)
      continue
    }
    const r = ROUTED_RE.exec(rest)
    if (!r) continue
    events.push({
      t: tSec,
      method: r[1] as "INVITE" | "BYE",
      callId: r[2] ?? "",
      ip: r[3] ?? "",
      proxyPod,
    })
  }
  return { events, warnTimestamps }
}

/**
 * Parse `repl: sampler-window` blocks out of a worker pod log. The
 * block opens with `... INFO (#NN): repl: sampler-window {` and spans
 * subsequent lines until a closing `}`. We pick out the timestamp on
 * the open line plus `peer:` and `queue_depth_mean:` from inside the
 * block. Other body lines (lag, n) are ignored.
 *
 * One sample per block; ~1/sec at runtime so the volume is bounded.
 */
const parseWorkerLogQueueDepth = async (
  filePath: string,
  source: string,
  baseDayMs: number,
): Promise<ReadonlyArray<QueueDepthSample>> => {
  const out: Array<QueueDepthSample> = []
  const stream = fs.createReadStream(filePath)
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let prevSec = -1
  let dayOffsetMs = 0
  let inBlock = false
  let blockTSec = 0
  let blockPeer = ""
  let blockQDepthMean: number | undefined
  for await (const rawLine of rl) {
    const line = rawLine.replace(/\r$/, "")
    if (!inBlock) {
      const m = PROXY_LINE_RE.exec(line)
      if (!m) continue
      const rest = m[6] ?? ""
      if (!REPL_SAMPLER_OPEN_RE.test(rest)) continue
      const hh = parseInt(m[1] ?? "", 10)
      const mm = parseInt(m[2] ?? "", 10)
      const ss = parseInt(m[3] ?? "", 10)
      const ms = parseInt(m[4] ?? "", 10)
      const dailySec = hh * 3600 + mm * 60 + ss
      const HALF_DAY_SEC = 12 * 3600
      if (prevSec >= 0 && dailySec + HALF_DAY_SEC < prevSec) {
        dayOffsetMs += 86_400_000
      }
      prevSec = dailySec
      blockTSec = (baseDayMs + dayOffsetMs + dailySec * 1000 + ms) / 1000
      blockPeer = ""
      blockQDepthMean = undefined
      inBlock = true
      continue
    }
    // Inside a sampler block — accumulate fields, close on '}' line.
    const peerMatch = REPL_PEER_RE.exec(line)
    if (peerMatch !== null) blockPeer = peerMatch[1] ?? ""
    const qMatch = REPL_QDEPTH_MEAN_RE.exec(line)
    if (qMatch !== null) {
      const v = parseFloat(qMatch[1] ?? "")
      if (Number.isFinite(v)) blockQDepthMean = v
    }
    if (line.trim() === "}") {
      if (blockPeer !== "" && blockQDepthMean !== undefined) {
        out.push({
          t: blockTSec,
          source,
          peer: blockPeer,
          queueDepthMean: blockQDepthMean,
        })
      }
      inBlock = false
    }
  }
  return out
}

/**
 * Bucket replication-queue-depth samples into per-(source→peer) series.
 * Each bucket holds the mean of the samples falling inside it (so a
 * 5 s bucket smooths out the ~5 per-second sampler readings without
 * distorting the trend).
 */
const bucketQueueDepth = (
  samples: ReadonlyArray<QueueDepthSample>,
  tStart: number,
  tEnd: number,
  periodSec: number,
): QueueDepthSeries => {
  const pairsSet = new Set<string>()
  for (const s of samples) pairsSet.add(`${s.source}→${s.peer}`)
  const pairs = Array.from(pairsSet).sort()
  const buckets = Math.max(1, Math.ceil((tEnd - tStart) / periodSec))
  const t: Array<number> = new Array(buckets)
  for (let i = 0; i < buckets; i++) t[i] = tStart + i * periodSec
  const sumByPair: Record<string, Array<number>> = {}
  const cntByPair: Record<string, Array<number>> = {}
  for (const p of pairs) {
    sumByPair[p] = new Array(buckets).fill(0)
    cntByPair[p] = new Array(buckets).fill(0)
  }
  for (const s of samples) {
    if (s.t < tStart || s.t > tEnd) continue
    const idx = Math.min(buckets - 1, Math.floor((s.t - tStart) / periodSec))
    const key = `${s.source}→${s.peer}`
    sumByPair[key]![idx] = (sumByPair[key]![idx] ?? 0) + s.queueDepthMean
    cntByPair[key]![idx] = (cntByPair[key]![idx] ?? 0) + 1
  }
  const perPair: Record<string, Array<number>> = {}
  for (const p of pairs) {
    const out: Array<number> = new Array(buckets).fill(0)
    for (let i = 0; i < buckets; i++) {
      const c = cntByPair[p]![i] ?? 0
      out[i] = c === 0 ? 0 : (sumByPair[p]![i] ?? 0) / c
    }
    perPair[p] = out
  }
  return { t, perPair }
}

/**
 * Bucket pre-sorted timestamps into a fixed-period rate series.
 */
const bucketRate = (
  timestamps: ReadonlyArray<number>,
  tStart: number,
  tEnd: number,
  periodSec: number,
): { readonly t: Array<number>; readonly rate: Array<number> } => {
  const buckets = Math.max(1, Math.ceil((tEnd - tStart) / periodSec))
  const t: Array<number> = new Array(buckets)
  const rate: Array<number> = new Array(buckets).fill(0)
  for (let i = 0; i < buckets; i++) t[i] = tStart + i * periodSec
  for (const ts of timestamps) {
    if (ts < tStart || ts > tEnd) continue
    const idx = Math.min(buckets - 1, Math.floor((ts - tStart) / periodSec))
    rate[idx] = (rate[idx] ?? 0) + 1
  }
  for (let i = 0; i < buckets; i++) rate[i] = (rate[i] ?? 0) / periodSec
  return { t, rate }
}

/**
 * Bucket pre-sorted INVITE-only events into per-IP and per-proxy rate
 * series (calls/sec). Each event counts exactly once in its time
 * bucket, so the result is leak-free — unlike INVITE − BYE which can
 * grow unboundedly when BYEs are lost to pod-log truncation.
 */
const replayInviteRate = (
  events: ReadonlyArray<RoutedEvent>,
  tStart: number,
  tEnd: number,
  periodSec: number,
): { readonly perWorker: PerWorkerSeries; readonly perProxy: PerProxySeries } => {
  const ipsSet = new Set<string>()
  const podsSet = new Set<string>()
  for (const ev of events) {
    if (ev.method !== "INVITE") continue
    ipsSet.add(ev.ip)
    podsSet.add(ev.proxyPod)
  }
  const ips = Array.from(ipsSet).sort()
  const pods = Array.from(podsSet).sort()
  const buckets = Math.max(1, Math.ceil((tEnd - tStart) / periodSec))
  const t: Array<number> = new Array(buckets)
  for (let i = 0; i < buckets; i++) t[i] = tStart + i * periodSec
  const perIp: Record<string, Array<number>> = {}
  const perPod: Record<string, Array<number>> = {}
  for (const ip of ips) perIp[ip] = new Array(buckets).fill(0)
  for (const pod of pods) perPod[pod] = new Array(buckets).fill(0)
  for (const ev of events) {
    if (ev.method !== "INVITE") continue
    if (ev.t < tStart || ev.t > tEnd) continue
    const idx = Math.min(buckets - 1, Math.floor((ev.t - tStart) / periodSec))
    perIp[ev.ip]![idx] = (perIp[ev.ip]![idx] ?? 0) + 1
    perPod[ev.proxyPod]![idx] = (perPod[ev.proxyPod]![idx] ?? 0) + 1
  }
  for (const ip of ips) {
    for (let i = 0; i < buckets; i++) perIp[ip]![i] = (perIp[ip]![i] ?? 0) / periodSec
  }
  for (const pod of pods) {
    for (let i = 0; i < buckets; i++) perPod[pod]![i] = (perPod[pod]![i] ?? 0) / periodSec
  }
  return {
    perWorker: { t, perIp },
    perProxy: { t, perPod },
  }
}

/* -------------------------------------------------------------------- */
/* Worker /metrics scrape — series builder                               */
/* -------------------------------------------------------------------- */

interface MetricRow {
  readonly tScrape: string
  readonly pod: string
  readonly metric: string
  readonly labels: Record<string, string>
  readonly value: number
}

interface ProcRow {
  readonly tScrape: string
  readonly pod: string
  readonly VmRSS?: number
  readonly Threads?: number
}

/**
 * Build a `metric × pod × split-label` master grid. `kind` selects
 * gauge semantics (sample-mean per bucket) vs counter semantics (raw
 * delta over each bucket, divided by the bucket period to yield a
 * per-second rate). `splitLabel` projects rows onto a single label
 * dimension — useful for `b2bua_overload_fraction{signal=…}` etc.
 *
 * Empty buckets are filled with 0 (rate) or carry-forward (gauge) so
 * the resulting series is dense and uPlot can connect points cleanly
 * even across the rare missed scrape interval.
 */
const buildMetricSeries = (
  rows: ReadonlyArray<MetricRow>,
  metric: string,
  kind: "gauge" | "rate",
  tStart: number,
  tEnd: number,
  periodSec: number,
  splitLabel?: string,
): MetricSeriesGrid => {
  const buckets = Math.max(1, Math.ceil((tEnd - tStart) / periodSec))
  const t: Array<number> = new Array(buckets)
  for (let i = 0; i < buckets; i++) t[i] = tStart + i * periodSec

  // Group rows by (pod, splitValue), preserving scrape time order.
  const grouped = new Map<string, Array<{ readonly t: number; readonly v: number }>>()
  for (const r of rows) {
    if (r.metric !== metric) continue
    const splitV = splitLabel === undefined ? "" : (r.labels[splitLabel] ?? "")
    const key = splitV === "" ? r.pod : `${r.pod}[${splitLabel}=${splitV}]`
    const tSec = new Date(r.tScrape).getTime() / 1000
    if (!Number.isFinite(tSec)) continue
    let list = grouped.get(key)
    if (list === undefined) {
      list = []
      grouped.set(key, list)
    }
    list.push({ t: tSec, v: r.value })
  }

  const series: Array<MetricSeries> = []
  const labels = Array.from(grouped.keys()).sort()
  for (const lab of labels) {
    const samples = grouped.get(lab)!
    samples.sort((a, b) => a.t - b.t)
    const out: Array<number> = new Array(buckets).fill(0)
    if (kind === "gauge") {
      const sum: Array<number> = new Array(buckets).fill(0)
      const cnt: Array<number> = new Array(buckets).fill(0)
      for (const s of samples) {
        if (s.t < tStart || s.t > tEnd) continue
        const idx = Math.min(buckets - 1, Math.floor((s.t - tStart) / periodSec))
        sum[idx] = (sum[idx] ?? 0) + s.v
        cnt[idx] = (cnt[idx] ?? 0) + 1
      }
      // carry-forward last seen bucket value into empty buckets so the
      // line stays continuous; leading empties stay at 0.
      let last = 0
      for (let i = 0; i < buckets; i++) {
        const c = cnt[i] ?? 0
        if (c > 0) {
          last = (sum[i] ?? 0) / c
          out[i] = last
        } else {
          out[i] = last
        }
      }
    } else {
      // counter — delta between successive samples, attributed to the
      // bucket that contains the *later* sample, divided by bucket
      // period for a per-second rate.
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1]!
        const b = samples[i]!
        if (b.t < tStart || b.t > tEnd) continue
        const dv = Math.max(0, b.v - a.v)
        const idx = Math.min(buckets - 1, Math.floor((b.t - tStart) / periodSec))
        out[idx] = (out[idx] ?? 0) + dv / periodSec
      }
    }
    series.push({ label: lab, values: out })
  }
  return { t, series }
}

const buildProcSeries = (
  rows: ReadonlyArray<ProcRow>,
  field: "VmRSS" | "Threads",
  tStart: number,
  tEnd: number,
  periodSec: number,
): MetricSeriesGrid => {
  const buckets = Math.max(1, Math.ceil((tEnd - tStart) / periodSec))
  const t: Array<number> = new Array(buckets)
  for (let i = 0; i < buckets; i++) t[i] = tStart + i * periodSec
  const byPod = new Map<string, Array<{ readonly t: number; readonly v: number }>>()
  for (const r of rows) {
    const v = r[field]
    if (typeof v !== "number") continue
    const tSec = new Date(r.tScrape).getTime() / 1000
    if (!Number.isFinite(tSec)) continue
    let list = byPod.get(r.pod)
    if (list === undefined) {
      list = []
      byPod.set(r.pod, list)
    }
    list.push({ t: tSec, v })
  }
  const series: Array<MetricSeries> = []
  for (const pod of Array.from(byPod.keys()).sort()) {
    const samples = byPod.get(pod)!
    samples.sort((a, b) => a.t - b.t)
    const out: Array<number> = new Array(buckets).fill(0)
    const sum: Array<number> = new Array(buckets).fill(0)
    const cnt: Array<number> = new Array(buckets).fill(0)
    for (const s of samples) {
      if (s.t < tStart || s.t > tEnd) continue
      const idx = Math.min(buckets - 1, Math.floor((s.t - tStart) / periodSec))
      sum[idx] = (sum[idx] ?? 0) + s.v
      cnt[idx] = (cnt[idx] ?? 0) + 1
    }
    let last = 0
    for (let i = 0; i < buckets; i++) {
      const c = cnt[i] ?? 0
      if (c > 0) {
        last = (sum[i] ?? 0) / c
        out[i] = last
      } else {
        out[i] = last
      }
    }
    series.push({ label: pod, values: out })
  }
  return { t, series }
}

/* -------------------------------------------------------------------- */
/* Main                                                                  */
/* -------------------------------------------------------------------- */

const buildReportData = async (artifactDir: string): Promise<ReportData> => {
  const meta = await readJson<MetadataFile>(
    path.join(artifactDir, "metadata.json"),
  )
  const runStartMs = new Date(meta.tStart).getTime()
  // Day boundary in UTC for proxy log lines (which carry no date).
  const baseDayMs = Date.UTC(
    new Date(runStartMs).getUTCFullYear(),
    new Date(runStartMs).getUTCMonth(),
    new Date(runStartMs).getUTCDate(),
  )
  const tStart = epoch(meta.phase.tWarmupStart)
  const tEnd = epoch(meta.phase.tDrainEnd)

  const chaosRows = await readNdjson<ChaosRow>(
    path.join(artifactDir, "chaos-timeline.ndjson"),
  )
  const scheduledChaos = chaosRows
    .filter((r) => r.status === "executed" && r.tRecovered !== undefined)
    .map((r) => ({
      type: r.type,
      target: r.target ?? "",
      tFire: epoch(r.tFire),
      tRecovered: epoch(r.tRecovered as string),
    }))
  // Fold actual platform anomalies (sipp staleness = wheel_base/clock_tick
  // race triggered by host stalls) into the chaos timeline as unsolicited
  // entries. Point-in-time events: tFire == tRecovered.
  const stalenessRows = await readNdjson<SippStalenessRow>(
    path.join(artifactDir, "sipp-staleness.ndjson"),
  ).catch(() => [] as Array<SippStalenessRow>)
  const unsolicitedChaos = stalenessRows.map((r) => {
    const t = epoch(r.tDetected)
    return {
      type: "kernel-stall",
      target: `${r.name} (sipp ElapsedTime(C) frozen at ${r.lastElapsed})`,
      tFire: t,
      tRecovered: t,
      unsolicited: true as const,
    }
  })
  const chaos = [...scheduledChaos, ...unsolicitedChaos].sort(
    (a, b) => a.tFire - b.tFire,
  )

  const limiterRows = await readNdjson<LimiterRow>(
    path.join(artifactDir, "limiter-probe.ndjson"),
  )
  const limiter = {
    t: limiterRows.map((r) => epoch(r.tScrape)),
    inflight: limiterRows.map((r) => r.inflight),
  }

  const sippDir = path.join(artifactDir, "sipp")
  const sippStreamDirs = await fsp
    .readdir(sippDir)
    .catch(() => [] as Array<string>)
  const streams: Array<SippStream> = []
  for (const sd of sippStreamDirs) {
    const name = sd
      .replace(/^endurance-/, "")
      .replace(/-endurance-.*/, "")
    const csv = path.join(sippDir, sd, "stat.csv")
    const parsed = await parseSippStatCsv(csv, name)
    if (parsed) {
      streams.push(resampleSippStream(parsed, tStart, tEnd, SAMPLE_PERIOD_SEC))
    }
  }

  const podLogsDir = path.join(artifactDir, "pod-logs")
  const podLogFiles = await fsp
    .readdir(podLogsDir)
    .catch(() => [] as Array<string>)
  const proxyLogs = podLogFiles.filter((f) => f.startsWith("sip-front-proxy"))
  const allEvents: Array<RoutedEvent> = []
  const allWarnTs: Array<number> = []
  for (const f of proxyLogs) {
    const podName = f.replace(/\.log$/, "")
    const r = await parseProxyLog(path.join(podLogsDir, f), podName, baseDayMs)
    for (const e of r.events) allEvents.push(e)
    for (const w of r.warnTimestamps) allWarnTs.push(w)
  }
  allEvents.sort((a, b) => a.t - b.t)
  allWarnTs.sort((a, b) => a - b)

  const concurrency = replayInviteRate(allEvents, tStart, tEnd, SAMPLE_PERIOD_SEC)
  const warnRate = bucketRate(allWarnTs, tStart, tEnd, SAMPLE_PERIOD_SEC)

  const workerLogs = podLogFiles.filter((f) => f.startsWith("b2bua-worker"))
  const allSamples: Array<QueueDepthSample> = []
  for (const f of workerLogs) {
    const podName = f.replace(/\.log$/, "")
    const samples = await parseWorkerLogQueueDepth(
      path.join(podLogsDir, f),
      podName,
      baseDayMs,
    )
    for (const s of samples) allSamples.push(s)
  }
  allSamples.sort((a, b) => a.t - b.t)
  const queueDepth = bucketQueueDepth(allSamples, tStart, tEnd, SAMPLE_PERIOD_SEC)

  // Worker /metrics scrape — slurp every metrics/<pod>.ndjson into a
  // flat row list, then build per-chart series. The recorder pre-
  // filters to known metrics, so unrelated rows are absent rather
  // than expensive to skip here.
  const metricsDir = path.join(artifactDir, "metrics")
  const metricsFiles = await fsp.readdir(metricsDir).catch(() => [] as Array<string>)
  const metricRows: Array<MetricRow> = []
  const procRows: Array<ProcRow> = []
  for (const f of metricsFiles) {
    if (f.endsWith(".proc.ndjson")) {
      const rows = await readNdjson<ProcRow>(path.join(metricsDir, f))
      for (const r of rows) procRows.push(r)
    } else if (f.endsWith(".ndjson")) {
      const rows = await readNdjson<MetricRow>(path.join(metricsDir, f))
      for (const r of rows) metricRows.push(r)
    }
  }

  const series = (
    metric: string,
    kind: "gauge" | "rate",
    splitLabel?: string,
  ): MetricSeriesGrid =>
    buildMetricSeries(metricRows, metric, kind, tStart, tEnd, SAMPLE_PERIOD_SEC, splitLabel)

  const workerMetrics: WorkerMetricCharts = {
    gcWindowPause: series("b2bua_gc_window_pause_seconds", "gauge"),
    loopLagP95: series("b2bua_loop_lag_ms_p95", "gauge"),
    eventQueueDepth: series("b2bua_worker_event_queue_depth", "gauge"),
    eventQueueDropsRate: series(
      "b2bua_worker_event_queue_drops_total",
      "rate",
      "reason",
    ),
    terminatingByBucket: series(
      "b2bua_worker_terminating_calls",
      "gauge",
      "age_bucket",
    ),
    activeTimers: series("b2bua_worker_active_timers", "gauge"),
    forcePurgeTotal: series("b2bua_worker_call_force_purge_total", "gauge"),
    handlerTimeoutsRate: series(
      "b2bua_worker_event_handler_timeouts_total",
      "rate",
    ),
    udpQueueDepth: series("b2bua_udp_queue_depth", "gauge"),
    udpDropsRate: series("b2bua_udp_drops_total", "rate", "reason"),
    overloadFraction: series("b2bua_overload_fraction", "gauge", "signal"),
    overloadShedProb: series("b2bua_overload_shed_probability", "gauge"),
    otelBspQueueDepth: series("b2bua_otel_bsp_queue_depth", "gauge"),
    otelBspDroppedRate: series("b2bua_otel_bsp_dropped_total", "rate"),
    procVmRss: buildProcSeries(procRows, "VmRSS", tStart, tEnd, SAMPLE_PERIOD_SEC),
    procThreads: buildProcSeries(procRows, "Threads", tStart, tEnd, SAMPLE_PERIOD_SEC),
  }

  return {
    runId: meta.runId,
    tStart,
    tEnd,
    limiterCap: meta.args.limiterCap,
    phase: {
      tSoakStart: epoch(meta.phase.tSoakStart),
      tSoakEnd: epoch(meta.phase.tSoakEnd),
      tCooldownEnd: epoch(meta.phase.tCooldownEnd),
      tDrainEnd: epoch(meta.phase.tDrainEnd),
    },
    chaos,
    limiter,
    perWorker: concurrency.perWorker,
    perProxy: concurrency.perProxy,
    streams,
    proxyWarnings: { t: warnRate.t, ratePerSec: warnRate.rate },
    queueDepth,
    workerMetrics,
    platform: await loadPlatformHealth(artifactDir, meta),
  }
}

const loadPlatformHealth = async (
  artifactDir: string,
  meta: MetadataFile,
): Promise<PlatformHealth> => {
  const stalenessEvents = await readNdjson<SippStalenessRow>(
    path.join(artifactDir, "sipp-staleness.ndjson"),
  ).catch(() => [] as Array<SippStalenessRow>)
  return {
    kernel: meta.kernel,
    isWsl2: meta.kernel?.toLowerCase().includes("microsoft") ?? false,
    stalenessEvents,
  }
}

/* -------------------------------------------------------------------- */
/* HTML emitter                                                          */
/* -------------------------------------------------------------------- */

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      default:
        return "&#39;"
    }
  })

const renderPlatformBanner = (p: PlatformHealth): string => {
  if (!p.isWsl2 && p.stalenessEvents.length === 0) return ""
  const lines: Array<string> = []
  lines.push(`<div class="platform">`)
  // The "detected" wording is reserved for runs where the staleness
  // watchdog actually fired; an isWsl2-only banner is a heads-up about
  // the host platform, not a claim that anything stalled in this run.
  const heading = p.stalenessEvents.length > 0
    ? `⚠ Platform-side event detected (NOT a B2BUA regression)`
    : `Platform context (host may affect timing — no anomaly detected in this run)`
  lines.push(`<h2>${heading}</h2>`)
  if (p.isWsl2) {
    lines.push(
      `<div>Host kernel <code>${escapeHtml(p.kernel ?? "")}</code> — this run executed on <strong>WSL2</strong>. WSL2 is known to exhibit TSC drift (kernel re-anchors monotonic time when the Windows host steals CPU) and recurring <code>vmbus_alloc_ring</code> order:7 page-allocation failures under memory pressure. Both produce sub-second to multi-second pauses inside the guest that look like B2BUA stalls but originate outside it. When a stall is <em>actually observed</em> (the sipp-staleness watchdog catches it), it lands in the events table above as an unsolicited <code>kernel-stall</code> row.</div>`,
    )
  }
  if (p.stalenessEvents.length > 0) {
    lines.push(
      `<div style="margin-top:6px;"><strong>${p.stalenessEvents.length}</strong> sipp staleness event(s) recorded — sipp's <code>ElapsedTime(C)</code> stalled, meaning the sipp process froze (typically the wheel_base/clock_tick race, triggered by host stalls). The freeze is sipp wedging in response to a host-side time-keeping anomaly — read it as a platform-health signal, not as a SIP system regression. Affected streams continue to appear in per-event "during/after" counts but stop generating new traffic.</div>`,
    )
    lines.push(
      `<table><thead><tr><th>tDetected (UTC)</th><th>stream</th><th>scenario</th><th>last ElapsedTime(C)</th></tr></thead><tbody>`,
    )
    for (const ev of p.stalenessEvents) {
      lines.push(
        `<tr><td>${escapeHtml(ev.tDetected)}</td><td>${escapeHtml(ev.name)}</td><td>${escapeHtml(ev.scenario)}</td><td>${escapeHtml(ev.lastElapsed)}</td></tr>`,
      )
    }
    lines.push(`</tbody></table>`)
  }
  lines.push(
    `<div style="margin-top:6px;font-size:11px;color:#92400e;">See <code>tests/k8s/endurance/sippJobs.ts</code> (MAX_CALLS comment) and <code>docs/plan/2026-05-14-post-proxy-graceful-481-wave-investigation.md</code> §6.4.5b for the diagnostic history.</div>`,
  )
  lines.push(`</div>`)
  return lines.join("\n")
}

const emitHtml = (data: ReportData): string => {
  const json = JSON.stringify(data)
  // Pre-format the chaos rows so the script can render the table without
  // recomputing dates client-side.
  const eventRows = data.chaos
    .map((ev, i) => {
      const dur = (ev.tRecovered - ev.tFire).toFixed(2)
      const fire = new Date(ev.tFire * 1000).toISOString().replace(/\.\d+Z$/, "Z")
      const rec = new Date(ev.tRecovered * 1000).toISOString().replace(/\.\d+Z$/, "Z")
      const rowClass = ev.unsolicited === true ? ' class="unsolicited"' : ""
      const typeCell = ev.unsolicited === true
        ? `${escapeHtml(ev.type)} <span class="badge">unsolicited</span>`
        : escapeHtml(ev.type)
      return `<tr${rowClass}><td class="ix">${i}</td><td>${typeCell}</td><td>${escapeHtml(
        ev.target,
      )}</td><td>${fire}</td><td>${rec}</td><td>${dur}s</td></tr>`
    })
    .join("\n      ")
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Endurance ${escapeHtml(data.runId)} — timeline</title>
  <link rel="stylesheet" href="./uPlot.min.css">
  <style>
    body { font-family: system-ui, sans-serif; margin: 16px; background: #fafafa; color: #222; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .meta { color: #666; font-size: 12px; margin-bottom: 16px; }
    .toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .toolbar button { padding: 4px 10px; font-size: 12px; cursor: pointer; }
    .toolbar .hint { color: #666; font-size: 11px; }
    .events { background: #fff; border: 1px solid #ddd; padding: 8px 12px; margin-bottom: 16px; }
    .events table { border-collapse: collapse; font-size: 12px; }
    .events td, .events th { padding: 2px 8px; border-bottom: 1px solid #eee; text-align: left; }
    .events td.ix { font-family: monospace; color: #666; text-align: right; }
    .events tr.unsolicited td { background: #fff7ed; color: #7c2d12; }
    .events .badge { display: inline-block; padding: 0 6px; margin-left: 6px; border: 1px solid #d97706; border-radius: 3px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #7c2d12; background: #fed7aa; }
    .platform { border-left: 4px solid #d97706; background: #fff7ed; padding: 10px 14px; margin-bottom: 16px; font-size: 13px; color: #7c2d12; }
    .platform h2 { font-size: 14px; margin: 0 0 6px; color: #7c2d12; }
    .platform table { border-collapse: collapse; font-size: 12px; margin-top: 6px; }
    .platform td, .platform th { padding: 2px 8px; border-bottom: 1px solid #fcd5b5; text-align: left; }
    .chart { background: #fff; border: 1px solid #ddd; padding: 8px 12px; margin-bottom: 16px; }
    .chart h2 { font-size: 14px; margin: 0 0 6px; color: #333; }
    .chart .uplot { width: 100%; }
  </style>
</head>
<body>
  <h1>Endurance run ${escapeHtml(data.runId)}</h1>
  <div class="meta">
    Soak ${new Date(data.phase.tSoakStart * 1000).toISOString()} → ${new Date(data.phase.tSoakEnd * 1000).toISOString()}.
    ${data.chaos.length} chaos events. Limiter cap = ${data.limiterCap}.
  </div>
  <div class="toolbar">
    <button id="reset-zoom" type="button">Reset zoom</button>
    <button id="zoom-soak" type="button">Zoom to soak</button>
    <span class="hint">drag = zoom · shift+drag = pan · wheel = zoom · double-click = reset</span>
  </div>
  ${renderPlatformBanner(data.platform)}
  <div class="events">
    <h2 style="font-size:14px;margin:0 0 6px;">Chaos events</h2>
    <table>
      <thead><tr><th>#</th><th>type</th><th>target</th><th>tFire (UTC)</th><th>tRecovered (UTC)</th><th>duration</th></tr></thead>
      <tbody>
      ${eventRows}
      </tbody>
    </table>
  </div>
  <div id="charts"></div>
  <script src="./uPlot.iife.min.js"></script>
  <script>
    const DATA = ${json};
    // More saturated bands than the first iteration — short events
    // (sub-second kill9) were nearly invisible against the lighter
    // alpha values, which is what made them feel "missing" on the
    // timeline.
    const CHAOS_COLORS = {
      'proxy-pod-graceful':  'rgba(60, 130, 255, 0.30)',
      'proxy-pod-kill9':     'rgba(60, 130, 255, 0.45)',
      'worker-pod-graceful': 'rgba(255, 160, 60, 0.30)',
      'worker-pod-kill9':    'rgba(255, 90, 60, 0.45)',
      'node-shutdown-app':   'rgba(180, 60, 220, 0.40)',
      'node-shutdown-edge':  'rgba(220, 30, 30, 0.50)',
      'kernel-stall':        'rgba(217, 119, 6, 0.55)',
    };
    const SERIES_COLORS = ['#1f77b4','#ff7f0e','#2ca02c','#d62728','#9467bd','#8c564b','#e377c2','#7f7f7f','#bcbd22','#17becf'];
    const FULL_RANGE = { min: DATA.tStart, max: DATA.tEnd };
    const SOAK_RANGE = { min: DATA.phase.tSoakStart, max: DATA.phase.tCooldownEnd };
    const MIN_BAND_PX = 4;

    function chaosBandsPlugin(events) {
      return {
        hooks: {
          drawClear: (u) => {
            const ctx = u.ctx;
            ctx.save();
            const yTop = u.bbox.top;
            const yBot = u.bbox.top + u.bbox.height;
            // First pass: shaded bands.
            for (const ev of events) {
              const x0 = u.valToPos(ev.tFire, 'x', true);
              const x1 = u.valToPos(ev.tRecovered, 'x', true);
              const w = Math.max(MIN_BAND_PX, x1 - x0);
              ctx.fillStyle = CHAOS_COLORS[ev.type] || 'rgba(120,120,120,0.30)';
              ctx.fillRect(x0, yTop, w, yBot - yTop);
            }
            // Second pass: index labels at top of band so the user can
            // cross-reference with the events table above.
            ctx.fillStyle = '#222';
            ctx.font = 'bold 10px system-ui, sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            for (let i = 0; i < events.length; i++) {
              const ev = events[i];
              const x0 = u.valToPos(ev.tFire, 'x', true);
              if (x0 < u.bbox.left || x0 > u.bbox.left + u.bbox.width) continue;
              ctx.fillText(String(i), x0 + 2, yTop + 2);
            }
            ctx.restore();
          },
        },
      };
    }

    // Mouse-wheel zoom + shift+drag pan, applied to whichever chart the
    // mouse is over (sync key propagates the new x scale to all peers).
    function wheelAndPanPlugin() {
      return {
        hooks: {
          ready: (u) => {
            const over = u.over;
            // Wheel zoom around mouse cursor.
            over.addEventListener('wheel', (e) => {
              e.preventDefault();
              const rect = over.getBoundingClientRect();
              const cx = e.clientX - rect.left;
              const xVal = u.posToVal(cx, 'x');
              const sx = u.scales.x;
              if (sx.min == null || sx.max == null) return;
              const factor = e.deltaY < 0 ? 0.8 : 1.25;
              const newRange = (sx.max - sx.min) * factor;
              const leftFrac = cx / over.clientWidth;
              let newMin = xVal - leftFrac * newRange;
              let newMax = newMin + newRange;
              // Don't zoom out beyond the full range.
              if (newMax - newMin > FULL_RANGE.max - FULL_RANGE.min) {
                newMin = FULL_RANGE.min;
                newMax = FULL_RANGE.max;
              }
              u.batch(() => u.setScale('x', { min: newMin, max: newMax }));
            }, { passive: false });

            // Shift+drag pan.
            let panOrigin = null;
            over.addEventListener('mousedown', (e) => {
              if (!e.shiftKey) return;
              e.preventDefault();
              const sx = u.scales.x;
              if (sx.min == null || sx.max == null) return;
              panOrigin = {
                clientX: e.clientX,
                xMin: sx.min,
                xMax: sx.max,
                widthPx: over.clientWidth,
              };
              over.style.cursor = 'grabbing';
            });
            window.addEventListener('mousemove', (e) => {
              if (!panOrigin) return;
              const dx = e.clientX - panOrigin.clientX;
              const fracPerPx = (panOrigin.xMax - panOrigin.xMin) / panOrigin.widthPx;
              const shift = -dx * fracPerPx;
              u.batch(() => u.setScale('x', {
                min: panOrigin.xMin + shift,
                max: panOrigin.xMax + shift,
              }));
            });
            window.addEventListener('mouseup', () => {
              if (panOrigin) over.style.cursor = '';
              panOrigin = null;
            });

            // Double-click resets to full range.
            over.addEventListener('dblclick', () => setAllScales(FULL_RANGE));
          },
        },
      };
    }

    const allCharts = [];
    function setAllScales(range) {
      for (const u of allCharts) {
        u.batch(() => u.setScale('x', { min: range.min, max: range.max }));
      }
    }

    function makeChart(title, parent, xs, seriesData, yLabel, opts) {
      opts = opts || {};
      const wrap = document.createElement('div');
      wrap.className = 'chart';
      const h = document.createElement('h2');
      h.textContent = title;
      wrap.appendChild(h);
      const div = document.createElement('div');
      wrap.appendChild(div);
      parent.appendChild(wrap);
      const series = [{}];
      const data = [xs];
      seriesData.forEach((s, i) => {
        series.push({
          label: s.label,
          stroke: s.color || SERIES_COLORS[i % SERIES_COLORS.length],
          width: s.width || 1.25,
          dash: s.dash,
          points: { show: false },
        });
        data.push(s.values);
      });
      const width = Math.max(800, (parent.clientWidth || window.innerWidth) - 32);
      const u = new uPlot({
        width: width,
        height: opts.height || 200,
        cursor: { sync: { key: 'endurance' }, drag: { x: true, y: false, setScale: true } },
        scales: { x: { time: true, range: () => [FULL_RANGE.min, FULL_RANGE.max] } },
        // Render axes and hover values in UTC so the timeline reads
        // identically across timezones for a distributed team.
        tzDate: function (ts) { return uPlot.tzDate(new Date(ts * 1e3), 'Etc/UTC'); },
        axes: [{}, { label: yLabel, size: 60 }],
        series: series,
        plugins: [chaosBandsPlugin(DATA.chaos), wheelAndPanPlugin()],
      }, data, div);
      allCharts.push(u);
      return u;
    }

    uPlot.sync('endurance');

    // Defer chart creation until the layout has settled, otherwise the
    // first render measures parent.clientWidth before the page is laid
    // out and uPlot draws into a 0-width canvas (visible as "blank
    // until you click the legend or zoom").
    function buildCharts() {
      const charts = document.getElementById('charts');

      // 1. Limiter inflight
      {
        const cap = DATA.limiterCap;
        const xs = DATA.limiter.t;
        const ys = DATA.limiter.inflight;
        const capLine = xs.map(function () { return cap; });
        makeChart('Limiter inflight (cap=' + cap + ')', charts, xs, [
          { label: 'inflight', values: ys, color: '#d62728', width: 1.5 },
          { label: 'cap',      values: capLine, color: '#888', dash: [4,4] },
        ], 'calls');
      }

      // 2. Concurrent calls per sipp stream (CurrentCall — ground truth)
      {
        const xs = DATA.streams[0] ? DATA.streams[0].t : [];
        const seriesData = DATA.streams.map(function (s, i) {
          return {
            label: s.name,
            values: s.currentCall,
            color: SERIES_COLORS[i % SERIES_COLORS.length],
          };
        });
        makeChart('Concurrent calls per sipp stream (CurrentCall — ground truth)', charts, xs, seriesData, 'calls');
      }

      // 3. Per-worker INVITE rate (proxy logs)
      {
        const xs = DATA.perWorker.t;
        const ips = Object.keys(DATA.perWorker.perIp).sort();
        const seriesData = ips.map(function (ip, i) {
          return {
            label: ip,
            values: DATA.perWorker.perIp[ip],
            color: SERIES_COLORS[i % SERIES_COLORS.length],
          };
        });
        makeChart('INVITE rate per worker IP (proxy log)', charts, xs, seriesData, 'cps');
      }

      // 4. Per-proxy INVITE rate
      {
        const xs = DATA.perProxy.t;
        const pods = Object.keys(DATA.perProxy.perPod).sort();
        const seriesData = pods.map(function (pod, i) {
          return {
            label: pod.replace(/^sip-front-proxy-/, 'proxy-'),
            values: DATA.perProxy.perPod[pod],
            color: SERIES_COLORS[i % SERIES_COLORS.length],
          };
        });
        makeChart('INVITE rate per proxy pod (proxy log)', charts, xs, seriesData, 'cps');
      }

      // 5. Sipp call rate per stream
      {
        const xs = DATA.streams[0] ? DATA.streams[0].t : [];
        const seriesData = DATA.streams.map(function (s, i) {
          return {
            label: s.name,
            values: s.callsPerSec,
            color: SERIES_COLORS[i % SERIES_COLORS.length],
          };
        });
        makeChart('Sipp calls/sec per stream (CallRate(P))', charts, xs, seriesData, 'cps');
      }

      // 6. Sipp cumulative failures per stream (total + per cause)
      //    Replaces the periodic /sec view: cumulative is easier to read
      //    for impact attribution because steps in the line align with
      //    the exact moment failures started accruing, and the slope
      //    encodes the rate. Per-cause breakdown (timeout / unexpected /
      //    rejected) lets you tell apart "B2BUA didn't answer" from
      //    "B2BUA returned 481" from "B2BUA's UAS rejected the leg" at
      //    a glance — same x-axis across all four charts.
      {
        const xs = DATA.streams[0] ? DATA.streams[0].t : [];
        const buildSeries = function (pick) {
          return DATA.streams.map(function (s, i) {
            return {
              label: s.name,
              values: pick(s),
              color: SERIES_COLORS[i % SERIES_COLORS.length],
            };
          });
        };
        makeChart('Sipp cumulative failures per stream (FailedCall(C))',
          charts, xs,
          buildSeries(function (s) { return s.failsCumTotal; }),
          'calls');
        makeChart('Sipp cumulative failures — timeout (FailedTimeoutOnRecv+Send (C))',
          charts, xs,
          buildSeries(function (s) { return s.failsCumTimeout; }),
          'calls');
        makeChart('Sipp cumulative failures — unexpected message, incl. mid-flow 481 (FailedUnexpectedMessage(C))',
          charts, xs,
          buildSeries(function (s) { return s.failsCumUnexpected; }),
          'calls');
        makeChart('Sipp cumulative failures — explicit call-reject responses (FailedCallRejected(C))',
          charts, xs,
          buildSeries(function (s) { return s.failsCumRejected; }),
          'calls');
      }

      // 7. Proxy "no alive workers" warning rate
      {
        makeChart('Proxy "no alive workers" warning rate', charts,
          DATA.proxyWarnings.t,
          [{ label: 'warn/sec', values: DATA.proxyWarnings.ratePerSec, color: '#d62728' }],
          '/sec');
      }

      // 8. Replication queue depth per (source → peer) pair
      {
        const xs = DATA.queueDepth.t;
        const pairs = Object.keys(DATA.queueDepth.perPair).sort();
        const seriesData = pairs.map(function (p, i) {
          return {
            label: p.replace(/b2bua-worker-/g, 'w'),
            values: DATA.queueDepth.perPair[p],
            color: SERIES_COLORS[i % SERIES_COLORS.length],
          };
        });
        makeChart('Replication queue depth (worker → peer, mean over 5s buckets)',
          charts, xs, seriesData, 'events');
      }

      // Worker-side /metrics scrape charts. One series per pod (and
      // per label dimension where the metric is split). All share the
      // master t-grid so cursor-sync lets you cross-reference any
      // anomaly (e.g. a GC pause spike) with the SIPP-stream chart up
      // top.
      function plotMetricGrid(title, grid, yLabel) {
        if (!grid || !grid.series || grid.series.length === 0) return;
        const xs = grid.t;
        const seriesData = grid.series.map(function (s, i) {
          return {
            label: s.label.replace(/b2bua-worker-/g, 'w'),
            values: s.values,
            color: SERIES_COLORS[i % SERIES_COLORS.length],
          };
        });
        makeChart(title, charts, xs, seriesData, yLabel);
      }
      const wm = DATA.workerMetrics || {};
      plotMetricGrid('Event-loop lag p95 (ms)', wm.loopLagP95, 'ms');
      plotMetricGrid('GC pause per scrape window (s)', wm.gcWindowPause, 's');
      plotMetricGrid('Inbound event queue depth', wm.eventQueueDepth, 'events');
      plotMetricGrid('Inbound event queue drops/sec by reason', wm.eventQueueDropsRate, '/sec');
      plotMetricGrid('Terminating calls by age bucket (gte300s = stuck-terminating canary)',
        wm.terminatingByBucket, 'calls');
      plotMetricGrid('Active timers (live fiber count)', wm.activeTimers, 'fibers');
      plotMetricGrid('call_force_purge_total (Slice 1.4 safety net hits)',
        wm.forcePurgeTotal, 'count');
      plotMetricGrid('event_handler_timeouts_total (rate)', wm.handlerTimeoutsRate, '/sec');
      plotMetricGrid('UDP queue depth', wm.udpQueueDepth, 'pkts');
      plotMetricGrid('UDP drops/sec by reason', wm.udpDropsRate, '/sec');
      plotMetricGrid('Overload fraction by signal', wm.overloadFraction, 'fraction');
      plotMetricGrid('Overload shed probability', wm.overloadShedProb, 'fraction');
      plotMetricGrid('OTel BSP queue depth', wm.otelBspQueueDepth, 'spans');
      plotMetricGrid('OTel BSP dropped spans/sec', wm.otelBspDroppedRate, '/sec');
      plotMetricGrid('Process resident set size (kB)', wm.procVmRss, 'kB');
      plotMetricGrid('Process thread count', wm.procThreads, 'threads');

      // Force a resize after construction so the drawing buffer matches
      // the laid-out container width even if the initial measurement was
      // off by a few pixels (mitigates the "blank until first click" bug
      // belt-and-braces).
      const w = Math.max(800, document.getElementById('charts').clientWidth - 32);
      for (const u of allCharts) u.setSize({ width: w, height: u.height });

      document.getElementById('reset-zoom').addEventListener('click', function () { setAllScales(FULL_RANGE); });
      document.getElementById('zoom-soak').addEventListener('click', function () { setAllScales(SOAK_RANGE); });
      window.addEventListener('resize', function () {
        const w = Math.max(800, document.getElementById('charts').clientWidth - 32);
        for (const u of allCharts) u.setSize({ width: w, height: u.height });
      });
    }
    if (document.readyState === 'complete') buildCharts();
    else window.addEventListener('load', buildCharts);
  </script>
</body>
</html>
`
}

/* -------------------------------------------------------------------- */
/* CLI                                                                   */
/* -------------------------------------------------------------------- */

export const runRender = async (artifactDir: string): Promise<string> => {
  const data = await buildReportData(artifactDir)
  const html = emitHtml(data)
  const outHtml = path.join(artifactDir, "timeline.html")
  await fsp.writeFile(outHtml, html, "utf8")
  for (const asset of ["uPlot.iife.min.js", "uPlot.min.css"]) {
    await fsp.copyFile(
      path.join(ASSET_DIR, asset),
      path.join(artifactDir, asset),
    )
  }
  return outHtml
}

// CLI entry — only fires when this file is invoked directly, so
// importing the module (e.g. from run-endurance.ts) doesn't execute
// main(). The `tsx`/Node ESM convention compares import.meta.url to
// argv[1] resolved as a file URL.
const isDirectInvocation = (() => {
  const argv1 = process.argv[1]
  if (argv1 === undefined) return false
  const argvUrl = new URL("file://" + path.resolve(argv1)).href
  return import.meta.url === argvUrl
})()

if (isDirectInvocation) {
  const artifactDir = process.argv[2]
  if (artifactDir === undefined) {
    console.error("usage: render-report.ts <run-dir>")
    process.exit(2)
  }
  runRender(artifactDir).then(
    (out) => console.log(out),
    (e) => {
      console.error(e)
      process.exit(1)
    },
  )
}
