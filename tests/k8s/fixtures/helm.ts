import { Effect } from "effect"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { exec } from "./exec.js"

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(here, "../../..")

export const PROXY_CHART = resolve(REPO_ROOT, "deploy/helm/sip-front-proxy")
export const WORKER_CHART = resolve(REPO_ROOT, "deploy/helm/b2bua-worker")
export const SIPP_CHART = resolve(REPO_ROOT, "tests/k8s/charts/sipp")

export const PROXY_VALUES = resolve(REPO_ROOT, "tests/k8s/values/sip-front-proxy.yaml")
export const WORKER_VALUES = resolve(REPO_ROOT, "tests/k8s/values/b2bua-worker.yaml")

export interface HelmInstallOpts {
  readonly release: string
  readonly chart: string
  readonly namespace: string
  readonly valuesFiles?: ReadonlyArray<string>
  readonly setValues?: ReadonlyArray<readonly [string, string]>
  readonly waitTimeoutSec?: number
}

export const helmInstall = (opts: HelmInstallOpts) =>
  Effect.gen(function* () {
    const args: Array<string> = [
      "upgrade",
      "--install",
      opts.release,
      opts.chart,
      "--namespace",
      opts.namespace,
      "--create-namespace",
      "--wait",
      "--timeout",
      `${opts.waitTimeoutSec ?? 180}s`,
    ]
    for (const f of opts.valuesFiles ?? []) {
      args.push("-f", f)
    }
    for (const [k, v] of opts.setValues ?? []) {
      args.push("--set", `${k}=${v}`)
    }
    yield* Effect.logInfo(`helm ${args.join(" ")}`)
    yield* exec("helm", args, { timeoutMs: ((opts.waitTimeoutSec ?? 180) + 30) * 1000 })
  })

export const helmUninstall = (release: string, namespace: string) =>
  Effect.gen(function* () {
    yield* Effect.logInfo(`helm uninstall ${release} -n ${namespace}`)
    yield* exec("helm", ["uninstall", release, "--namespace", namespace, "--wait"], {
      timeoutMs: 120_000,
    })
  })

export const helmStatus = (release: string, namespace: string) =>
  Effect.gen(function* () {
    const { stdout } = yield* exec("helm", [
      "status",
      release,
      "--namespace",
      namespace,
      "-o",
      "json",
    ])
    return JSON.parse(stdout) as { name: string; info: { status: string } }
  })

export const installWorker = (namespace: string) =>
  helmInstall({
    release: "b2bua-worker",
    chart: WORKER_CHART,
    namespace,
    valuesFiles: [WORKER_VALUES],
    waitTimeoutSec: 120,
  })

export const installProxy = (namespace: string) =>
  helmInstall({
    release: "sip-front-proxy",
    chart: PROXY_CHART,
    namespace,
    valuesFiles: [PROXY_VALUES],
    waitTimeoutSec: 120,
  })

export const installSipp = (namespace: string) =>
  helmInstall({
    release: "sipp",
    chart: SIPP_CHART,
    namespace,
    waitTimeoutSec: 60,
  })
