/**
 * peer-relay-roundtrip — end-to-end HTTP smoke test for Slice 3.
 *
 * Spins up a real Node HTTP server on an ephemeral port hosting the
 * `addPeerRelayRoutes` routes against an in-memory
 * `PartitionedRelayStorage.memoryLayer`. Then issues HTTP requests
 * via `PeerCacheClient` (FetchHttpClient) pointing at that server.
 *
 * Exercises every endpoint:
 *   - PUT /cache/:role/:owner/calls/:callRef
 *   - POST /cache/:role/:owner/calls/:callRef/refresh
 *   - POST /cache/:role/:owner/calls/:callRef/delete
 *   - GET  /cache/:role/:owner/scan
 *
 * Data path: client → real HTTP → router → storage → response.
 *
 * Note: this test uses `it.live` (real clock, real sockets) since
 * NodeHttpServer cannot be driven by TestClock.
 */

import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import {
  PartitionedRelayStorage,
} from "../../src/cache/PartitionedRelayStorage.js"
import {
  PeerCacheClientLayer,
} from "../../src/cache/PeerCacheClient.js"
import {
  PeerCachePort,
  WorkerOrdinal,
} from "../../src/cache/PeerCachePort.js"
import { PeerEndpointResolver } from "../../src/cache/PeerEndpointResolver.js"
import { addPeerRelayRoutes } from "../../src/cache/PeerRelay.ts"

const PEER = WorkerOrdinal("worker-test")

/** Routes layer. */
const RoutesLayer = HttpRouter.use((router) => addPeerRelayRoutes(router))

/**
 * Build the full server stack. Picks an ephemeral port (port: 0) and
 * exposes the actual port via `HttpServer.HttpServer.address` so the
 * client knows where to connect.
 */
const ServerLayer = HttpRouter.serve(RoutesLayer).pipe(
  Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 })),
  Layer.provide(PartitionedRelayStorage.memoryLayer)
)

/** Pull the bound port out of the running server. */
const boundPort = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer
  const addr = server.address
  if (addr._tag === "TcpAddress") return addr.port
  throw new Error("expected TcpAddress")
})

describe("PeerCacheClient ↔ PeerRelay HTTP round-trip", () => {
  it.live("PUT then scan returns the inserted call", () =>
    Effect.gen(function* () {
      const port = yield* boundPort
      const clientLayer = PeerCacheClientLayer.pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(
          PeerEndpointResolver.staticMap(
            new Map([[PEER, `http://127.0.0.1:${port}`]])
          )
        )
      )

      yield* Effect.gen(function* () {
        const port = yield* PeerCachePort
        // PUT
        yield* port.putCall({
          peer: PEER,
          role: "bak",
          owner: WorkerOrdinal("worker-A"),
          callRef: "call-1@host",
          state: '{"hello":"world"}',
          indexes: ["leg:abc|tag1"],
          ttlSec: 60,
        })
        // Scan returns the inserted entry
        const items = yield* Stream.runCollect(
          port.scan({
            peer: PEER,
            role: "bak",
            owner: WorkerOrdinal("worker-A"),
          })
        )
        const arr = Array.from(items)
        expect(arr).toHaveLength(1)
        expect(arr[0]!.callRef).toBe("call-1@host")
        // Slice 7c: PRS now stamps `written_at_ms` into the body for
        // T7 latency. Parse-and-check rather than byte-equality.
        const parsed = JSON.parse(arr[0]!.json) as Record<string, unknown>
        expect(parsed["hello"]).toBe("world")
      }).pipe(Effect.provide(clientLayer))
    }).pipe(Effect.provide(ServerLayer)) as Effect.Effect<void>
  )

  it.live("refresh + delete clears the partition", () =>
    Effect.gen(function* () {
      const port = yield* boundPort
      const clientLayer = PeerCacheClientLayer.pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(
          PeerEndpointResolver.staticMap(
            new Map([[PEER, `http://127.0.0.1:${port}`]])
          )
        )
      )

      yield* Effect.gen(function* () {
        const port = yield* PeerCachePort
        const args = {
          peer: PEER,
          role: "bak" as const,
          owner: WorkerOrdinal("worker-B"),
          callRef: "call-2",
        }
        yield* port.putCall({
          ...args,
          state: '{"v":1}',
          indexes: ["leg:x|y"],
          ttlSec: 30,
        })
        // Refresh extends TTL (no error)
        yield* port.refreshCall({
          ...args,
          indexes: ["leg:x|y"],
          ttlSec: 60,
        })
        // Delete removes everything
        yield* port.deleteCall({
          ...args,
          indexes: ["leg:x|y"],
        })
        const items = yield* Stream.runCollect(
          port.scan({
            peer: PEER,
            role: "bak",
            owner: WorkerOrdinal("worker-B"),
          })
        )
        expect(Array.from(items)).toHaveLength(0)
      }).pipe(Effect.provide(clientLayer))
    }).pipe(Effect.provide(ServerLayer)) as Effect.Effect<void>
  )
})
