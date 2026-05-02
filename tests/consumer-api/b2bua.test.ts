/**
 * Consumer-API gate for `@vcharbon/sipjs/b2bua`.
 *
 * Verifies the public surface compiles and that `b2buaEmbeddedLayer`
 * accepts a consumer-supplied `CallDecisionEngine` Layer with the
 * documented method shapes. Does NOT actually launch a UDP listener —
 * that would require port allocation and takes us out of unit-test
 * territory; the live `tests/fullcall/` suites cover that.
 */

import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"

import {
  b2buaEmbeddedLayer,
  defaultEmbeddedAppConfig,
  CallDecisionEngine,
  CallDecisionError,
  isTransient,
  newCallSipStatus,
  AppConfig,
} from "@vcharbon/sipjs/b2bua"
import type {
  B2buaEmbeddedOptions,
  NewCallRequest,
  NewCallResponse,
  CallFailureRequest,
  CallFailureResponse,
  CallReferRequest,
  CallReferResponse,
} from "@vcharbon/sipjs/b2bua"

const trivialCallDecision = Layer.succeed(CallDecisionEngine, {
  newCall: (_req: NewCallRequest) =>
    Effect.succeed({
      action: "route",
      destination: { host: "10.0.1.5", port: 5060 },
    } as NewCallResponse),
  callFailure: (_req: CallFailureRequest) =>
    Effect.succeed({ action: "terminate" } as CallFailureResponse),
  callRefer: (_req: CallReferRequest) =>
    Effect.succeed({
      action: "reject",
      reject_code: 403,
    } as CallReferResponse),
})

describe("@vcharbon/sipjs/b2bua public surface", () => {
  it("b2buaEmbeddedLayer composes with a consumer CallDecisionEngine", () => {
    const opts: B2buaEmbeddedOptions = {
      callDecision: trivialCallDecision,
      config: { sipLocalPort: 35060 },
    }
    const layer = b2buaEmbeddedLayer(opts)
    // The returned layer must be a Layer — we don't launch it here.
    expect(layer).toBeDefined()
    expect(typeof (layer as { pipe?: unknown }).pipe).toBe("function")
  })

  it("default config is overridable via the config option", () => {
    expect(defaultEmbeddedAppConfig.workerServiceName).toBe("embedded-b2bua")
    expect(defaultEmbeddedAppConfig.sipLocalPort).toBe(5060)
    // AppConfig is re-exported as the Service Tag
    expect(AppConfig).toBeDefined()
  })

  it("re-exports the CallDecisionError helpers", () => {
    expect(typeof isTransient).toBe("function")
    expect(typeof newCallSipStatus).toBe("function")
    // Build a CallDecisionError instance to confirm the class is callable
    const err = new CallDecisionError({
      kind: "timeout",
      adapterName: "unit-test",
      method: "newCall",
      detail: "unit test",
      cause: undefined,
    })
    expect(err.kind).toBe("timeout")
    expect(isTransient(err)).toBe(true)
    expect(newCallSipStatus(err)).toBe(503)
  })
})
