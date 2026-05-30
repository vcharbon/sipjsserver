/**
 * Slice 2 — transport demux + active-peer state machine (RFC 3261 §13 /
 * RFC 5009). One caller port can receive RTP from several forked branches; the
 * transport demuxes by source and records each, but only the committed active
 * peer is sent to and resolves a plain `recorded()`. Committing one branch
 * abandons the rest. All over the simulated fabric under TestClock; no B2BUA.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import { MediaEndpoint, type MediaTransport, type NetAddr, PCMA } from "../../src/media/MediaEndpoint.js"
import { MediaEndpointTs } from "../../src/media/ts/MediaEndpointTs.js"
import type { NegotiatedMedia } from "../../src/media/sdp/types.js"
import { classify } from "../../src/test-harness/media/audio/classify.js"
import { type ClipName, referenceClip } from "../../src/test-harness/media/audio/clips.js"

const stack = MediaEndpointTs.pipe(Layer.provide(SignalingNetwork.simulated({ transitDelayMs: 1 })))

const neg = (remote: NetAddr): NegotiatedMedia => ({
  remote,
  codec: PCMA,
  direction: "sendrecv",
  send: true,
  receive: true,
})

/** Configure + commit a session on `from` toward `to`, then play a clip. */
const sendClip = (from: MediaTransport, to: NetAddr, dialogId: string, clip: ClipName) =>
  Effect.gen(function* () {
    const s = yield* from.session(dialogId)
    yield* s.configure(neg(to))
    yield* s.commit("confirmed")
    yield* s.play({ kind: "pcm", pcm: referenceClip(clip) })
    return s
  })

describe("transport demux + active-peer", () => {
  it.effect("two forked branches → two recorded source buckets, demuxed by source", () =>
    Effect.gen(function* () {
      const me = yield* MediaEndpoint
      const alice = yield* me.open("10.10.0.1", 40000)
      const bob = yield* me.open("10.20.0.1", 40002)
      const charlie = yield* me.open("10.30.0.1", 40004)

      // Two forked branches both send early media to alice's one port.
      yield* sendClip(bob, alice.localAddr, "b", "bob")
      yield* sendClip(charlie, alice.localAddr, "c", "charlie")
      yield* TestClock.adjust("3 seconds")

      const srcs = yield* alice.sources()
      expect(srcs.length).toBe(2)

      // Per-dialog sessions attribute each bucket to the right peer.
      const sBob = yield* alice.session("ab")
      yield* sBob.configure(neg(bob.localAddr))
      const sCharlie = yield* alice.session("ac")
      yield* sCharlie.configure(neg(charlie.localAddr))

      expect(classify((yield* sBob.recorded()).pcm).matched).toBe("bob")
      expect(classify((yield* sCharlie.recorded()).pcm).matched).toBe("charlie")
    }).pipe(Effect.scoped, Effect.provide(stack)),
  )

  it.effect("no active peer and no send until commit", () =>
    Effect.gen(function* () {
      const me = yield* MediaEndpoint
      const alice = yield* me.open("10.10.0.1", 41000)
      const bob = yield* me.open("10.20.0.1", 41002)

      const aS = yield* alice.session("d")
      yield* aS.configure(neg(bob.localAddr))
      expect(yield* alice.activePeer()).toBeNull()

      // play before commit is a no-op → bob receives nothing.
      yield* aS.play({ kind: "pcm", pcm: referenceClip("alice") })
      yield* TestClock.adjust("2 seconds")
      expect((yield* bob.sources()).length).toBe(0)

      // commit → becomes active → now it sends.
      yield* aS.commit("confirmed")
      expect(yield* alice.activePeer()).not.toBeNull()
      yield* aS.play({ kind: "pcm", pcm: referenceClip("alice") })
      yield* TestClock.adjust("3 seconds")
      expect((yield* bob.sources()).length).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(stack)),
  )

  it.effect("200 OK commits one branch and abandons the rest; abandoned stays silent", () =>
    Effect.gen(function* () {
      const me = yield* MediaEndpoint
      const alice = yield* me.open("10.10.0.1", 42000)
      const bob = yield* me.open("10.20.0.1", 42002)
      const charlie = yield* me.open("10.30.0.1", 42004)

      const sBob = yield* alice.session("eb")
      yield* sBob.configure(neg(bob.localAddr))
      const sCharlie = yield* alice.session("ec")
      yield* sCharlie.configure(neg(charlie.localAddr))

      // Early media authorized on bob's branch.
      yield* sBob.commit("early-pem")
      expect((yield* alice.activePeer())?.dialogId).toBe("eb")
      yield* sBob.play({ kind: "pcm", pcm: referenceClip("alice") })
      yield* TestClock.adjust("3 seconds")
      const bobPacketsAfterEarly = (yield* bob.sources())[0]!.packets
      expect(bobPacketsAfterEarly).toBeGreaterThan(0)

      // 200 OK from charlie commits charlie and abandons bob.
      yield* sCharlie.commit("confirmed")
      expect((yield* alice.activePeer())?.dialogId).toBe("ec")
      expect(yield* sBob.isActive()).toBe(false)

      // Abandoned bob branch stays silent; charlie now receives.
      yield* sBob.play({ kind: "pcm", pcm: referenceClip("alice") })
      yield* sCharlie.play({ kind: "pcm", pcm: referenceClip("alice") })
      yield* TestClock.adjust("3 seconds")

      expect((yield* bob.sources())[0]!.packets).toBe(bobPacketsAfterEarly) // no new packets
      expect((yield* charlie.sources()).length).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(stack)),
  )

  it.effect("re-offer re-points the active peer's send to a new remote", () =>
    Effect.gen(function* () {
      const me = yield* MediaEndpoint
      const alice = yield* me.open("10.10.0.1", 43000)
      const bob = yield* me.open("10.20.0.1", 43002)
      const dave = yield* me.open("10.40.0.1", 43006)

      const s = yield* alice.session("d")
      yield* s.configure(neg(bob.localAddr))
      yield* s.commit("confirmed")
      yield* s.play({ kind: "pcm", pcm: referenceClip("alice") })
      yield* TestClock.adjust("3 seconds")
      expect((yield* bob.sources()).length).toBe(1)

      // Re-INVITE realign: re-point the SAME active session to dave.
      yield* s.configure(neg(dave.localAddr))
      yield* s.play({ kind: "pcm", pcm: referenceClip("alice") })
      yield* TestClock.adjust("3 seconds")
      expect((yield* dave.sources()).length).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(stack)),
  )
})
