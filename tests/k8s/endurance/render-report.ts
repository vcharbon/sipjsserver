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
  readonly callsPerSec: ReadonlyArray<number>
  readonly failsPerSec: ReadonlyArray<number>
  readonly currentCall: ReadonlyArray<number>
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
  if (idxCurrentTime < 0 || idxFailedP < 0) return undefined
  const t: Array<number> = []
  const callsPerSec: Array<number> = []
  const failsPerSec: Array<number> = []
  const currentCall: Array<number> = []
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
    // Sipp CSV writes one trailing cumulative-only row whose period
    // values are 0; skip it by requiring a positive period count when
    // we already have rows.
    if (
      i > 1 &&
      callRate === 0 &&
      failedP === 0 &&
      successP === 0
    ) {
      continue
    }
    t.push(unix)
    callsPerSec.push(Number.isFinite(callRate) ? callRate : 0)
    // FailedCall(P) is over a 10s period; convert to per-sec for the
    // y-axis.
    failsPerSec.push(Number.isFinite(failedP) ? failedP / 10 : 0)
    const cc = idxCurrentCall >= 0 ? parseFloat(cols[idxCurrentCall] ?? "0") : 0
    currentCall.push(Number.isFinite(cc) ? cc : 0)
  }
  return { name, t, callsPerSec, failsPerSec, currentCall }
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
  const chaos = chaosRows
    .filter((r) => r.status === "executed" && r.tRecovered !== undefined)
    .map((r) => ({
      type: r.type,
      target: r.target ?? "",
      tFire: epoch(r.tFire),
      tRecovered: epoch(r.tRecovered as string),
    }))

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
    if (parsed) streams.push(parsed)
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

const emitHtml = (data: ReportData): string => {
  const json = JSON.stringify(data)
  // Pre-format the chaos rows so the script can render the table without
  // recomputing dates client-side.
  const eventRows = data.chaos
    .map((ev, i) => {
      const dur = (ev.tRecovered - ev.tFire).toFixed(2)
      const fire = new Date(ev.tFire * 1000).toISOString().replace(/\.\d+Z$/, "Z")
      const rec = new Date(ev.tRecovered * 1000).toISOString().replace(/\.\d+Z$/, "Z")
      return `<tr><td class="ix">${i}</td><td>${escapeHtml(ev.type)}</td><td>${escapeHtml(
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

      // 6. Sipp failure rate per stream
      {
        const xs = DATA.streams[0] ? DATA.streams[0].t : [];
        const seriesData = DATA.streams.map(function (s, i) {
          return {
            label: s.name,
            values: s.failsPerSec,
            color: SERIES_COLORS[i % SERIES_COLORS.length],
          };
        });
        makeChart('Sipp failures/sec per stream (FailedCall(P)/10s)', charts, xs, seriesData, '/sec');
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

const main = async (): Promise<void> => {
  const artifactDir = process.argv[2]
  if (artifactDir === undefined) {
    console.error("usage: render-report.ts <run-dir>")
    process.exit(2)
  }
  const data = await buildReportData(artifactDir)
  const html = emitHtml(data)
  const outHtml = path.join(artifactDir, "timeline.html")
  await fsp.writeFile(outHtml, html, "utf8")
  // Copy uPlot assets next to the HTML so the report stays
  // self-contained.
  for (const asset of ["uPlot.iife.min.js", "uPlot.min.css"]) {
    await fsp.copyFile(
      path.join(ASSET_DIR, asset),
      path.join(artifactDir, asset),
    )
  }
  console.log(outHtml)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
