/**
 * Issue 1 (Part A) — `TransactionLayer.cancelTxnsForCall` tears down the
 * client retransmit + Timer B/F fibers for every transaction belonging
 * to a given callRef, so an evicted call cannot leave orphan transactions
 * firing minutes later (the libuv DNS-threadpool drain documented in the
 * 2026-05-14 SIPp investigation).
 *
 * Runs under TestClock per CLAUDE.md test-strategy guidance.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { TransactionLayer } from "../../src/sip/TransactionLayer.js"
import { CallState } from "../../src/call/CallState.js"
import { fakeStackLayer } from "../support/fakeStack.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"
import type { SipRequest } from "../../src/sip/types.js"
import type { Call, Leg } from "../../src/call/CallModel.js"
import { hydrateRequest } from "../../src/sip/parsers/extract-fields.js"

function makeInvite(callRef: string, callId: string, branch: string, legId: string): SipRequest {
  // Via `cr` + `lg` custom params are what TransactionLayer reads to bind
  // the client txn to (callRef, legId) for later `cancelTxnsForCall` /
  // timeout lookups.
  return hydrateRequest({
    method: "INVITE",
    uri: "sip:bob@192.0.2.20:5060",
    headers: [
      { name: "Via", value: `SIP/2.0/UDP 127.0.0.1:15071;branch=${branch};cr=${callRef};lg=${legId}` },
      { name: "Max-Forwards", value: "70" },
      { name: "From", value: `<sip:b2bua@127.0.0.1:15071>;tag=b2bua-${legId}` },
      { name: "To", value: "<sip:bob@192.0.2.20:5060>" },
      { name: "Call-ID", value: callId },
      { name: "CSeq", value: "1 INVITE" },
      { name: "Contact", value: "<sip:b2bua@127.0.0.1:15071>" },
      { name: "Content-Length", value: "0" },
    ],
    body: new Uint8Array(0),
    raw: Buffer.alloc(0),
  })
}

const stack = fakeStackLayer({
  config: testAppConfigDefaults({ sipLocalIp: "127.0.0.1", sipLocalPort: 15071 }),
})

describe("TransactionLayer.cancelTxnsForCall", () => {
  it.effect("T1 — cancellation prevents Timer B from firing the timeout event", () =>
    Effect.gen(function* () {
      const txn = yield* TransactionLayer
      const callRef = "self|call-T1"
      const invite = makeInvite(callRef, "callid-T1", "z9hG4bK-T1", "b-1")

      // Subscribe to events into a queue so we can later assert absence
      // of a `timeout` event without blocking on Stream.take.
      const collected: Array<string> = []
      const subscriber = yield* Effect.forkChild(
        txn.events.pipe(
          Stream.tap((ev) => Effect.sync(() => collected.push(ev.type))),
          Stream.runDrain,
        ),
      )

      yield* txn.sendRequest(invite, { host: "192.0.2.20", port: 5060 }, "invite")
      expect(txn.metrics.activeTransactions()).toBe(1)

      yield* txn.cancelTxnsForCall(callRef)
      expect(txn.metrics.activeTransactions()).toBe(0)
      expect(txn.metrics.txnCancelledOnCallEvict).toBe(1)

      // Advance well past Timer B (32 000 ms) — a healthy fiber would
      // have fired by now; cancelled fibers are silent.
      yield* TestClock.adjust("35 seconds")
      yield* Effect.yieldNow

      expect(collected.includes("timeout")).toBe(false)

      yield* Fiber.interrupt(subscriber)
    }).pipe(Effect.provide(stack)),
  )

  it.effect("T2 — calling cancelTxnsForCall twice is idempotent", () =>
    Effect.gen(function* () {
      const txn = yield* TransactionLayer
      const callRef = "self|call-T2"
      const invite = makeInvite(callRef, "callid-T2", "z9hG4bK-T2", "b-1")

      yield* txn.sendRequest(invite, { host: "192.0.2.20", port: 5060 }, "invite")
      yield* txn.cancelTxnsForCall(callRef)
      const firstCount = txn.metrics.txnCancelledOnCallEvict
      yield* txn.cancelTxnsForCall(callRef)
      expect(txn.metrics.txnCancelledOnCallEvict).toBe(firstCount)
    }).pipe(Effect.provide(stack)),
  )

  it.effect("T3 — cancellation only targets the owning callRef; other calls' timers still fire", () =>
    Effect.gen(function* () {
      const txn = yield* TransactionLayer
      const refA = "self|call-A"
      const refB = "self|call-B"
      const inviteA = makeInvite(refA, "callid-A", "z9hG4bK-A", "b-1")
      const inviteB = makeInvite(refB, "callid-B", "z9hG4bK-B", "b-1")

      const seenTimeouts: Array<string | undefined> = []
      const subscriber = yield* Effect.forkChild(
        txn.events.pipe(
          Stream.tap((ev) =>
            Effect.sync(() => {
              if (ev.type === "timeout") seenTimeouts.push(ev.callRef)
            }),
          ),
          Stream.runDrain,
        ),
      )

      yield* txn.sendRequest(inviteA, { host: "192.0.2.20", port: 5060 }, "invite")
      yield* txn.sendRequest(inviteB, { host: "192.0.2.21", port: 5060 }, "invite")
      expect(txn.metrics.activeTransactions()).toBe(2)

      yield* txn.cancelTxnsForCall(refA)
      expect(txn.metrics.activeTransactions()).toBe(1)

      // Drive Timer B for call B. The retransmit fiber wakes on every
      // T1/T2 boundary so we need to yield repeatedly while advancing.
      for (let i = 0; i < 40; i++) {
        yield* TestClock.adjust("1 second")
        yield* Effect.yieldNow
      }

      expect(seenTimeouts.length).toBe(1)
      expect(seenTimeouts[0]).toBe(refB)

      yield* Fiber.interrupt(subscriber)
    }).pipe(Effect.provide(stack)),
  )

  it.effect("T4 — CallState.remove cancels the call's live transactions in one shot", () =>
    Effect.gen(function* () {
      const txn = yield* TransactionLayer
      const callState = yield* CallState
      const callRef = "self|call-T4"
      const callId = "callid-T4"

      // Seed a live call in CallState so `remove` exercises the full path
      // (CDR write, index removal, storage delete) the same way the
      // production rule chain does.
      const aLeg: Leg = {
        legId: "a",
        callId,
        fromTag: "uac-tag",
        source: { address: "127.0.0.1", port: 5060 },
        state: "trying",
        disposition: "pending",
        dialogs: [],
      }
      const call: Call = {
        callRef,
        aLeg,
        bLegs: [],
        activePeer: null,
        limiterEntries: [],
        timers: [],
        cdrEvents: [],
        state: "terminating",
        createdAt: 0,
        sampled: false,
      }
      yield* callState.create(call)

      const invite = makeInvite(callRef, callId, "z9hG4bK-T4", "b-1")
      yield* txn.sendRequest(invite, { host: "192.0.2.20", port: 5060 }, "invite")
      expect(txn.metrics.activeTransactions()).toBe(1)

      yield* callState.remove(callRef)
      expect(txn.metrics.activeTransactions()).toBe(0)
      expect(txn.metrics.txnCancelledOnCallEvict).toBeGreaterThanOrEqual(1)
    }).pipe(Effect.provide(stack)),
  )

  it.effect("T5 — URL-encoded Via cr/lg round-trip; cancel matches the decoded callRef", () =>
    Effect.gen(function* () {
      // Reproduces the kind-cluster regression: production `buildCallVia`
      // URL-encodes `cr=` (callRefs contain `|` and `@`), and the parser
      // stores Via param values raw. Pre-fix, `extractViaCustomParams`
      // returned the encoded string, so `txn.callRef === callRef` in
      // `cancelTxnsForCall` was always false against the decoded callRef
      // the caller passes — silent no-op, zombie timers fire.
      const txn = yield* TransactionLayer
      const decodedCallRef = "worker-0|UUID-1234@5.1.1.1|tag"
      const decodedLegId = "b-1"
      const encodedCallRef = encodeURIComponent(decodedCallRef)
      const encodedLegId = encodeURIComponent(decodedLegId)

      const invite = hydrateRequest({
        method: "INVITE",
        uri: "sip:bob@192.0.2.20:5060",
        headers: [
          { name: "Via", value: `SIP/2.0/UDP 127.0.0.1:15071;branch=z9hG4bK-T5;cr=${encodedCallRef};lg=${encodedLegId}` },
          { name: "Max-Forwards", value: "70" },
          { name: "From", value: `<sip:b2bua@127.0.0.1:15071>;tag=b2bua-T5` },
          { name: "To", value: "<sip:bob@192.0.2.20:5060>" },
          { name: "Call-ID", value: "callid-T5" },
          { name: "CSeq", value: "1 INVITE" },
          { name: "Contact", value: "<sip:b2bua@127.0.0.1:15071>" },
          { name: "Content-Length", value: "0" },
        ],
        body: new Uint8Array(0),
        raw: Buffer.alloc(0),
      })

      yield* txn.sendRequest(invite, { host: "192.0.2.20", port: 5060 }, "invite")
      expect(txn.metrics.activeTransactions()).toBe(1)

      // Caller passes the natural (decoded) callRef.
      yield* txn.cancelTxnsForCall(decodedCallRef)
      expect(txn.metrics.activeTransactions()).toBe(0)
      expect(txn.metrics.txnCancelledOnCallEvict).toBeGreaterThanOrEqual(1)
    }).pipe(Effect.provide(stack)),
  )
})
