/**
 * k8s-register-smoke — slice 3 smoke test for the hybrid harness.
 *
 * Alice (host) sends a single REGISTER over real UDP through the kind
 * NodePort to the in-cluster sip-front-proxy and expects a 200 OK back.
 * Proves the round-trip: host UDP → kind hostPort → NodePort → proxy →
 * 200 → docker bridge gateway → host UDP.
 *
 * Slice 4 builds a full REGISTER + INVITE + BYE on top of this; this
 * scenario exists only to validate the network plumbing end-to-end.
 */

import { scenario } from "../../../src/test-harness/framework/dsl.js"

export const k8sRegisterSmoke = scenario("k8s-register-smoke", (s) => {
  // Synthetic `5.1.x.x` address on the simulated ext fabric. The hybrid
  // runner binds proxy(ext) at `5.1.0.1:5060`; alice binds at
  // `5.1.1.1:5060` here. Standard SIP port `5060` is fine because the
  // simulated fabric is in-memory — no kernel collision with anything
  // else listening on the host's real 5060.
  const alice = s.agent("alice", {
    uri: "sip:alice@kindlab",
    ip: "5.1.1.1",
    port: 5060,
  })
  alice.register({ expires: 3600 }).expect(200)
})
  .describe(
    "Alice REGISTERs against the kind-deployed sip-front-proxy " +
      "(in-memory registrar mode) and expects 200 OK. Smoke test for the " +
      "hybrid fakeExt-realCore network plumbing.",
  )
  .tier("short")
