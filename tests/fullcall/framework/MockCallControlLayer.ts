/**
 * In-process CallDecisionEngine mock for e2e tests.
 *
 * Implements newCall/callFailure/callRefer directly using the same
 * response-building helpers the reference HTTP adapter serves — no
 * HTTP round-trip. Driven by an X-Api-Call SIP header in sip_headers.
 *
 * Mirrors the HttpReferenceAdapter's translate step so tests see the
 * same canonical enrichment (e.g. `features: FeatureActivations`) as
 * the real HTTP path.
 */

import { Effect, Layer } from "effect"
import { AppConfig } from "../../../src/config/AppConfig.js"
import { CallDecisionEngine } from "../../../src/decision/CallDecisionEngine.js"
import { CallDecisionError } from "../../../src/decision/schemas/errors.js"
import {
  mockNewCallResponse,
  mockCallFailureResponse,
  mockCallReferBehavior,
} from "../../../src/decision/adapters/http-reference/MockServer.js"
import {
  translateCallFailureResponse,
  translateCallReferResponse,
  translateNewCallResponse,
} from "../../../src/decision/adapters/http-reference/translate.js"
import type {
  WireCallFailureResponse,
  WireCallReferResponse,
  WireNewCallResponse,
} from "../../../src/decision/adapters/http-reference/schemas.js"

const ADAPTER_NAME = "mock"

export const MockCallControlLayer = Layer.effect(
  CallDecisionEngine,
  Effect.gen(function* () {
    const config = yield* AppConfig

    return {
      newCall: (req) =>
        Effect.try({
          try: () => translateNewCallResponse(
            mockNewCallResponse(req) as WireNewCallResponse,
            config,
          ),
          catch: (err) =>
            new CallDecisionError({
              kind: "schema-violation",
              adapterName: ADAPTER_NAME,
              method: "newCall",
              detail: `Mock newCall failed: ${err}`,
              cause: err,
            }),
        }),
      callFailure: (req) =>
        Effect.try({
          try: () => translateCallFailureResponse(
            mockCallFailureResponse(req) as WireCallFailureResponse,
            config,
          ),
          catch: (err) =>
            new CallDecisionError({
              kind: "schema-violation",
              adapterName: ADAPTER_NAME,
              method: "callFailure",
              detail: `Mock callFailure failed: ${err}`,
              cause: err,
            }),
        }),
      callRefer: (req) =>
        Effect.suspend(() => {
          let behavior
          try {
            behavior = mockCallReferBehavior(req)
          } catch (err) {
            return Effect.fail(
              new CallDecisionError({
                kind: "schema-violation",
                adapterName: ADAPTER_NAME,
                method: "callRefer",
                detail: `Mock callRefer failed: ${err}`,
                cause: err,
              }),
            )
          }
          switch (behavior.type) {
            case "respond":
              return Effect.succeed(
                translateCallReferResponse(behavior.body as WireCallReferResponse, config),
              )
            case "http500":
              return Effect.fail(
                new CallDecisionError({
                  kind: "http-5xx",
                  adapterName: ADAPTER_NAME,
                  method: "callRefer",
                  detail: "POST /call/refer failed: HTTP 500",
                  cause: undefined,
                }),
              )
            case "hang":
              return Effect.never
          }
        }),
    }
  }),
)
