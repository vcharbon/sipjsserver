import { Effect, LogLevel, References } from "effect"
import {
  installProxy,
  installRedis,
  installSipp,
  installWorker,
} from "../fixtures/helm.js"

const ns = process.argv[2] ?? "sip-test"

const program = Effect.gen(function* () {
  yield* Effect.logInfo(`installing stack into namespace=${ns}`)
  yield* installRedis(ns)
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
