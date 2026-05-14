# Cleanup: registrarFrontProxy-kind reporting (fake-ext / real-core)

## Scope

**In scope:** `k8s-register-smoke` + `k8s-register-call-bye`. Get these two fully clean before touching anything else.

**Out of scope this pass:** `k8s-register-call-reroute` is currently failing for unrelated reasons. We will leave its `it.live` in place but mark it `.skip` (or `.fails`) until the cleanup is proven on smoke + call-bye and the reroute failure is investigated separately.

## Context

The test file [tests/fullcall/e2e-register-fakeExt-realCore.test.ts](tests/fullcall/e2e-register-fakeExt-realCore.test.ts) advertises a hybrid topology — alice/bob/proxy(ext) on a **fully simulated in-memory fabric**, proxy(core) ↔ k8s-ingress on **real UDP**. The current implementation does not match the name: both halves use `SignalingNetwork.realTracing`, which forces every "fake" agent through the kernel and exposes the runner to WSL's source-address rewriting. The three reports under [test-results/real-clock/registrarFrontProxy-kind/](test-results/real-clock/registrarFrontProxy-kind/) all show the same family of symptoms — easiest to spot on the 3-row smoke trace:

```
[T+0.000s] alice (172.20.0.1:25060) → proxy(ext) (172.20.0.1:25080) ── REGISTER
[T+0.005s] B2BUA (10.255.255.254:25080) → alice (172.20.0.1:25060) ── 200 OK   ← spurious "B2BUA" label, WSL-substituted src IP
[T+0.005s] proxy(ext) (0.0.0.0:25080) → 10.255.255.254:25060 ── 200 OK         ← duplicate of row 2 with the other half-broken endpoint label
```

The primary observability requirement: **rows must show the actual src/dst IP:port used at the fabric layer**. Labels (`alice`, `proxy(ext)`, etc.) are a nice-to-have on top.

Two distinct cleanup needs combine here:

1. The "fake" half (alice ↔ proxy(ext) ↔ bob) must run on a true simulated fabric where we pick arbitrary synthetic IPs (no kernel involvement, no WSL substitution, no kind dependence).
2. The "real" half (proxy(core) ↔ k8s-ingress) must bind on a specific advertised IP — your `sipp -i 172.27.217.175` invocation already proves that path works without `0.0.0.0`.

Side question — *why doesn't Alice send the INVITE directly to `172.20.255.250:5060` with a Route header to the proxy?* The in-process proxy IS the SUT. Sending the INVITE elsewhere would skip the registrar lookup (the proxy resolves `sip:bob@kindlab` → bob's Contact via the in-memory `Registrar`) and would hide the very hop the test is meant to validate. The current "outbound proxy" pattern (Request-URI = AOR, next-hop = proxy) is the textbook setup; keep it.

## Constraint check

`makeProxyCore` at [src/sip-front-proxy/ProxyCore.ts:248](src/sip-front-proxy/ProxyCore.ts#L248) reads ONE `SignalingNetwork` and binds both `extEndpoint` (line 264) and `coreEndpoint` (line 292) against it. To put the ext endpoint on a simulated fabric and the core endpoint on a real fabric, we need a second `SignalingNetwork` service tag the proxy can consume **optionally** for its core bind. Existing single-network deployments (`bin/proxy.ts`, the fake-clock fakestack) must keep working unchanged.

## Approach

### Step 1 — Add an optional second network tag for the core endpoint

In [src/sip/SignalingNetwork.ts](src/sip/SignalingNetwork.ts), add a sibling `ServiceMap.Service` tag `SignalingNetworkCore` with the same shape as `SignalingNetwork`. No new implementation: every layer factory we already have (`real`, `realTracing`, `simulated`) gets a `*Core` variant that builds the same underlying impl but provides the `SignalingNetworkCore` tag. Keep the existing `SignalingNetwork` tag as-is for the ext endpoint.

In [src/sip-front-proxy/ProxyCore.ts:248-305](src/sip-front-proxy/ProxyCore.ts#L248-L305):
- Keep reading `SignalingNetwork` for the ext bind (line 264).
- Add `const coreNetworkOpt = yield* Effect.serviceOption(SignalingNetworkCore)` near the existing `registrarCfgOpt` read.
- When `registrarCfgOpt` is `Some`, bind the core endpoint against `Option.getOrElse(coreNetworkOpt, () => network)`. → Single-network callers (bin/proxy, the fake fakestack) still get both endpoints on one fabric. Dual-fabric callers (this hybrid runner) get split fabrics.
- Add `SignalingNetworkCore` to `makeProxyCore`'s requirements as an OPTIONAL service (via `Effect.serviceOption`). Nothing in the requirement union changes because the read is optional.

### Step 2 — Wire the hybrid runner with two fabrics

In [src/test-harness/hybrid-runner.ts](src/test-harness/hybrid-runner.ts):

- **ext fabric**: `SignalingNetwork.simulated({ transitDelayMs: 0 })`. alice, bob, and the proxy's ext endpoint bind here on **deliberately distinctive synthetic addresses** so the report instantly reads as "fake fabric" — no overlap with kind, WSL, or any real network range. Convention for this harness:
  - `proxy(ext)` (the B2B-facing endpoint): **`5.1.0.1:15060`**
  - alices: **`5.1.1.<n>:15060`** (e.g. alice = `5.1.1.1`, alice2 = `5.1.1.2`, …)
  - bobs:   **`5.1.2.<n>:15060`** (e.g. bob   = `5.1.2.1`, bob2   = `5.1.2.2`, …)
  - **No** `0.0.0.0` anywhere on the fake fabric. Every endpoint binds on its assigned `5.1.x.y`. The simulated fabric is in-memory so the addresses don't need to be bindable on the kernel; we're free to pick anything.
  - We deliberately do **not** reuse the `extIp(n)` helper from [tests/support/registrarFrontProxyFakeStack.ts:68](tests/support/registrarFrontProxyFakeStack.ts#L68) — that one's `10.30.0.x` overlaps with normal RFC1918 ranges and is easy to confuse for a real container IP. `5.1.x.x` is intentionally exotic.
- **core fabric**: `SignalingNetworkCore.realTracing`. proxy(core) binds here on the kind-bridge gateway IP discovered by `discoverHostReachableIp` (today `172.20.0.1`, which IS a bindable local interface on WSL). Bind host == advertised host, **never** `0.0.0.0`.
- **core destination** (where the proxy forwards ext-INVITEs into the cluster): change the default from the kind hostPort `127.0.0.1:5060` to the in-cluster MetalLB VIP **`172.20.255.250:5060`**. That's the address `sipp -s uac 172.20.255.250:5060 -i 172.27.217.175 -p 9999` already reaches successfully, and it's how external traffic actually enters the SBC in production-shaped tests (no NodePort hop). Update both:
  - [hybrid-runner.ts:230-231](src/test-harness/hybrid-runner.ts#L230-L231): `kindHost = opts.kindHost ?? "172.20.255.250"`, `kindPort = opts.kindPort ?? 5060`.
  - [tests/fullcall/e2e-register-fakeExt-realCore.test.ts:47-48](tests/fullcall/e2e-register-fakeExt-realCore.test.ts#L47-L48): `process.env.E2E_KIND_PROXY_HOST ?? "172.20.255.250"`.
  - The label registered for this address becomes `"k8s-ingress" → 172.20.255.250:5060`.
- `createLiveTransport` already uses `useExternalNetwork: true` and reads `SignalingNetwork` from scope — that becomes the simulated fabric, and alice/bob bind there. No change needed in live-backend.ts for ext.
- Replace the `createLiveTransport({ bindIp: "0.0.0.0", advertisedIp, ...})` call with the simulated-fabric defaults (`bindIp` unused; each agent's config supplies its own `5.1.x.y` IP). `advertisedIp` becomes a per-fabric concept and is only relevant for the core endpoint.
- The labels map shrinks to: `5.1.0.1:15060 → proxy(ext)`, `<advertisedIp>:<corePort> → proxy(core)`, `<kindHost>:<kindPort> → k8s-ingress`. alice/bob get their labels registered by the live-backend's per-agent loop automatically.

### Step 3 — Update the two in-scope scenarios with the `5.1.x.x` IPs

In [tests/scenarios/registrar/k8s-register-smoke.ts](tests/scenarios/registrar/k8s-register-smoke.ts):

```ts
const alice = s.agent("alice", {
  uri: "sip:alice@kindlab",
  ip: "5.1.1.1",
  port: 15060,
})
```

In [tests/scenarios/registrar/k8s-register-call-bye.ts](tests/scenarios/registrar/k8s-register-call-bye.ts):

```ts
const alice = s.agent("alice", { uri: "sip:alice@kindlab", ip: "5.1.1.1", port: 15060 })
const bob   = s.agent("bob",   { uri: "sip:bob@kindlab",   ip: "5.1.2.1", port: 15060 })
```

The `X-Api-Call` destination in call-bye was hard-coded to `ctx.agent("alice").ip` + `PROXY_CORE_PORT`. That was a coincidence — alice's IP happened to be the same as the proxy's bind under the old all-real-UDP design. With split fabrics it's wrong: `ctx.agent("alice").ip` is now `5.1.1.1` (ext fabric), but the b2bua-worker needs to reach the proxy's core endpoint on the real fabric. Switch the call-bye scenario to read the runner-provided core advertised address. Easiest path: expose `proxyCoreAdvertised: SocketAddr` through the scenario build context (extend [src/test-harness/framework/types.ts](src/test-harness/framework/types.ts) `BuildContext` and have the interpreter populate it from the runner), and use `ctx.proxyCoreAdvertised` in the build. If extending the DSL is too disruptive, the alternative is to import `hybridProxyCoreDestination(advertisedIp, corePort)` from the runner at scenario load time — slightly hackier but zero DSL churn.

**Reroute scenario:** mark `it.live(... k8sRegisterCallReroute ...)` in [tests/fullcall/e2e-register-fakeExt-realCore.test.ts:65-69](tests/fullcall/e2e-register-fakeExt-realCore.test.ts#L65-L69) as `.skip` with a TODO comment pointing at the pre-existing failure. Do **not** touch the reroute scenario file.

### Step 4 — Merge two trace buffers in the runner

[hybrid-runner.ts:315-328](src/test-harness/hybrid-runner.ts#L315-L328) drains a single network's trace. Change `drainNetworkTrace` to drain BOTH (ext + core), concatenate, sort by `sentMs`, and re-run the existing dedup + label-known filter on the merged stream. Both fabrics record into independent buffers; nothing else needs to change.

### Step 5 — Drop the now-obsolete `0.0.0.0` and gateway-IP fallbacks

After step 2, the `0.0.0.0:port` and (gateway-IP):port entries in the labels/networks maps are dead. Remove them so the next reader doesn't think we need them. Update the header comment on `hybrid-runner.ts` to describe the dual-fabric model.

### Step 6 — Verify the two in-scope reports

Run the two scenarios and confirm each report:
- Smoke: exactly 2 rows. Both rows show synthetic IPs on both sides (`5.1.1.1:15060 ↔ 5.1.0.1:15060`).
- Call-bye: ext rows on `5.1.1.x ↔ 5.1.0.1:15060 ↔ 5.1.2.x`, core rows on `<bridge-gw>:<corePort> ↔ 172.20.255.250:5060` (real fabric, MetalLB VIP). No `10.255.255.254` anywhere, no `B2BUA` label on identified hops, no `0.0.0.0`.

## What stays untouched

- The proxy's request-handling logic ([ProxyCore.ts:370-410](src/sip-front-proxy/ProxyCore.ts#L370-L410) and the `handleRequestRegistrarMode` / `Registrar` / strategies) — behavior is unchanged.
- The HTML/SVG renderer and text-report writer.
- The `realTracing` and `simulated` implementations in SignalingNetwork.ts (only the new `*Core` sibling tag/layers are added).
- `bin/proxy.ts` and the production wiring (no `SignalingNetworkCore` is provided → proxy reuses the single network for both endpoints, as today).
- The fake-clock `tests/support/registrarFrontProxyFakeStack.ts` (same — no core network provided).

## Files to modify

- [src/sip/SignalingNetwork.ts](src/sip/SignalingNetwork.ts) — add `SignalingNetworkCore` service tag and `*Core` layer factories (~30 lines, purely additive).
- [src/sip-front-proxy/ProxyCore.ts](src/sip-front-proxy/ProxyCore.ts) — read optional `SignalingNetworkCore` and use it for the core bind (~10 lines).
- [src/test-harness/hybrid-runner.ts](src/test-harness/hybrid-runner.ts) — split fabrics, simulated ext defaults, merged drain.
- [src/test-harness/hybrid-stacks/registrar-front-proxy.ts](src/test-harness/hybrid-stacks/registrar-front-proxy.ts) — comment updates only; the layer continues NOT to bundle a network, it just now expects two from the surrounding scope.
- [tests/scenarios/registrar/k8s-register-smoke.ts](tests/scenarios/registrar/k8s-register-smoke.ts) — add `ip: "5.1.1.1"` + `port: 15060` to alice.
- [tests/scenarios/registrar/k8s-register-call-bye.ts](tests/scenarios/registrar/k8s-register-call-bye.ts) — `ip: "5.1.1.1"` for alice, `ip: "5.1.2.1"` for bob; fix the `X-Api-Call` destination to use the proxy-core advertised address.
- [tests/fullcall/e2e-register-fakeExt-realCore.test.ts](tests/fullcall/e2e-register-fakeExt-realCore.test.ts) — `.skip` the reroute `it.live` with a TODO comment.

Plus thread a small new accessor `ctx.proxyCoreAdvertised` (or equivalent) into the DSL's build context — required by call-bye/reroute. If we don't want to extend the DSL, the scenarios can read a module-level constant (the runner exposes it already via `hybridProxyCoreDestination` in the same file).

## Verification

```bash
npm run typecheck                                  # zero errors AND zero warnings (Effect plugin included)
npm run test                                       # fake stack must still pass (proves single-network mode unchanged)
npm run test:k8s:up                                # idempotent
E2E_KIND=1 vitest run -c vitest.config.live.ts \
  tests/fullcall/e2e-register-fakeExt-realCore.test.ts
```

For each report:
1. Open `<name>.global.txt`. Confirm src/dst columns show the actual fabric IPs we picked (smoke uses `5.1.x.x` on ext only; call-bye additionally shows `<bridge-gw>:<corePort>` and `172.20.255.250:5060` on core hops).
2. No row has `10.255.255.254` on either side. No row has `0.0.0.0`.
3. Smoke row count = 2. For call-bye, compare row count to today's report — every row removed in the cleaned output must be a duplicate (same packet, same CSeq+branch+method, opposite-perspective dup).
4. Open the HTML. SVG lanes should be `alice`, `bob`, `proxy(ext)`, `proxy(core)`, `k8s-ingress` (and the synthesised `B2BUA` for in-cluster hops the proxy never sees, which is correct).

Bind-feasibility + reachability sanity check before running the live tests:
```bash
docker network inspect kind --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'      # bridge gateway, used for proxy(core) bind
ip -4 addr show | grep "$(docker network inspect kind --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')"
sipp -s ping 172.20.255.250:5060 -i <bridge-gw> -p 9999 -m 1 -timeout 2s              # confirm MetalLB VIP responds
```
The bridge gateway IP must appear on a local interface (we bind proxy(core) there). The VIP `172.20.255.250:5060` must be reachable (that's where the proxy forwards to). If either fails, expose a `coreBindIp` option on `HybridRunnerOptions` so the user can override.

## Out of scope (explicit follow-ups)

- Extracting `createRegistrarTestProxyRunner` into a dedicated `src/test-harness/registrar-front-proxy/` module with a clean public surface.
- Parameterising alice/bob count, per-agent advertised IPs, multiple registrations per AOR.
- An external-consumer doc covering the harness usage pattern.
- A simulated fabric that can selectively bridge specific addresses to real UDP (would unify into a single trace buffer but is a much bigger change).
