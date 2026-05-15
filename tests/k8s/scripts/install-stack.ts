import { Effect, References } from "effect"
import {
  installProxy,
  installRedis,
  installSipp,
  installWorker,
} from "../fixtures/helm.js"
import { ensureImagesLoaded } from "../fixtures/images.js"

const ns = process.argv[2] ?? "sip-test"

const program = Effect.gen(function* () {
  yield* Effect.logInfo(`installing stack into namespace=${ns}`)
  // Reload any chart-referenced images that are missing from the kind
  // nodes' containerd store. Common after a host reboot — host docker
  // still has the tags but the nodes' image stores were wiped.
  yield* ensureImagesLoaded
  // Two Redis topologies coexist:
  //   - tests/k8s/charts/redis/  → cluster-shared, used ONLY by the
  //     CallLimiter (LimiterRedisClient → REDIS://redis:6379). Installed
  //     here, before the workers.
  //   - b2bua-worker chart's per-pod sidecar (redis.enabled=true) →
  //     holds call context (RedisClient → redis://localhost:6379).
  //     See docs/replication/call-cache-backup.md for the latency
  //     rationale behind keeping call context off any cross-pod hop.
  yield* installRedis(ns)
  yield* installSipp(ns)
  yield* installWorker(ns)
  yield* installProxy(ns)
  yield* Effect.logInfo("stack ready")
})

Effect.runPromise(
  program.pipe(Effect.provideService(References.MinimumLogLevel, "Info")),
).then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  },
)
