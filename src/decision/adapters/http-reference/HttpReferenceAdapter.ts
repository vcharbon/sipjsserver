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
 *   - Uncategorised failure                               → kind: "defect"
 *
 * Transient tier (timeout/network/http-5xx) → WARN + adapter_error_transient.
 * Permanent tier                            → ERROR + adapter_error_permanent.
 *
 * Per-call latency observation is still forwarded to OverloadController
 * (Tier 3 routing-API signal). Stack-level retries are intentionally absent;
 * retry / circuit-breaker logic is the adapter's responsibility.
 */

import { Clock, Effect, Layer } from "effect"
import {
  HttpClient,
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
  type CallDecisionErrorKind,
  type CallDecisionMethod,
} from "../../schemas/errors.js"
import { validateUpdateHeaders } from "../../validators/forbiddenHeaders.js"
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

interface TimeoutMarker {
  readonly _tag: "AdapterTimeout"
  readonly timeoutMs: number
}

/**
 * Classify an underlying failure into one of the CallDecisionErrorKinds.
 *
 * HttpClientError (v4 umbrella) carries `.reason` with a discriminator tag:
 *   StatusCodeError → 4xx/5xx split by response.status
 *   DecodeError / EmptyBodyError → schema-violation
 *   TransportError / EncodeError / InvalidUrlError → network
 *
 * SchemaError (from `schemaBodyJson`) → schema-violation.
 * TimeoutMarker (from withTimeout below) → timeout.
 */
function classifyError(method: CallDecisionMethod, err: unknown): CallDecisionError {
  const tag = typeof err === "object" && err !== null ? (err as { _tag?: string })._tag : undefined

  if (tag === "AdapterTimeout") {
    const t = err as TimeoutMarker
    return new CallDecisionError({
      kind: "timeout",
      adapterName: ADAPTER_NAME,
      method,
      detail: `timed out after ${t.timeoutMs}ms`,
      cause: err,
    })
  }

  if (tag === "HttpClientError") {
    const httpErr = err as {
      readonly reason: {
        readonly _tag: string
        readonly response?: { readonly status: number }
        readonly request?: { readonly url: string }
      }
    }
    const reason = httpErr.reason
    if (reason._tag === "StatusCodeError") {
      const status = reason.response?.status ?? 0
      const kind: CallDecisionErrorKind = status >= 500 ? "http-5xx" : "http-4xx"
      return new CallDecisionError({
        kind,
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
    // TransportError / EncodeError / InvalidUrlError
    return new CallDecisionError({
      kind: "network",
      adapterName: ADAPTER_NAME,
      method,
      detail: `request failed (${reason._tag})`,
      cause: err,
    })
  }

  if (tag === "SchemaError" || tag === "ParseError") {
    return new CallDecisionError({
      kind: "schema-violation",
      adapterName: ADAPTER_NAME,
      method,
      detail: `response body failed schema validation`,
      cause: err,
    })
  }

  return new CallDecisionError({
    kind: "defect",
    adapterName: ADAPTER_NAME,
    method,
    detail: `unexpected error: ${String(err)}`,
    cause: err,
  })
}

/**
 * Per-method hard timeout. On expiry the inner effect is abandoned and we
 * fail with a tagged marker that `classifyError` converts into
 * `CallDecisionError(kind: "timeout")`.
 */
function withTimeout<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeoutMs: number,
): Effect.Effect<A, E | TimeoutMarker, R> {
  return Effect.timeoutOrElse(effect, {
    duration: `${timeoutMs} millis`,
    orElse: (): Effect.Effect<never, TimeoutMarker> =>
      Effect.fail({ _tag: "AdapterTimeout", timeoutMs }),
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
     * Record the error in the dual-tier counter, log at the right level,
     * then re-fail with the classified error so callers see the ADT.
     */
    const recordAndLog = (err: CallDecisionError): Effect.Effect<never, CallDecisionError> => {
      const transient = isTransient(err)
      const counters = transient
        ? metrics.adapterErrors.transient
        : metrics.adapterErrors.permanent
      counters[err.method]++
      const logLine = `[adapter=${err.adapterName}] ${err.method} failed — kind=${err.kind}: ${err.detail}`
      const log = transient ? Effect.logWarning(logLine) : Effect.logError(logLine)
      return Effect.flatMap(log, () => Effect.fail(err))
    }

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
      decoder: (resp: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, unknown>,
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
          Effect.mapError((err) => classifyError(method, err)),
          Effect.catchTag("CallDecisionError", recordAndLog),
        )
        const endedAt = yield* Clock.currentTimeMillis
        overload.observeRoutingApiLatency(stage, endedAt - startedAt)
        return result
      })

    /** Screen `update_headers` on any response shape that carries the field. */
    const validateNewCall = (resp: NewCallResponseType): CallDecisionError | null =>
      resp.action === "route"
        ? validateUpdateHeaders(ADAPTER_NAME, "newCall", resp.update_headers)
        : null

    const validateCallFailure = (resp: CallFailureResponseType): CallDecisionError | null =>
      resp.action === "failover"
        ? validateUpdateHeaders(ADAPTER_NAME, "callFailure", resp.update_headers)
        : null

    const validateCallRefer = (resp: CallReferResponseType): CallDecisionError | null =>
      resp.action === "allow"
        ? validateUpdateHeaders(ADAPTER_NAME, "callRefer", resp.update_headers)
        : null

    const newCall = Effect.fnUntraced(function* (req: NewCallRequestType) {
      const wire = yield* runRequest(
        "newCall",
        "new_call",
        config.callControlNewCallTimeoutMs,
        req,
        "/call/new",
        HttpClientResponse.schemaBodyJson(WireNewCallResponse),
      )
      const canonical = translateNewCallResponse(wire, config)
      const violation = validateNewCall(canonical)
      if (violation !== null) return yield* recordAndLog(violation)
      return canonical
    })

    const callFailure = Effect.fnUntraced(function* (req: CallFailureRequestType) {
      const wire = yield* runRequest(
        "callFailure",
        "in_dialog",
        config.callControlFailureTimeoutMs,
        req,
        "/call/failure",
        HttpClientResponse.schemaBodyJson(WireCallFailureResponse),
      )
      const canonical = translateCallFailureResponse(wire, config)
      const violation = validateCallFailure(canonical)
      if (violation !== null) return yield* recordAndLog(violation)
      return canonical
    })

    const callRefer = Effect.fnUntraced(function* (req: CallReferRequestType) {
      const wire = yield* runRequest(
        "callRefer",
        "in_dialog",
        config.callControlReferTimeoutMs,
        req,
        "/call/refer",
        HttpClientResponse.schemaBodyJson(WireCallReferResponse),
      )
      const canonical = translateCallReferResponse(wire, config)
      const violation = validateCallRefer(canonical)
      if (violation !== null) return yield* recordAndLog(violation)
      return canonical
    })

    return { newCall, callFailure, callRefer }
  }),
)
