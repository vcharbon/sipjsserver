/**
 * Mock CallControlClient layer for e2e tests.
 *
 * Implements newCall/callFailure directly using the same response-building
 * logic as MockCallControlServer, but without any HTTP round-trip.
 * Reads X-Api-Call from sip_headers to drive routing decisions.
 */

import { Effect, Layer } from "effect"
import { CallControlClient, CallControlError } from "../../../src/http/CallControlClient.js"
import { mockNewCallResponse, mockCallFailureResponse } from "../../../src/http/MockCallControlServer.js"

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
})
