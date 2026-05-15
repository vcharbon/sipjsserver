/**
 * Post-up sanity gate. Run by `up-full.ts` after charts are installed,
 * before any test consumer is allowed to use the cluster.
 *
 * Confirms two things, in order:
 *   1. A real representative call goes end-to-end via
 *      `tests/fullcall/e2e-register-fakeExt-realCore.test.ts`
 *      (REGISTER + INVITE + BYE + reroute).
 *   2. `/metrics` on every worker and every proxy pod returns a
 *      non-empty Prometheus exposition — proves the scrape targets
 *      vmagent will hit are alive.
 *
 * The e2e step retries up to 3× with a 10s spacer so a slow first-call
 * cold path doesn't abort the bring-up. On final failure the script
 * prints pod state + recent logs so the operator sees the source of the
 * "bad launch" without re-typing kubectl by hand.
 */

import { Data, Duration, Effect, References } from "effect"
import { exec, ExecError } from "../fixtures/exec.js"
import { listPods, podExec, podLogs } from "../fixtures/kubectl.js"

const NAMESPACE = process.env["K8S_TEST_NAMESPACE"] ?? "sip-test"
const VIP = process.env["E2E_KIND_PROXY_HOST"] ?? "172.20.255.250"
const WORKER_METRICS_PORT = 3002
const PROXY_METRICS_PORT = 9090

const E2E_ATTEMPTS = 3
const E2E_RETRY_DELAY = Duration.seconds(10)
const E2E_PER_ATTEMPT_TIMEOUT_MS = 90_000

class SanityError extends Data.TaggedError("SanityError")<{
  readonly stage: "e2e" | "worker-metrics" | "proxy-metrics"
  readonly detail: string
}> {
  override get message(): string {
    return `sanity check failed at stage=${this.stage}: ${this.detail}`
  }
}

const runE2eOnce = Effect.gen(function* () {
  yield* Effect.logInfo("sanity: vitest run e2e-register-fakeExt-realCore.test.ts")
  yield* exec(
    "npx",
    [
      "vitest",
      "run",
      "-c",
      "vitest.config.live.ts",
      "tests/fullcall/e2e-register-fakeExt-realCore.test.ts",
    ],
    {
      env: { E2E_KIND: "1", E2E_KIND_PROXY_HOST: VIP },
      timeoutMs: E2E_PER_ATTEMPT_TIMEOUT_MS,
    },
  )
})

const runE2eWithRetries = Effect.gen(function* () {
  for (let attempt = 1; attempt <= E2E_ATTEMPTS; attempt++) {
    const result = yield* runE2eOnce.pipe(Effect.result)
    if (result._tag === "Success") {
      yield* Effect.logInfo(`sanity: e2e passed on attempt ${attempt}`)
      return
    }
    const err = result.failure
    const detail = err instanceof ExecError ? err.message : String(err)
    if (attempt === E2E_ATTEMPTS) {
      return yield* new SanityError({
        stage: "e2e",
        detail: `${E2E_ATTEMPTS} attempts exhausted; last error: ${detail}`,
      })
    }
    yield* Effect.logWarning(
      `sanity: e2e attempt ${attempt}/${E2E_ATTEMPTS} failed; retrying in ${Duration.toSeconds(E2E_RETRY_DELAY)}s`,
    )
    yield* Effect.sleep(E2E_RETRY_DELAY)
  }
})

const probeMetrics = (
  stage: "worker-metrics" | "proxy-metrics",
  selector: string,
  port: number,
) =>
  Effect.gen(function* () {
    const pods = yield* listPods(NAMESPACE, selector)
    if (pods.length === 0) {
      return yield* new SanityError({
        stage,
        detail: `no pods match label selector '${selector}' in ns=${NAMESPACE}`,
      })
    }
    for (const pod of pods) {
      if (!pod.ready) {
        return yield* new SanityError({
          stage,
          detail: `pod ${pod.name} not Ready (phase=${pod.phase})`,
        })
      }
      const text = yield* podExec(NAMESPACE, pod.name, [
        "wget",
        "-qO-",
        `http://127.0.0.1:${port}/metrics`,
      ]).pipe(
        Effect.catchTag("ExecError", (e) =>
          Effect.fail(
            new SanityError({
              stage,
              detail: `pod ${pod.name} /metrics:${port} unreachable (${e.message})`,
            }),
          ),
        ),
      )
      // BusyBox wget returns 0 with empty body on 404 — guard against
      // both "no body" and "looks like an error page".
      if (text.length === 0 || !/^[a-zA-Z_]/m.test(text)) {
        return yield* new SanityError({
          stage,
          detail: `pod ${pod.name} /metrics:${port} returned no Prometheus samples`,
        })
      }
      yield* Effect.logInfo(
        `sanity: ${pod.name} /metrics:${port} OK (${text.length} bytes)`,
      )
    }
  })

const dumpDiagnostics = Effect.gen(function* () {
  yield* Effect.logError("sanity: dumping cluster diagnostics for triage")
  const podsOut = yield* exec("kubectl", ["-n", NAMESPACE, "get", "pods", "-o", "wide"]).pipe(
    Effect.matchEffect({
      onSuccess: (r) => Effect.succeed(r.stdout),
      onFailure: () => Effect.succeed("(kubectl get pods failed)"),
    }),
  )
  process.stderr.write(`\n--- kubectl get pods -o wide ---\n${podsOut}\n`)

  const pods = yield* listPods(NAMESPACE)
  for (const pod of pods) {
    if (pod.ready) continue
    const desc = yield* exec("kubectl", ["-n", NAMESPACE, "describe", "pod", pod.name]).pipe(
      Effect.matchEffect({
        onSuccess: (r) => Effect.succeed(r.stdout),
        onFailure: () => Effect.succeed("(kubectl describe failed)"),
      }),
    )
    process.stderr.write(`\n--- kubectl describe pod ${pod.name} ---\n${desc}\n`)
  }

  for (const selector of [
    "app.kubernetes.io/name=b2bua-worker",
    "app.kubernetes.io/name=sip-front-proxy",
  ]) {
    const logs = yield* podLogs(NAMESPACE, { labelSelector: selector }, { tail: 50 }).pipe(
      Effect.matchEffect({
        onSuccess: (s) => Effect.succeed(s),
        onFailure: () => Effect.succeed("(kubectl logs failed)"),
      }),
    )
    process.stderr.write(`\n--- logs ${selector} (tail=50) ---\n${logs}\n`)
  }
})

export const sanity = Effect.gen(function* () {
  yield* runE2eWithRetries
  yield* probeMetrics(
    "worker-metrics",
    "app.kubernetes.io/name=b2bua-worker",
    WORKER_METRICS_PORT,
  )
  yield* probeMetrics(
    "proxy-metrics",
    "app.kubernetes.io/name=sip-front-proxy",
    PROXY_METRICS_PORT,
  )
  yield* Effect.logInfo("sanity: all checks passed")
}).pipe(
  Effect.catchTag("SanityError", (e) =>
    Effect.gen(function* () {
      yield* dumpDiagnostics
      return yield* e
    }),
  ),
)

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  Effect.runPromise(
    sanity.pipe(Effect.provideService(References.MinimumLogLevel, "Info")),
  ).then(
    () => process.exit(0),
    (err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    },
  )
}
