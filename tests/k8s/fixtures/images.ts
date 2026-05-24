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
// Keepalived sidecar for sip-front-proxy VIP HA (docs/lb-proxy-ha.md).
// Must match deploy/helm/sip-front-proxy values.yaml `vip.keepalivedImage`.
export const KEEPALIVED_IMAGE = "osixia/keepalived:2.0.20"
// SIPp test image. Built from tests/k8s/charts/sipp/Dockerfile and
// referenced by tests/k8s/charts/sipp/values.yaml + sippJob fixtures.
// Local build (single-arch), so plain `kind load docker-image` works.
export const SIPP_IMAGE_TAG = "sipp:dev"
export const SIPP_DOCKERFILE_DIR = resolve(REPO_ROOT, "tests/k8s/charts/sipp")

export const dockerBuild = Effect.gen(function* () {
  yield* Effect.logInfo(`docker build --network=host -t ${IMAGE_TAG} ${REPO_ROOT}`)
  // --network=host: buildkit's default network has intermittent DNS in
  // WSL2 — npm ci times out reaching registry.npmjs.org. Host network
  // bypasses buildkit's resolver and uses WSL2's own.
  yield* exec("docker", ["build", "--network=host", "-t", IMAGE_TAG, REPO_ROOT], {
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

export const dockerBuildSipp = Effect.gen(function* () {
  yield* Effect.logInfo(`docker build --network=host -t ${SIPP_IMAGE_TAG} ${SIPP_DOCKERFILE_DIR}`)
  yield* exec(
    "docker",
    ["build", "--network=host", "-t", SIPP_IMAGE_TAG, SIPP_DOCKERFILE_DIR],
    { timeoutMs: 10 * 60 * 1000 },
  )
})

export const kindLoadSipp = Effect.gen(function* () {
  yield* Effect.logInfo(
    `kind load docker-image ${SIPP_IMAGE_TAG} --name ${CLUSTER_NAME}`,
  )
  yield* exec(
    "kind",
    ["load", "docker-image", SIPP_IMAGE_TAG, "--name", CLUSTER_NAME],
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

/**
 * Pull and side-load the keepalived sidecar image into every kind node.
 * Same multi-arch workaround as `ensureRedisImage` — `kind load
 * docker-image` rejects multi-arch OCI indexes.
 */
export const ensureKeepalivedImage = Effect.gen(function* () {
  yield* Effect.logInfo(`docker pull ${KEEPALIVED_IMAGE}`)
  yield* exec("docker", ["pull", KEEPALIVED_IMAGE], { timeoutMs: 5 * 60 * 1000 })

  const tarPath = "/tmp/keepalived-sidecar-image.tar"
  yield* Effect.logInfo(`docker save ${KEEPALIVED_IMAGE} -> ${tarPath}`)
  yield* exec("docker", ["save", KEEPALIVED_IMAGE, "-o", tarPath], {
    timeoutMs: 5 * 60 * 1000,
  })

  const { stdout: nodesOut } = yield* exec(
    "kind",
    ["get", "nodes", "--name", CLUSTER_NAME],
  )
  const nodes = nodesOut
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  for (const node of nodes) {
    yield* Effect.logInfo(`loading ${KEEPALIVED_IMAGE} into ${node}`)
    yield* exec(
      "docker",
      ["cp", tarPath, `${node}:/keepalived-sidecar-image.tar`],
      { timeoutMs: 60_000 },
    )
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
        "/keepalived-sidecar-image.tar",
      ],
      { timeoutMs: 5 * 60 * 1000 },
    )
  }
})

export const buildAndLoad = Effect.gen(function* () {
  yield* dockerBuild
  yield* kindLoad
  yield* dockerBuildSipp
  yield* kindLoadSipp
  yield* ensureRedisImage
  yield* ensureKeepalivedImage
})

const kindNodes = Effect.gen(function* () {
  const { stdout } = yield* exec("kind", ["get", "nodes", "--name", CLUSTER_NAME])
  return stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0)
})

/**
 * Snapshot a node's containerd image store as a Set of `repo:tag` keys.
 * Each row is recorded twice — once with its full `docker.io/library/...`
 * prefix and once stripped — so callers can match against either form
 * (`sipp:dev` vs `docker.io/library/sipp:dev`).
 */
const nodeImageTags = (node: string) =>
  Effect.gen(function* () {
    const { stdout } = yield* exec("docker", ["exec", node, "crictl", "images"], {
      timeoutMs: 30_000,
    })
    const tags = new Set<string>()
    const lines = stdout.split("\n")
    for (const line of lines.slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 2) continue
      const repo = cols[0]
      const tag = cols[1]
      if (!repo || !tag || tag === "TAG") continue
      tags.add(`${repo}:${tag}`)
      const short = repo.replace(/^docker\.io\/library\//, "")
      if (short !== repo) tags.add(`${short}:${tag}`)
    }
    return tags
  })

const hostHasImage = (ref: string) =>
  exec("docker", ["image", "inspect", ref], { timeoutMs: 10_000 }).pipe(
    Effect.map(() => true),
    Effect.catchTag("ExecError", () => Effect.succeed(false)),
  )

/**
 * `docker save` once then `ctr images import` onto each named node.
 * Used for the multi-arch sidecars (redis, keepalived) where plain
 * `kind load docker-image` rejects the OCI index. Same mechanism as
 * `ensureRedisImage` / `ensureKeepalivedImage`, but scoped to the
 * subset of nodes that are actually missing the image.
 */
const tarImportToNodes = (
  imageRef: string,
  hostTarPath: string,
  nodeTarPath: string,
  nodes: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    if (nodes.length === 0) return
    if (!(yield* hostHasImage(imageRef))) {
      yield* Effect.logInfo(`docker pull ${imageRef}`)
      yield* exec("docker", ["pull", imageRef], { timeoutMs: 5 * 60 * 1000 })
    }
    yield* Effect.logInfo(`docker save ${imageRef} -> ${hostTarPath}`)
    yield* exec("docker", ["save", imageRef, "-o", hostTarPath], {
      timeoutMs: 5 * 60 * 1000,
    })
    for (const node of nodes) {
      yield* Effect.logInfo(`loading ${imageRef} into ${node}`)
      yield* exec("docker", ["cp", hostTarPath, `${node}:${nodeTarPath}`], {
        timeoutMs: 60_000,
      })
      yield* exec(
        "docker",
        ["exec", node, "ctr", "-n", "k8s.io", "images", "import", nodeTarPath],
        { timeoutMs: 5 * 60 * 1000 },
      )
    }
  })

/**
 * Precondition for `install-stack`: verify every kind node has the
 * four images the charts reference, and reload only what's missing.
 * Common after a host reboot — host docker still has the built tags
 * but the kind nodes' containerd store was wiped. Idempotent.
 */
export const ensureImagesLoaded = Effect.gen(function* () {
  const nodes = yield* kindNodes
  if (nodes.length === 0) return

  const perNode = new Map<string, Set<string>>()
  for (const node of nodes) {
    perNode.set(node, yield* nodeImageTags(node))
  }
  const missingNodesFor = (ref: string) =>
    nodes.filter((n) => !perNode.get(n)!.has(ref))

  const missingSipjs = missingNodesFor(IMAGE_TAG)
  if (missingSipjs.length > 0) {
    yield* Effect.logInfo(
      `${IMAGE_TAG} missing on ${missingSipjs.length}/${nodes.length} node(s); loading`,
    )
    if (!(yield* hostHasImage(IMAGE_TAG))) yield* dockerBuild
    yield* kindLoad
  }

  const missingSipp = missingNodesFor(SIPP_IMAGE_TAG)
  if (missingSipp.length > 0) {
    yield* Effect.logInfo(
      `${SIPP_IMAGE_TAG} missing on ${missingSipp.length}/${nodes.length} node(s); loading`,
    )
    if (!(yield* hostHasImage(SIPP_IMAGE_TAG))) yield* dockerBuildSipp
    yield* kindLoadSipp
  }

  yield* tarImportToNodes(
    REDIS_IMAGE,
    "/tmp/redis-sidecar-image.tar",
    "/redis-sidecar-image.tar",
    missingNodesFor(REDIS_IMAGE),
  )
  yield* tarImportToNodes(
    KEEPALIVED_IMAGE,
    "/tmp/keepalived-sidecar-image.tar",
    "/keepalived-sidecar-image.tar",
    missingNodesFor(KEEPALIVED_IMAGE),
  )
})
