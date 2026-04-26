/**
 * PeerRelay — HTTP routes that expose this pod's
 * `PartitionedRelayStorage` to peer pods.
 *
 * Slice 3 of the HA-resilience plan. See plan D10 for the wire
 * format. No authentication — runs on the trusted intra-cluster LAN
 * with sidecar Redis bound to 127.0.0.1.
 *
 * Path scheme:
 *
 *   PUT    /cache/:role/:owner/calls/:callRef            (body: { state, indexes, ttlSec })
 *   POST   /cache/:role/:owner/calls/:callRef/refresh    (body: { indexes, ttlSec })
 *   POST   /cache/:role/:owner/calls/:callRef/delete     (body: { indexes })
 *   GET    /cache/:role/:owner/scan                      (response: { items: [{callRef, json, ttlSec}] })
 *
 * `:callRef` is `encodeURIComponent`-encoded by the client (callRef
 * contains `@` and other SIP-grammar chars). The router does its own
 * decoding on extraction.
 */

import { Effect, Result, Schema, Stream } from "effect"
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import {
  PartitionedRelayStorage,
  type PartitionRole,
} from "./PartitionedRelayStorage.js"

// ---------------------------------------------------------------------------
// Body schemas
// ---------------------------------------------------------------------------

const PutCallBody = Schema.Struct({
  state: Schema.String,
  indexes: Schema.Array(Schema.String),
  ttlSec: Schema.Int,
})

const RefreshCallBody = Schema.Struct({
  indexes: Schema.Array(Schema.String),
  ttlSec: Schema.Int,
})

const DeleteCallBody = Schema.Struct({
  indexes: Schema.Array(Schema.String),
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const parseRole = (raw: string | undefined): PartitionRole | null => {
  if (raw === "pri" || raw === "bak") return raw as PartitionRole
  return null
}

const badRequest = (reason: string) =>
  Effect.succeed(HttpServerResponse.jsonUnsafe({ error: reason }, { status: 400 }))

const internalError = (reason: string) =>
  Effect.succeed(HttpServerResponse.jsonUnsafe({ error: reason }, { status: 500 }))

const noContent = HttpServerResponse.empty({ status: 204 })

// ---------------------------------------------------------------------------
// Public route registration
// ---------------------------------------------------------------------------

/**
 * Register the relay's routes on the supplied router. Call this
 * inside an `HttpRouter.use(...)` callback in the host server's
 * layer (e.g. alongside `addCallControlRoutes` in StatusServer).
 */
export const addPeerRelayRoutes = (
  router: HttpRouter.HttpRouter
): Effect.Effect<void, never, PartitionedRelayStorage> =>
  Effect.gen(function* () {
    const storage = yield* PartitionedRelayStorage

    // ── PUT /cache/:role/:owner/calls/:callRef ──────────────────────────
    yield* router.add(
      "PUT",
      "/cache/:role/:owner/calls/:callRef",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const role = parseRole(params["role"])
        const owner = params["owner"]
        const callRefRaw = params["callRef"]
        if (role === null || owner === undefined || callRefRaw === undefined) {
          return HttpServerResponse.jsonUnsafe(
            { error: "invalid path params" },
            { status: 400 }
          )
        }
        const callRef = decodeURIComponent(callRefRaw)
        const bodyResult = yield* Effect.result(
          HttpServerRequest.schemaBodyJson(PutCallBody)
        )
        if (Result.isFailure(bodyResult)) return yield* badRequest("malformed body")
        const body = bodyResult.success
        const writeResult = yield* Effect.result(
          storage.putCall(
            role,
            owner,
            callRef,
            body.state,
            body.indexes,
            body.ttlSec
          )
        )
        if (Result.isFailure(writeResult)) {
          return yield* internalError(writeResult.failure.reason)
        }
        return noContent
      })
    )

    // ── POST /cache/:role/:owner/calls/:callRef/refresh ─────────────────
    yield* router.add(
      "POST",
      "/cache/:role/:owner/calls/:callRef/refresh",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const role = parseRole(params["role"])
        const owner = params["owner"]
        const callRefRaw = params["callRef"]
        if (role === null || owner === undefined || callRefRaw === undefined) {
          return HttpServerResponse.jsonUnsafe(
            { error: "invalid path params" },
            { status: 400 }
          )
        }
        const callRef = decodeURIComponent(callRefRaw)
        const bodyResult = yield* Effect.result(
          HttpServerRequest.schemaBodyJson(RefreshCallBody)
        )
        if (Result.isFailure(bodyResult)) return yield* badRequest("malformed body")
        const body = bodyResult.success
        const writeResult = yield* Effect.result(
          storage.refreshCall(role, owner, callRef, body.indexes, body.ttlSec)
        )
        if (Result.isFailure(writeResult)) {
          return yield* internalError(writeResult.failure.reason)
        }
        return noContent
      })
    )

    // ── POST /cache/:role/:owner/calls/:callRef/delete ──────────────────
    yield* router.add(
      "POST",
      "/cache/:role/:owner/calls/:callRef/delete",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const role = parseRole(params["role"])
        const owner = params["owner"]
        const callRefRaw = params["callRef"]
        if (role === null || owner === undefined || callRefRaw === undefined) {
          return HttpServerResponse.jsonUnsafe(
            { error: "invalid path params" },
            { status: 400 }
          )
        }
        const callRef = decodeURIComponent(callRefRaw)
        const bodyResult = yield* Effect.result(
          HttpServerRequest.schemaBodyJson(DeleteCallBody)
        )
        if (Result.isFailure(bodyResult)) return yield* badRequest("malformed body")
        const body = bodyResult.success
        const writeResult = yield* Effect.result(
          storage.deleteCall(role, owner, callRef, body.indexes)
        )
        if (Result.isFailure(writeResult)) {
          return yield* internalError(writeResult.failure.reason)
        }
        return noContent
      })
    )

    // ── GET /cache/:role/:owner/scan ────────────────────────────────────
    // Buffers all entries server-side (with `Effect.yieldNow` between
    // SCAN batches inside `storage.scanCalls`) and emits one JSON
    // response. Switching to chunked NDJSON is a future optimization;
    // the critical "no peer Redis starvation" property is already
    // delivered by the per-batch yields inside `scanCalls`.
    yield* router.add(
      "GET",
      "/cache/:role/:owner/scan",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const role = parseRole(params["role"])
        const owner = params["owner"]
        if (role === null || owner === undefined) {
          return yield* badRequest("invalid path params")
        }
        const collected = yield* Effect.result(
          Stream.runCollect(storage.scanCalls(role, owner))
        )
        if (Result.isFailure(collected)) {
          return yield* internalError(collected.failure.reason)
        }
        return HttpServerResponse.jsonUnsafe({
          items: Array.from(collected.success),
        })
      })
    )
  })
