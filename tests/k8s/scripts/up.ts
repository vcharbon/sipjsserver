import { Effect, References } from "effect"
import { clusterUp } from "../fixtures/cluster.js"

Effect.runPromise(
  clusterUp.pipe(
    Effect.provideService(References.MinimumLogLevel, "Info"),
  ),
).then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  },
)
