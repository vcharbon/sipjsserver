/**
 * Unit tests for the connectivity gate (slice 1.3 of the
 * failover-harness plan).
 *
 * Verifies both fabrics — `SignalingNetwork.simulated` UDP and
 * `FakeHttpFabric` HTTP — consult the `ConnectivityGate` Reference and
 * honor the mutations exposed by `WorkerConnectivity`:
 *
 *   - symmetric disconnect drops both directions,
 *   - asymmetric partition drops one direction only,
 *   - reconnect (and heal) restore delivery,
 *   - the default (no override) always allows.
 *
 * All scenarios run under TestClock — the simulated fabric forks transit
 * fibers that need a `TestClock.adjust(transitDelay)` before deliveries
 * surface, and the HTTP fabric is wholly synchronous w.r.t. the clock.
 */

import { describe, expect, it } from "@effect/vitest"
import {
  Duration,
  Effect,
  Layer,
} from "effect"
import { TestClock } from "effect/testing"
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerResponse,
} from "effect/unstable/http"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import {
  FakeHttpClientLayer,
  FakeHttpFabric,
  FakeHttpFabricLayer,
  fakeHttpClientLayerForSelf,
} from "./FakeHttpFabric.js"
import {
  WorkerConnectivity,
  WorkerConnectivityLayer,
} from "../../src/test-harness/internal/WorkerConnectivity.js"

// ---------------------------------------------------------------------------
// UDP fabric — SignalingNetwork.simulated
// ---------------------------------------------------------------------------

const TRANSIT_MS = 15
const SimulatedNetworkLayer = SignalingNetwork.simulated({
  transitDelayMs: TRANSIT_MS,
})

const A_ADDR = { ip: "10.0.0.1", port: 5060 }
const B_ADDR = { ip: "10.0.0.2", port: 5060 }

interface Endpoints {
  readonly a: import("../../src/sip/SignalingNetwork.js").UdpEndpoint
  readonly b: import("../../src/sip/SignalingNetwork.js").UdpEndpoint
}

const bindBoth = Effect.fn(function* () {
  const net = yield* SignalingNetwork
  const a = yield* net.bindUdp({ ip: A_ADDR.ip, port: A_ADDR.port, queueMax: 4 })
  const b = yield* net.bindUdp({ ip: B_ADDR.ip, port: B_ADDR.port, queueMax: 4 })
  return { a, b } satisfies Endpoints
})

const sendAndPoll = Effect.fn(function* (
  endpoints: Endpoints,
  direction: "a-to-b" | "b-to-a",
  payload: string,
) {
  const sender = direction === "a-to-b" ? endpoints.a : endpoints.b
  const recipient = direction === "a-to-b" ? endpoints.b : endpoints.a
  const dst = direction === "a-to-b" ? B_ADDR : A_ADDR
  yield* sender.send(Buffer.from(payload), dst.port, dst.ip)
  yield* TestClock.adjust(Duration.millis(TRANSIT_MS + 1))
  return yield* recipient.poll()
})

describe("UDP connectivity gate — SignalingNetwork.simulated", () => {
  it.effect("default (no override) delivers the packet", () =>
    Effect.gen(function* () {
      const eps = yield* bindBoth()
      const got = yield* sendAndPoll(eps, "a-to-b", "hello")
      expect(got).not.toBeNull()
      expect(got!.raw.toString()).toBe("hello")
    }).pipe(Effect.scoped, Effect.provide(SimulatedNetworkLayer)),
  )

  it.effect("disconnect(B) drops a packet sent to B", () =>
    Effect.gen(function* () {
      const eps = yield* bindBoth()
      const conn = yield* WorkerConnectivity
      yield* conn.bind("worker-a", A_ADDR)
      yield* conn.bind("worker-b", B_ADDR)
      yield* conn.disconnect("worker-b")

      const got = yield* sendAndPoll(eps, "a-to-b", "drop-me")
      expect(got).toBeNull()
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(SimulatedNetworkLayer, WorkerConnectivityLayer)),
    ),
  )

  it.effect("disconnect(A) drops a packet sent FROM A (outbound flag)", () =>
    Effect.gen(function* () {
      const eps = yield* bindBoth()
      const conn = yield* WorkerConnectivity
      yield* conn.bind("worker-a", A_ADDR)
      yield* conn.bind("worker-b", B_ADDR)
      yield* conn.disconnect("worker-a")

      const got = yield* sendAndPoll(eps, "a-to-b", "drop-me")
      expect(got).toBeNull()
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(SimulatedNetworkLayer, WorkerConnectivityLayer)),
    ),
  )

  it.effect("asymmetric partition: A→B drops, B→A delivers", () =>
    Effect.gen(function* () {
      const eps = yield* bindBoth()
      const conn = yield* WorkerConnectivity
      yield* conn.bind("worker-a", A_ADDR)
      yield* conn.bind("worker-b", B_ADDR)
      yield* conn.partition({
        from: "worker-a",
        to: "worker-b",
        direction: "from-to",
      })

      const aToB = yield* sendAndPoll(eps, "a-to-b", "a-to-b")
      expect(aToB).toBeNull()

      const bToA = yield* sendAndPoll(eps, "b-to-a", "b-to-a")
      expect(bToA).not.toBeNull()
      expect(bToA!.raw.toString()).toBe("b-to-a")
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(SimulatedNetworkLayer, WorkerConnectivityLayer)),
    ),
  )

  it.effect("reconnect restores delivery; heal clears partition rules", () =>
    Effect.gen(function* () {
      const eps = yield* bindBoth()
      const conn = yield* WorkerConnectivity
      yield* conn.bind("worker-a", A_ADDR)
      yield* conn.bind("worker-b", B_ADDR)
      yield* conn.disconnect("worker-b")
      yield* conn.partition({
        from: "worker-a",
        to: "worker-b",
        direction: "both",
      })

      const blocked = yield* sendAndPoll(eps, "a-to-b", "blocked")
      expect(blocked).toBeNull()

      // `reconnect` flips inbound/outbound but leaves partitions
      // intact — packet still blocked.
      yield* conn.reconnect("worker-b")
      const stillBlocked = yield* sendAndPoll(eps, "a-to-b", "still-blocked")
      expect(stillBlocked).toBeNull()

      // `heal` removes the partition; delivery succeeds.
      yield* conn.heal("worker-a", "worker-b")
      const delivered = yield* sendAndPoll(eps, "a-to-b", "ok")
      expect(delivered).not.toBeNull()
      expect(delivered!.raw.toString()).toBe("ok")
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(SimulatedNetworkLayer, WorkerConnectivityLayer)),
    ),
  )

  it.effect("inner-scope unbind: outer send flows again under default gate", () =>
    Effect.gen(function* () {
      const eps = yield* bindBoth()
      const conn = yield* WorkerConnectivity
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* conn.bind("worker-a", A_ADDR)
          yield* conn.bind("worker-b", B_ADDR)
          yield* conn.disconnect("worker-b")
          const dropped = yield* sendAndPoll(eps, "a-to-b", "blocked")
          expect(dropped).toBeNull()
        }),
      )
      // Bindings released. Default gate is "always allow"; both
      // endpoints are now anonymous so the packet flows.
      const delivered = yield* sendAndPoll(eps, "a-to-b", "free")
      expect(delivered).not.toBeNull()
      expect(delivered!.raw.toString()).toBe("free")
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(SimulatedNetworkLayer, WorkerConnectivityLayer)),
    ),
  )
})

// ---------------------------------------------------------------------------
// HTTP fabric — FakeHttpFabric
// ---------------------------------------------------------------------------

const HOST_A = "worker-a.local"
const PORT_A = 8081
const HOST_B = "worker-b.local"
const PORT_B = 8082

const okRouter = Effect.gen(function* () {
  const r = yield* HttpRouter.make
  yield* r.add(
    "GET",
    "/ping",
    Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: true })),
  )
  return r
})

const HttpStack = Layer.merge(
  FakeHttpClientLayer.pipe(Layer.provideMerge(FakeHttpFabricLayer)),
  WorkerConnectivityLayer,
)

const httpStackForSelf = (selfAddr: {
  readonly ip: string
  readonly port: number
}) =>
  Layer.merge(
    fakeHttpClientLayerForSelf(selfAddr).pipe(
      Layer.provideMerge(FakeHttpFabricLayer),
    ),
    WorkerConnectivityLayer,
  )

describe("HTTP connectivity gate — FakeHttpFabric", () => {
  it.effect("default (no override) succeeds", () =>
    Effect.gen(function* () {
      const fabric = yield* FakeHttpFabric
      const client = yield* HttpClient.HttpClient
      yield* fabric.register(HOST_B, PORT_B, yield* okRouter)

      const resp = yield* client.execute(
        HttpClientRequest.get(`http://${HOST_B}:${PORT_B}/ping`),
      )
      expect(resp.status).toBe(200)
    }).pipe(Effect.scoped, Effect.provide(HttpStack)),
  )

  it.effect("disconnect(B) → request to B fails with TransportError", () =>
    Effect.gen(function* () {
      const fabric = yield* FakeHttpFabric
      const client = yield* HttpClient.HttpClient
      const conn = yield* WorkerConnectivity
      yield* fabric.register(HOST_B, PORT_B, yield* okRouter)
      yield* conn.bind("worker-b", { ip: HOST_B, port: PORT_B })
      yield* conn.disconnect("worker-b")

      const result = yield* Effect.result(
        client.execute(
          HttpClientRequest.get(`http://${HOST_B}:${PORT_B}/ping`),
        ),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.reason._tag).toBe("TransportError")
      }
    }).pipe(Effect.scoped, Effect.provide(HttpStack)),
  )

  it.effect("asymmetric partition: A→B blocked, B→A allowed (with self-aware client)", () =>
    Effect.gen(function* () {
      const fabric = yield* FakeHttpFabric
      const client = yield* HttpClient.HttpClient
      const conn = yield* WorkerConnectivity
      yield* fabric.register(HOST_A, PORT_A, yield* okRouter)
      yield* fabric.register(HOST_B, PORT_B, yield* okRouter)
      yield* conn.bind("worker-a", { ip: HOST_A, port: PORT_A })
      yield* conn.bind("worker-b", { ip: HOST_B, port: PORT_B })
      yield* conn.partition({
        from: "worker-a",
        to: "worker-b",
        direction: "from-to",
      })

      // This client identifies as worker-A → A→B request blocked.
      const aToB = yield* Effect.result(
        client.execute(
          HttpClientRequest.get(`http://${HOST_B}:${PORT_B}/ping`),
        ),
      )
      expect(aToB._tag).toBe("Failure")

      // The reverse direction isn't partitioned. Same client
      // identifying as A → A reaches B's peer (B→A). Use a separate
      // self-as-B client.
      const bToA = yield* Effect.gen(function* () {
        const cB = yield* HttpClient.HttpClient
        return yield* cB.execute(
          HttpClientRequest.get(`http://${HOST_A}:${PORT_A}/ping`),
        )
      }).pipe(Effect.provide(httpStackForSelf({ ip: HOST_B, port: PORT_B })))
      expect(bToA.status).toBe(200)
    }).pipe(
      Effect.scoped,
      Effect.provide(httpStackForSelf({ ip: HOST_A, port: PORT_A })),
    ),
  )

  it.effect("reconnect restores; heal clears partition", () =>
    Effect.gen(function* () {
      const fabric = yield* FakeHttpFabric
      const client = yield* HttpClient.HttpClient
      const conn = yield* WorkerConnectivity
      yield* fabric.register(HOST_B, PORT_B, yield* okRouter)
      yield* conn.bind("worker-a", { ip: HOST_A, port: PORT_A })
      yield* conn.bind("worker-b", { ip: HOST_B, port: PORT_B })
      yield* conn.disconnect("worker-b")
      yield* conn.partition({
        from: "worker-a",
        to: "worker-b",
        direction: "from-to",
      })

      const blocked = yield* Effect.result(
        client.execute(
          HttpClientRequest.get(`http://${HOST_B}:${PORT_B}/ping`),
        ),
      )
      expect(blocked._tag).toBe("Failure")

      yield* conn.reconnect("worker-b")
      // Partition still active.
      const stillBlocked = yield* Effect.result(
        client.execute(
          HttpClientRequest.get(`http://${HOST_B}:${PORT_B}/ping`),
        ),
      )
      expect(stillBlocked._tag).toBe("Failure")

      yield* conn.heal("worker-a", "worker-b")
      const ok = yield* client.execute(
        HttpClientRequest.get(`http://${HOST_B}:${PORT_B}/ping`),
      )
      expect(ok.status).toBe(200)
    }).pipe(
      Effect.scoped,
      Effect.provide(httpStackForSelf({ ip: HOST_A, port: PORT_A })),
    ),
  )
})
