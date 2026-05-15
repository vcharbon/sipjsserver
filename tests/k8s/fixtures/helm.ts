import { Effect } from "effect"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { classifyAdmission } from "../../../src/b2bua/TargetAdmission.js"
import { exec } from "./exec.js"

// Default suffix list the worker uses unless overridden via
// WORKER_ALLOWED_TARGET_SUFFIXES. Mirrors the production default in
// src/config/AppConfig.ts. Keep in sync.
const DEFAULT_WORKER_ALLOWED_TARGET_SUFFIXES = [".svc.cluster.local"]

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(here, "../../..")

export const PROXY_CHART = resolve(REPO_ROOT, "deploy/helm/sip-front-proxy")
export const WORKER_CHART = resolve(REPO_ROOT, "deploy/helm/b2bua-worker")
export const REDIS_CHART = resolve(REPO_ROOT, "tests/k8s/charts/redis")
export const SIPP_CHART = resolve(REPO_ROOT, "tests/k8s/charts/sipp")

export const PROXY_VALUES = resolve(REPO_ROOT, "tests/k8s/values/sip-front-proxy.yaml")
export const PROXY_HOST_VALUES = resolve(
  REPO_ROOT,
  "tests/k8s/values/sip-front-proxy.host.yaml",
)
export const WORKER_VALUES = resolve(REPO_ROOT, "tests/k8s/values/b2bua-worker.yaml")
/**
 * Endurance-specific overlay layered on top of WORKER_VALUES when
 * launching from `tests/k8s/endurance/run-endurance.ts`. Adds memory
 * limit + diagnostic NODE_OPTIONS (heap-snapshot signal, near-limit
 * auto-dump) so the next freeze produces an analyzable artifact
 * instead of an opaque stuck state. See
 * `tests/k8s/values/b2bua-worker.endurance.yaml` and memory note
 * `project_replication_dual_writer_collapse.md`. Memleak harness
 * (`sippperftest/memleak-test-k8s.sh`) explicitly does NOT consume
 * this overlay — it has its own.
 */
export const WORKER_VALUES_ENDURANCE = resolve(
  REPO_ROOT,
  "tests/k8s/values/b2bua-worker.endurance.yaml",
)

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

// Opaque payload pass-through; the helm CLI's JSON output is a stable
// external contract. Schema decoding here is overkill — extracted out
// of Effect.gen per docs/typescript-effect.md §"preferSchemaOverJson".
const parseHelmStatus = (
  raw: string,
): { name: string; info: { status: string } } =>
  JSON.parse(raw) as { name: string; info: { status: string } }

const formatSuffixesForDebug = (suffixes: ReadonlyArray<string>): string =>
  JSON.stringify(suffixes)

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
    return parseHelmStatus(stdout)
  })

export const installRedis = (namespace: string) =>
  helmInstall({
    release: "redis",
    chart: REDIS_CHART,
    namespace,
    waitTimeoutSec: 60,
  })

export const installWorker = (
  namespace: string,
  opts?: { readonly extraValues?: ReadonlyArray<string> },
) =>
  helmInstall({
    release: "b2bua-worker",
    chart: WORKER_CHART,
    namespace,
    valuesFiles: [WORKER_VALUES, ...(opts?.extraValues ?? [])],
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

/**
 * Install the proxy chart with the host-mode overlay applied on top of
 * the standard test values. Use when a host-resident SIPp UAC needs to
 * reach the proxy via 127.0.0.1:5060 (kind hostPort) — Record-Route is
 * stamped with 127.0.0.1 so the dialog's route set keeps working from
 * outside the cluster. See tests/k8s/values/sip-front-proxy.host.yaml.
 */
export const installProxyHostMode = (namespace: string) =>
  helmInstall({
    release: "sip-front-proxy",
    chart: PROXY_CHART,
    namespace,
    valuesFiles: [PROXY_VALUES, PROXY_HOST_VALUES],
    waitTimeoutSec: 120,
  })

export const installSipp = (namespace: string) =>
  Effect.gen(function* () {
    // The b2bua worker's TargetAdmission rejects b-leg destinations
    // whose host is neither an IP literal nor matches the suffix
    // allow-list. The mock call-control returns whatever
    // `callControl.target.host` is set to, so we install the chart
    // with the in-namespace FQDN — which ends in `.svc.cluster.local`
    // and clears the default admission gate. The chart's values.yaml
    // keeps the bare-name default (`sipp-uas`) for human readability;
    // this --set ensures every k8s test installs a host that survives
    // the admission rule introduced by commit aeaedde2.
    const target = `sipp-uas.${namespace}.svc.cluster.local`
    const verdict = classifyAdmission(target, DEFAULT_WORKER_ALLOWED_TARGET_SUFFIXES)
    if (verdict === "reject") {
      const suffixesDebug = formatSuffixesForDebug(
        DEFAULT_WORKER_ALLOWED_TARGET_SUFFIXES,
      )
      return yield* Effect.die(
        new Error(
          `installSipp: target host '${target}' would be rejected by the worker's TargetAdmission ` +
            `(suffixes=${suffixesDebug}). ` +
            `Update DEFAULT_WORKER_ALLOWED_TARGET_SUFFIXES or the helm --set value.`,
        ),
      )
    }
    yield* helmInstall({
      release: "sipp",
      chart: SIPP_CHART,
      namespace,
      setValues: [["callControl.target.host", target]],
      waitTimeoutSec: 60,
    })
  })
