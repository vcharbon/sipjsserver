import { Effect } from "effect"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { exec } from "./exec.js"
import { CLUSTER_NAME } from "./cluster.js"

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(here, "../../..")

export const IMAGE_TAG = "sipjsserver:dev"
// Per-pod Redis sidecar — must be loadable into kind so air-gapped
// runs don't fall over. Keep this matched to deploy/helm/b2bua-worker
// values.yaml `redis.image.{repository,tag}`.
export const REDIS_IMAGE = "redis:7-alpine"

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

/**
 * Pull the Redis sidecar image and side-load it into every kind node.
 *
 * `kind load docker-image` fails on multi-arch images (the OCI image
 * index referenced by Docker Hub's `redis:7-alpine` makes
 * `ctr images import --all-platforms` reject the digest with "content
 * digest … not found"). The robust workaround is to `docker save` the
 * tag once into a tar, `docker cp` it onto each node's root, then
 * `ctr -n k8s.io images import` it without `--all-platforms` so only
 * the host architecture is imported. Idempotent — repeated imports
 * overwrite the same content-addressable layers.
 */
export const ensureRedisImage = Effect.gen(function* () {
  yield* Effect.logInfo(`docker pull ${REDIS_IMAGE}`)
  yield* exec("docker", ["pull", REDIS_IMAGE], { timeoutMs: 5 * 60 * 1000 })

  const tarPath = "/tmp/redis-sidecar-image.tar"
  yield* Effect.logInfo(`docker save ${REDIS_IMAGE} -> ${tarPath}`)
  yield* exec("docker", ["save", REDIS_IMAGE, "-o", tarPath], {
    timeoutMs: 5 * 60 * 1000,
  })

  // Discover every kind node belonging to this cluster.
  const { stdout: nodesOut } = yield* exec(
    "kind",
    ["get", "nodes", "--name", CLUSTER_NAME],
  )
  const nodes = nodesOut
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  for (const node of nodes) {
    yield* Effect.logInfo(`loading ${REDIS_IMAGE} into ${node}`)
    yield* exec("docker", ["cp", tarPath, `${node}:/redis-sidecar-image.tar`], {
      timeoutMs: 60_000,
    })
    yield* exec(
      "docker",
      [
        "exec",
        node,
        "ctr",
        "-n",
        "k8s.io",
        "images",
        "import",
        "/redis-sidecar-image.tar",
      ],
      { timeoutMs: 5 * 60 * 1000 },
    )
  }
})

export const buildAndLoad = Effect.gen(function* () {
  yield* dockerBuild
  yield* kindLoad
  yield* ensureRedisImage
})
