/**
 * Unit tests for `FakeHttpFabric` (slice 1.2 of the failover-harness
 * plan). Covers:
 *
 *   - simple POST / GET round-trip through a registered router with
 *     JSON request body and JSON response,
 *   - `register` is finalizer-aware: scope close auto-deregisters,
 *   - "no router for host:port" surfaces as
 *     `HttpClientError(TransportError)`,
 *   - NDJSON long-poll streaming response with TestClock-driven
 *     heartbeat (composes a real `ReplLog` behind the fabric and
 *     verifies hello/caught_up/heartbeat frames round-trip).
 *
 * Connectivity-gate denial assertions are deferred to slice 1.3 when
 * `WorkerConnectivity` lands.
 */

import { describe, expect, it } from "@effect/vitest"
import {
  Duration,
  Effect,
  Fiber,
  Layer,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import {
  FakeHttpClientLayer,
  FakeHttpFabric,
  FakeHttpFabricLayer,
} from "./FakeHttpFabric.js"
import {
  AtomicWriter,
  type MemoryStore,
} from "../../src/replication/AtomicWriter.js"
import { EpochCounter } from "../../src/replication/EpochCounter.js"
import { PropagateStream } from "../../src/replication/PropagateStream.js"
import { ReplLog, addReplLogRoutes } from "../../src/replication/ReplLog.js"
import { WriteNotifier } from "../../src/replication/WriteNotifier.js"
import { PartitionedRelayStorage } from "../../src/cache/PartitionedRelayStorage.js"

const HOST = "worker-A.local"
const PORT = 8081

const ClientStack = FakeHttpClientLayer.pipe(
  Layer.provideMerge(FakeHttpFabricLayer),
)

// ---------------------------------------------------------------------------
// Echo helpers — small router with two routes used by the simple cases.
// ---------------------------------------------------------------------------

const echoRouterEffect = Effect.gen(function* () {
  const router = yield* HttpRouter.make
  yield* router.add(
    "GET",
    "/hello",
    Effect.succeed(
      HttpServerResponse.jsonUnsafe({ ok: true, route: "hello" }),
    ),
  )
  yield* router.add(
    "POST",
    "/echo",
    Effect.gen(function* () {
      // Echo the JSON body back. Schema-less read keeps the route
      // self-contained and exercises the request → server-request →
      // response → client-response round-trip.
      const req = yield* HttpServerRequest.HttpServerRequest
      const body = yield* req.json
      return HttpServerResponse.jsonUnsafe({ echoed: body })
    }),
  )
  return router
})

// ---------------------------------------------------------------------------
// ReplLog harness — real ReplLog behind the fabric for the streaming case.
// ---------------------------------------------------------------------------

const replLogHarness = (owner: string) => {
  const handle = PartitionedRelayStorage.makeMemoryApi()
  const sharedStore = handle.store
  const StorageLayer = Layer.sync(
    PartitionedRelayStorage,
    () => handle.api,
  )
  const ReadServices = Layer.mergeAll(
    WriteNotifier.layer,
    StorageLayer,
    PropagateStream.memoryLayerFromStore(sharedStore),
    EpochCounter.memoryLayerFromStore(sharedStore, owner),
  )
  const ReplStack = AtomicWriter.memoryLayerFromStore(sharedStore).pipe(
    Layer.provideMerge(ReadServices),
  )
  return {
    store: sharedStore as MemoryStore,
    layer: ReplLog.layer.pipe(Layer.provideMerge(ReplStack)),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FakeHttpFabric — basic round-trip", () => {
  it.effect("GET returns the registered route's response", () =>
    Effect.gen(function* () {
      const fabric = yield* FakeHttpFabric
      const client = yield* HttpClient.HttpClient
      const router = yield* echoRouterEffect
      yield* fabric.register(HOST, PORT, router)

      const resp = yield* client.execute(
        HttpClientRequest.get(`http://${HOST}:${PORT}/hello`),
      )
      expect(resp.status).toBe(200)
      const json = yield* resp.json
      expect(json).toEqual({ ok: true, route: "hello" })
    }).pipe(Effect.scoped, Effect.provide(ClientStack)),
  )

  it.effect("POST echoes JSON body back through the router", () =>
    Effect.gen(function* () {
      const fabric = yield* FakeHttpFabric
      const client = yield* HttpClient.HttpClient
      const router = yield* echoRouterEffect
      yield* fabric.register(HOST, PORT, router)

      const req = HttpClientRequest.post(
        `http://${HOST}:${PORT}/echo`,
      ).pipe(HttpClientRequest.bodyJsonUnsafe({ payload: 42 }))
      const resp = yield* client.execute(req)
      expect(resp.status).toBe(200)
      const json = yield* resp.json
      expect(json).toEqual({ echoed: { payload: 42 } })
    }).pipe(Effect.scoped, Effect.provide(ClientStack)),
  )

  it.effect("unknown host:port → HttpClientError(TransportError)", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const result = yield* Effect.result(
        client.execute(HttpClientRequest.get("http://nope.invalid:1234/x")),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.reason._tag).toBe("TransportError")
      }
    }).pipe(Effect.provide(ClientStack)),
  )
})

describe("FakeHttpFabric — registration lifecycle", () => {
  it.effect("scope close auto-deregisters the route", () =>
    Effect.gen(function* () {
      const fabric = yield* FakeHttpFabric
      const client = yield* HttpClient.HttpClient
      const router = yield* echoRouterEffect

      // Inner scope: register, hit the route, then let the scope close.
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* fabric.register(HOST, PORT, router)
          const resp = yield* client.execute(
            HttpClientRequest.get(`http://${HOST}:${PORT}/hello`),
          )
          expect(resp.status).toBe(200)
        }),
      )

      // After the inner scope closes the route should be gone.
      const present = yield* fabric.lookup(HOST, PORT)
      expect(present).toBeUndefined()

      const result = yield* Effect.result(
        client.execute(
          HttpClientRequest.get(`http://${HOST}:${PORT}/hello`),
        ),
      )
      expect(result._tag).toBe("Failure")
    }).pipe(Effect.provide(ClientStack)),
  )

  it.effect("re-register on the same host:port replaces the prior router", () =>
    Effect.gen(function* () {
      const fabric = yield* FakeHttpFabric
      const client = yield* HttpClient.HttpClient

      const routerA = yield* Effect.gen(function* () {
        const r = yield* HttpRouter.make
        yield* r.add(
          "GET",
          "/who",
          Effect.succeed(HttpServerResponse.jsonUnsafe({ id: "A" })),
        )
        return r
      })
      const routerB = yield* Effect.gen(function* () {
        const r = yield* HttpRouter.make
        yield* r.add(
          "GET",
          "/who",
          Effect.succeed(HttpServerResponse.jsonUnsafe({ id: "B" })),
        )
        return r
      })

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* fabric.register(HOST, PORT, routerA)
          // Register B in the same scope — overrides A.
          yield* fabric.register(HOST, PORT, routerB)
          const resp = yield* client.execute(
            HttpClientRequest.get(`http://${HOST}:${PORT}/who`),
          )
          const json = yield* resp.json
          expect(json).toEqual({ id: "B" })
        }),
      )
    }).pipe(Effect.provide(ClientStack)),
  )
})

describe("FakeHttpFabric — NDJSON long-poll over a real ReplLog", () => {
  it.effect("hello + caught_up + heartbeat frames pipe through the fake client under TestClock", () => {
    const { layer: replLogLayer } = replLogHarness("worker-A")

    // Build the router inside the ReplLog stack so addReplLogRoutes
    // can pick up the ReplLog service.
    const RouterLayer: Layer.Layer<HttpRouter.HttpRouter> = Layer.effect(
      HttpRouter.HttpRouter,
      Effect.gen(function* () {
        const router = yield* HttpRouter.make
        yield* addReplLogRoutes(router, {
          heartbeatInterval: "5 seconds",
          maxOpenDuration: "1 hour",
        })
        return router
      }),
    ).pipe(Layer.provide(replLogLayer))

    const TestStack = Layer.mergeAll(ClientStack, RouterLayer)

    return Effect.gen(function* () {
      const fabric = yield* FakeHttpFabric
      const client = yield* HttpClient.HttpClient
      const router = yield* HttpRouter.HttpRouter
      yield* fabric.register(HOST, PORT, router)

      const req = HttpClientRequest.get(
        `http://${HOST}:${PORT}/replog?caller=worker-B&since=0`,
      )
      const resp = yield* client.execute(req)
      expect(resp.status).toBe(200)

      // Take just enough to see the long-poll heartbeat: hello +
      // caught_up + 2 heartbeats.
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(resp.stream.pipe(Stream.take(4))),
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.seconds(11))
      const collected = yield* Fiber.join(fiber)

      const decoder = new TextDecoder()
      const frames = Array.from(collected)
        .map((u) => decoder.decode(u))
        .join("")
        .split("\n")
        .filter((s) => s.length > 0)
        .map((s) => JSON.parse(s) as { readonly type: string })
      const types = frames.map((f) => f.type)
      expect(types[0]).toBe("hello")
      expect(types).toContain("caught_up")
      expect(types.filter((t) => t === "heartbeat").length).toBe(2)
    }).pipe(Effect.scoped, Effect.provide(TestStack))
  })
})

