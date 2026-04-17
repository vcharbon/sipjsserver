/**
 * Mock CallControlClient layer for e2e tests.
 *
 * Implements newCall/callFailure directly using the same response-building
 * logic as MockCallControlServer, but without any HTTP round-trip.
 * Reads X-Api-Call from sip_headers to drive routing decisions.
 */

import { Effect, Layer } from "effect"
import { CallControlClient, CallControlError } from "../../../src/http/CallControlClient.js"
import {
  mockNewCallResponse,
  mockCallFailureResponse,
  mockCallReferBehavior,
} from "../../../src/http/MockCallControlServer.js"

export const MockCallControlLayer = Layer.succeed(CallControlClient, {
  newCall: (req) =>
    Effect.try({
      try: () => mockNewCallResponse(req),
      catch: (err) => new CallControlError({ reason: `Mock newCall failed: ${err}` })
    }),
  callFailure: (req) =>
    Effect.try({
      try: () => mockCallFailureResponse(req),
      catch: (err) => new CallControlError({ reason: `Mock callFailure failed: ${err}` })
    }),
  callRefer: (req) =>
    Effect.suspend(() => {
      let behavior
      try {
        behavior = mockCallReferBehavior(req)
      } catch (err) {
        return Effect.fail(new CallControlError({ reason: `Mock callRefer failed: ${err}` }))
      }
      switch (behavior.type) {
        case "respond":
          return Effect.succeed(behavior.body)
        case "http500":
          return Effect.fail(new CallControlError({ reason: "POST /call/refer failed: HTTP 500" }))
        case "hang":
          return Effect.never
      }
    }),
})
