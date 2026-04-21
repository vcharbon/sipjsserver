/**
 * CallControlClient service — HTTP client for the external call control API.
 *
 * Wraps POST /call/new (and future /call/failure, /call/refer) in typed
 * Effect operations using HttpClient + Schema decoding.
 */

import { Clock, Effect, Layer, Schema, ServiceMap } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { AppConfig } from "../config/AppConfig.js"
import { OverloadController } from "../b2bua/OverloadController.js"
import {
  NewCallResponse,
  CallFailureResponse,
  CallReferResponse,
  type NewCallRequest as NewCallRequestType,
  type NewCallResponse as NewCallResponseType,
  type CallFailureRequest as CallFailureRequestType,
  type CallFailureResponse as CallFailureResponseType,
  type CallReferRequest as CallReferRequestType,
  type CallReferResponse as CallReferResponseType
} from "./CallControlSchemas.js"

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class CallControlError extends Schema.TaggedErrorClass<CallControlError>()(
  "CallControlError",
  { reason: Schema.String }
) {}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CallControlClient extends ServiceMap.Service<
  CallControlClient,
  {
    readonly newCall: (req: NewCallRequestType) => Effect.Effect<NewCallResponseType, CallControlError>
    readonly callFailure: (req: CallFailureRequestType) => Effect.Effect<CallFailureResponseType, CallControlError>
    readonly callRefer: (req: CallReferRequestType) => Effect.Effect<CallReferResponseType, CallControlError>
  }
>()("@sipjsserver/CallControlClient") {
  static readonly layer = Layer.effect(
    CallControlClient,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const client = yield* HttpClient.HttpClient
      const overload = yield* OverloadController
      const baseUrl = config.callControlUrl

      const newCall = Effect.fnUntraced(function* (req: NewCallRequestType) {
        const startedAt = yield* Clock.currentTimeMillis
        const request = HttpClientRequest.post(`${baseUrl}/call/new`).pipe(
          HttpClientRequest.bodyJsonUnsafe(req)
        )
        const response = yield* client.execute(request).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(NewCallResponse)),
          Effect.tap((resp) =>
            Effect.currentSpan.pipe(
              Effect.tap((span) =>
                Effect.sync(() => {
                  span.attribute("http.response.action", resp.action)
                  if ("callback_context" in resp && typeof resp.callback_context === "string") {
                    span.attribute("http.response.callback_context", resp.callback_context.slice(0, 8))
                  }
                  if ("destination" in resp && resp.destination) {
                    const dest = resp.destination as { host: string; port?: number }
                    span.attribute("http.response.destination", `${dest.host}:${dest.port ?? 5060}`)
                  }
                })
              ),
              Effect.ignore
            )
          ),
          Effect.mapError((err) =>
            new CallControlError({ reason: `POST /call/new failed: ${err}` })
          )
        )
        const endedAt = yield* Clock.currentTimeMillis
        overload.observeRoutingApiLatency("new_call", endedAt - startedAt)
        return response
      })

      const callFailure = Effect.fnUntraced(function* (req: CallFailureRequestType) {
        const startedAt = yield* Clock.currentTimeMillis
        const request = HttpClientRequest.post(`${baseUrl}/call/failure`).pipe(
          HttpClientRequest.bodyJsonUnsafe(req)
        )
        const response = yield* client.execute(request).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(CallFailureResponse)),
          Effect.tap((resp) =>
            Effect.currentSpan.pipe(
              Effect.tap((span) =>
                Effect.sync(() => {
                  span.attribute("http.response.action", resp.action)
                })
              ),
              Effect.ignore
            )
          ),
          Effect.mapError((err) =>
            new CallControlError({ reason: `POST /call/failure failed: ${err}` })
          )
        )
        const endedAt = yield* Clock.currentTimeMillis
        overload.observeRoutingApiLatency("in_dialog", endedAt - startedAt)
        return response
      })

      const callRefer = Effect.fnUntraced(function* (req: CallReferRequestType) {
        const startedAt = yield* Clock.currentTimeMillis
        const request = HttpClientRequest.post(`${baseUrl}/call/refer`).pipe(
          HttpClientRequest.bodyJsonUnsafe(req)
        )
        const response = yield* client.execute(request).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(CallReferResponse)),
          Effect.tap((resp) =>
            Effect.currentSpan.pipe(
              Effect.tap((span) =>
                Effect.sync(() => {
                  span.attribute("http.response.action", resp.action)
                  if ("callback_context" in resp && typeof resp.callback_context === "string") {
                    span.attribute("http.response.callback_context", resp.callback_context.slice(0, 8))
                  }
                  if ("destination" in resp && resp.destination) {
                    const dest = resp.destination as { host: string; port?: number }
                    span.attribute("http.response.destination", `${dest.host}:${dest.port ?? 5060}`)
                  }
                })
              ),
              Effect.ignore
            )
          ),
          Effect.mapError((err) =>
            new CallControlError({ reason: `POST /call/refer failed: ${err}` })
          )
        )
        const endedAt = yield* Clock.currentTimeMillis
        overload.observeRoutingApiLatency("in_dialog", endedAt - startedAt)
        return response
      })

      return { newCall, callFailure, callRefer }
    })
  )
}
