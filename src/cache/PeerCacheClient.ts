/**
 * PeerCacheClient — HTTP-backed implementation of `PeerCachePort`.
 *
 * Slice 3 of the HA-resilience plan. Resolves the destination peer
 * via `PeerEndpointResolver`, builds an HTTP request, sends it
 * through `HttpClient` from `effect/unstable/http`, maps wire errors
 * to `PeerWriteError` / `PeerScanError` so the dual-write path
 * (Slice 4) can apply its "throw away on failure" semantics
 * uniformly.
 *
 * No authentication — runs on the trusted intra-cluster LAN.
 */

import { Effect, Layer, Result, Schema, Stream } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import type { HttpClientError } from "effect/unstable/http"
import {
  PeerCachePort,
  PeerScanError,
  PeerWriteError,
  type WorkerOrdinal,
} from "./PeerCachePort.js"
import { PeerEndpointResolver } from "./PeerEndpointResolver.js"
import type {
  PartitionRole,
  ScanEntry,
} from "./PartitionedRelayStorage.js"

// ---------------------------------------------------------------------------
// Wire-level schemas
// ---------------------------------------------------------------------------

// Wire shape: msgpack bodies are sent as base64 since the HTTP scan
// envelope is JSON. Recovery-only path; not on the replication hot
// path (that's `/replog` via `ReplLogServer`).
const ScanResponse = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      callRef: Schema.String,
      body_b64: Schema.String,
      ttlSec: Schema.Int,
    })
  ),
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cachePath = (
  role: PartitionRole,
  owner: WorkerOrdinal,
  callRef: string,
  suffix: string = ""
): string =>
  `/cache/${role}/${owner}/calls/${encodeURIComponent(callRef)}${suffix}`

const scanPath = (role: PartitionRole, owner: WorkerOrdinal): string =>
  `/cache/${role}/${owner}/scan`

const writeErrorFromHttp = (
  peer: WorkerOrdinal,
  err: HttpClientError.HttpClientError
): PeerWriteError => {
  // v4 HttpClientError carries `reason._tag` covering Transport / Encode /
  // Decode / InvalidUrl / StatusCodeError / EmptyBody. Map TransportError
  // (network refused / DNS fail) separately; everything else lumps into
  // http_error.
  const tag = err.reason._tag
  const reason: PeerWriteError["reason"] =
    tag === "TransportError" ? "connection_refused" : "http_error"
  return new PeerWriteError({ peer, reason, detail: err.message })
}

const scanErrorFromHttp = (
  peer: WorkerOrdinal,
  err: HttpClientError.HttpClientError
): PeerScanError => {
  const tag = err.reason._tag
  const reason: PeerScanError["reason"] =
    tag === "TransportError" ? "connection_refused" : "stream_aborted"
  return new PeerScanError({ peer, reason, detail: err.message })
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

/**
 * Production-friendly default. Layers `HttpClient.layerFetch` (Node's
 * built-in fetch) under `PeerCachePort`, with `PeerEndpointResolver`
 * as the URL provider. Tests can compose with any other HttpClient
 * layer (e.g. one that points at a localhost test server).
 */
export const PeerCacheClientLayer = Layer.effect(
  PeerCachePort,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const resolver = yield* PeerEndpointResolver

    const baseUrl = (peer: WorkerOrdinal) =>
      resolver.resolve(peer).pipe(
        Effect.mapError(
          (e) =>
            new PeerWriteError(
              e.detail === undefined
                ? { peer, reason: "dns_failed" }
                : { peer, reason: "dns_failed", detail: e.detail }
            )
        )
      )

    const baseUrlScan = (peer: WorkerOrdinal) =>
      resolver.resolve(peer).pipe(
        Effect.mapError(
          (e) =>
            new PeerScanError(
              e.detail === undefined
                ? { peer, reason: "dns_failed" }
                : { peer, reason: "dns_failed", detail: e.detail }
            )
        )
      )

    const sendWrite = (
      peer: WorkerOrdinal,
      request: HttpClientRequest.HttpClientRequest
    ): Effect.Effect<void, PeerWriteError> =>
      Effect.gen(function* () {
        const result = yield* Effect.result(client.execute(request))
        if (Result.isFailure(result)) {
          return yield* writeErrorFromHttp(peer, result.failure)
        }
        const resp = result.success
        if (resp.status >= 200 && resp.status < 300) return
        return yield* new PeerWriteError({
          peer,
          reason: "http_error",
          detail: `status=${resp.status}`,
        })
      })

    const putCall: PeerCachePort["Service"]["putCall"] = ({
      peer,
      role,
      owner,
      callRef,
      state,
      indexes,
      ttlSec,
      callGen,
    }) =>
      Effect.gen(function* () {
        const url = yield* baseUrl(peer)
        const request = HttpClientRequest.put(
          `${url}${cachePath(role, owner, callRef)}`
        ).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            state_b64: state.toString("base64"),
            indexes,
            ttlSec,
            callGen: callGen ?? 0,
          }),
        )
        yield* sendWrite(peer, request)
      })

    const refreshCall: PeerCachePort["Service"]["refreshCall"] = ({
      peer,
      role,
      owner,
      callRef,
      indexes,
      ttlSec,
    }) =>
      Effect.gen(function* () {
        const url = yield* baseUrl(peer)
        const request = HttpClientRequest.post(
          `${url}${cachePath(role, owner, callRef, "/refresh")}`
        ).pipe(HttpClientRequest.bodyJsonUnsafe({ indexes, ttlSec }))
        yield* sendWrite(peer, request)
      })

    const deleteCall: PeerCachePort["Service"]["deleteCall"] = ({
      peer,
      role,
      owner,
      callRef,
      indexes,
    }) =>
      Effect.gen(function* () {
        const url = yield* baseUrl(peer)
        const request = HttpClientRequest.post(
          `${url}${cachePath(role, owner, callRef, "/delete")}`
        ).pipe(HttpClientRequest.bodyJsonUnsafe({ indexes }))
        yield* sendWrite(peer, request)
      })

    const scan: PeerCachePort["Service"]["scan"] = ({ peer, role, owner }) => {
      // Wrap the underlying request in an Effect that yields a Stream.
      const streamEffect: Effect.Effect<
        Stream.Stream<ScanEntry, PeerScanError>,
        PeerScanError
      > = Effect.gen(function* () {
        const url = yield* baseUrlScan(peer)
        const request = HttpClientRequest.get(
          `${url}${scanPath(role, owner)}`
        )
        const respResult = yield* Effect.result(client.execute(request))
        if (Result.isFailure(respResult)) {
          return Stream.fail(scanErrorFromHttp(peer, respResult.failure))
        }
        const resp = respResult.success
        if (resp.status < 200 || resp.status >= 300) {
          return Stream.fail(
            new PeerScanError({
              peer,
              reason: "stream_aborted",
              detail: `status=${resp.status}`,
            })
          )
        }
        const decoded = yield* Effect.result(
          HttpClientResponse.schemaBodyJson(ScanResponse)(resp)
        )
        if (Result.isFailure(decoded)) {
          return Stream.fail(
            new PeerScanError({
              peer,
              reason: "stream_aborted",
              detail: "malformed response body",
            })
          )
        }
        return Stream.fromIterable(
          decoded.success.items.map(
            (it): ScanEntry => ({
              callRef: it.callRef,
              body: Buffer.from(it.body_b64, "base64"),
              ttlSec: it.ttlSec,
            }),
          ),
        )
      })
      return Stream.unwrap(streamEffect)
    }

    return {
      putCall,
      refreshCall,
      deleteCall,
      scan,
    } satisfies PeerCachePort["Service"]
  })
)
