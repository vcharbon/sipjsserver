import { Effect } from "effect"
import { exec } from "./exec.js"
import {
  installProxy,
  installRedis,
  installSipp,
  installWorker,
} from "./helm.js"

/**
 * Install the full Phase A stack (redis + sipp + worker + proxy) into a
 * namespace. Helm `--wait` blocks per chart until pods are Ready, so
 * this resolves only when the cluster is ready to accept SIPp traffic.
 */
export const installStack = (namespace: string) =>
  Effect.gen(function* () {
    yield* Effect.logInfo(`installing stack into namespace=${namespace}`)
    yield* installRedis(namespace)
    yield* installSipp(namespace)
    yield* installWorker(namespace)
    yield* installProxy(namespace)
  })

export const deleteNamespace = (namespace: string) =>
  Effect.gen(function* () {
    yield* Effect.logInfo(`deleting namespace=${namespace}`)
    yield* exec("kubectl", ["delete", "namespace", namespace, "--wait=true"], {
      timeoutMs: 120_000,
    })
  })

export const namespaceExists = (namespace: string) =>
  Effect.gen(function* () {
    const { stdout } = yield* exec("kubectl", [
      "get",
      "namespaces",
      "--no-headers",
      "-o",
      "name",
    ])
    return stdout
      .split("\n")
      .map((s) => s.trim().replace(/^namespace\//, ""))
      .includes(namespace)
  })

/**
 * Generate a short, lowercase, DNS-1123-safe namespace name. Suitable
 * for per-test isolation: each test file calls this once and installs
 * the full stack into it.
 */
export const generateNamespaceName = (prefix = "sip-test"): string => {
  const ts = Date.now().toString(36).slice(-6)
  const r = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${ts}-${r}`
}
