import { Effect } from "effect"
import { exec } from "./exec.js"

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
