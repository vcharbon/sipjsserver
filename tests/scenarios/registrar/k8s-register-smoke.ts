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
  // No `network` tag — the kind cluster is one fabric from the test's
  // POV. The hybrid runner sets `advertisedIp` transport-wide so Alice's
  // Contact carries a kind-reachable IP.
  const alice = s.agent("alice", {
    uri: "sip:alice@kindlab",
    port: 25060,
  })
  alice.register({ expires: 3600 }).expect(200)
})
  .describe(
    "Alice REGISTERs against the kind-deployed sip-front-proxy " +
      "(in-memory registrar mode) and expects 200 OK. Smoke test for the " +
      "hybrid fakeExt-realCore network plumbing.",
  )
  .tier("short")
