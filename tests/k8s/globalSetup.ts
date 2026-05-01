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
// Set K8S_PROXY_HOST_MODE=1 to make the proxy advertise 127.0.0.1 so a
// host-resident SIPp UAC can drive it via the kind hostPort. Default
// (unset) installs the in-cluster mode the failover/drain suite needs.
const PROXY_HOST_MODE = process.env.K8S_PROXY_HOST_MODE === "1"

export default async function setup(): Promise<void> {
  const program = Effect.gen(function* () {
    yield* Effect.logInfo(
      `k8s globalSetup: ensuring cluster + images + stack` +
        (PROXY_HOST_MODE ? " [proxy=host-mode]" : ""),
    )
    yield* clusterUp
    yield* buildAndLoad
    yield* installStack(NAMESPACE, { proxyHostMode: PROXY_HOST_MODE })
    yield* Effect.logInfo("k8s globalSetup: ready")
  })

  await Effect.runPromise(
    program.pipe(
      Effect.provideService(References.MinimumLogLevel, LogLevel.Info),
    ),
  )
}
