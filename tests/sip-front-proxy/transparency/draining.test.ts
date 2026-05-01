/**
 * Transparency: D5 (draining model) — proxy in-dialog routing across a
 * worker's drain transition.
 *
 * Topology: proxy + two workers (`w-A`, `w-B`), Alice as UAC.
 *
 *   1. Alice sends INVITE; rendezvous picks `w-A`. The proxy stamps a
 *      stickiness cookie pointing at `w-A` into the Record-Route.
 *   2. Bob (= `w-A`) accepts (200 OK) — dialog confirmed.
 *   3. Test flips `w-A` health to `draining` (drainingSince stamped).
 *   4. Within `drainGracePolicyMs`: Alice sends a re-INVITE bearing the
 *      Route. Proxy decodes the cookie → still `w-A` (grace not elapsed)
 *      → forwards to `w-A`.
 *   5. TestClock advances past the grace window. Alice sends another
 *      re-INVITE → proxy decodes cookie → `w-A` past grace → falls back
 *      via `selectForNewDialog` → `w-B` is the only alive worker, so the
 *      re-INVITE arrives at `w-B`.
 *   6. ACK on the post-grace exchange still routes via the cookie's
 *      `w-A` (ACK exemption, RFC 3261 §13.2.2.4) — verifies the
 *      load-balancer's per-method exemption.
 */

import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect } from "effect"
import { TestClock } from "effect/testing"
import { customParser } from "../../../src/sip/parsers/custom/index.js"
import {
  ProxyCore,
  WorkerId,
} from "../../../src/sip-front-proxy/index.js"
import {
  proxyFakeStack,
  pumpFor,
} from "../../support/proxy-fakeStack.js"
import { runProxyScenario } from "../_report/runner.js"
import { TRANSPARENCY_OUTPUT_DIR } from "../../support/topologies.js"

const PROXY = { host: "10.0.0.1", port: 5060 }
const ALICE = { host: "10.0.0.2", port: 5060 }
const W_A_ADDR = { host: "10.0.1.0", port: 5060 }
const W_B_ADDR = { host: "10.0.1.1", port: 5060 }
const CALL_ID = "drain-call-1@alice"
const TRANSIT_MS = 5
const DRAIN_GRACE_MS = 5_000

const parse = (raw: Buffer) => {
  const r = customParser.parse(raw)
  if (r._tag !== "Success") throw new Error(`parse failure: ${r.failure.reason}`)
  return r.success
}

// We DO NOT register w-B initially. Adding it post-establishment lets
// us verify rendezvous picks w-A on the first INVITE deterministically.
const W_A = WorkerId("w-A")
const W_B = WorkerId("w-B")

const fx = proxyFakeStack({
  proxyAddr: PROXY,
  workers: [{ id: W_A, address: W_A_ADDR, health: "alive" }],
  transitDelayMs: TRANSIT_MS,
  loadBalancer: { drainGracePolicyMs: DRAIN_GRACE_MS },
})

describe("transparency: draining model (D5)", () => {
  it.effect(
    "in-dialog requests stay on draining worker until grace; post-grace ACK joins the fallback (slice 4)",
    () =>
      runProxyScenario(
        {
          name: "draining--with-proxy",
          description:
            "Establish dialog with w-A; flip w-A draining; verify in-dialog\n" +
            "requests stick to w-A pre-grace, fall back to w-B post-grace,\n" +
            "ACK always routes to w-A (D5 + ACK exemption).",
          outputDir: TRANSPARENCY_OUTPUT_DIR,
        },
        Effect.gen(function* () {
          yield* ProxyCore // force layer build
          const alice = yield* fx.bindNamedUac("alice", ALICE)
          const wA = yield* fx.bindNamedUasFor("w-A", W_A)

          // ── 1. Establish dialog with w-A ─────────────────────────
          const invite = Buffer.from(
            [
              `INVITE sip:bob@bob.example SIP/2.0`,
              `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-inv;rport`,
              `Max-Forwards: 70`,
              `From: <sip:alice@${ALICE.host}>;tag=alice-tag`,
              `To: <sip:bob@bob.example>`,
              `Call-ID: ${CALL_ID}`,
              `CSeq: 1 INVITE`,
              `Contact: <sip:alice@${ALICE.host}:${ALICE.port}>`,
              `Content-Length: 0`,
              ``,
              ``,
            ].join("\r\n"),
            "utf-8"
          )
          yield* alice.send(invite, PROXY.port, PROXY.host)
          yield* pumpFor(TRANSIT_MS, 2)

          const inviteAtA = yield* wA.poll()
          expect(inviteAtA).not.toBeNull()
          const inviteParsed = parse(inviteAtA!.raw)
          if (inviteParsed.type !== "request") throw new Error("expected INVITE")
          expect(inviteParsed.method).toBe("INVITE")
          // Snag the Record-Route the proxy inserted; it carries the
          // stickiness cookie pointing at w-A.
          const rrHeader = inviteParsed.headers.find(
            (h) => h.name.toLowerCase() === "record-route"
          )
          expect(rrHeader).toBeDefined()
          const routeValue = rrHeader!.value

          // ── 2. w-A → 200 OK ──────────────────────────────────────
          const ok = Buffer.from(
            [
              `SIP/2.0 200 OK`,
              ...inviteParsed.headers
                .filter((h) => h.name.toLowerCase() === "via")
                .map((h) => `Via: ${h.value}`),
              `Record-Route: ${routeValue}`,
              `From: <sip:alice@${ALICE.host}>;tag=alice-tag`,
              `To: <sip:bob@bob.example>;tag=wa-tag`,
              `Call-ID: ${CALL_ID}`,
              `CSeq: 1 INVITE`,
              `Contact: <sip:bob@${W_A_ADDR.host}:${W_A_ADDR.port}>`,
              `Content-Length: 0`,
              ``,
              ``,
            ].join("\r\n"),
            "utf-8"
          )
          yield* wA.send(ok, PROXY.port, PROXY.host)
          yield* pumpFor(TRANSIT_MS, 2)
          const okAtAlice = yield* alice.poll()
          expect(okAtAlice).not.toBeNull()

          // Build the Route header Alice will use on every in-dialog
          // request (the entry came back to her in the 200 OK's
          // Record-Route — she reverses → single entry → Route).
          const routeHeader = `Route: ${routeValue}`

          // ── 3. Pre-grace: register w-B (alive) and flip w-A draining
          // We bind w-B's endpoint AND register it before flipping w-A,
          // so the proxy can fall back to it after grace.
          const wB = yield* fx.bindNamedUasFor("w-B", W_B).pipe(
            Effect.catchTag("UnknownWorkerForBind", () =>
              Effect.gen(function* () {
                yield* fx.addSimulatedWorker(W_B, W_B_ADDR)
                return yield* fx.bindNamedUasFor("w-B", W_B)
              })
            )
          )
          yield* fx.setWorkerHealth(W_A, "draining")

          // ── 4. Pre-grace re-INVITE — must hit w-A ────────────────
          const reinvitePre = Buffer.from(
            [
              `INVITE sip:bob@${W_A_ADDR.host}:${W_A_ADDR.port} SIP/2.0`,
              `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-reinv-pre;rport`,
              routeHeader,
              `Max-Forwards: 70`,
              `From: <sip:alice@${ALICE.host}>;tag=alice-tag`,
              `To: <sip:bob@bob.example>;tag=wa-tag`,
              `Call-ID: ${CALL_ID}`,
              `CSeq: 2 INVITE`,
              `Contact: <sip:alice@${ALICE.host}:${ALICE.port}>`,
              `Content-Length: 0`,
              ``,
              ``,
            ].join("\r\n"),
            "utf-8"
          )
          yield* alice.send(reinvitePre, PROXY.port, PROXY.host)
          yield* pumpFor(TRANSIT_MS, 2)
          const reinviteAtA = yield* wA.poll()
          expect(reinviteAtA).not.toBeNull()
          const reinvitePreParsed = parse(reinviteAtA!.raw)
          expect(reinvitePreParsed.type).toBe("request")
          // w-B should NOT have received it.
          expect(yield* wB.poll()).toBeNull()

          // ── 5. Advance past grace ─────────────────────────────────
          yield* TestClock.adjust(Duration.millis(DRAIN_GRACE_MS + 1_000))
          yield* Effect.yieldNow

          const reinvitePost = Buffer.from(
            [
              `INVITE sip:bob@${W_A_ADDR.host}:${W_A_ADDR.port} SIP/2.0`,
              `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-reinv-post;rport`,
              routeHeader,
              `Max-Forwards: 70`,
              `From: <sip:alice@${ALICE.host}>;tag=alice-tag`,
              `To: <sip:bob@bob.example>;tag=wa-tag`,
              `Call-ID: ${CALL_ID}`,
              `CSeq: 3 INVITE`,
              `Contact: <sip:alice@${ALICE.host}:${ALICE.port}>`,
              `Content-Length: 0`,
              ``,
              ``,
            ].join("\r\n"),
            "utf-8"
          )
          yield* alice.send(reinvitePost, PROXY.port, PROXY.host)
          yield* pumpFor(TRANSIT_MS, 2)
          // Post-grace fallback → w-B must receive it; w-A must NOT.
          const reinviteAtB = yield* wB.poll()
          expect(reinviteAtB).not.toBeNull()
          const postParsed = parse(reinviteAtB!.raw)
          expect(postParsed.type).toBe("request")
          expect(yield* wA.poll()).toBeNull()

          // ── 6. Post-grace ACK falls back to w-B along with everything else.
          //
          // Slice 4 fix: a post-grace draining primary no longer holds an
          // ACK exemption. The reasoning that previously kept ACK pinned
          // ("only the worker that owns the INVITE transaction can
          // complete it") doesn't survive failover: after the post-grace
          // re-INVITE was served by w-B, the ACK is for w-B's
          // transaction. Routing it back to w-A would 481-storm.
          const ackToA = Buffer.from(
            [
              `ACK sip:bob@${W_A_ADDR.host}:${W_A_ADDR.port} SIP/2.0`,
              `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-ack-late;rport`,
              routeHeader,
              `Max-Forwards: 70`,
              `From: <sip:alice@${ALICE.host}>;tag=alice-tag`,
              `To: <sip:bob@bob.example>;tag=wa-tag`,
              `Call-ID: ${CALL_ID}`,
              `CSeq: 2 ACK`,
              `Content-Length: 0`,
              ``,
              ``,
            ].join("\r\n"),
            "utf-8"
          )
          yield* alice.send(ackToA, PROXY.port, PROXY.host)
          yield* pumpFor(TRANSIT_MS, 2)
          const ackAtB = yield* wB.poll()
          expect(ackAtB).not.toBeNull()
          const ackParsed = parse(ackAtB!.raw)
          if (ackParsed.type !== "request") throw new Error("expected ACK")
          expect(ackParsed.method).toBe("ACK")
          // w-A must NOT receive the post-grace ACK.
          expect(yield* wA.poll()).toBeNull()
        })
      ).pipe(Effect.provide(fx.layer))
  )
})
