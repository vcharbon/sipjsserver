import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { deleteSippJob, runSippJob } from "./fixtures/sippJob.js"

const NAMESPACE = process.env.K8S_TEST_NAMESPACE ?? "sip-test"

describe("k8s/smoke", () => {
  it.live(
    "5 calls round-trip through proxy → worker → mock-call-control → UAS",
    () =>
      Effect.gen(function* () {
        const jobName = `smoke-${Date.now().toString(36)}`
        try {
          const result = yield* runSippJob({
            namespace: NAMESPACE,
            name: jobName,
            scenario: "uac-basic.xml",
            target: "sip-front-proxy:5060",
            service: "test",
            calls: 5,
            callsPerSecond: 5,
            timeoutSec: 30,
            waitTimeoutSec: 60,
          })
          expect(result.jobStatus, `SIPp job did not succeed:\n${result.logs}`).toBe(
            "succeeded",
          )
          expect(result.stats.successful).toBe(5)
          expect(result.stats.failed).toBe(0)
          expect(result.stats.created).toBe(5)
        } finally {
          yield* deleteSippJob(NAMESPACE, jobName).pipe(Effect.ignore)
        }
      }),
    { timeout: 120_000 },
  )
})
