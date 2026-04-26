import { Effect } from "effect"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { exec } from "./exec.js"

export const CLUSTER_NAME = "sip-e2e"

const here = dirname(fileURLToPath(import.meta.url))
export const CLUSTER_CONFIG = resolve(here, "../cluster.yaml")

export const clusterExists = Effect.gen(function* () {
  const { stdout } = yield* exec("kind", ["get", "clusters"])
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .includes(CLUSTER_NAME)
})

export const clusterUp = Effect.gen(function* () {
  const exists = yield* clusterExists
  if (exists) {
    yield* Effect.logInfo(`kind cluster '${CLUSTER_NAME}' already exists; skipping create`)
    return
  }
  yield* Effect.logInfo(`creating kind cluster '${CLUSTER_NAME}' from ${CLUSTER_CONFIG}`)
  yield* exec(
    "kind",
    ["create", "cluster", "--name", CLUSTER_NAME, "--config", CLUSTER_CONFIG, "--wait", "120s"],
    { timeoutMs: 5 * 60 * 1000 },
  )
})

export const clusterDown = Effect.gen(function* () {
  const exists = yield* clusterExists
  if (!exists) {
    yield* Effect.logInfo(`kind cluster '${CLUSTER_NAME}' does not exist; nothing to delete`)
    return
  }
  yield* Effect.logInfo(`deleting kind cluster '${CLUSTER_NAME}'`)
  yield* exec("kind", ["delete", "cluster", "--name", CLUSTER_NAME], { timeoutMs: 60_000 })
})

export const nodeCount = Effect.gen(function* () {
  const { stdout } = yield* exec("kubectl", ["get", "nodes", "--no-headers", "-o", "name"])
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length
})
