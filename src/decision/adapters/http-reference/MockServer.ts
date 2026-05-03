/**
 * Mock Call Control HTTP route handlers (test infrastructure).
 *
 * Mock backend for the HTTP Reference Adapter — drives B2BUA behavior in
 * e2e tests via an X-Api-Call SIP header. NOT production routing logic.
 *
 * Registers three endpoints on the supplied HttpRouter:
 *   POST /call/new      → routing decision for inbound INVITEs
 *   POST /call/failure  → failure/failover decision
 *   POST /call/refer    → in-dialog REFER authorization
 *
 * Routing behaviour is driven by an `X-Api-Call` SIP header passed through
 * the `sip_headers` field of the request body. If absent, falls back to
 * default routing (route to 127.0.0.1:5666).
 *
 * X-Api-Call JSON format for /call/new:
 *   { action: "route", destination?, call_limiter?, on_failure? }
 *   { action: "reject", reject_code, reject_reason? }
 *
 * The `on_failure` field is encoded into callback_context so the /call/failure
 * handler can use it to determine failover vs terminate:
 *   { on_failure: "terminate" }
 *   { on_failure: "failover", destination: { host, port }, new_ruri? }
 */

import { Effect } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { randomUUID } from "node:crypto"
import {
  CallFailureRequest,
  CallReferRequest,
  NewCallRequest,
  type NewCallRequestType,
  type NewCallResponseType,
  type CallFailureRequestType,
  type CallFailureResponseType,
  type CallReferRequestType,
  type CallReferResponseType,
} from "./schemas.js"

// ── Shared helpers ────────────────────────────────────────────────────────────

const jsonResponse = (body: unknown, options?: { status?: number }) =>
  Effect.succeed(HttpServerResponse.jsonUnsafe(body, options))

const badRequest = (message: string) =>
  jsonResponse({ error: message }, { status: 400 })

// ── Pure response builders (used by both HTTP handlers and mock layer) ────────

/**
 * Build a NewCallResponse from a NewCallRequest, driven by X-Api-Call header.
 * Pure function — no Effect, no HTTP. Throws on invalid X-Api-Call JSON.
 */
export function mockNewCallResponse(body: NewCallRequestType): NewCallResponseType {
  const apiCallRaw = body.sip_headers?.["X-Api-Call"]
  if (apiCallRaw !== undefined && apiCallRaw !== null) {
    const instruction = JSON.parse(apiCallRaw) as Record<string, unknown>
    return buildApiCallResponse(body, instruction)
  }

  // Fallback: legacy dial-string pattern matching
  const userMatch = /^sip:([^@]+)@/.exec(body.ruri)
  const user = userMatch?.[1] ?? ""

  if (user.startsWith("+403")) {
    return {
      action: "reject" as const,
      reject_code: 403,
      reject_reason: "Forbidden"
    }
  }

  return {
    action: "route" as const,
    destination: { host: "127.0.0.1", port: 5666, transport: "udp" as const },
    new_ruri: `sip:${user}@127.0.0.1:5666`,
    update_headers: { "X-Random": randomUUID() }
  }
}

/**
 * Build a CallFailureResponse from a CallFailureRequest.
 * Pure function — parses callback_context for failover instructions.
 */
export function mockCallFailureResponse(body: CallFailureRequestType): CallFailureResponseType {
  if (body.callback_context !== undefined) {
    try {
      const instruction = JSON.parse(body.callback_context) as Record<string, unknown>

      if (instruction.action === "failover") {
        if (!instruction.destination) throw new Error("failover requires destination")
        const failoverResp: Record<string, unknown> = { action: "failover", destination: instruction.destination }
        if (instruction.new_ruri) failoverResp.new_ruri = instruction.new_ruri
        if (instruction.call_limiter) failoverResp.call_limiter = instruction.call_limiter
        if (instruction.update_headers) failoverResp.update_headers = instruction.update_headers
        if (instruction.on_next_failure !== undefined) {
          failoverResp.callback_context = JSON.stringify(instruction.on_next_failure)
        } else {
          failoverResp.callback_context = body.callback_context
        }
        if (instruction.relay_first_18x_to_180 !== undefined) {
          failoverResp.relay_first_18x_to_180 = instruction.relay_first_18x_to_180
        }
        return failoverResp as CallFailureResponseType
      }
    } catch {
      // Not JSON or no instruction — fall through to terminate
    }
  }
  return { action: "terminate" as const }
}

function buildApiCallResponse(body: NewCallRequestType, instruction: Record<string, unknown>): NewCallResponseType {
  const userMatch = /^sip:([^@]+)@/.exec(body.ruri)
  const user = userMatch?.[1] ?? ""

  if (instruction.action === "reject") {
    const reject: Record<string, unknown> = {
      action: "reject" as const,
      reject_code: (instruction.reject_code as number) ?? 403,
      reject_reason: (instruction.reject_reason as string) ?? "Rejected",
    }
    if (instruction.update_headers !== undefined) {
      reject.update_headers = instruction.update_headers
    }
    return reject as NewCallResponseType
  }

  // Default: action === "route"
  const dest = instruction.destination as { host?: string; port?: number } | undefined
  const response: Record<string, unknown> = {
    action: "route",
    destination: {
      host: dest?.host ?? "127.0.0.1",
      port: dest?.port ?? 5666,
      transport: "udp"
    },
    new_ruri: (instruction.new_ruri as string) ?? `sip:${user}@${dest?.host ?? "127.0.0.1"}:${dest?.port ?? 5666}`,
    update_headers: {
      "X-Random": randomUUID(),
      ...((instruction.update_headers as Record<string, string>) ?? {}),
    }
  }

  if (instruction.call_limiter !== undefined) {
    response.call_limiter = instruction.call_limiter
  }

  if (instruction.on_failure !== undefined) {
    response.callback_context = JSON.stringify(instruction.on_failure)
  }

  if (instruction.relay_first_18x_to_180 !== undefined) {
    response.relay_first_18x_to_180 = instruction.relay_first_18x_to_180
  }

  return response as NewCallResponseType
}

/**
 * Mock /call/refer behaviour — either respond, fail with 500, or hang.
 * Both the HTTP handler and the in-process mock layer branch on this result.
 */
export type MockReferBehavior =
  | { readonly type: "respond"; readonly body: CallReferResponseType }
  | { readonly type: "http500" }
  | { readonly type: "hang" }

/**
 * Decide how to respond to a /call/refer request based on X-Api-Call in
 * `sip_headers`. Pure — no Effect, no HTTP. Throws on invalid X-Api-Call JSON.
 *
 * Recognised keys:
 *   - `refer-reject-403`     → { action: "reject", reject_code: 403 }
 *   - `refer-http-500`       → mock HTTP 500 (transport-level error)
 *   - `refer-http-timeout`   → mock hangs indefinitely (transport-level stall)
 *   - `refer-allow-c`        → { action: "allow", destination, ... } (slice 5)
 *
 * Default (no X-Api-Call) → reject 603 (Declined).
 */
export function mockCallReferBehavior(body: CallReferRequestType): MockReferBehavior {
  const apiCallRaw = body.sip_headers?.["X-Api-Call"]
  if (apiCallRaw === undefined || apiCallRaw === null) {
    return {
      type: "respond",
      body: { action: "reject", reject_code: 603, reject_reason: "Declined" }
    }
  }

  const instruction = JSON.parse(apiCallRaw) as Record<string, unknown>
  const key = instruction.refer_key as string | undefined

  switch (key) {
    case "refer-reject-403":
      return {
        type: "respond",
        body: {
          action: "reject",
          reject_code: (instruction.reject_code as number) ?? 403,
          reject_reason: (instruction.reject_reason as string) ?? "Forbidden"
        }
      }
    case "refer-http-500":
      return { type: "http500" }
    case "refer-http-timeout":
      return { type: "hang" }
    case "refer-allow-c": {
      const dest = instruction.destination as { host?: string; port?: number } | undefined
      const response: Record<string, unknown> = {
        action: "allow",
        destination: {
          host: dest?.host ?? "127.0.0.1",
          port: dest?.port ?? 5667,
          transport: "udp",
        },
      }
      if (instruction.new_refer_to !== undefined) response.new_refer_to = instruction.new_refer_to
      if (instruction.update_headers !== undefined) response.update_headers = instruction.update_headers
      if (instruction.no_answer_timeout_sec !== undefined) response.no_answer_timeout_sec = instruction.no_answer_timeout_sec
      if (instruction.call_limiter !== undefined) response.call_limiter = instruction.call_limiter
      if (instruction.callback_context !== undefined) response.callback_context = instruction.callback_context
      if (instruction.relay_first_18x_to_180 !== undefined) {
        response.relay_first_18x_to_180 = instruction.relay_first_18x_to_180
      }
      return { type: "respond", body: response as CallReferResponseType }
    }
    default:
      return {
        type: "respond",
        body: { action: "reject", reject_code: 603, reject_reason: "Declined" }
      }
  }
}

// ── POST /call/new ────────────────────────────────────────────────────────────

const newCallHandler = HttpServerRequest.schemaBodyJson(NewCallRequest).pipe(
  Effect.matchEffect({
    onFailure: () => badRequest("Invalid request body"),
    onSuccess: (body) => {
      try {
        return jsonResponse(mockNewCallResponse(body))
      } catch {
        return badRequest("Invalid X-Api-Call JSON")
      }
    }
  })
)

// ── POST /call/failure ────────────────────────────────────────────────────────

const callFailureHandler = HttpServerRequest.schemaBodyJson(CallFailureRequest).pipe(
  Effect.matchEffect({
    onFailure: () => badRequest("Invalid request body"),
    onSuccess: (body) => jsonResponse(mockCallFailureResponse(body))
  })
)

// ── POST /call/refer ──────────────────────────────────────────────────────────

const callReferHandler = HttpServerRequest.schemaBodyJson(CallReferRequest).pipe(
  Effect.matchEffect({
    onFailure: () => badRequest("Invalid request body"),
    onSuccess: (body) => {
      let behavior: MockReferBehavior
      try {
        behavior = mockCallReferBehavior(body)
      } catch {
        return badRequest("Invalid X-Api-Call JSON")
      }
      switch (behavior.type) {
        case "respond":
          return jsonResponse(behavior.body)
        case "http500":
          return jsonResponse({ error: "Simulated upstream failure" }, { status: 500 })
        case "hang":
          // Never resolves — exercises HTTP client timeout / refer_subscription_expiry.
          return Effect.never
      }
    }
  })
)

// ── Route registration ────────────────────────────────────────────────────────

/**
 * Registers the call control routes on the given router.
 * Call this inside an HttpRouter.use() callback.
 */
export const addCallControlRoutes = (
  router: HttpRouter.HttpRouter
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    yield* router.add("POST", "/call/new", newCallHandler)
    yield* router.add("POST", "/call/failure", callFailureHandler)
    yield* router.add("POST", "/call/refer", callReferHandler)
  })
