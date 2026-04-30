import { Data, Effect } from "effect"
import { exec } from "./exec.js"

export class KubectlWaitError extends Data.TaggedError("KubectlWaitError")<{
  readonly resource: string
  readonly reason: string
}> {
  override get message(): string {
    return `kubectl wait failed for ${this.resource}: ${this.reason}`
  }
}

export interface PodInfo {
  readonly name: string
  readonly ip: string
  readonly node: string
  readonly phase: string
  readonly ready: boolean
}

const POD_JSON_TEMPLATE = `{range .items[*]}{.metadata.name}|{.status.podIP}|{.spec.nodeName}|{.status.phase}|{range .status.conditions[?(@.type=="Ready")]}{.status}{end}{"\\n"}{end}`

export const listPods = (
  namespace: string,
  labelSelector?: string,
): Effect.Effect<ReadonlyArray<PodInfo>> =>
  Effect.gen(function* () {
    const args = ["-n", namespace, "get", "pods", "-o", `jsonpath=${POD_JSON_TEMPLATE}`]
    if (labelSelector) args.push("-l", labelSelector)
    const result = yield* exec("kubectl", args).pipe(
      Effect.matchEffect({
        onSuccess: (r) => Effect.succeed(r.stdout),
        onFailure: () => Effect.succeed(""),
      }),
    )
    return result
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line): PodInfo => {
        const [name, ip, node, phase, ready] = line.split("|")
        return {
          name: name ?? "",
          ip: ip ?? "",
          node: node ?? "",
          phase: phase ?? "",
          ready: ready === "True",
        }
      })
  })

/**
 * Return the worker pod that owns a given pod IP, or undefined.
 */
export const podByIp = (pods: ReadonlyArray<PodInfo>, ip: string): PodInfo | undefined =>
  pods.find((p) => p.ip === ip)

export const deletePod = (
  namespace: string,
  name: string,
  opts: { gracePeriodSec?: number } = {},
) =>
  Effect.gen(function* () {
    const args = ["-n", namespace, "delete", "pod", name, "--ignore-not-found"]
    if (opts.gracePeriodSec !== undefined) {
      args.push(`--grace-period=${opts.gracePeriodSec}`)
      if (opts.gracePeriodSec === 0) args.push("--force")
    }
    yield* Effect.logInfo(`kubectl ${args.join(" ")}`)
    yield* exec("kubectl", args, { timeoutMs: 60_000 })
  })

export const scaleStatefulSet = (namespace: string, name: string, replicas: number) =>
  Effect.gen(function* () {
    yield* Effect.logInfo(
      `kubectl -n ${namespace} scale statefulset/${name} --replicas=${replicas}`,
    )
    yield* exec(
      "kubectl",
      [
        "-n",
        namespace,
        "scale",
        "statefulset",
        name,
        `--replicas=${replicas}`,
      ],
      { timeoutMs: 60_000 },
    )
  })

export const waitForPodReady = (namespace: string, podName: string, timeoutSec = 60) =>
  Effect.gen(function* () {
    yield* exec(
      "kubectl",
      [
        "-n",
        namespace,
        "wait",
        "--for=condition=ready",
        `--timeout=${timeoutSec}s`,
        `pod/${podName}`,
      ],
      { timeoutMs: (timeoutSec + 10) * 1000 },
    )
  })

/**
 * Run a command inside a pod and return stdout.
 */
export const podExec = (
  namespace: string,
  podName: string,
  command: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const { stdout } = yield* exec(
      "kubectl",
      ["-n", namespace, "exec", podName, "--", ...command],
      { timeoutMs: 30_000 },
    )
    return stdout
  })

/**
 * Run a command inside a specific container of a pod. Returns both
 * stdout and stderr because callers (e.g. `podKill.ts`) may want the
 * stderr stream when the exec exits non-zero (kill -9 makes the kubectl
 * exec channel close abruptly, which is normal).
 */
export const execInPod = (
  namespace: string,
  podName: string,
  container: string,
  command: ReadonlyArray<string>,
  opts: { timeoutMs?: number } = {},
) =>
  exec(
    "kubectl",
    ["-n", namespace, "exec", podName, "-c", container, "--", ...command],
    { timeoutMs: opts.timeoutMs ?? 30_000 },
  )

/**
 * Wait until a Deployment has `replicas` ready replicas AND its
 * generation has been observed by the controller (i.e. no rollout in
 * progress). Used by LB-failover tests to confirm the killed proxy pod
 * was recreated.
 */
export const waitForDeploymentSteady = (
  namespace: string,
  name: string,
  replicas: number,
  timeoutSec: number,
): Effect.Effect<void, KubectlWaitError> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutSec * 1000
    let lastSeen = ""
    while (Date.now() < deadline) {
      const result = yield* exec(
        "kubectl",
        [
          "-n",
          namespace,
          "get",
          "deployment",
          name,
          "-o",
          "jsonpath={.status.readyReplicas}|{.status.observedGeneration}|{.metadata.generation}",
        ],
        { timeoutMs: 10_000 },
      ).pipe(
        Effect.matchEffect({
          onSuccess: (r) => Effect.succeed(r.stdout.trim()),
          onFailure: () => Effect.succeed(""),
        }),
      )
      lastSeen = result
      const [readyRaw, observedRaw, generationRaw] = result.split("|")
      const ready = readyRaw ? parseInt(readyRaw, 10) : NaN
      const observed = observedRaw ? parseInt(observedRaw, 10) : NaN
      const generation = generationRaw ? parseInt(generationRaw, 10) : NaN
      if (
        Number.isFinite(ready) &&
        ready === replicas &&
        Number.isFinite(observed) &&
        Number.isFinite(generation) &&
        observed >= generation
      ) {
        return
      }
      yield* Effect.sleep("1 second")
    }
    return yield* new KubectlWaitError({
      resource: `deployment ${namespace}/${name}`,
      reason:
        `not steady within ${timeoutSec}s ` +
        `(want readyReplicas=${replicas}, last status="${lastSeen}")`,
    })
  })

/**
 * Wait until a StatefulSet has `replicas` ready replicas AND its
 * `currentRevision` matches `updateRevision` (i.e. no rolling update in
 * progress). Throws on timeout. Used by failover tests in `afterEach`
 * before yielding to the next test.
 */
export const waitForStatefulSetSteady = (
  namespace: string,
  name: string,
  replicas: number,
  timeoutSec: number,
): Effect.Effect<void, KubectlWaitError> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutSec * 1000
    let lastSeen = ""
    while (Date.now() < deadline) {
      const result = yield* exec(
        "kubectl",
        [
          "-n",
          namespace,
          "get",
          "statefulset",
          name,
          "-o",
          "jsonpath={.status.readyReplicas}|{.status.currentRevision}|{.status.updateRevision}",
        ],
        { timeoutMs: 10_000 },
      ).pipe(
        Effect.matchEffect({
          onSuccess: (r) => Effect.succeed(r.stdout.trim()),
          onFailure: () => Effect.succeed(""),
        }),
      )
      lastSeen = result
      const [readyRaw, currentRev, updateRev] = result.split("|")
      const ready = readyRaw ? parseInt(readyRaw, 10) : NaN
      if (
        Number.isFinite(ready) &&
        ready === replicas &&
        currentRev !== "" &&
        currentRev === updateRev
      ) {
        return
      }
      yield* Effect.sleep("1 second")
    }
    return yield* new KubectlWaitError({
      resource: `statefulset ${namespace}/${name}`,
      reason:
        `not steady within ${timeoutSec}s ` +
        `(want readyReplicas=${replicas}, last status="${lastSeen}")`,
    })
  })

/**
 * Wrap `kubectl cp <ns>/<pod>:<srcInPod> <dstOnHost>`. The pod must
 * still be in `Running` phase — copying out of a `Succeeded` or
 * `Failed` pod fails with "cannot exec into a container in a completed
 * pod". Callers (e.g. `sippJob.ts`) hold the pod alive with a tail
 * `sleep` after the workload exits to make this work.
 */
export const kubectlCp = (
  namespace: string,
  podName: string,
  srcInPod: string,
  dstOnHost: string,
  opts: { container?: string; timeoutMs?: number } = {},
) =>
  Effect.gen(function* () {
    const args = ["-n", namespace, "cp"]
    if (opts.container) args.push("-c", opts.container)
    args.push(`${podName}:${srcInPod}`, dstOnHost)
    yield* exec("kubectl", args, { timeoutMs: opts.timeoutMs ?? 60_000 })
  })

/**
 * Get raw pod logs. `since` filters by relative duration (e.g. "30s",
 * "5m"), useful for limiting log volume to the recent test window.
 */
export const podLogs = (
  namespace: string,
  selector: { pod?: string; labelSelector?: string },
  opts: { since?: string; tail?: number; previous?: boolean } = {},
) =>
  Effect.gen(function* () {
    const args: Array<string> = ["-n", namespace, "logs"]
    if (selector.pod) {
      args.push(selector.pod)
    } else if (selector.labelSelector) {
      // `--max-log-requests` default is 5 (enough for our 2-3 pod
      // selectors). `--prefix` adds `[pod/<name>/<container>] ` to each
      // line so test code can disambiguate by source.
      args.push("-l", selector.labelSelector, "--prefix", "--max-log-requests=10")
    }
    if (opts.since) args.push("--since", opts.since)
    // `kubectl logs -l` defaults to --tail=10 per pod, which silently
    // truncates everything older. Override unconditionally so callers
    // get the full window they asked for via --since.
    args.push("--tail", String(opts.tail ?? 10000))
    if (opts.previous) args.push("--previous")
    const { stdout } = yield* exec("kubectl", args, { timeoutMs: 30_000 })
    return stdout
  })
