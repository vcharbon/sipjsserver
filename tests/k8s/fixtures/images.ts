import { Effect } from "effect"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { exec } from "./exec.js"
import { CLUSTER_NAME } from "./cluster.js"

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(here, "../../..")

export const IMAGE_TAG = "sipjsserver:dev"

export const dockerBuild = Effect.gen(function* () {
  yield* Effect.logInfo(`docker build -t ${IMAGE_TAG} ${REPO_ROOT}`)
  yield* exec("docker", ["build", "-t", IMAGE_TAG, REPO_ROOT], {
    timeoutMs: 10 * 60 * 1000,
  })
})

export const kindLoad = Effect.gen(function* () {
  yield* Effect.logInfo(`kind load docker-image ${IMAGE_TAG} --name ${CLUSTER_NAME}`)
  yield* exec(
    "kind",
    ["load", "docker-image", IMAGE_TAG, "--name", CLUSTER_NAME],
    { timeoutMs: 5 * 60 * 1000 },
  )
})

export const buildAndLoad = Effect.gen(function* () {
  yield* dockerBuild
  yield* kindLoad
})
