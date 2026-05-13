/**
 * deregister-via-expires-zero — Alice REGISTERs, then re-REGISTERs with
 * `Expires: 0` (single-Contact de-registration shape per the v1 plan).
 * Afterwards the K8s "core" agent sends an INVITE for `sip:alice@…`
 * and the proxy's `CoreToExtRoutingStrategy.registrarLookup` returns
 * 404 Not Found because the binding was cleared.
 *
 * Slice 3 of `docs/plan/register-and-double-stack-bright-panda.md`.
 *
 * Two-network scenario — Alice on `ext`, "core" agent on `core`. The
 * resulting HTML report has two lanes (one per fabric); the cross-
 * fabric hop is the proxy's 404 reply on the core endpoint.
 */

import { scenario } from "../../../src/test-harness/framework/dsl.js"
import {
  CORE_INGRESS,
  coreIp,
  extIp,
} from "../../support/registrarFrontProxyFakeStack.js"

export const deregisterViaExpiresZero = scenario(
  "deregister-via-expires-zero",
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

    // 1. Alice registers — registrar applies default 3600s and 200 OKs.
    alice.register().expect(200)

    // 2. Alice re-registers with Expires=0 — registrar drops the binding.
    alice.register({ expires: 0 }).expect(200)

    // 3. The K8s core sends an INVITE addressed to alice. With no
    //    binding, `CoreToExtRoutingStrategy.registrarLookup` returns
    //    `RouteOutcome.reject(404, "Not Found")` and the proxy replies
    //    on the core endpoint.
    core
      .invite(`sip:alice@${CORE_INGRESS.host}:${CORE_INGRESS.port}`, {})
      .transaction.expect(404)
  },
)
  .describe(
    "Alice registers, then de-registers via `Expires: 0`. A subsequent " +
      "INVITE from the core network targeting alice's AOR is rejected " +
      "404 Not Found — the binding was cleared.",
  )
  .runOn(["registrarFrontProxy"])
  .title("registrar: deregister via Expires=0 (core INVITE → 404)")
