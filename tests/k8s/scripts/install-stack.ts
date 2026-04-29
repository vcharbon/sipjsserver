import { Effect, LogLevel, References } from "effect"
import {
  installProxy,
  installSipp,
  installWorker,
} from "../fixtures/helm.js"

const ns = process.argv[2] ?? "sip-test"

const program = Effect.gen(function* () {
  yield* Effect.logInfo(`installing stack into namespace=${ns}`)
  // No standalone Redis install: each b2bua-worker pod ships its own
  // Redis sidecar (chart `redis.enabled=true`). See
  // docs/replication/call-cache-backup.md §2.
  yield* installSipp(ns)
  yield* installWorker(ns)
  yield* installProxy(ns)
  yield* Effect.logInfo("stack ready")
})

Effect.runPromise(
  program.pipe(Effect.provideService(References.MinimumLogLevel, LogLevel.Info)),
).then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  },
)
