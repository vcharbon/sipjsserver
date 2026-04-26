import { Effect, LogLevel, References } from "effect"
import { clusterExists, clusterUp } from "../fixtures/cluster.js"

const program = Effect.gen(function* () {
  const exists = yield* clusterExists
  if (exists) {
    yield* Effect.logInfo(`kind cluster already up`)
    return
  }
  yield* clusterUp
})

Effect.runPromise(
  program.pipe(
    Effect.provideService(References.MinimumLogLevel, LogLevel.Info),
  ),
).then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  },
)
