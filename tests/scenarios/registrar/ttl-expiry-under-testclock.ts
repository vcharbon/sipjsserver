/**
 * ttl-expiry-under-testclock — Alice REGISTERs (default 3600s),
 * TestClock advances past the TTL, then the K8s "core" agent sends an
 * INVITE for `sip:alice@…` and gets 404 Not Found because the
 * `Registrar.inMemoryLayer`'s lazy expiry sweep removed the binding.
 *
 * Slice 3 of `docs/plan/register-and-double-stack-bright-panda.md`.
 *
 * Verifies the lazy-TTL design end-to-end: `Clock.currentTimeMillis`
 * inside the `Registrar` Effect honours `TestClock.adjust`, so the
 * scenario can fast-forward an hour without burning real wall time.
 */

import { scenario } from "../../../src/test-harness/framework/dsl.js"
import {
  CORE_INGRESS,
  coreIp,
  extIp,
} from "../../support/registrarFrontProxyFakeStack.js"

export const ttlExpiryUnderTestClock = scenario(
  "ttl-expiry-under-testclock",
  (s) => {
    const alice = s.agent("alice", {
      uri: "sip:alice@example.test",
      ip: extIp(1),
      network: "ext",
    })
    const core = s.agent("core", {
      uri: "sip:trunk@k8s.example.test",
      ip: coreIp(1),
      port: 5060,
      network: "core",
    })

    // 1. Alice registers — registrar grants 3600s default Expires.
    alice.register().expect(200)

    // 2. Advance virtual time 3601s past the binding's expiry.
    //    `Registrar.inMemoryLayer` reads `Clock.currentTimeMillis` on
    //    each `lookup`/`register`, so this deterministically pushes the
    //    binding past `expiresAtMs`.
    s.pause(3601_000)

    // 3. Core sends an INVITE for the (expired) AOR; `registrarLookup`
    //    sweeps + finds nothing → 404.
    core
      .invite(`sip:alice@${CORE_INGRESS.host}:${CORE_INGRESS.port}`, {})
      .transaction.expect(404)
  },
)
  .describe(
    "Alice registers with the default 3600s lifetime. Virtual time " +
      "advances 3601s past the TTL; a subsequent core-side INVITE for " +
      "alice gets 404 Not Found from the proxy's lazy-expiry sweep.",
  )
  .tier("medium")
  .runOn(["registrarFrontProxy"])
