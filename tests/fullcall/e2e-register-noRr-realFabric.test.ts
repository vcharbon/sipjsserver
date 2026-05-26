/**
 * E2E test — register + call against the kind-deployed SBC stack with
 * the front-proxy in NON-RECORD-ROUTING mode and an **all-real
 * single-fabric** topology.
 *
 * Topology diff vs `e2e-register-fakeExt-realCore.test.ts`:
 *   - The existing test uses fake `5.1.x.x` addresses for alice/bob and
 *     proxy(ext), with only proxy(core) on real UDP.
 *   - This test puts EVERY participant on real UDP at the docker bridge
 *     gateway IP, each on a distinct kernel-bound port. The proxy reuses
 *     the same `SignalingNetwork.realTracing` instance for both endpoints
 *     (single fabric) — `SignalingNetworkCore` is not provided.
 *   - The proxy runs with `recordRoute: false` so once the INVITE/200/ACK
 *     handshake completes, in-dialog ACK and BYE flow peer-to-peer via
 *     the b2bua's own Record-Route (not ours).
 *
 * Gated on `E2E_KIND=1` so the default `npm run test` doesn't depend on
 * docker / kind.
 */

import { describe, it } from "@effect/vitest"
import { afterAll, beforeAll } from "vitest"
import { Effect } from "effect"
import { k8sRegisterCallByeNoRr } from "../scenarios/registrar/k8s-register-call-bye-noRr.js"
import {
  createRegistrarTestProxyRunner,
  discoverHostReachableIp,
  flushHybridIndexReport,
  hybridProxyCoreDestination,
  SignalingNetwork,
  makeEventSequencer,
} from "../../src/test-harness/index.js"

const OUTPUT_DIR = "test-results/real-clock/registrarFrontProxy-noRr-kind"
const E2E_KIND_ENABLED = process.env.E2E_KIND === "1"
const CORE_PORT = parseInt(process.env.E2E_KIND_PROXY_CORE_NORR_PORT ?? "25082", 10)
const EXT_PORT = parseInt(process.env.E2E_KIND_PROXY_EXT_NORR_PORT ?? "25083", 10)
const ALICE_PORT = parseInt(process.env.E2E_KIND_NORR_ALICE_PORT ?? "26101", 10)
const BOB_PORT = parseInt(process.env.E2E_KIND_NORR_BOB_PORT ?? "26102", 10)

describe.skipIf(!E2E_KIND_ENABLED)(
  "E2E (real clock) — register + call no-RR, all-real single fabric",
  () => {
    let advertisedIp = ""

    beforeAll(async () => {
      advertisedIp = await Effect.runPromise(discoverHostReachableIp)
      console.log(
        `[hybrid-noRR] bridge gateway = ${advertisedIp}; ` +
          `proxy(ext)=${advertisedIp}:${EXT_PORT}, ` +
          `proxy(core)=${advertisedIp}:${CORE_PORT}, ` +
          `alice=${advertisedIp}:${ALICE_PORT}, ` +
          `bob=${advertisedIp}:${BOB_PORT}`,
      )
    })

    afterAll(() => flushHybridIndexReport(OUTPUT_DIR))

    const buildRunner = () => {
      // One sequencer shared across the (single) real-UDP fabric. The
      // runner forwards it to the layer so cross-event ordering on the
      // merged report is monotonic.
      const traceSequencer = makeEventSequencer()
      return createRegistrarTestProxyRunner({
        coreDestination: {
          host: process.env.E2E_KIND_PROXY_HOST ?? "172.20.255.250",
          port: parseInt(process.env.E2E_KIND_PROXY_PORT ?? "5060", 10),
        },
        advertisedIp,
        corePort: CORE_PORT,
        outputDir: OUTPUT_DIR,
        recordRoute: false,
        singleFabric: true,
        // Both proxy endpoints on real UDP, distinct ports so we can
        // bind two sockets on the bridge-gateway IP.
        extBind: { host: advertisedIp, port: EXT_PORT },
        extAdvertised: { host: advertisedIp, port: EXT_PORT },
        extNetworkLayer: SignalingNetwork.realTracing({ traceSequencer }),
        traceSequencer,
      })
    }

    it.live(
      "REGISTER + INVITE + BYE (alice ↔ proxy(ext)/(core) all-real ↔ k8s ↔ bob; no Record-Route)",
      () =>
        buildRunner()(
          k8sRegisterCallByeNoRr({
            proxyCoreAdvertised: hybridProxyCoreDestination(advertisedIp, CORE_PORT),
            aliceIp: advertisedIp,
            alicePort: ALICE_PORT,
            bobIp: advertisedIp,
            bobPort: BOB_PORT,
          }).toScenario(),
        ),
      { timeout: 60_000 },
    )
  },
)
