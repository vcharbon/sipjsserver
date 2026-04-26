import { Effect, LogLevel, References } from "effect"
import { buildAndLoad } from "../fixtures/images.js"

Effect.runPromise(
  buildAndLoad.pipe(
    Effect.provideService(References.MinimumLogLevel, LogLevel.Info),
  ),
).then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  },
)
