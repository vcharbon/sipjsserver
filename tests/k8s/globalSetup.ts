import { Effect, LogLevel, References } from "effect"
import { clusterUp } from "./fixtures/cluster.js"
import { buildAndLoad } from "./fixtures/images.js"
import { installStack } from "./fixtures/sipNamespace.js"

// vitest globalSetup for vitest.config.k8s.ts. Runs once per vitest
// invocation, BEFORE any test file is loaded. Each step is idempotent
// (clusterUp checks `kind get clusters`, buildAndLoad relies on docker
// + kind layer dedup, installStack uses `helm upgrade --install`), so
// repeated runs are fast no-ops.
//
// Without this hook, running `npx vitest run -c vitest.config.k8s.ts
// <file>` against a fresh cluster would fail: every test file assumes
// the `sip-test` namespace already exists with the proxy + worker +
// sipp charts installed.

const NAMESPACE = process.env.K8S_TEST_NAMESPACE ?? "sip-test"

export default async function setup(): Promise<void> {
  const program = Effect.gen(function* () {
    yield* Effect.logInfo("k8s globalSetup: ensuring cluster + images + stack")
    yield* clusterUp
    yield* buildAndLoad
    yield* installStack(NAMESPACE)
    yield* Effect.logInfo("k8s globalSetup: ready")
  })

  await Effect.runPromise(
    program.pipe(
      Effect.provideService(References.MinimumLogLevel, LogLevel.Info),
    ),
  )
}
