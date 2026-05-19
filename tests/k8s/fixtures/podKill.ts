import { Data, Effect } from "effect"
import { execInPod } from "./kubectl.js"
import { exec } from "./exec.js"

export type KillMode = "delete-grace0" | "delete-grace20" | "exec-kill-9"

export class PodKillError extends Data.TaggedError("PodKillError")<{
  readonly pod: string
  readonly mode: KillMode
  readonly reason: string
}> {
  override get message(): string {
    return `killPod[${this.mode}] failed for ${this.pod}: ${this.reason}`
  }
}

export interface KillPodOpts {
  /**
   * Container to send `kill -9 1` to (only used by `"exec-kill-9"`).
   * Defaults to the conventional names per pod kind:
   * `b2bua-worker-*` → `worker`, `sip-front-proxy-*` → `proxy`. Override
   * for any other pod, or to target a specific container in a multi-
   * container pod.
   */
  readonly container?: string
  /** Hard timeout in seconds for the kubectl invocation. Default 30. */
  readonly timeoutSec?: number
}

/**
 * Issue the kill and return the wall-clock `Date` at which the kill was
 * issued. This is the test's `T_kill` reference — used by
 * `callLifecycle.classifyCalls` to bucket calls into
 * `established-on-dying` / `in-flight-on-dying` / `pre-routed-on-dying`.
 *
 * Three strategies:
 *
 * - `"delete-grace0"` — `kubectl delete pod --grace-period=0 --force`.
 *   Fast control-plane removal; the kubelet still SIGTERMs/SIGKILLs the
 *   container after the API delete. Models the "node-lost" failure the
 *   user is least likely to recover from gracefully. Backs the
 *   `worker-pod-api-delete-force` chaos event.
 *
 * - `"delete-grace20"` — `kubectl delete pod --grace-period=20`. True
 *   graceful drain: kubelet sends SIGTERM and waits up to 20 s before
 *   SIGKILL, giving the worker time to walk the two-tier graceful drain
 *   protocol (ADR-0008). Backs the `worker-pod-graceful` chaos event.
 *
 * - `"exec-kill-9"` — `kubectl exec ... -- kill -9 1`. Models a hard
 *   in-pod crash where the kubelet sees the container exit before any
 *   API delete. The exec channel will close with a non-zero status when
 *   PID 1 dies — that's expected and not an error from our point of
 *   view.
 *
 * The returned `Date` is captured *immediately before* the kubectl call
 * starts. Tests should assume `T_kill ≈ Date.now()` at the moment of
 * the call, with sub-second precision.
 */
export const killPod = (
  namespace: string,
  pod: string,
  mode: KillMode,
  opts: KillPodOpts = {},
): Effect.Effect<Date, PodKillError> =>
  Effect.gen(function* () {
    const tKill = new Date()
    const timeoutMs = (opts.timeoutSec ?? 30) * 1000
    if (mode === "delete-grace0" || mode === "delete-grace20") {
      const graceArg = mode === "delete-grace0" ? "--grace-period=0" : "--grace-period=20"
      const args = [
        "-n",
        namespace,
        "delete",
        "pod",
        pod,
        graceArg,
        "--ignore-not-found",
      ]
      if (mode === "delete-grace0") args.splice(args.indexOf(graceArg) + 1, 0, "--force")
      yield* exec("kubectl", args, { timeoutMs }).pipe(
        Effect.mapError(
          (e) =>
            new PodKillError({
              pod,
              mode,
              reason: `kubectl delete failed: ${e.stderr.trim() || e.stdout.trim()}`,
            }),
        ),
      )
      return tKill
    }
    // mode === "exec-kill-9"
    const container = opts.container ?? defaultContainerFor(pod)
    yield* execInPod(namespace, pod, container, ["kill", "-9", "1"], { timeoutMs }).pipe(
      // PID 1 dying tears down the exec channel; kubectl exits non-zero.
      // That's the success path here — only report a real error if the
      // kubectl invocation itself was malformed (no such pod / container).
      Effect.catchTag("ExecError", (e) => {
        const text = `${e.stderr}\n${e.stdout}`.toLowerCase()
        if (
          text.includes("not found") ||
          text.includes("no such") ||
          text.includes("container not valid")
        ) {
          return Effect.fail(
            new PodKillError({
              pod,
              mode,
              reason: `kubectl exec rejected target: ${e.stderr.trim() || e.stdout.trim()}`,
            }),
          )
        }
        // Treat the abrupt channel close as success.
        return Effect.void
      }),
    )
    return tKill
  })

/**
 * Convention-based container resolution. Keeps callers from having to
 * hard-code `container: "worker"` for every worker pod test. Falls back
 * to the StatefulSet pod kind by hostname prefix.
 */
const defaultContainerFor = (pod: string): string => {
  if (pod.startsWith("b2bua-worker-")) return "worker"
  if (pod.startsWith("sip-front-proxy-") || pod.startsWith("sip-front-proxy")) {
    return "proxy"
  }
  // Fallback: assume single-container or that the caller wants the
  // first container — kubectl exec defaults to it when -c is omitted,
  // but our wrapper requires a name. Use the pod name root as a guess.
  return pod.split("-")[0] ?? pod
}
