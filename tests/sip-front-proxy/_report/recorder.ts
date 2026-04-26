/**
 * Proxy-test participant registry.
 *
 * A tiny `(host, port) → label` registry. Every UDP packet on the simulated
 * fabric is already captured by `SignalingNetwork.drainTrace`; the runner
 * just needs to know which logical participant lives at which `(ip, port)`
 * so the report can render labels (alice, bob, worker-1, …) instead of raw
 * addresses.
 *
 * `bindNamedEndpoint(name, addr, queueMax)` registers the mapping and
 * binds a vanilla UDP endpoint — no send/poll/take wrappers, no Stream tap.
 */

import { Effect, Ref, ServiceMap, type Scope } from "effect"
import {
  SignalingNetwork,
  type UdpEndpoint,
} from "../../../src/sip/SignalingNetwork.js"

const labelKey = (host: string, port: number): string => `${host}:${port}`

export interface ProxyParticipantsApi {
  readonly register: (
    name: string,
    addr: { readonly host: string; readonly port: number }
  ) => Effect.Effect<void>
  /** Resolve `(ip, port) → name`, or `undefined` if the address is unknown. */
  readonly labelFor: (
    ip: string,
    port: number
  ) => Effect.Effect<string | undefined>
  /** Snapshot the registered names in registration order. */
  readonly snapshot: Effect.Effect<{
    readonly participants: ReadonlyArray<string>
    readonly addrs: ReadonlyMap<string, string>
  }>
}

export class ProxyParticipants extends ServiceMap.Service<
  ProxyParticipants,
  ProxyParticipantsApi
>()("ProxyParticipants") {}

const makeApi = Effect.gen(function* () {
  const namesRef = yield* Ref.make<ReadonlyArray<string>>([])
  const addrsRef = yield* Ref.make<ReadonlyMap<string, string>>(new Map())

  const register = (
    name: string,
    addr: { readonly host: string; readonly port: number }
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* Ref.update(namesRef, (xs) => (xs.includes(name) ? xs : [...xs, name]))
      yield* Ref.update(addrsRef, (m) => {
        const next = new Map(m)
        next.set(labelKey(addr.host, addr.port), name)
        return next
      })
    })

  const labelFor = (ip: string, port: number): Effect.Effect<string | undefined> =>
    Effect.gen(function* () {
      const m = yield* Ref.get(addrsRef)
      return m.get(labelKey(ip, port))
    })

  const snapshot = Effect.gen(function* () {
    const participants = yield* Ref.get(namesRef)
    const addrs = yield* Ref.get(addrsRef)
    return { participants, addrs }
  })

  return ProxyParticipants.of({ register, labelFor, snapshot })
})

export const ProxyParticipantsLive = Effect.gen(function* () {
  return yield* makeApi
})

/**
 * Bind a participant-registered UDP endpoint. The endpoint is the raw one
 * from `SignalingNetwork.bindUdp` — recording happens at the fabric level,
 * not by wrapping send/poll/take.
 */
export const bindNamedEndpoint = (
  participant: string,
  addr: { readonly host: string; readonly port: number },
  queueMax = 64
): Effect.Effect<UdpEndpoint, never, SignalingNetwork | ProxyParticipants | Scope.Scope> =>
  Effect.gen(function* () {
    const net = yield* SignalingNetwork
    const participants = yield* ProxyParticipants
    yield* participants.register(participant, addr)
    return yield* net
      .bindUdp({ ip: addr.host, port: addr.port, queueMax })
      .pipe(Effect.orDie)
  })

