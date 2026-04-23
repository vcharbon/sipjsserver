/**
 * HttpReferenceAdapter — reference HTTP implementation of CallDecisionEngine.
 *
 * Wraps POST /call/new, /call/failure, /call/refer in typed Effect
 * operations using HttpClient + Schema decoding.
 *
 * Error classification (see SplitServiceLogic.md §D11):
 *   - Per-method timeout exceeded                         → kind: "timeout"
 *   - Transport / DNS / connect refused / encode / url    → kind: "network"
 *   - HTTP 5xx                                            → kind: "http-5xx"
 *   - HTTP 4xx                                            → kind: "http-4xx"
 *   - Response body fails schema decode (or empty body)   → kind: "schema-violation"
 *   - `update_headers` names a forbidden / partial header → kind: "semantic-violation"
 *
 * Transient tier (timeout/network/http-5xx) → WARN + adapter_error_transient.
 * Permanent tier                            → ERROR + adapter_error_permanent.
 *
 * Per-call latency observation is still forwarded to OverloadController
 * (Tier 3 routing-API signal). Stack-level retries are intentionally absent;
 * retry / circuit-breaker logic is the adapter's responsibility.
 *
 * Note: the engine methods use `Effect.fnUntraced` deliberately — per-call
 * span creation is measured pressure under overload. The `CallDecisionError`
 * kind `"defect"` remains reserved in the ADT for call sites that need to
 * classify a failure as an adapter bug outside this pipeline; the typed
 * catchTags chain below is exhaustive over this adapter's known error union,
 * so true runtime defects propagate as Effect defects (a crash).
 */

import { Clock, Effect, Layer, Schema } from "effect"
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { AppConfig } from "../../../config/AppConfig.js"
import { OverloadController } from "../../../b2bua/OverloadController.js"
import { MetricsRegistry } from "../../../observability/MetricsRegistry.js"
import { CallDecisionEngine } from "../../CallDecisionEngine.js"
import {
  CallDecisionError,
  isTransient,
  type CallDecisionMethod,
} from "../../schemas/errors.js"
import { validateUpdateHeadersEffect } from "../../validators/forbiddenHeaders.js"
import {
  WireCallFailureResponse,
  WireCallReferResponse,
  WireNewCallResponse,
  type CallFailureRequestType,
  type CallFailureResponseType,
  type CallReferRequestType,
  type CallReferResponseType,
  type NewCallRequestType,
  type NewCallResponseType,
} from "./schemas.js"
import {
  translateCallFailureResponse,
  translateCallReferResponse,
  translateNewCallResponse,
} from "./translate.js"

const ADAPTER_NAME = "http-reference"

/**
 * Tagged error emitted by {@link withTimeout} on expiry. Lives as a proper
 * `Schema.TaggedErrorClass` so the catchTags pipeline below can narrow it.
 */
class AdapterTimeout extends Schema.TaggedErrorClass<AdapterTimeout>()(
  "AdapterTimeout",
  { timeoutMs: Schema.Number },
) {}

/**
 * Map an HttpClientError's inner `reason._tag` onto the adapter's typed ADT.
 * Uses the library-provided types from `effect/unstable/http` instead of
 * hand-written structural assertions.
 */
function fromHttpClientError(
  method: CallDecisionMethod,
  err: HttpClientError.HttpClientError,
): CallDecisionError {
  const reason = err.reason
  if (reason._tag === "StatusCodeError") {
    const status = reason.response.status
    return new CallDecisionError({
      kind: status >= 500 ? "http-5xx" : "http-4xx",
      adapterName: ADAPTER_NAME,
      method,
      detail: `HTTP ${status}`,
      cause: err,
    })
  }
  if (reason._tag === "DecodeError" || reason._tag === "EmptyBodyError") {
    return new CallDecisionError({
      kind: "schema-violation",
      adapterName: ADAPTER_NAME,
      method,
      detail: `response body failed to decode (${reason._tag})`,
      cause: err,
    })
  }
  // TransportError | EncodeError | InvalidUrlError
  return new CallDecisionError({
    kind: "network",
    adapterName: ADAPTER_NAME,
    method,
    detail: `request failed (${reason._tag})`,
    cause: err,
  })
}

/**
 * Per-method hard timeout. On expiry the inner effect is abandoned and we
 * fail with {@link AdapterTimeout}, which the catchTags chain converts into
 * `CallDecisionError(kind: "timeout")`.
 */
function withTimeout<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeoutMs: number,
): Effect.Effect<A, E | AdapterTimeout, R> {
  return Effect.timeoutOrElse(effect, {
    duration: `${timeoutMs} millis`,
    orElse: () => Effect.fail(new AdapterTimeout({ timeoutMs })),
  })
}

export const HttpReferenceAdapterLayer = Layer.effect(
  CallDecisionEngine,
  Effect.gen(function* () {
    const config = yield* AppConfig
    const client = yield* HttpClient.HttpClient
    const overload = yield* OverloadController
    const metrics = yield* MetricsRegistry
    const baseUrl = config.callControlUrl

    /**
     * Observe a `CallDecisionError`: bump the right counter and emit a log
     * line at the tier-appropriate level. Pure side effect — does NOT re-fail
     * so callers attach it via `Effect.tapError` and let the error keep
     * flowing through the channel.
     */
    const recordAndLog = (err: CallDecisionError): Effect.Effect<void> =>
      Effect.gen(function* () {
        const transient = isTransient(err)
        const counters = transient
          ? metrics.adapterErrors.transient
          : metrics.adapterErrors.permanent
        yield* Effect.sync(() => {
          counters[err.method]++
        })
        const line = `[adapter=${err.adapterName}] ${err.method} failed — kind=${err.kind}: ${err.detail}`
        yield* transient ? Effect.logWarning(line) : Effect.logError(line)
      })

    /**
     * Execute a single lifecycle HTTP call. Callers decode with a wire
     * schema, then translate + canonical-validate themselves — that keeps
     * the Effect here ignorant of canonical shapes.
     */
    const runRequest = <A>(
      method: CallDecisionMethod,
      stage: "new_call" | "in_dialog",
      timeoutMs: number,
      body: unknown,
      path: string,
      decoder: (
        resp: HttpClientResponse.HttpClientResponse,
      ) => Effect.Effect<A, HttpClientError.HttpClientError | Schema.SchemaError>,
    ): Effect.Effect<A, CallDecisionError> =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        const request = HttpClientRequest.post(`${baseUrl}${path}`).pipe(
          HttpClientRequest.bodyJsonUnsafe(body),
        )
        const result = yield* withTimeout(
          Effect.flatMap(client.execute(request), decoder),
          timeoutMs,
        ).pipe(
          Effect.catchTags({
            AdapterTimeout: (e) =>
              Effect.fail(
                new CallDecisionError({
                  kind: "timeout",
                  adapterName: ADAPTER_NAME,
                  method,
                  detail: `timed out after ${e.timeoutMs}ms`,
                  cause: e,
                }),
              ),
            HttpClientError: (e) => Effect.fail(fromHttpClientError(method, e)),
            SchemaError: (e) =>
              Effect.fail(
                new CallDecisionError({
                  kind: "schema-violation",
                  adapterName: ADAPTER_NAME,
                  method,
                  detail: `response body failed schema validation`,
                  cause: e,
                }),
              ),
          }),
        )
        const endedAt = yield* Clock.currentTimeMillis
        overload.observeRoutingApiLatency(stage, endedAt - startedAt)
        return result
      })

    /** Screen `update_headers` on any response shape that carries the field. */
    const validateNewCall = (
      resp: NewCallResponseType,
    ): Effect.Effect<void, CallDecisionError> =>
      resp.action === "route"
        ? validateUpdateHeadersEffect(ADAPTER_NAME, "newCall", resp.update_headers)
        : Effect.void

    const validateCallFailure = (
      resp: CallFailureResponseType,
    ): Effect.Effect<void, CallDecisionError> =>
      resp.action === "failover"
        ? validateUpdateHeadersEffect(ADAPTER_NAME, "callFailure", resp.update_headers)
        : Effect.void

    const validateCallRefer = (
      resp: CallReferResponseType,
    ): Effect.Effect<void, CallDecisionError> =>
      resp.action === "allow"
        ? validateUpdateHeadersEffect(ADAPTER_NAME, "callRefer", resp.update_headers)
        : Effect.void

    const newCall = Effect.fnUntraced(
      function* (req: NewCallRequestType) {
        const wire = yield* runRequest(
          "newCall",
          "new_call",
          config.callControlNewCallTimeoutMs,
          req,
          "/call/new",
          HttpClientResponse.schemaBodyJson(WireNewCallResponse),
        )
        const canonical = translateNewCallResponse(wire, config)
        yield* validateNewCall(canonical)
        return canonical
      },
      Effect.tapError(recordAndLog),
    )

    const callFailure = Effect.fnUntraced(
      function* (req: CallFailureRequestType) {
        const wire = yield* runRequest(
          "callFailure",
          "in_dialog",
          config.callControlFailureTimeoutMs,
          req,
          "/call/failure",
          HttpClientResponse.schemaBodyJson(WireCallFailureResponse),
        )
        const canonical = translateCallFailureResponse(wire, config)
        yield* validateCallFailure(canonical)
        return canonical
      },
      Effect.tapError(recordAndLog),
    )

    const callRefer = Effect.fnUntraced(
      function* (req: CallReferRequestType) {
        const wire = yield* runRequest(
          "callRefer",
          "in_dialog",
          config.callControlReferTimeoutMs,
          req,
          "/call/refer",
          HttpClientResponse.schemaBodyJson(WireCallReferResponse),
        )
        const canonical = translateCallReferResponse(wire, config)
        yield* validateCallRefer(canonical)
        return canonical
      },
      Effect.tapError(recordAndLog),
    )

    return { newCall, callFailure, callRefer }
  }),
)
