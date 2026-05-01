/**
 * Slice E3 of the decode-forward-respawn-bye-481 fix — fresh-pod guard.
 *
 * The PodInformer's view of K8s `Ready` is eventually consistent. If the
 * proxy hasn't yet observed the new pod's first probe failure, the
 * informer may report `Ready=True` for a pod that will fail the next
 * probe. Slice E3 closes that race: any pod whose `firstSeenAtMs` is
 * younger than `freshPodGuardMs` is treated as `not-ready` for routing
 * purposes regardless of the registry's current health, by promoting
 * `decode_forward → decode_forward_backup`.
 *
 * This is a pure proxy-decision test: we drive INVITE → 200 OK → BYE
 * through the simulated UDP fabric and assert only on the BYE's
 * destination. TestClock advances control the guard window.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { customParser } from "../../../src/sip/parsers/custom/index.js"
import {
  ProxyCore,
  rendezvousSelect,
  WorkerId,
} from "../../../src/sip-front-proxy/index.js"
import { proxyFakeStack, pumpFor } from "../../support/proxy-fakeStack.js"

const PROXY = { host: "10.0.0.1", port: 5060 }
const ALICE = { host: "10.0.0.2", port: 5060 }
const W_A = WorkerId("worker-a")
const W_B = WorkerId("worker-b")
const ADDR_A = { host: "10.0.1.10", port: 5060 }
const ADDR_B = { host: "10.0.1.11", port: 5060 }
const TRANSIT_MS = 1
const GUARD_MS = 5_000

const parse = (raw: Buffer) => {
  const r = customParser.parse(raw)
  if (r._tag !== "Success") throw new Error(`parse failure: ${r.failure.reason}`)
  return r.success
}

const findCallIdMappingTo = (target: WorkerId): string => {
  const candidates = [{ id: W_A as string }, { id: W_B as string }]
  for (let i = 0; i < 1000; i++) {
    const cid = `pin-${i}@alice`
    const w = rendezvousSelect(cid, candidates)
    if (w !== undefined && w.id === target) return cid
  }
  throw new Error(`no Call-ID found mapping to ${target}`)
}

describe("sip-front-proxy/load-balancer — fresh-pod guard (Slice E3)", () => {
  // Both workers admitted as `alive` (mirroring K8s Ready=True). Worker A
  // is stamped fresh (`firstSeenAtMs` = test start) so the guard fires;
  // worker B carries no firstSeenAtMs so it stays freely routable as the
  // backup.
  it.effect(
    "alive primary inside guard window → BYE promoted to alive backup",
    () => {
      const fx = proxyFakeStack({
        proxyAddr: PROXY,
        workers: [
          { id: W_A, address: ADDR_A, health: "alive", firstSeenAtMs: 0 },
          { id: W_B, address: ADDR_B, health: "alive" },
        ],
        transitDelayMs: TRANSIT_MS,
        loadBalancer: { freshPodGuardMs: GUARD_MS },
      })

      return Effect.gen(function* () {
        const proxy = yield* ProxyCore
        const callId = findCallIdMappingTo(W_A)

        const alice = yield* fx.bindUac(ALICE)
        const aEp = yield* fx.bindUasFor(W_A)
        const bEp = yield* fx.bindUasFor(W_B)

        // Establish call on A.
        yield* alice.send(
          buildInvite(callId),
          proxy.localAddress.port,
          proxy.localAddress.ip
        )
        yield* pumpFor(TRANSIT_MS)
        const inviteAtA = yield* aEp.poll()
        const inviteParsed = parse(inviteAtA!.raw)
        if (inviteParsed.type !== "request") throw new Error("expected request")
        const rr = inviteParsed.headers.find(
          (h) => h.name.toLowerCase() === "record-route"
        )!

        const ok = build200Ok(callId, inviteParsed.headers, rr.value)
        yield* aEp.send(ok, proxy.localAddress.port, proxy.localAddress.ip)
        yield* pumpFor(TRANSIT_MS)
        yield* alice.poll() // drain

        // Send BYE WHILE INSIDE the guard window. Even though A is alive,
        // the guard demotes the decode and routes to B.
        const rrInner = rr.value.replace(/^</, "").replace(/>$/, "")
        yield* alice.send(
          buildBye(callId, rrInner),
          proxy.localAddress.port,
          proxy.localAddress.ip
        )
        yield* pumpFor(TRANSIT_MS)

        const byeAtA = yield* aEp.poll()
        const byeAtB = yield* bEp.poll()
        expect(byeAtA).toBeNull()
        expect(byeAtB).not.toBeNull()
      }).pipe(Effect.provide(fx.layer))
    }
  )

  it.effect(
    "guard expires (TestClock advances past freshPodGuardMs) → BYE forwarded to alive primary",
    () => {
      const fx = proxyFakeStack({
        proxyAddr: PROXY,
        workers: [
          { id: W_A, address: ADDR_A, health: "alive", firstSeenAtMs: 0 },
          { id: W_B, address: ADDR_B, health: "alive" },
        ],
        transitDelayMs: TRANSIT_MS,
        loadBalancer: { freshPodGuardMs: GUARD_MS },
      })

      return Effect.gen(function* () {
        const proxy = yield* ProxyCore
        const callId = findCallIdMappingTo(W_A)

        const alice = yield* fx.bindUac(ALICE)
        const aEp = yield* fx.bindUasFor(W_A)
        const bEp = yield* fx.bindUasFor(W_B)

        yield* alice.send(
          buildInvite(callId),
          proxy.localAddress.port,
          proxy.localAddress.ip
        )
        yield* pumpFor(TRANSIT_MS)
        const inviteAtA = yield* aEp.poll()
        // The guard fires on the INVITE too — but selectForNewDialog
        // doesn't consult the cookie, so initial INVITE always lands on
        // its HRW winner. Confirm that and move on.
        expect(inviteAtA).not.toBeNull()
        const inviteParsed = parse(inviteAtA!.raw)
        if (inviteParsed.type !== "request") throw new Error("expected request")
        const rr = inviteParsed.headers.find(
          (h) => h.name.toLowerCase() === "record-route"
        )!

        const ok = build200Ok(callId, inviteParsed.headers, rr.value)
        yield* aEp.send(ok, proxy.localAddress.port, proxy.localAddress.ip)
        yield* pumpFor(TRANSIT_MS)
        yield* alice.poll()

        // Advance virtual time past the guard window.
        yield* TestClock.adjust(`${GUARD_MS + 100} millis`)

        // BYE outside the guard window: A is still `alive`, no longer
        // fresh → decode_forward to A.
        const rrInner = rr.value.replace(/^</, "").replace(/>$/, "")
        yield* alice.send(
          buildBye(callId, rrInner),
          proxy.localAddress.port,
          proxy.localAddress.ip
        )
        yield* pumpFor(TRANSIT_MS)

        const byeAtA = yield* aEp.poll()
        const byeAtB = yield* bEp.poll()
        expect(byeAtA).not.toBeNull()
        expect(byeAtB).toBeNull()
      }).pipe(Effect.provide(fx.layer))
    }
  )

  it.effect(
    "no firstSeenAtMs on entry → guard inert; BYE forwarded to primary",
    () => {
      // Existing load-balancer suites pre-date Slice E3 and don't set
      // firstSeenAtMs. The guard MUST stay inert for them.
      const fx = proxyFakeStack({
        proxyAddr: PROXY,
        workers: [
          { id: W_A, address: ADDR_A, health: "alive" },
          { id: W_B, address: ADDR_B, health: "alive" },
        ],
        transitDelayMs: TRANSIT_MS,
        loadBalancer: { freshPodGuardMs: GUARD_MS },
      })

      return Effect.gen(function* () {
        const proxy = yield* ProxyCore
        const callId = findCallIdMappingTo(W_A)

        const alice = yield* fx.bindUac(ALICE)
        const aEp = yield* fx.bindUasFor(W_A)
        const bEp = yield* fx.bindUasFor(W_B)

        yield* alice.send(
          buildInvite(callId),
          proxy.localAddress.port,
          proxy.localAddress.ip
        )
        yield* pumpFor(TRANSIT_MS)
        const inviteAtA = yield* aEp.poll()
        const inviteParsed = parse(inviteAtA!.raw)
        if (inviteParsed.type !== "request") throw new Error("expected request")
        const rr = inviteParsed.headers.find(
          (h) => h.name.toLowerCase() === "record-route"
        )!

        const ok = build200Ok(callId, inviteParsed.headers, rr.value)
        yield* aEp.send(ok, proxy.localAddress.port, proxy.localAddress.ip)
        yield* pumpFor(TRANSIT_MS)
        yield* alice.poll()

        const rrInner = rr.value.replace(/^</, "").replace(/>$/, "")
        yield* alice.send(
          buildBye(callId, rrInner),
          proxy.localAddress.port,
          proxy.localAddress.ip
        )
        yield* pumpFor(TRANSIT_MS)

        const byeAtA = yield* aEp.poll()
        const byeAtB = yield* bEp.poll()
        expect(byeAtA).not.toBeNull()
        expect(byeAtB).toBeNull()
      }).pipe(Effect.provide(fx.layer))
    }
  )
})

// ---------------------------------------------------------------------------
// Local message builders.
// ---------------------------------------------------------------------------

const buildInvite = (callId: string): Buffer =>
  Buffer.from(
    [
      `INVITE sip:user@example.com SIP/2.0`,
      `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-alice-inv;rport`,
      `Max-Forwards: 70`,
      `From: <sip:alice@${ALICE.host}>;tag=t-alice`,
      `To: <sip:user@example.com>`,
      `Call-ID: ${callId}`,
      `CSeq: 1 INVITE`,
      `Contact: <sip:alice@${ALICE.host}:${ALICE.port}>`,
      `Content-Length: 0`,
      ``,
      ``,
    ].join("\r\n"),
    "utf-8"
  )

const build200Ok = (
  callId: string,
  inviteHeaders: ReadonlyArray<{ name: string; value: string }>,
  rrValue: string
): Buffer =>
  Buffer.from(
    [
      `SIP/2.0 200 OK`,
      ...inviteHeaders
        .filter((h) => h.name.toLowerCase() === "via")
        .map((h) => `Via: ${h.value}`),
      `Record-Route: ${rrValue}`,
      `From: <sip:alice@${ALICE.host}>;tag=t-alice`,
      `To: <sip:user@example.com>;tag=t-b`,
      `Call-ID: ${callId}`,
      `CSeq: 1 INVITE`,
      `Contact: <sip:user@${ADDR_A.host}:${ADDR_A.port}>`,
      `Content-Length: 0`,
      ``,
      ``,
    ].join("\r\n"),
    "utf-8"
  )

const buildBye = (callId: string, rrInner: string): Buffer =>
  Buffer.from(
    [
      `BYE sip:user@${ADDR_A.host}:${ADDR_A.port} SIP/2.0`,
      `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-alice-bye;rport`,
      `Route: <${rrInner}>`,
      `Max-Forwards: 70`,
      `From: <sip:alice@${ALICE.host}>;tag=t-alice`,
      `To: <sip:user@example.com>;tag=t-b`,
      `Call-ID: ${callId}`,
      `CSeq: 2 BYE`,
      `Content-Length: 0`,
      ``,
      ``,
    ].join("\r\n"),
    "utf-8"
  )
