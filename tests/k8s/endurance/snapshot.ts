/**
 * Final-state capture (the SNAPSHOT phase, ~30s).
 *
 * Runs after DRAIN, captures everything the analyzer's "no-leak" /
 * "no-OOM" / "no-unexpected-restart" invariants need:
 *
 *   - Per-pod restart counts and Ready/OOMKilled state
 *   - Sidecar Redis dbsize per worker pod (call-context DB)
 *   - Shared limiter Redis dbsize
 *   - Final /metrics scrape from proxy + each worker
 *   - Last 100 lines of pod logs (defensive — full stream lives in pod-logs/)
 *
 * Output: `snapshot.json` in the artifact dir.
 */

import { Data, Duration, Effect } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { exec } from "../fixtures/exec.js"
import { execInPod, listPods } from "../fixtures/kubectl.js"
import { parsePrometheusText } from "../fixtures/proxyMetrics.js"
import {
  LIMITER_REDIS_LABEL,
  PROXY_LABEL,
  WORKER_LABEL,
} from "./chaosOps.js"

export class SnapshotError extends Data.TaggedError("SnapshotError")<{
  readonly stage: string
  readonly reason: string
}> {
  override get message(): string {
    return `snapshot[${this.stage}] failed: ${this.reason}`
  }
}

export interface SnapshotOpts {
  readonly namespace: string
  readonly artifactDir: string
}

export interface PodSnapshot {
  readonly name: string
  readonly phase: string
  readonly ready: boolean
  readonly node: string
  readonly restartCount: number
  readonly oomKilledHistorical: boolean
  /** dbsize when reachable (sidecar Redis or shared limiter Redis); -1 otherwise. */
  readonly redisDbsize?: number
  /** Final /metrics scrape (a few key gauges). */
  readonly metrics?: Record<string, number>
}

export interface Snapshot {
  readonly tCaptured: string
  readonly proxyPods: ReadonlyArray<PodSnapshot>
  readonly workerPods: ReadonlyArray<PodSnapshot>
  readonly limiterRedisPods: ReadonlyArray<PodSnapshot>
  /** Sum of `limiter:*` keys across the shared Redis. Should be 0 at end. */
  readonly limiterTotalInflight: number
  /** Sum of OOMKilled detected across all monitored pods. */
  readonly oomKilledCount: number
}

export const captureSnapshot = (
  opts: SnapshotOpts,
): Effect.Effect<Snapshot, SnapshotError> =>
  Effect.gen(function* () {
    const tCaptured = new Date().toISOString()
    const proxyPods = yield* snapshotPods(opts.namespace, PROXY_LABEL, "proxy")
    const workerPods = yield* snapshotPods(opts.namespace, WORKER_LABEL, "worker")
    const limiterRedisPods = yield* snapshotPods(
      opts.namespace,
      LIMITER_REDIS_LABEL,
      "redis",
    )
    const limiterTotalInflight = yield* readAllLimiterKeys(
      opts.namespace,
      limiterRedisPods,
    )
    const oomKilledCount =
      proxyPods.filter((p) => p.oomKilledHistorical).length +
      workerPods.filter((p) => p.oomKilledHistorical).length +
      limiterRedisPods.filter((p) => p.oomKilledHistorical).length

    // Trigger graceful shutdown of each worker so Node's `--cpu-prof`
    // flushes its `.cpuprofile` to /heapdumps before we collect.
    // Without this, the cpuprofile file is never written (V8 only
    // emits it at clean process exit). Best-effort: pods may already
    // be terminating from chaos / drain.
    yield* flushCpuProfiles(opts.namespace, workerPods)

    // Pull any heap snapshots and cpu profiles written by the worker
    // (V8 auto-snapshot via --heapsnapshot-near-heap-limit, /debug/heap-snapshot,
    // SIGUSR2, and --cpu-prof on clean exit). Best-effort; if /heapdumps
    // isn't mounted (production-style helm values), the copy is a no-op.
    yield* collectHeapdumps(opts.namespace, opts.artifactDir, workerPods)

    const snap: Snapshot = {
      tCaptured,
      proxyPods,
      workerPods,
      limiterRedisPods,
      limiterTotalInflight,
      oomKilledCount,
    }
    yield* Effect.tryPromise(() =>
      fs.writeFile(
        path.join(opts.artifactDir, "snapshot.json"),
        JSON.stringify(snap, null, 2),
        "utf8",
      ),
    ).pipe(
      Effect.mapError(
        (e) => new SnapshotError({ stage: "write", reason: String(e) }),
      ),
    )
    return snap
  })

/**
 * Send SIGTERM (kill -15 1) to each worker's PID 1 so Node's
 * `--cpu-prof` flushes the `.cpuprofile` to /heapdumps. V8 only writes
 * the profile on clean process exit; without this the file never lands.
 *
 * After SIGTERM the StatefulSet controller restarts the worker
 * container — its emptyDir survives the container restart, so the
 * old profile remains until kubectl cp picks it up. The race window
 * before the new container also starts writing to /heapdumps is
 * bounded by the post-SIGTERM grace + the new container's boot time
 * (sleep below covers both).
 *
 * Best-effort: failures are swallowed; if a worker is already
 * terminating from chaos we still proceed.
 */
const flushCpuProfiles = (
  namespace: string,
  workerPods: ReadonlyArray<PodSnapshot>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (workerPods.length === 0) return
    yield* Effect.forEach(
      workerPods,
      (pod) =>
        exec("kubectl", [
          "-n",
          namespace,
          "exec",
          pod.name,
          "-c",
          "worker",
          "--",
          "kill",
          "-15",
          "1",
        ]).pipe(Effect.ignore),
      { discard: true, concurrency: "unbounded" },
    )
    // Worker SIGTERM handler runs (drain ≲ 1 s) and then Node exits.
    // V8 flushes --cpu-prof on the exit path. 8 s gives generous slack
    // for the drain + flush before kubectl cp.
    yield* Effect.sleep(Duration.seconds(8))
  })

/**
 * For each worker pod, pull the contents of `/heapdumps/` (if any)
 * into `<artifactDir>/heapdumps/<pod>/`. Failures are swallowed —
 * worth a missing-snapshot footgun in the analyzer rather than
 * derailing the whole SNAPSHOT phase.
 */
const collectHeapdumps = (
  namespace: string,
  artifactDir: string,
  workerPods: ReadonlyArray<PodSnapshot>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const dest = path.join(artifactDir, "heapdumps")
    yield* Effect.tryPromise(() => fs.mkdir(dest, { recursive: true })).pipe(
      Effect.ignore,
    )
    for (const pod of workerPods) {
      const podDir = path.join(dest, pod.name)
      yield* Effect.tryPromise(() => fs.mkdir(podDir, { recursive: true })).pipe(
        Effect.ignore,
      )
      // List first so we can no-op cleanly when /heapdumps is empty
      // or absent. `ls -1` exits non-zero on missing dir, which the
      // ignore swallows.
      const listed = yield* exec("kubectl", [
        "-n",
        namespace,
        "exec",
        pod.name,
        "-c",
        "worker",
        "--",
        "sh",
        "-c",
        "ls -1 /heapdumps 2>/dev/null || true",
      ]).pipe(
        Effect.matchEffect({
          onSuccess: (r) => Effect.succeed(r.stdout),
          onFailure: () => Effect.succeed(""),
        }),
      )
      const files = listed
        .split("\n")
        .map((s) => s.trim())
        .filter(
          (s) =>
            s.length > 0 &&
            (s.endsWith(".heapsnapshot") || s.endsWith(".cpuprofile")),
        )
      if (files.length === 0) continue
      // `kubectl cp <pod>:<src> <dst>` copies the directory contents
      // recursively when the source ends in `/.`.
      yield* exec("kubectl", [
        "-n",
        namespace,
        "cp",
        "-c",
        "worker",
        `${pod.name}:/heapdumps/.`,
        podDir,
      ]).pipe(Effect.ignore)
    }
  })

const snapshotPods = (
  namespace: string,
  label: string,
  kind: "proxy" | "worker" | "redis",
): Effect.Effect<ReadonlyArray<PodSnapshot>, SnapshotError> =>
  Effect.gen(function* () {
    const pods = yield* listPods(namespace, label).pipe(Effect.orElseSucceed(() => []))
    const out: Array<PodSnapshot> = []
    for (const pod of pods) {
      const detail = yield* readPodDetail(namespace, pod.name).pipe(
        Effect.orElseSucceed(() => ({
          restartCount: 0,
          oomKilled: false,
        })),
      )
      const base: PodSnapshot = {
        name: pod.name,
        phase: pod.phase,
        ready: pod.ready,
        node: pod.node,
        restartCount: detail.restartCount,
        oomKilledHistorical: detail.oomKilled,
      }
      const enriched = { ...base } as Record<string, unknown>
      if (kind === "worker") {
        const dbsize = yield* readRedisDbsize(namespace, pod.name, "redis").pipe(
          Effect.orElseSucceed(() => -1),
        )
        enriched.redisDbsize = dbsize
        const m = yield* readPodMetrics(namespace, pod.name, "worker").pipe(
          Effect.orElseSucceed(() => undefined),
        )
        if (m !== undefined) enriched.metrics = m
      } else if (kind === "proxy") {
        const m = yield* readPodMetrics(namespace, pod.name, "proxy").pipe(
          Effect.orElseSucceed(() => undefined),
        )
        if (m !== undefined) enriched.metrics = m
      } else if (kind === "redis") {
        const dbsize = yield* readRedisDbsize(namespace, pod.name, "redis").pipe(
          Effect.orElseSucceed(() => -1),
        )
        enriched.redisDbsize = dbsize
      }
      out.push(enriched as unknown as PodSnapshot)
    }
    return out
  })

const readPodDetail = (
  namespace: string,
  pod: string,
): Effect.Effect<{ restartCount: number; oomKilled: boolean }, SnapshotError> =>
  Effect.gen(function* () {
    const result = yield* exec("kubectl", [
      "-n",
      namespace,
      "get",
      "pod",
      pod,
      "-o",
      // Sum restart counts across containers; presence of any
      // OOMKilled in the lastState/state across containers.
      "jsonpath={range .status.containerStatuses[*]}{.restartCount},{.lastState.terminated.reason},{.state.terminated.reason}|{end}",
    ]).pipe(
      Effect.mapError(
        (e) =>
          new SnapshotError({
            stage: `read-pod-detail/${pod}`,
            reason: e.message,
          }),
      ),
    )
    let restartCount = 0
    let oomKilled = false
    for (const part of result.stdout.split("|")) {
      if (!part.trim()) continue
      const [rcRaw, last, current] = part.split(",")
      const n = parseInt((rcRaw ?? "").trim(), 10)
      if (Number.isFinite(n)) restartCount += n
      if ((last ?? "").includes("OOMKilled") || (current ?? "").includes("OOMKilled")) {
        oomKilled = true
      }
    }
    return { restartCount, oomKilled }
  })

const readRedisDbsize = (
  namespace: string,
  pod: string,
  container: string,
): Effect.Effect<number, SnapshotError> =>
  Effect.gen(function* () {
    const result = yield* execInPod(namespace, pod, container, [
      "redis-cli",
      "DBSIZE",
    ]).pipe(
      Effect.mapError(
        (e) =>
          new SnapshotError({
            stage: `dbsize/${pod}`,
            reason: e.message,
          }),
      ),
    )
    const n = parseInt(result.stdout.trim(), 10)
    return Number.isFinite(n) ? n : -1
  })

/**
 * Sum every `limiter:*` key value across the shared limiter Redis. At
 * end of DRAIN this MUST be zero (no inflight, no leaked counters).
 */
const readAllLimiterKeys = (
  namespace: string,
  limiterRedisPods: ReadonlyArray<PodSnapshot>,
): Effect.Effect<number, SnapshotError> =>
  Effect.gen(function* () {
    const ready = limiterRedisPods.find((p) => p.ready)
    if (ready === undefined) return 0
    const result = yield* execInPod(namespace, ready.name, "redis", [
      "sh",
      "-c",
      // Production keys carry the `redisKeyPrefix` (default "sipas").
      "redis-cli --scan --pattern 'sipas:limiter:*' | xargs -r redis-cli mget | awk '{s+=$1} END {print s+0}'",
    ]).pipe(
      Effect.matchEffect({
        onSuccess: (r) => Effect.succeed(r.stdout.trim()),
        onFailure: () => Effect.succeed("0"),
      }),
    )
    const n = parseInt(result, 10)
    return Number.isFinite(n) ? n : 0
  })

/**
 * Read /metrics from a pod and return a compact subset of the gauges
 * we care about for the snapshot. Stays a small subset: the full
 * timeseries is in `metrics/<pod>.ndjson`.
 */
const readPodMetrics = (
  namespace: string,
  pod: string,
  container: "proxy" | "worker",
): Effect.Effect<Record<string, number>, SnapshotError> =>
  Effect.gen(function* () {
    const text = yield* execInPod(namespace, pod, container, [
      "wget",
      "-qO-",
      "http://localhost:9090/metrics",
    ]).pipe(
      Effect.matchEffect({
        onSuccess: (r) => Effect.succeed(r.stdout),
        onFailure: () => Effect.succeed(""),
      }),
    )
    if (text.length === 0) return {}
    const samples = parsePrometheusText(text)
    const interesting = new Set([
      "process_resident_memory_bytes",
      "process_cpu_seconds_total",
      "process_open_fds",
      "nodejs_heap_size_used_bytes",
      "nodejs_heap_size_total_bytes",
    ])
    const out: Record<string, number> = {}
    for (const s of samples) {
      if (interesting.has(s.name)) out[s.name] = s.value
    }
    return out
  })
