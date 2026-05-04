/**
 * Append-only NDJSON recorder for the endurance harness.
 *
 * Five concurrent streams are written into the run's artifact directory:
 *
 *   - `metrics/<pod>.ndjson`       Prometheus scrape every 10s
 *   - `limiter-probe.ndjson`       Limiter Redis poll every 10s
 *   - `k8s-events.ndjson`          `kubectl get events --watch`
 *   - `pod-logs/<pod>.log`         `kubectl logs -f` per pod (raw text)
 *   - `chaos-timeline.ndjson`      written by the orchestrator at fire/recover time
 *
 * Append-only is the cornerstone of the crash-recovery story (per
 * plan): if the orchestrator dies, every byte that hit disk is valid
 * NDJSON / log text and analyze-endurance.ts can still process the
 * partial run.
 *
 * The recorder yields a controller object with a `stop()` Effect; the
 * orchestrator runs all background fibers under one supervised scope
 * and stops them via this controller during the COOLDOWN/DRAIN
 * transition.
 */

import { Data, Effect, Fiber } from "effect"
import { spawn, type ChildProcess } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { exec } from "../fixtures/exec.js"
import { execInPod, listPods } from "../fixtures/kubectl.js"
import { parsePrometheusText } from "../fixtures/proxyMetrics.js"
import { LIMITER_REDIS_LABEL, readLimiterInflight } from "./chaosOps.js"

export class RecorderError extends Data.TaggedError("RecorderError")<{
  readonly stream: string
  readonly reason: string
}> {
  override get message(): string {
    return `recorder[${this.stream}] failed: ${this.reason}`
  }
}

export interface RecorderOpts {
  readonly namespace: string
  readonly artifactDir: string
  /** Limiter id to poll in shared Redis (matches X-Api-Call directive). */
  readonly limiterProbeId: string
  /** Override the default 10s scrape cadence. */
  readonly scrapeIntervalMs?: number
}

export interface RecorderHandle {
  readonly stop: Effect.Effect<void>
}

/**
 * Start all background recorders. The returned handle's `stop` Effect
 * interrupts every fiber and flushes/closes file descriptors.
 */
export const startRecorder = (
  opts: RecorderOpts,
): Effect.Effect<RecorderHandle, RecorderError> =>
  Effect.gen(function* () {
    const scrapeMs = opts.scrapeIntervalMs ?? 10_000
    yield* mkdirp(path.join(opts.artifactDir, "metrics"))
    yield* mkdirp(path.join(opts.artifactDir, "pod-logs"))

    const eventsFiber = yield* Effect.forkChild(
      streamK8sEvents(opts.namespace, opts.artifactDir),
    )
    const metricsFiber = yield* Effect.forkChild(
      pollMetrics(opts.namespace, opts.artifactDir, scrapeMs),
    )
    const limiterFiber = yield* Effect.forkChild(
      pollLimiter(opts.namespace, opts.artifactDir, opts.limiterProbeId, scrapeMs),
    )
    const podLogsFiber = yield* Effect.forkChild(
      streamPodLogs(opts.namespace, opts.artifactDir),
    )

    const stop = Effect.gen(function* () {
      yield* Fiber.interrupt(eventsFiber).pipe(Effect.ignore)
      yield* Fiber.interrupt(metricsFiber).pipe(Effect.ignore)
      yield* Fiber.interrupt(limiterFiber).pipe(Effect.ignore)
      yield* Fiber.interrupt(podLogsFiber).pipe(Effect.ignore)
    })
    return { stop }
  })

/* ------------------------------------------------------------------ */
/* k8s events                                                          */
/* ------------------------------------------------------------------ */

interface K8sEventRow {
  readonly tWritten: string
  readonly tEvent: string
  readonly type: string
  readonly reason: string
  readonly object: string
  readonly message: string
}

/**
 * `kubectl get events --watch -o json` streams a JSON object per
 * event. We parse each line and append a flattened NDJSON row.
 */
const streamK8sEvents = (
  namespace: string,
  artifactDir: string,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const filePath = path.join(artifactDir, "k8s-events.ndjson")
    yield* runStreamingChild(
      "kubectl",
      [
        "-n",
        namespace,
        "get",
        "events",
        "--watch",
        "--output-watch-events=true",
        "-o",
        "json",
      ],
      (chunk) => parseK8sEventChunk(chunk),
      (rows) => appendNdjsonRows(filePath, rows),
    ).pipe(Effect.ignore)
  })

const parseK8sEventChunk = (chunk: string): Array<K8sEventRow> => {
  // kubectl --watch emits one JSON object per line for some object kinds,
  // but with --output-watch-events it wraps in `{type, object}` per line.
  const rows: Array<K8sEventRow> = []
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed) as { object?: Record<string, unknown> }
      const ev = (obj.object ?? obj) as {
        type?: string
        reason?: string
        message?: string
        lastTimestamp?: string
        eventTime?: string
        firstTimestamp?: string
        involvedObject?: { kind?: string; name?: string }
      }
      const tEvent = ev.eventTime ?? ev.lastTimestamp ?? ev.firstTimestamp ?? ""
      const involved = ev.involvedObject
      const objectRef = involved
        ? `${involved.kind ?? ""}/${involved.name ?? ""}`
        : ""
      rows.push({
        tWritten: new Date().toISOString(),
        tEvent,
        type: ev.type ?? "",
        reason: ev.reason ?? "",
        object: objectRef,
        message: ev.message ?? "",
      })
    } catch {
      // Skip un-parseable partial chunks.
    }
  }
  return rows
}

/* ------------------------------------------------------------------ */
/* /metrics scrape                                                     */
/* ------------------------------------------------------------------ */

interface MetricRow {
  readonly tScrape: string
  readonly pod: string
  readonly metric: string
  readonly labels: Readonly<Record<string, string>>
  readonly value: number
}

const pollMetrics = (
  namespace: string,
  artifactDir: string,
  intervalMs: number,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    while (true) {
      const tScrape = new Date().toISOString()
      const proxyPods = yield* listPods(
        namespace,
        "app.kubernetes.io/name=sip-front-proxy",
      ).pipe(Effect.orElseSucceed(() => []))
      const workerPods = yield* listPods(
        namespace,
        "app.kubernetes.io/name=b2bua-worker",
      ).pipe(Effect.orElseSucceed(() => []))
      const all = [...proxyPods, ...workerPods]
      for (const pod of all) {
        if (!pod.ready) continue
        // Both proxy and worker expose /metrics on :9090 via wget inside
        // the container. The wrapper tolerates ECONNREFUSED for pods
        // whose /metrics isn't wired (returns empty).
        const text = yield* execInPod(namespace, pod.name, defaultContainerFor(pod.name), [
          "wget",
          "-qO-",
          "http://localhost:9090/metrics",
        ]).pipe(
          Effect.matchEffect({
            onSuccess: (r) => Effect.succeed(r.stdout),
            onFailure: () => Effect.succeed(""),
          }),
        )
        if (text.length === 0) continue
        const samples = parsePrometheusText(text)
        const rows: Array<MetricRow> = samples.map((s) => ({
          tScrape,
          pod: pod.name,
          metric: s.name,
          labels: s.labels,
          value: s.value,
        }))
        yield* appendNdjsonRows(
          path.join(artifactDir, "metrics", `${pod.name}.ndjson`),
          rows,
        )
      }
      yield* Effect.sleep(`${intervalMs} millis`)
    }
  })

const defaultContainerFor = (pod: string): string => {
  if (pod.startsWith("b2bua-worker-")) return "worker"
  if (pod.startsWith("sip-front-proxy-") || pod.startsWith("sip-front-proxy")) {
    return "proxy"
  }
  return pod.split("-")[0] ?? pod
}

/* ------------------------------------------------------------------ */
/* limiter Redis poll                                                  */
/* ------------------------------------------------------------------ */

interface LimiterRow {
  readonly tScrape: string
  readonly limiterId: string
  readonly inflight: number
  /** Whether at least one limiter Redis pod was readable at scrape time. */
  readonly redisReady: boolean
}

const pollLimiter = (
  namespace: string,
  artifactDir: string,
  limiterId: string,
  intervalMs: number,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const filePath = path.join(artifactDir, "limiter-probe.ndjson")
    while (true) {
      const tScrape = new Date().toISOString()
      const pods = yield* listPods(namespace, LIMITER_REDIS_LABEL).pipe(
        Effect.orElseSucceed(() => []),
      )
      const ready = pods.some((p) => p.ready)
      const inflight = yield* readLimiterInflight(namespace, limiterId).pipe(
        Effect.orElseSucceed(() => 0),
      )
      const row: LimiterRow = {
        tScrape,
        limiterId,
        inflight,
        redisReady: ready,
      }
      yield* appendNdjsonRows(filePath, [row])
      yield* Effect.sleep(`${intervalMs} millis`)
    }
  })

/* ------------------------------------------------------------------ */
/* pod logs (kubectl logs -f per pod)                                  */
/* ------------------------------------------------------------------ */

/**
 * Discover proxy + worker + limiter-redis pods, attach a `kubectl logs
 * -f` per pod into a per-pod file. Re-discovers periodically so logs
 * for newly-spawned pods (post-chaos) are captured.
 *
 * Uses a fork-per-pod Map keyed by pod name. When a pod disappears we
 * leave its log file alone (it's already complete) and stop the fiber.
 */
const streamPodLogs = (
  namespace: string,
  artifactDir: string,
): Effect.Effect<void, never> => {
  const active = new Map<string, ChildProcess>()
  const dir = path.join(artifactDir, "pod-logs")
  const labels = [
    "app.kubernetes.io/name=sip-front-proxy",
    "app.kubernetes.io/name=b2bua-worker",
    "app.kubernetes.io/name=redis",
  ]
  const loop = Effect.gen(function* () {
    while (true) {
      for (const label of labels) {
        const pods = yield* listPods(namespace, label).pipe(
          Effect.orElseSucceed(() => []),
        )
        for (const pod of pods) {
          if (active.has(pod.name)) continue
          const filePath = path.join(dir, `${pod.name}.log`)
          const out = fs.createWriteStream(filePath, { flags: "a" })
          const child = spawn(
            "kubectl",
            ["-n", namespace, "logs", "-f", "--all-containers=true", pod.name],
            { stdio: ["ignore", "pipe", "pipe"] },
          )
          child.stdout?.pipe(out, { end: false })
          child.stderr?.pipe(out, { end: false })
          child.on("exit", () => {
            active.delete(pod.name)
            out.end()
          })
          active.set(pod.name, child)
        }
      }
      yield* Effect.sleep("5 seconds")
    }
  })
  // `Effect.ensuring` runs the finalizer on success, failure, or
  // interrupt without needing a Scope. We need this so Fiber.interrupt
  // from the recorder handle's stop tears down the spawned `kubectl
  // logs -f` processes.
  const cleanup = Effect.sync(() => {
    for (const [, child] of active) {
      try {
        child.kill("SIGTERM")
      } catch {
        // ignore
      }
    }
  })
  return Effect.ensuring(loop, cleanup)
}

/* ------------------------------------------------------------------ */
/* primitives                                                          */
/* ------------------------------------------------------------------ */

/**
 * Append an array of NDJSON rows to `filePath`, creating it (and its
 * parent dir) if needed. Single fs.promises.appendFile call per batch.
 */
export const appendNdjsonRows = (
  filePath: string,
  rows: ReadonlyArray<unknown>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (rows.length === 0) return
    const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
    yield* Effect.tryPromise(() => fsp.appendFile(filePath, text, "utf8")).pipe(
      Effect.orDie,
    )
  })

const mkdirp = (dir: string): Effect.Effect<void, RecorderError> =>
  Effect.tryPromise({
    try: () => fsp.mkdir(dir, { recursive: true }),
    catch: (e) =>
      new RecorderError({
        stream: "mkdirp",
        reason: `mkdir ${dir} failed: ${e}`,
      }),
  }).pipe(Effect.asVoid)

/**
 * Spawn a long-lived child process whose stdout is parsed line-by-line
 * into rows by `parse`, then appended via `sink`. Used by the k8s
 * events stream. The child is killed when the calling fiber is
 * interrupted.
 */
const runStreamingChild = (
  command: string,
  args: ReadonlyArray<string>,
  parse: (chunk: string) => Array<unknown>,
  sink: (rows: Array<unknown>) => Effect.Effect<void>,
): Effect.Effect<void, never> =>
  Effect.callback<void, never>((resume) => {
    let buffer = ""
    const child = spawn(command, args as Array<string>, { stdio: ["ignore", "pipe", "pipe"] })
    child.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString("utf8")
      const lastNewline = buffer.lastIndexOf("\n")
      if (lastNewline === -1) return
      const ready = buffer.slice(0, lastNewline)
      buffer = buffer.slice(lastNewline + 1)
      const rows = parse(ready)
      if (rows.length > 0) {
        // Effect.runPromise here is acceptable since sink is fire-and-
        // forget for the streaming side; we don't backpressure on it.
        Effect.runPromise(sink(rows)).catch(() => {
          /* swallow — recorder is best-effort */
        })
      }
    })
    child.on("exit", () => resume(Effect.void))
    child.on("error", () => resume(Effect.void))
    return Effect.sync(() => {
      try {
        child.kill("SIGTERM")
      } catch {
        // ignore
      }
    })
  })

/** Compatibility wrapper used by chaos timeline writes. */
export const appendChaosEvent = (
  artifactDir: string,
  row: unknown,
): Effect.Effect<void> =>
  appendNdjsonRows(path.join(artifactDir, "chaos-timeline.ndjson"), [row])

// Re-export so callers don't need a second import.
export { exec }
