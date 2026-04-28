# Hybrid E2E Test: Register + K8s `realCore` (`register-fakeExt-realCore`)

## Context

Slices 1–3 of `register-and-double-stack` (commits `9198735`, `fc2403f`,
`52ab46c`) shipped the registrar proxy, dual-endpoint `ProxyCore`, and a
new `agent.register()` scenario DSL — all exercised today **only under
the in-process fake-clock harness**. We have no end-to-end coverage that
proves the new register flow works against a real running B2BUA stack
inside kind, nor that the X-Api-Call routing path is wired correctly
through to a real HTTP call-control backend.

This plan adds a **hybrid** real-clock test: fake in-process alice/bob
agents talk over **real UDP** to a **real kind-deployed SBC** (sip-front-proxy
+ b2bua-worker StatefulSet + Redis + a new mock call-control HTTP service)
and the SBC routes back to the fakes via `X-Api-Call` instructions. The
test produces an HTML + `global.txt` sequence-diagram report under
`test-results/real-clock/registrarFrontProxy-kind/`. A second, advanced
scenario then proves bob1→bob2 re-routing/failover. Finally the
`sip-callflow-review` skill audits the resulting trace and any anomalies
get fixed.

The deliverable also includes a public-facing doc that teaches an external
user how to author multi-agent scenarios against this test API.

---

## Topology

```
host (test process)                    kind cluster
─────────────────────                  ───────────────────────────────
alice (UDP)  ─────────► hostPort 5060 ─► NodePort 30060/UDP
bob1 (UDP)                                     │
bob2 (UDP)                                     ▼
                                         sip-front-proxy (registrar mode)
                                               │ HMAC-cookie LB
                                               ▼
                                         b2bua-worker StatefulSet
                                               │ HTTP /call/new
                                               ▼
                                         mock-call-control (NEW Service)
                                               │ parses X-Api-Call
                                               ▼
                                         Redis (state, limiter)

alice/bob bind on host UDP; their Contact addresses point to a
host-reachable IP that pods can route to (auto-discovered — typically
host.docker.internal on Docker Desktop, or the kind docker network
gateway on Linux native; details resolved during slice 3 by inspecting
`docker network inspect kind` at test bootstrap).
```

---

## Approach overview (sliced)

| Slice | Goal | Outcome |
|-------|------|---------|
| **1** | Verify X-Api-Call wiring through real prod path | b2bua-worker forwards `X-Api-Call` from inbound INVITE into HTTP `sip_headers`; gap (if any) fixed |
| **2** | MockServer → HTTP service | New bin entrypoint + image entry + helm chart so the existing pure builders run as a real HTTP service |
| **3** | Hybrid runner & cluster wiring | New `createHybridRunner` + adapt `tests/k8s/cluster.yaml` & `install-stack.ts` so kind pods can reach fake alice/bob and vice-versa |
| **4** | Basic E2E scenario (`registerCallBye`) | alice REGISTERs, alice→bob INVITE/200/BYE via X-Api-Call routing, HTML report emitted |
| **5** | Advanced scenario (`registerCallReroute`) | alice + bob1 + bob2; bob1 503 → failover to bob2 via X-Api-Call `on_failure` |
| **6** | External-facing test API documentation | `docs/test-api-external.md` covering scenario DSL, multi-agent topology, X-Api-Call format, report navigation |
| **7** | sip-callflow-review audit & fix | Run skill on `register-fakeExt-realCore` global.txt; address each anomaly |

Slices 1–3 are infrastructure (must land first). Slices 4–5 are scenario
authoring. Slices 6–7 finalise.

---

## Slice 1 — Verify X-Api-Call wiring (investigation)

**Why first:** the user explicitly said "make sure first it is properly
wired." The whole hybrid test relies on the b2bua-worker reading
`X-Api-Call` off an inbound INVITE and propagating it into the
`/call/new` HTTP body as `sip_headers["X-Api-Call"]`.

Read in this order:
- [src/decision/adapters/http-reference/MockServer.ts](src/decision/adapters/http-reference/MockServer.ts) — confirm header name + JSON shape (`{ action: "route" | "reject", destination, call_limiter, on_failure }`).
- [src/decision/adapters/http-reference/HttpReferenceAdapter.ts](src/decision/adapters/http-reference/HttpReferenceAdapter.ts) — confirm `newCall` request builder includes the inbound INVITE's `X-Api-Call` value under `sip_headers`.
- [src/b2bua/InitialInviteHandler.ts](src/b2bua/InitialInviteHandler.ts) — confirm the inbound INVITE's parsed headers are reachable when `callControl.newCall(...)` is invoked.

If a gap exists (e.g. header not propagated), fix it minimally with a
focused unit test in the existing fake-clock suite **before** moving on.
No work in slices 2+ until this is green.

**Acceptance:** an existing or new fake-clock test sends `X-Api-Call:
{...}` and asserts the value reaches the HTTP body unchanged.

---

## Slice 2 — Mock call-control HTTP service ✅ already wired

**Discovery during implementation:** the mock call-control endpoints are
**already exposed by every b2bua-worker pod**. [src/http/StatusServer.ts:413](src/http/StatusServer.ts#L413) calls
`addCallControlRoutes(router)` unconditionally inside the StatusServer
layer. `AppConfig.ts:172` defaults `CALL_CONTROL_URL` to
`http://localhost:3002` — the worker's own status port.

Net effect: a freshly-deployed worker pod self-routes via X-Api-Call out
of the box. **No new bin entrypoint, no new helm chart, no
[tests/k8s/scripts/install-stack.ts](tests/k8s/scripts/install-stack.ts) change is required.**

The only worker-side env wiring slice 3 will add (via helm `extraEnv`)
is:
- `B2B_OUTBOUND_PROXY=<proxy ClusterIP>:5060` so b-leg INVITEs egress
  through the proxy back to alice/bob (required for the proxy's
  registrar lookup + Record-Route stamping to apply on the b-leg too).
- `SIP_LOCAL_IP=$(POD_IP)` via downward API so worker-stamped Via /
  Contact don't claim 127.0.0.1.

---

## Slice 3 — Hybrid runner & cluster wiring

**3a — Cluster ingress/egress.**
- Existing [tests/k8s/cluster.yaml](tests/k8s/cluster.yaml) maps `containerPort 30060 → hostPort 5060/UDP` on the load worker. That's enough for **inbound** alice/bob → proxy.
- For **outbound** (worker → host alice/bob), pods initiate UDP to any IP they can route to. Implementation: at test bootstrap, run `docker network inspect kind` to discover the gateway IP, and have alice/bob register Contact with that IP. If it doesn't work out of the box (e.g. firewall on the bridge), fall back to running alice/bob with `extra_hosts`-style mapping or adding an extra kind-cluster `extraPortMappings` block — adjust [tests/k8s/cluster.yaml](tests/k8s/cluster.yaml) only if needed.

**3b — `createHybridRunner` in [tests/support/harness.ts](tests/support/harness.ts)** (or new file `tests/support/hybridRunner.ts`):
```
createHybridRunner({
  proxyHost: <kind ingress, default 127.0.0.1>,
  proxyPort: <kind hostPort, default 5060>,
  hostReachableIp: <auto-discovered>,
  alicePort, bobPorts: [...],
  outputDir: "test-results/real-clock/registrarFrontProxy-kind",
})
```
Reuses `createLiveTransport` (real UDP) + the existing `executeScenario`
interpreter. Differences from `createLiveRunner`:
- Multi-agent: agents need fixed bind ports so kind can send back to them.
- `targetFor(agent)`: every agent's outbound goes to the kind ingress.
- Contact rewriting hook: alice/bob must advertise `hostReachableIp` in
  Contact (not 127.0.0.1) so the registrar stores a kind-reachable Contact.

**3c — Lifecycle.**
- A vitest `beforeAll` shells out to `tests/k8s/scripts/up-if-needed.ts` and `install-stack.ts` if not already running, then a `helm uninstall` in `afterAll` (or rely on `npm run test:k8s:fresh`).
- Skip the suite when `process.env.E2E_KIND` is not `1` so the default `npm run test` doesn't depend on docker.

**Acceptance:** a smoke test sends one OPTIONS to the kind proxy and gets a 200 back via real UDP (proves both directions work).

---

## Slice 4 — Basic E2E scenario `registerCallBye`

**New scenario file** `tests/scenarios/registrar/k8s-register-call-bye.ts`:
- `alice = s.agent("alice", { uri: "sip:alice@kindlab", network: "ext", port: <fixed> })`
- `bob   = s.agent("bob",   { uri: "sip:bob@kindlab",   network: "ext", port: <fixed> })`
- `alice.register({ expires: 3600 }).expect(200)`
- `bob.register({ expires: 3600 }).expect(200)`
- `alice.invite("sip:bob@kindlab", { headers: { "X-Api-Call": JSON.stringify({ action: "route", destination: "<bob contact via registrar>" }) } })`
- INVITE/100/180/200/ACK
- `aliceDialog.bye().expect(200)`

Helper: reuse the existing pattern in [tests/scenarios/registrar/register-happy-path.ts](tests/scenarios/registrar/register-happy-path.ts) and the failover X-Api-Call pattern in [tests/scenarios/failover-reroute.ts](tests/scenarios/failover-reroute.ts).

**New test file** `tests/fullcall/e2e-register-fakeExt-realCore.test.ts`:
- `describe.skipIf(!process.env.E2E_KIND)`
- Uses `createHybridRunner({ outputDir: "test-results/real-clock/registrarFrontProxy-kind", ... })`.
- `afterAll(() => flushIndexReport(OUTPUT_DIR))` — gives us the index page automatically (existing infra at [tests/support/harness.ts:59](tests/support/harness.ts#L59)).

**Acceptance:**
- Test passes against `npm run test:k8s:up`-managed cluster + installed stack.
- `test-results/real-clock/registrarFrontProxy-kind/` contains:
  - `index.html`
  - `register-call-bye.html` (sequence diagram with ext + core lanes)
  - `register-call-bye.global.txt`
  - `ext/register-call-bye.alice.txt` etc.

---

## Slice 5 — Advanced scenario `registerCallReroute`

**New scenario** `tests/scenarios/registrar/k8s-register-call-reroute.ts`:
- alice + bob1 + bob2 (both bobs REGISTER different contacts under the same AOR or distinct AORs, depending on what the registrar implementation supports — confirm against [src/sip-front-proxy/Registrar.ts](src/sip-front-proxy/Registrar.ts) before writing).
- alice INVITEs with `X-Api-Call: { action: "route", destination: bob1, on_failure: { action: "route", destination: bob2 } }`.
- bob1 replies 503 (use `bob1.receiveInitialInvite().reply(503)`); bob1 must `allowExtra("ACK")` because the proxy auto-ACKs non-2xx.
- bob2 receives the failover INVITE → 200 → alice ACKs → BYE.

Pattern reference: [tests/scenarios/failover-reroute.ts](tests/scenarios/failover-reroute.ts) — same shape, different agents and registered Contacts.

**Acceptance:** same as slice 4, plus the trace shows the 503 from bob1 followed by the rerouted INVITE to bob2 in the same dialog.

---

## Slice 6 — External-facing test API documentation

**New doc** `docs/test-api-external.md` (linked from the progressive-reading
table in [CLAUDE.md](CLAUDE.md) under a new row "Authoring scenarios for
the test API"):

Sections:
1. **What you can build** — register, place calls, BYE, transfer, multi-agent topologies, re-routing.
2. **Quickstart** — one-page copy-paste of a 3-step scenario (register → call → bye), pointing at `tests/scenarios/registrar/k8s-register-call-bye.ts` as the canonical example.
3. **Agent abstraction** — `s.agent(name, { uri, port, network })`, `agent.register()`, `agent.invite()`, `agent.receiveInitialInvite()`, `dialog.ack()`, `dialog.bye()`, `dialog.send(method, ...)`.
4. **Multi-agent topology** — how to wire alice + bob1 + bob2; fixed ports; per-agent network tagging.
5. **X-Api-Call header** — JSON shape, `action: "route" | "reject"`, `destination`, `on_failure`, `call_limiter`. Cross-link [src/decision/adapters/http-reference/MockServer.ts](src/decision/adapters/http-reference/MockServer.ts).
6. **Running the tests** — `npm run test:k8s:up`, `E2E_KIND=1 npm run test:live:short`, where reports land, how to read the HTML/global.txt.
7. **Customising routing** — pointer to `MockServer.ts` for adding new X-Api-Call actions; pointer to `tests/scenarios/registrar/` for the scenario library.

Keep it ~300 lines max, link-heavy, no copy-pasted code longer than ~15 lines.

**Acceptance:** a colleague new to the codebase can write their own `alice→bob` scenario without reading `tests/fullcall/framework/*` source.

---

## Slice 7 — `sip-callflow-review` audit & fix

After slice 5 passes:
1. Invoke the `sip-callflow-review` skill on `test-results/real-clock/registrarFrontProxy-kind/register-call-bye.global.txt` and `register-call-reroute.global.txt`.
2. For every anomaly the skill flags, decide: real bug (fix in source), test bug (fix scenario), or false positive (document why in the scenario file with a one-line comment).
3. Re-run, re-audit, repeat until clean.

This step is mandatory per the user request: "once the test is OK, ask the sip-stack analyser subagent for analysis of the generated global.txt report and address the report."

---

## Critical files

| Purpose | File |
|---------|------|
| New mock HTTP entrypoint | `bin/mock-call-control.ts` (NEW) |
| New helm chart | `tests/k8s/charts/mock-call-control/` (NEW) |
| Stack installer hook | [tests/k8s/fixtures/helm.ts](tests/k8s/fixtures/helm.ts), [tests/k8s/scripts/install-stack.ts](tests/k8s/scripts/install-stack.ts) |
| Worker `CALL_CONTROL_URL` wiring | [deploy/helm/b2bua-worker/values.yaml](deploy/helm/b2bua-worker/values.yaml), templates/statefulset.yaml |
| Cluster networking | [tests/k8s/cluster.yaml](tests/k8s/cluster.yaml) (adjust only if needed) |
| New runner | [tests/support/harness.ts](tests/support/harness.ts) (add `createHybridRunner`) |
| Live UDP transport (reused) | [tests/fullcall/framework/live-backend.ts](tests/fullcall/framework/live-backend.ts) |
| Scenario interpreter (reused) | [tests/fullcall/framework/interpreter.ts](tests/fullcall/framework/interpreter.ts) |
| Report writers (reused) | [tests/fullcall/framework/html-report.ts](tests/fullcall/framework/html-report.ts), [text-report.ts](tests/fullcall/framework/text-report.ts) |
| New scenarios | `tests/scenarios/registrar/k8s-register-call-bye.ts` (NEW), `k8s-register-call-reroute.ts` (NEW) |
| New test file | `tests/fullcall/e2e-register-fakeExt-realCore.test.ts` (NEW) |
| New external doc | `docs/test-api-external.md` (NEW) |
| X-Api-Call source of truth | [src/decision/adapters/http-reference/MockServer.ts](src/decision/adapters/http-reference/MockServer.ts) |
| Header propagation chain (slice 1 verification) | [src/b2bua/InitialInviteHandler.ts](src/b2bua/InitialInviteHandler.ts), [src/decision/adapters/http-reference/HttpReferenceAdapter.ts](src/decision/adapters/http-reference/HttpReferenceAdapter.ts) |

---

## Verification

End-to-end run sequence on a clean machine:

```bash
npm run typecheck                      # zero errors / zero warnings
npm run test:fake                      # existing fake-clock still green
npm run test:k8s:up                    # bring up kind cluster
tsx tests/k8s/scripts/install-stack.ts # installs redis + mock-call-control + worker + proxy
E2E_KIND=1 vitest run -c vitest.config.live.ts \
  tests/fullcall/e2e-register-fakeExt-realCore.test.ts
ls test-results/real-clock/registrarFrontProxy-kind/   # index.html + per-scenario reports
open test-results/real-clock/registrarFrontProxy-kind/index.html
npm run test:k8s:down                  # tear down
```

Then run the `sip-callflow-review` skill against the generated `*.global.txt`
and confirm zero outstanding anomalies.

For ongoing CI: gate the suite on `E2E_KIND=1` so it stays opt-in until
infra hosts can run kind reliably.

---

## Open risks (to revisit during implementation)

1. **Pod → host UDP routing.** Kind on Linux native may need explicit
   bridge-gateway configuration; on Docker Desktop `host.docker.internal`
   tends to "just work". Concrete plan in slice 3 is to attempt the
   default first and only adjust [tests/k8s/cluster.yaml](tests/k8s/cluster.yaml) if traffic doesn't flow.
2. **Registrar AOR collision for bob1/bob2** (slice 5). If the registrar
   is single-Contact-per-AOR, register them under distinct usernames
   (`bob1@kindlab`, `bob2@kindlab`) and let X-Api-Call's `destination`
   pick which one. Verify against [src/sip-front-proxy/Registrar.ts](src/sip-front-proxy/Registrar.ts) before slice 5.
3. **CALL_CONTROL_URL env wiring** may be missing from the worker helm
   template — found in slice 1 if so, fixed inline.
4. **HMAC routing cookie** is on by default in [deploy/helm/sip-front-proxy/values.yaml](deploy/helm/sip-front-proxy/values.yaml); make sure the install path provides a key (or set replicaCount=1 + disable cookie validation for the test).
