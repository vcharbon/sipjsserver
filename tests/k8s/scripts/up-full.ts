/**
 * Canonical K8s test environment bring-up. Produces a fully-ready
 * cluster: host observability stack up, kind cluster created, kind-addons
 * applied (vmagent + fluent-bit + node-exporter + kube-state-metrics),
 * images rebuilt and loaded, charts installed in `sip-test`, and the
 * post-up sanity gate (real e2e call + /metrics probes) passing.
 *
 * Wired to `npm run test:k8s:up`. The endurance run consumes this verbatim
 * after `clusterDown`; see [tests/k8s/endurance/run-endurance.ts].
 *
 * Pre-flight guards fail fast so a long endurance run cannot start on a
 * host that's about to fill its disk. Operator-facing rationale lives in
 * [docs/k8s-endurance.md].
 */

import { Data, Effect, References } from "effect"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { clusterUp } from "../fixtures/cluster.js"
import { exec } from "../fixtures/exec.js"
import { buildAndLoad } from "../fixtures/images.js"
import {
  installProxy,
  installRedis,
  installSipp,
  installWorker,
} from "../fixtures/helm.js"
import { sanity } from "./sanity.js"

const here = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(here, "../../..")
const OBSERVABILITY_INSTALL = resolve(REPO_ROOT, "deploy/observability/install.sh")
const ARTIFACT_DIR = resolve(REPO_ROOT, "test-results")
const NAMESPACE = process.env["K8S_TEST_NAMESPACE"] ?? "sip-test"
const MIN_FREE_DISK_GIB = 30

class BringupError extends Data.TaggedError("BringupError")<{
  readonly stage: string
  readonly detail: string
}> {
  override get message(): string {
    return `bringup failed at stage=${this.stage}: ${this.detail}`
  }
}

const checkDiskSpace = Effect.gen(function* () {
  // `df -BG --output=avail <path>` prints e.g. "Avail\n42G\n".
  // -BG forces gibibyte units; trailing 'G' is sliced off.
  const result = yield* exec("df", [
    "-BG",
    "--output=avail",
    ARTIFACT_DIR,
  ]).pipe(
    Effect.catchTag("ExecError", (e) =>
      Effect.fail(
        new BringupError({
          stage: "preflight-disk",
          detail: `df ${ARTIFACT_DIR} failed: ${e.message}`,
        }),
      ),
    ),
  )
  const lines = result.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0)
  const last = lines[lines.length - 1] ?? ""
  const m = /^(\d+)G$/.exec(last)
  if (!m) {
    return yield* new BringupError({
      stage: "preflight-disk",
      detail: `df output not parseable: '${result.stdout}'`,
    })
  }
  const availGib = parseInt(m[1] ?? "0", 10)
  yield* Effect.logInfo(`preflight: ${availGib} GiB free at ${ARTIFACT_DIR}`)
  if (availGib < MIN_FREE_DISK_GIB) {
    return yield* new BringupError({
      stage: "preflight-disk",
      detail:
        `only ${availGib} GiB free on artifact volume (${ARTIFACT_DIR}); ` +
        `need ≥${MIN_FREE_DISK_GIB} GiB. Free space and retry.`,
    })
  }
})

const checkDocker = Effect.gen(function* () {
  yield* exec("docker", ["info"], { timeoutMs: 10_000 }).pipe(
    Effect.catchTag("ExecError", (e) =>
      Effect.fail(
        new BringupError({
          stage: "preflight-docker",
          detail: `docker daemon not reachable: ${e.message}`,
        }),
      ),
    ),
  )
  yield* Effect.logInfo("preflight: docker daemon reachable")
})

const applyObservability = (label: string) =>
  Effect.gen(function* () {
    yield* Effect.logInfo(`observability: ${label} (install.sh --apply)`)
    yield* exec("bash", [OBSERVABILITY_INSTALL, "--apply"], {
      timeoutMs: 5 * 60 * 1000,
    }).pipe(
      Effect.catchTag("ExecError", (e) =>
        Effect.fail(
          new BringupError({
            stage: `observability-${label}`,
            detail: e.message,
          }),
        ),
      ),
    )
  })

const installStack = (extraWorkerValues: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* Effect.logInfo(`charts: installing into namespace=${NAMESPACE}`)
    yield* installRedis(NAMESPACE)
    yield* installSipp(NAMESPACE)
    yield* installWorker(NAMESPACE, { extraValues: extraWorkerValues })
    yield* installProxy(NAMESPACE)
  })

export interface UpFullOptions {
  /**
   * Extra Helm values files layered on top of the worker chart's base
   * values. Endurance passes `WORKER_VALUES_ENDURANCE`; the inner-loop
   * path passes nothing.
   */
  readonly extraWorkerValues?: ReadonlyArray<string>
}

export const upFull = (opts: UpFullOptions = {}) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("=== K8s test bring-up: start ===")

    // Pre-flight: fail fast before doing anything heavy.
    yield* checkDiskSpace
    yield* checkDocker

    // 1st observability pass — host stack only (kind-addons step warns
    // and skips because no cluster yet; that's the documented behavior).
    yield* applyObservability("host-stack")

    // Kind cluster (idempotent — skip if already exists).
    yield* clusterUp

    // 2nd observability pass — host stack is now a no-op; this is the
    // pass that actually applies vmagent/fluent-bit/node-exporter/
    // kube-state-metrics into the freshly-created cluster.
    yield* applyObservability("kind-addons")

    // Always rebuild and side-load both images. Content-hashed → fast
    // no-op when nothing changed; ensures the cluster never runs against
    // a stale tag.
    yield* buildAndLoad

    // Helm charts.
    yield* installStack(opts.extraWorkerValues ?? [])

    // Sanity gate — fails the bring-up loudly if traffic can't flow or
    // metrics aren't being served.
    yield* sanity

    yield* Effect.logInfo("=== K8s test bring-up: ready ===")
  })

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  Effect.runPromise(
    upFull().pipe(Effect.provideService(References.MinimumLogLevel, "Info")),
  ).then(
    () => process.exit(0),
    (err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    },
  )
}
