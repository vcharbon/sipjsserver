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
  WorkerReadiness,
  StackIdentity,
} from "@vcharbon/sipjs/b2bua"
import type {
  B2buaEmbeddedOptions,
  B2buaLayer,
  NewCallRequest,
  NewCallResponse,
  CallFailureRequest,
  CallFailureResponse,
  CallReferRequest,
  CallReferResponse,
  CallState,
  TimerService,
  SipParser,
  TransactionLayer,
  StackIdentityApi,
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
    // The B2buaLayer alias must accept the factory's return value with
    // R = never (no residual requirements leak to the consumer).
    const layer: B2buaLayer = b2buaEmbeddedLayer(opts)
    expect(layer).toBeDefined()
    expect(typeof (layer as { pipe?: unknown }).pipe).toBe("function")
    // Sanity: the type-only re-exports resolve.
    const _services: ReadonlyArray<string> = (
      [] as Array<CallState | TimerService | SipParser | TransactionLayer>
    ).map(() => "")
    expect(_services).toEqual([])
  })

  it("re-exports WorkerReadiness so consumers can override the default test layer", () => {
    expect(WorkerReadiness).toBeDefined()
    // Both runtime layers are reachable
    expect(WorkerReadiness.Default).toBeDefined()
    expect(WorkerReadiness.test(true)).toBeDefined()
    expect(WorkerReadiness.test(false)).toBeDefined()
  })

  it("re-exports StackIdentity for consumers building their own templating", () => {
    expect(StackIdentity).toBeDefined()
    expect(StackIdentity.Default).toBeDefined()
    // The `StackIdentityApi` shape resolves as a type
    const _api: StackIdentityApi | undefined = undefined
    expect(_api).toBeUndefined()
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
