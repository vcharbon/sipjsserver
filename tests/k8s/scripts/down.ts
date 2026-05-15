import { Effect, References } from "effect"
import { clusterDown } from "../fixtures/cluster.js"

Effect.runPromise(
  clusterDown.pipe(
    Effect.provideService(References.MinimumLogLevel, "Info"),
  ),
).then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  },
)
