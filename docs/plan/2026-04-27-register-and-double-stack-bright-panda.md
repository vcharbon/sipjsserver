# REGISTER + Double-Stack on Front Proxy

## Slice progress

| Slice | Title                                                            | Status |
|-------|------------------------------------------------------------------|--------|
| 1     | Test stack: dual networks + per-network trace/report + register DSL | ✅ done |
| 2     | Proxy: Registrar + RegisterStrategy + CoreToExtRoutingStrategy + dual-endpoint ProxyCore | ✅ done |
| 3     | Integration tests under fake clock + reporting end-to-end        | ✅ done |

### Slice 3 outcome (committed)

Acceptance criteria all met:

- `npm run typecheck`: zero errors, zero warnings.
- `npm run test:fake`: **800 passed / 1 skipped** (797 prior + 3 new registrar e2e scenarios).
- HTML reports under `test-results/fake-clock/registrarFrontProxy/` show two-lane diagrams with `ext` (gray) and `core` (amber) network band labels. Per-network TXT files written to `ext/` and `core/` subfolders.

Reconciliation note: slice 1 had wired a *separate* simulated `SignalingNetwork` for `core` agents. Slice 2's `ProxyCore` registrar mode binds both endpoints on a *single* fabric (different IPs). Slice 3 collapsed slice 1's dual-fabric runtime to single-fabric — `agentConfig.network` now drives only the trace / report tag, not a different fabric instance. The "real-ext + simulated-core" hybrid the user originally flagged is preserved in the *type* surface but deferred until a deployment actually needs it.

What landed:

- New SUT layer [tests/support/registrarFrontProxyFakeStack.ts](tests/support/registrarFrontProxyFakeStack.ts) — composes `ProxyCore.Default` with `Registrar.inMemoryLayer` (single shared instance), `RegisterStrategy.inMemoryRegistrarLayer`, `CoreToExtRoutingStrategy.registrarLookupLayer`, and `RegistrarProxyConfig.layer({ coreBind, coreDestination })`. Fixed addresses: ext ingress `10.30.0.1:15060`, core ingress `10.40.0.1:15060`, core destination `10.40.0.10:5060`. Helpers `extIp(n)` / `coreIp(n)` for agent placement.
- `Sut` type in [tests/fullcall/framework/types.ts](tests/fullcall/framework/types.ts) gained `"registrarFrontProxy"`. Added to `ALL_SUTS`; deliberately excluded from `DEFAULT_APPLICABLE_SUTS` so legacy scenarios don't try to run on a SUT without a B2BUA.
- [tests/fullcall/framework/simulated-backend.ts](tests/fullcall/framework/simulated-backend.ts) — new SUT branch instantiates the registrar fake-stack and seeds participant labels `proxy(ext)` (network=ext) and `proxy(core)` (network=core) so the renderer paints both lanes correctly. `setup()` materialises only `ProxyCore` (no B2BUA/SipRouter/CallState).
- [tests/support/harness.ts](tests/support/harness.ts) — per-agent `targetFor` for the registrar SUT routes `network: "core"` agents to the proxy's core ingress; ext agents keep the ext ingress as the default destination.
- Three scenarios under [tests/scenarios/registrar/](tests/scenarios/registrar/), all `.runOn(["registrarFrontProxy"])`:
  - [register-happy-path.ts](tests/scenarios/registrar/register-happy-path.ts) — Alice (ext) `agent.register()`; expects 200 OK with echoed Contact at her IP and `Expires: 3600`.
  - [deregister-via-expires-zero.ts](tests/scenarios/registrar/deregister-via-expires-zero.ts) — Alice REGISTER → re-REGISTER `Expires: 0` (200 OK on both); core agent INVITE for `sip:alice@…` → 404 Not Found.
  - [ttl-expiry-under-testclock.ts](tests/scenarios/registrar/ttl-expiry-under-testclock.ts) — Alice REGISTER (default 3600s) → `s.pause(3601s)` → core agent INVITE for `sip:alice@…` → 404 Not Found via the lazy-expiry sweep.
- [tests/fullcall/e2e-fake-clock.test.ts](tests/fullcall/e2e-fake-clock.test.ts) — three new `it.effect` cases that run only on the `registrarFrontProxy` SUT.
- [tests/fullcall/framework/live-backend.ts](tests/fullcall/framework/live-backend.ts) — also reconciled to single-fabric for symmetry; drops the lazy second `SignalingNetwork.real`.

The headline bidirectional flow (Alice → core → proxy(bob) → Bob with full INVITE/200/ACK/BYE round-trip) the original plan flagged as a v1.1 follow-up remains deferred — slice 3 covers REGISTER + the rejection paths but not a successful cross-fabric call. That's the natural next ticket.

### Slice 2 outcome (committed)

Acceptance criteria all met:

- `npm run typecheck`: zero errors, zero warnings.
- `npm run test:fake`: 797 passed / 1 skipped (779 existing scenarios unchanged + 18 new registrar unit tests).
- All four new services landed; existing K8s-LB consumers continue to work via `noop` defaults.

What landed:

- New service [src/sip-front-proxy/Registrar.ts](src/sip-front-proxy/Registrar.ts) — userpart-keyed AOR → Contact store. `noopLayer` (lookup always `none`) and `inMemoryLayer` (lazy-TTL on Effect `Clock`).
- New strategy [src/sip-front-proxy/RegisterStrategy.ts](src/sip-front-proxy/RegisterStrategy.ts) — `noopLayer` returns 501; `inMemoryRegistrarLayer` parses To-URI userpart, computes effective Expires (header > Contact `;expires` param > default 3600), `Expires=0` removes, otherwise registers, and emits 200 OK with echoed Contact + Expires.
- New strategy [src/sip-front-proxy/CoreToExtRoutingStrategy.ts](src/sip-front-proxy/CoreToExtRoutingStrategy.ts) — `noopLayer` always 404s; `registrarLookupLayer` resolves the RURI userpart to a registered Contact and returns `forward { destination, ruriOverride }` or `reject { 404 / 400 }`.
- New config [src/sip-front-proxy/RegistrarProxyConfig.ts](src/sip-front-proxy/RegistrarProxyConfig.ts) — opt-in second-endpoint config (`coreBind`, `coreAdvertised*`, `coreDestination`); presence flips ProxyCore into dual-endpoint mode.
- Modified [src/sip-front-proxy/ProxyCore.ts](src/sip-front-proxy/ProxyCore.ts) — now requires `RegisterStrategy` + `CoreToExtRoutingStrategy`; reads `RegistrarProxyConfig` via `Effect.serviceOption`; binds a `core` `UdpEndpoint` when configured; ingress is per-endpoint forked with a `NetworkTag` (`"ext" | "core"`); REGISTER on ext always hands off to `RegisterStrategy.handle`; in dual mode INVITE-on-ext forwards to `coreDestination`, INVITE-on-core delegates to `CoreToExtRoutingStrategy.resolve`, in-dialog requests forward across the fabric boundary; egress Vias are stamped with `;net=<ingress>` so response routing pops them and replies on the matching endpoint.
- Consumer updates wired the noop strategy layers — every existing K8s-LB pathway still resolves without change in behaviour:
  - [bin/proxy.ts](bin/proxy.ts)
  - [tests/support/networkLeaves.ts](tests/support/networkLeaves.ts) — `proxyStackLayer` (used by sipproxyHA + proxy+b2b SUTs).
  - [tests/support/proxy-only-fakeStack.ts](tests/support/proxy-only-fakeStack.ts) — transit-only test fixture.
- New exports surfaced through [src/sip-front-proxy/index.ts](src/sip-front-proxy/index.ts) (`Registrar`, `RegisterStrategy`, `CoreToExtRoutingStrategy`, `RegistrarProxyConfig`, `NetworkTag`, `DEFAULT_EXPIRES_SEC`, `CoreToExtRouteOutcome`).
- Unit coverage in [tests/sip-front-proxy/registrar/](tests/sip-front-proxy/registrar/):
  - `Registrar.test.ts` — 7 tests (register/lookup round-trip, case-insensitive AOR, single-binding overwrite, remove, lazy expiry under `TestClock.adjust`, post-expiry re-register, noop contract).
  - `RegisterStrategy.test.ts` — 7 tests (default Expires=3600, header > param > default precedence, persistence into the Registrar, `Expires=0` removal, noop returns 501).
  - `CoreToExtRoutingStrategy.test.ts` — 4 tests (forward on hit, 404 on miss, 400 when RURI lacks userpart, noop always 404).

The end-to-end dual-endpoint flow (Alice REGISTER → ext, core INVITE for unregistered AOR → 404, TTL-expiry → 404) is exercised by slice 3's scenario tests, not by slice 2.

### Slice 1 outcome (committed)

Acceptance criteria all met:

- `npm run typecheck`: zero errors, zero warnings.
- `npm run test:fake`: 779 passed / 1 skipped (every existing scenario unchanged).
- Pre-existing live-clock limiter timeouts (4 tests) reproduce on `main` without these changes — verified by stashing — so they are unrelated to slice 1.

What landed:

- Types ([tests/fullcall/framework/types.ts](tests/fullcall/framework/types.ts)) — added `NetworkTag = "ext" | "core"`, `Participant`, `DEFAULT_NETWORK`. `AgentConfig.network?` defaults to `"ext"`. `TraceEntry.network` is now mandatory. `ScenarioResult.participants` changed from `string[]` to `ReadonlyArray<Participant>`. `TestTransport.participantNetwork?(ip, port)` for SUT-side resolution.
- DSL ([tests/fullcall/framework/recorder.ts](tests/fullcall/framework/recorder.ts)) — new `agent.register(opts?)` verb returning a `UacTransaction`. Defaults To/From to the agent's AOR and threads optional `Expires` header.
- Backends — lazy second `SignalingNetwork` (`core`) materialised via `Layer.build` only when an agent declares `network: "core"`; per-agent bind on the right fabric; per-(ip,port) network registry.
  - [tests/fullcall/framework/simulated-backend.ts](tests/fullcall/framework/simulated-backend.ts)
  - [tests/fullcall/framework/live-backend.ts](tests/fullcall/framework/live-backend.ts)
- Interpreter ([tests/fullcall/framework/interpreter.ts](tests/fullcall/framework/interpreter.ts)) — every `trace.push` (send / receive / internal hop / dangling / unexpected) now stamps `network` via `transport.participantNetwork` (when known) or `state.networkOf(participantName)`. `buildParticipantList` returns `Participant[]`.
- Reports — sequence diagram now paints contiguous-network background bands and labels them; per-agent `.txt` reports live under `outputDir/<network>/scenario.<agent>.txt`; index gains a "Networks" column.
  - [tests/fullcall/framework/svg-sequence-diagram.ts](tests/fullcall/framework/svg-sequence-diagram.ts)
  - [tests/fullcall/framework/text-report.ts](tests/fullcall/framework/text-report.ts)
  - [tests/fullcall/framework/html-report.ts](tests/fullcall/framework/html-report.ts)
- Compat fixup ([tests/sip-front-proxy/_report/runner.ts](tests/sip-front-proxy/_report/runner.ts)) — constructs `Participant[]` with `DEFAULT_NETWORK` to match the new `ScenarioResult` shape.
- Smoke coverage ([tests/fullcall/framework/register-network-smoke.test.ts](tests/fullcall/framework/register-network-smoke.test.ts)) — asserts `agent.register` produces a REGISTER `SendStep` with To/From=AOR and a parseable `Expires` header, and that a `core`-tagged trace round-trips into HTML (band label) + TXT (`core/` subfolder).

Slice 1 deliberately does **not** instantiate the `core` fabric in any production scenario — `coreNetwork` only materialises when a scenario explicitly opts in via `network: "core"`, which slice 2 will start doing once the registrar proxy binds its K8s-facing endpoint.

## Context

Today's `src/sip-front-proxy/` is a stateless front-proxy used by the K8s sticky LB path. The user wants a *separate operating mode* of that same proxy — a registrar + recursive proxy — that:

1. Accepts `REGISTER` from external UAs (Alice, Bob, …) and stores their AOR → Contact mapping in process memory.
2. Forwards external INVITEs to a single configured **core** IP (the K8s app server) without involving the registrar.
3. When the **core** later sends an INVITE back to the proxy with a registered userpart in the Request-URI, the proxy resolves the userpart against the registrar and forwards to the registered Contact.

The proxy faces this with **two independent SIP networks** ("ext" facing endpoints, "core" facing the K8s server). Either side can be the real UDP fabric or the simulated one in tests; they may even bind overlapping IPs since they are independent fabrics.

v1 focus is SIP correctness for the limited path above — no auth, no media, no NAT, no upstream registrar chaining.

## Decisions (locked during grilling)

| Topic | Decision |
|-------|----------|
| Module placement | Stays in `src/sip-front-proxy/`. Adds **two new orthogonal strategy services** + a **`Registrar` service**. ProxyCore composes them. |
| SIP role | **Pure stateful proxy with Record-Route.** No dialog splitting, no CSeq remap. |
| Networks | **Two independent `SignalingNetwork` instances**, "ext" and "core". |
| Egress network selection on responses | **Stamp `;net=ext|core` parameter** on the proxy's own Via on the way out; on response, read it from the popped top Via and send via the matching `UdpEndpoint`. No extra LRU. |
| Who is registrar | **Proxy is the registrar.** REGISTER terminates locally; **no Path (RFC 3327)**. |
| AOR key | **Userpart only** from To-URI (REGISTER) and Request-URI (INVITE-from-core), lowercased. *(User accepted the multi-tenant collision risk for v1.)* |
| Bindings per AOR | **Single, last-write-wins.** |
| Contact target stored | **Contact header URI verbatim** (no NAT rewriting). |
| TTL | **Lazy on read**, against Effect `Clock` (so TestClock advancement deterministically expires entries). |
| `Expires=0` (single-Contact) | **Accept and remove** the binding. |
| ext→ext registrar routing | **Not in v1.** All ext-ingress INVITEs go to core. |
| Trace shape | Add `network: 'ext'|'core'` to `TraceEntry`; **one merged HTML report** with per-network lane backgrounds; per-network TXT files. |
| Test scenarios in v1 | (1) REGISTER happy path; (2) Expires=0 deregistration; (3) TTL expiry under TestClock. |
| Configuration | Extend `src/config/` with `registrarProxy: { extBind, coreBind, coreDestination }`. |

### Explicitly out of scope (NOT assumed to work in v1 — flag in code/docs)

- Digest auth, RTP/media, TLS.
- `Min-Expires` / 423 Interval Too Brief.
- Wildcard de-registration (`Contact: *`).
- Multiple bindings per AOR (forking).
- RFC 3327 Path.
- RFC 5626 SIP outbound / instance-id / GRUU.
- NAT rewriting / `received` / `rport` stamping on Contact.
- Multi-tenant AOR keys (host part is ignored).
- ext→ext direct calls bypassing core.

## Architecture

### New services / strategies

All under `src/sip-front-proxy/`. Use the existing `ServiceMap.Service<T, API>()` pattern documented at [src/call/CallStateCache.ts:18-100](src/call/CallStateCache.ts).

1. **`Registrar`** (`src/sip-front-proxy/Registrar.ts`)
   - API: `register(userpart, contactUri, expiresSec) → Effect<Binding, never>`, `lookup(userpart) → Effect<Option<Binding>, never>`, `remove(userpart) → Effect<void, never>`.
   - Internal: `MutableHashMap<string, { contactUri: ParsedUri; expiresAtMs: number }>`. Lazy expiry on `lookup`/`register`: read `Clock.currentTimeMillis`, drop if past.
   - Two layers: `noop` (lookup always returns `None`, register returns immediately without storing — useful for the "registrar disabled" deployment), `inMemory`.

2. **`RegisterStrategy`** (`src/sip-front-proxy/RegisterStrategy.ts`)
   - API: `handle(req: SipRequest, ingress: NetworkTag) → Effect<SipResponse, never>`.
   - Variants:
     - `noop` — replies `501 Not Implemented` (or 405) regardless. The "we don't support REGISTER on this deployment" mode for the existing K8s LB binary.
     - `inMemoryRegistrar` — delegates to `Registrar.inMemory`. Parses To-URI userpart and Contact URI; computes effective Expires (`Expires` header > Contact `;expires` param > default **3600s**); if `Expires=0` calls `Registrar.remove`; else `Registrar.register`. Builds 200 OK echoing Contact + computed Expires via `generateResponse` ([src/sip/generators.ts:466](src/sip/generators.ts)).

3. **`CoreToExtRoutingStrategy`** (`src/sip-front-proxy/CoreToExtRoutingStrategy.ts`)
   - API: `resolve(req: SipRequest) → Effect<RouteOutcome, never>` where `RouteOutcome = { destination: { host, port } } | { reject: { status, reason } }`.
   - Variants: `registrarLookup` (uses `Registrar`; on `None` returns `{ reject: { status: 404, reason: "Not Found" } }`); `noop` (always rejects with 404). Future variants (`database`, `mix`) can plug in without changing ProxyCore.

   Kept orthogonal to `RegisterStrategy` so a future deployment can run "registrar=noop, coreToExt=database" or vice versa.

### `NetworkTag` + dual-endpoint `ProxyCore`

[src/sip-front-proxy/ProxyCore.ts:287-680](src/sip-front-proxy/ProxyCore.ts) currently runs one ingress loop on one `UdpEndpoint`. Changes:

- Type: `type NetworkTag = "ext" | "core"`.
- Construction takes **two `UdpEndpoint`s** (`ext`, `core`) instead of one. Still one ProxyCore instance.
- Ingress: merge both `endpoint.messages` streams into one tagged stream — `Stream.merge(ext.messages.map(p => ({ p, net: "ext" })), core.messages.map(...))` — and dispatch in a single loop. Preserves existing parse/MaxForwards/error handling.
- Dispatch table (request side):

  | Method | Ingress | Action |
  |--------|---------|--------|
  | REGISTER | ext | `RegisterStrategy.handle(req, "ext")` → reply on ext endpoint. |
  | REGISTER | core | Drop with `403 Forbidden` (registrar is ext-only). |
  | INVITE / dialog-creating | ext | Forward to `config.coreDestination`; insert RR; stamp Via with `;net=core`. Send on core endpoint. |
  | INVITE / dialog-creating | core | `CoreToExtRoutingStrategy.resolve(req)`: on success forward to resolved Contact; insert RR; stamp Via with `;net=ext`; send on ext endpoint. On reject build response, send back on core. |
  | In-dialog (ACK/BYE/CANCEL/reINVITE) | either | Existing behaviour — Route header / Via popping drives target. The `;net=` tag added when we record-routed determines egress. |

- Egress network selection on **responses** (existing path at `ProxyCore.ts:632-680`): when popping our own top Via, read `;net=` param. Use that endpoint's `send()`. If absent, fall back to ingress endpoint (legacy front-proxy mode unchanged).
- Existing K8s sticky strategy (`selectForNewDialog`) remains. The new strategies are *additional* hooks; deployments that don't use the registrar wire `RegisterStrategy=noop` and `CoreToExtRoutingStrategy=noop` and behaviour is identical to today.

### Test stack — dual networks and reporting

Following the user's constraint: **all stack-side gaps go in the test infra, not the proxy.**

- [tests/support/fakeStack.ts](tests/support/fakeStack.ts) and [tests/support/liveStack.ts](tests/support/liveStack.ts): build **two** `SignalingNetwork` instances tagged `ext` and `core`. Either side may be `real` or `simulated`; mixing is allowed (real ext + simulated core, etc.).
- [tests/support/harness.ts](tests/support/harness.ts): expose both fabrics; agents register against a specific fabric.
- [tests/fullcall/framework/dsl.ts](tests/fullcall/framework/dsl.ts) + [recorder.ts](tests/fullcall/framework/recorder.ts): extend `s.agent(name, cfg)` config with `network: "ext" | "core"`, default `"ext"`. Every existing test stays compiled and behaves identically.
- New DSL verb on `AgentProxy`: `agent.register({ uri, expires? })` → builds a REGISTER, sends over the agent's network, returns a transaction with `.expect(200)` etc. Mirrors the existing `agent.invite` shape so scenario authors pick it up immediately.
- [tests/fullcall/framework/types.ts](tests/fullcall/framework/types.ts) `TraceEntry`: add `network: "ext" | "core"`. `ScenarioResult.participants` becomes `ReadonlyArray<{ name: string; network: NetworkTag }>`.
- [tests/fullcall/framework/html-report.ts](tests/fullcall/framework/html-report.ts): SVG renderer groups participant lanes by network with a coloured background band; lane labels show network. Single timeline preserved (sorted by `timestamp`) so cause/effect across the proxy hop is visible.
- [tests/fullcall/framework/text-report.ts](tests/fullcall/framework/text-report.ts): keeps the global `.txt` (all events, ordered) and emits per-agent files in network-prefixed subfolders (e.g., `ext/alice.txt`, `core/coreServer.txt`). Index page shows the network column.

### Configuration

[src/config/](src/config/) gains a `registrarProxy` block:

```ts
registrarProxy: {
  extBind:         { host: string; port: number }
  coreBind:        { host: string; port: number }
  coreDestination: { host: string; port: number }
  // Strategy selection (defaults wire to `noop`/`noop` so existing
  // K8s LB deployments are byte-identical to today.)
  registerStrategy:    "noop" | "inMemoryRegistrar"
  coreToExtStrategy:   "noop" | "registrarLookup"
}
```

`main.ts` / `bin/proxy.ts` reads the block, builds two `UdpEndpoint`s, picks strategy layers, composes ProxyCore.

## Slicing (3 slices)

Each slice typechecks clean (`npm run typecheck` — zero errors, zero warnings) and the relevant test suite passes before moving on. Intermediate slices commit with a one-line message per project convention (CLAUDE.md "Commit policy").

### Slice 1 — Test stack: dual networks + per-network trace/report

Goal: every existing test still passes; harness now supports two networks; reports gain a network dimension; **no proxy code changed.**

- Add `NetworkTag` to test framework types.
- Build two `SignalingNetwork` instances in fake & live stacks; expose tagged.
- Extend `s.agent()` config; default `"ext"`; thread `network` through to `UdpEndpoint` binding.
- Add `network` to `TraceEntry`, `ScenarioResult.participants`.
- Update HTML/TXT/console report writers to render lanes/sections by network.
- Add `agent.register(...)` DSL verb (just message construction + send/expect; no proxy interaction yet — verify by sending REGISTER between two agents on the same network and asserting the raw bytes).

Acceptance: every test in `tests/fullcall/e2e-fake-clock.test.ts` and `tests/fullcall/e2e-real-clock.test.ts` still passes. New unit-level test confirms `agent.register` produces a parseable REGISTER message and that traces tagged with `network` round-trip into HTML/TXT.

### Slice 2 — Proxy: Registrar + RegisterStrategy + CoreToExtRoutingStrategy + dual-endpoint ProxyCore

Goal: the front proxy can run in registrar mode; legacy K8s LB mode unchanged.

- New service `Registrar` with `noop` and `inMemory` layers (lazy-TTL on Effect `Clock`).
- New service `RegisterStrategy` with `noop` and `inMemoryRegistrar` layers.
- New service `CoreToExtRoutingStrategy` with `noop` and `registrarLookup` layers.
- Modify [src/sip-front-proxy/ProxyCore.ts](src/sip-front-proxy/ProxyCore.ts) to bind two `UdpEndpoint`s, merge ingress streams, dispatch by `(method, networkTag)` per the table above, stamp `;net=` on egress Vias, read `;net=` on responses to choose egress endpoint.
- Extend [src/config/](src/config/) with the `registrarProxy` block + defaults that preserve current behaviour when the new strategies are `noop`.
- Wire new strategies in [src/main.ts](src/main.ts) / [bin/proxy.ts](bin/proxy.ts).
- Reuse [src/sip/generators.ts](src/sip/generators.ts) `generateResponse` for the REGISTER 200 OK.

Acceptance: `npm run typecheck` clean; `npm run test:fake` still green for all existing scenarios; new unit tests for `Registrar` (register, lookup, remove, lazy expiry under TestClock) and for `RegisterStrategy.inMemoryRegistrar` (response shape: 200 OK with Contact + computed Expires).

### Slice 3 — Integration tests under fake clock + reporting end-to-end

Goal: the three v1 scenarios run as fake-stack tests using both networks, and the merged HTML/TXT report shows the cross-network flow.

- New SUT label (e.g. `registrarFrontProxy`) layered into [tests/fullcall/e2e-fake-clock.test.ts](tests/fullcall/e2e-fake-clock.test.ts) with the two-endpoint ProxyCore composition.
- Scenario modules under [tests/scenarios/registrar/](tests/scenarios/) for:
  1. **register-happy-path**: Alice on `ext` REGISTERs; expect 200 OK; assert response has Contact and `Expires: 3600`.
  2. **deregister-via-expires-zero**: Alice REGISTERs; Alice REGISTERs again with `Expires: 0`; "core" agent on `core` network sends INVITE for `sip:alice@…`; expect `404 Not Found`.
  3. **ttl-expiry-under-testclock**: Alice REGISTERs; advance TestClock by 3601s; "core" agent sends INVITE for alice; expect `404 Not Found`.

Acceptance: `npm run test:fake` green; HTML reports under `test-results/fake-clock/registrarFrontProxy/` show two-lane diagrams with both networks visible; per-network TXT files written.

## Verification

After all three slices:

```bash
npm run typecheck     # zero errors, zero warnings
npm run test:fake     # all existing + 3 new registrar scenarios green
npm run test          # short-tier live tests still green (regression check on legacy front-proxy)
npm run dev           # smoke-start; manual REGISTER from sipsak/sip-cli optional
```

Open the generated `test-results/fake-clock/registrarFrontProxy/index.html`; confirm per-scenario diagrams render with `ext` and `core` lanes coloured distinctly.

## Critical files

To create:

- [src/sip-front-proxy/Registrar.ts](src/sip-front-proxy/Registrar.ts)
- [src/sip-front-proxy/RegisterStrategy.ts](src/sip-front-proxy/RegisterStrategy.ts)
- [src/sip-front-proxy/CoreToExtRoutingStrategy.ts](src/sip-front-proxy/CoreToExtRoutingStrategy.ts)
- [tests/scenarios/registrar/register-happy-path.ts](tests/scenarios/registrar/register-happy-path.ts)
- [tests/scenarios/registrar/deregister-via-expires-zero.ts](tests/scenarios/registrar/deregister-via-expires-zero.ts)
- [tests/scenarios/registrar/ttl-expiry-under-testclock.ts](tests/scenarios/registrar/ttl-expiry-under-testclock.ts)

To modify:

- [src/sip-front-proxy/ProxyCore.ts](src/sip-front-proxy/ProxyCore.ts) — dual endpoints, dispatch by `(method, network)`, `;net=` tagging on egress Vias, read tag on responses.
- [src/config/](src/config/) — add `registrarProxy` block.
- [src/main.ts](src/main.ts) / [bin/proxy.ts](bin/proxy.ts) — wire new layers and dual binds.
- [tests/support/fakeStack.ts](tests/support/fakeStack.ts), [tests/support/liveStack.ts](tests/support/liveStack.ts), [tests/support/harness.ts](tests/support/harness.ts) — expose two networks.
- [tests/fullcall/framework/dsl.ts](tests/fullcall/framework/dsl.ts), [tests/fullcall/framework/recorder.ts](tests/fullcall/framework/recorder.ts) — `network` field on `s.agent`, `agent.register(...)` verb.
- [tests/fullcall/framework/types.ts](tests/fullcall/framework/types.ts) — `network` on `TraceEntry`, `ScenarioResult.participants` shape.
- [tests/fullcall/framework/html-report.ts](tests/fullcall/framework/html-report.ts), [tests/fullcall/framework/text-report.ts](tests/fullcall/framework/text-report.ts), [tests/fullcall/framework/report.ts](tests/fullcall/framework/report.ts) — render network-aware output.
- [tests/fullcall/e2e-fake-clock.test.ts](tests/fullcall/e2e-fake-clock.test.ts) — new SUT label and registrar scenario list.

To reuse (do not re-implement):

- `generateResponse` at [src/sip/generators.ts:466-515](src/sip/generators.ts) for REGISTER 200 OK and CoreToExt 404.
- Contact / URI helpers in [src/sip/parsers/custom/structured-headers.ts](src/sip/parsers/custom/structured-headers.ts) and [src/sip/MessageHelpers.ts](src/sip/MessageHelpers.ts) for parsing Contact + RURI.
- Existing Via-stamping / RR-insertion / MaxForwards code paths in [src/sip-front-proxy/ProxyCore.ts:600-630](src/sip-front-proxy/ProxyCore.ts).
- `ServiceMap.Service<T, API>()` + `MutableHashMap` + Effect `Clock` pattern from [src/call/CallStateCache.ts](src/call/CallStateCache.ts).

## Known gap to flag for follow-up

The chosen v1 test set deliberately omits the **headline bidirectional flow** (Alice → core → proxy(bob) → Bob → 200 OK → ACK → BYE). The cross-network egress-Via-tag logic in slice 2 is therefore exercised in slice 3 only on the rejection paths (404). Recommend a v1.1 follow-up scenario covering the full call once v1 lands, before any second consumer of the dual-stack proxy is wired.
