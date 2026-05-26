# Non-record-routing registrar proxy mode

## Context

The existing `ProxyCore` registrar mode (see [src/sip-front-proxy/ProxyCore.ts:1592-1687](../../src/sip-front-proxy/ProxyCore.ts)) does two things that the user wants to drop in a new deployment shape:

1. **Inserts Record-Route** on dialog-creating requests (single RR when ext/core advertise the same address, double RR when they differ). This keeps every in-dialog request flowing back through the proxy.
2. **Rewrites the Request-URI** on registrar-resolved INVITEs from the original `sip:bob@kindlab` to the registered Contact `sip:bob@<bob-ip>:<bob-port>` via `RouteOutcome.forward.ruriOverride`.

The user wants a second deployment mode of the same `ProxyCore` that:
- **Does NOT insert Record-Route** — once the dialog is set up, in-dialog traffic (ACK, re-INVITE, BYE) goes peer-to-peer via each side's Contact and the proxy is out of the loop.
- **Does NOT rewrite RURI** — the lookup still uses the AOR userpart to find the binding, but only the wire-level destination (host/port) comes from the Contact. The original RURI passes through untouched.

The RURI-rewrite change applies to **both** modes (project is not in production, ADR-style behavioral changes are acceptable). The Record-Route change is gated by a new required config flag.

The mode must be reachable to external library consumers via the existing test-harness API surface ([src/test-harness/index.ts](../../src/test-harness/index.ts)) — they need a way to wire either mode with their own network-layer composition (single-fabric all-real, dual-fabric, all-fake) without `createRegistrarTestProxyRunner` making magic decisions on their behalf.

## Decisions locked with user

| # | Decision | Detail |
|---|---|---|
| 1 | New config flag | `RegistrarProxyConfig.recordRoute: boolean`, **required** (no default). |
| 2 | RURI rewrite removal | Drop `ruriOverride` from `RouteOutcome.forward` entirely; applies to both modes. |
| 3 | RR insertion gate | Only the registrar-mode RR block (`ProxyCore.ts:1656-1687`). Legacy K8s-LB RR (`ProxyCore.ts:1061-1077`) is untouched. |
| 4 | No new SUT | The `registrarFrontProxy` SUT stays the only registrar-proxy SUT. Mode is selected at layer-config time. |
| 5 | Fake-clock no-RR test wiring | Direct `it.effect` test, not via the `runOn`-driven harness — composes the layer factory itself. |
| 6 | Hybrid runner API | Extend existing `createRegistrarTestProxyRunner` / `createHybridRunner` with optional `extNetworkLayer` / `coreNetworkLayer` / `traceSequencer` opts and **required** `recordRoute`. Defaults preserve today's dual-fabric (simulated ext + real-tracing core) when network layers are omitted. |
| 7 | Public API expansion | Re-export `SignalingNetwork`, `SignalingNetworkCore`, `makeEventSequencer`, and the relevant trace types from `src/test-harness/index.ts`. |

## Code changes — file by file

### `src/sip-front-proxy/RegistrarProxyConfig.ts`
Add `recordRoute: boolean` to `RegistrarProxyConfigData`. No default in the `layer` factory — callers must supply it.

### `src/sip-front-proxy/CoreToExtRoutingStrategy.ts`
- Drop the `ruriOverride` field from `RouteOutcome.forward`.
- Update `RouteOutcome.forward` constructor signature to `(destination: SocketAddr) => RouteOutcome`.
- `registrarLookupLayer.resolve` returns `RouteOutcome.forward(destination)` — destination still derived from the parsed Contact URI's host/port.

### `src/sip-front-proxy/ProxyCore.ts`
- Around line 1575: remove `let ruriOverride: string | undefined`.
- Around line 1598: drop the `ruriOverride = outcome.ruriOverride` assignment in the core-INVITE branch.
- Around lines 1656-1687: wrap the dialog-creating Record-Route insertion block with `if (registrarCfg.recordRoute) { ... }`. The `populateReceivedRportOnTopVia` and Via push that follow stay unconditional.
- Around line 1710: simplify `finalReq` to `{ ...req, headers: nextHeaders } as SipRequest` — drop the `ruriOverride !== undefined` ternary.
- The `registrarCfg` service handle is already in scope (used to read `coreDestination` at 1591); add `recordRoute` to the destructure / read.

### `src/sip-front-proxy/index.ts`
No changes — `RegistrarProxyConfig` is already exported, and `RouteOutcome` shape changes are internal-facing.

### `tests/sip-front-proxy/registrar/CoreToExtRoutingStrategy.test.ts`
Line 52: drop the `expect(outcome.ruriOverride).toBe(...)` assertion. Remaining `outcome.destination` assertions stay.

### `tests/support/registrarFrontProxyFakeStack.ts`
Add `recordRoute: boolean` to `RegistrarFrontProxyFakeStackOpts`. Thread into `RegistrarProxyConfig.layer({ ..., recordRoute: opts.recordRoute })`.

### `src/test-harness/hybrid-stacks/registrar-front-proxy.ts`
Add `recordRoute: boolean` to `RegistrarFrontProxyHybridStackOpts`. Thread into `RegistrarProxyConfig.layer`.

### `tests/fullcall/framework/simulated-backend.ts`
At the `registrarFrontProxy` SUT branch (around line 244), pass `recordRoute: true` to `registrarFrontProxyFakeStackLayer({ config, recordRoute: true })` — preserves today's behavior for all scenarios wired through this branch.

### `tests/sip-front-proxy/registrar-503-on-drop.test.ts`
At its call to `registrarFrontProxyFakeStackLayer`, pass `recordRoute: true` explicitly.

### `src/test-harness/hybrid-runner.ts`
- Extend `HybridRunnerOptions` with: `recordRoute: boolean` (required); optional `extNetworkLayer: Layer<SignalingNetwork>`, `coreNetworkLayer?: Layer<SignalingNetworkCore>`, `traceSequencer?: NetworkTraceSequencer`.
- Extend `RegistrarTestProxyRunnerOptions` with the same fields.
- When `extNetworkLayer` / `coreNetworkLayer` are omitted, fall back to the current defaults (`SignalingNetwork.simulated({ transitDelayMs: 0, traceSequencer })` and `SignalingNetworkCore.realTracing({ traceSequencer })`).
- When `coreNetworkLayer` is explicitly omitted but `extNetworkLayer` is provided, the proxy reuses `SignalingNetwork` for both endpoints (existing fallback, see comment at [src/test-harness/hybrid-stacks/registrar-front-proxy.ts:21-23](../../src/test-harness/hybrid-stacks/registrar-front-proxy.ts)). Verify this fallback exists in `ProxyCore.bindEndpoints`.
- Thread `recordRoute` into `registrarFrontProxyHybridStackLayer`.

### `tests/fullcall/e2e-register-fakeExt-realCore.test.ts`
Update the `createHybridRunner` / `createRegistrarTestProxyRunner` call site to pass `recordRoute: true`.

### `src/test-harness/index.ts`
Add re-exports:
- `SignalingNetwork` and `SignalingNetworkCore` (Tag classes with their static `realTracing` / `simulated` factories) from `src/sip/SignalingNetwork.ts`.
- `makeEventSequencer` from `src/test-harness/framework/EventSequencer.ts`.
- Types: `NetworkTraceSequencer`, `NetworkTraceEntry`.

### New: `tests/scenarios/registrar/k8s-register-call-bye-noRr.ts`
Variant of the existing [k8s-register-call-bye.ts](../../tests/scenarios/registrar/k8s-register-call-bye.ts). Same call flow but built to assert (via merged trace inspection) that no proxy Via/RR sits on the in-dialog ACK and BYE.

### New: `tests/fullcall/e2e-register-noRr-realFabric.test.ts`
- Wires `createRegistrarTestProxyRunner` with `recordRoute: false`, single-fabric all-real:
  - `extNetworkLayer: SignalingNetwork.realTracing({ traceSequencer })`
  - `coreNetworkLayer` omitted (ProxyCore reuses ext fabric)
  - Both proxy endpoints + alice/bob bind on the bridge-gateway IP (discovered via `discoverHostReachableIp`) on distinct ports
- Runs the `k8s-register-call-bye-noRr` scenario.

### New: `tests/fullcall/e2e-fake-clock-noRr.test.ts`
Direct `it.effect` test (no SUT harness). Wires `registrarFrontProxyFakeStackLayer({ config, recordRoute: false })` and runs a full alice ↔ bob lifecycle: REGISTER both, alice INVITE (from ext for `sip:bob@<core-ingress>`), bob receives via the core-side AOR lookup (bob registered from core side per the existing `core-call-to-registered-ext` topology), full 100/180/200/ACK/hold/BYE/200. Asserts via drained trace that ACK and BYE bypass the proxy participants.

## Public API surface for external consumers

After the change, external library users can wire any topology:

```ts
import {
  createRegistrarTestProxyRunner,
  SignalingNetwork,
  SignalingNetworkCore,
  makeEventSequencer,
} from "@vcharbon/sipjs/test-harness"

// Single-fabric all-real, no-RR mode
const seq = makeEventSequencer()
const runner = createRegistrarTestProxyRunner({
  coreDestination: { host: "10.0.1.5", port: 5060 },
  advertisedIp: "10.0.1.10",
  recordRoute: false,
  extNetworkLayer: SignalingNetwork.realTracing({ traceSequencer: seq }),
  // coreNetworkLayer omitted -> proxy reuses ext fabric
  traceSequencer: seq,
})

// Existing dual-fabric, RR mode (back-compat path — omit network layers)
const runner = createRegistrarTestProxyRunner({
  coreDestination: { host: "10.0.1.5", port: 5060 },
  advertisedIp: "10.0.1.10",
  recordRoute: true,
})
```

## Commit plan

| # | Title | Files | Rationale |
|---|---|---|---|
| 1 | `proxy: drop ruriOverride; preserve original RURI on registrar resolve` | `CoreToExtRoutingStrategy.ts`, `ProxyCore.ts`, `CoreToExtRoutingStrategy.test.ts`, doc comments | Smallest signature change; existing scenarios pass (no header assertions depend on the rewrite). |
| 2 | `proxy: add required recordRoute flag to RegistrarProxyConfig` | `RegistrarProxyConfig.ts`, `ProxyCore.ts`, `registrarFrontProxyFakeStack.ts`, `registrar-front-proxy.ts` (hybrid stack), `simulated-backend.ts`, `registrar-503-on-drop.test.ts` | Introduces the flag with required-everywhere semantics. All existing consumers pass `true`; behavior unchanged. |
| 3 | `test-harness: expose network/sequencer surface; parametrize hybrid runner` | `hybrid-runner.ts`, `index.ts`, `e2e-register-fakeExt-realCore.test.ts` | Completes consumer-facing API; existing E2E test gets `recordRoute: true` explicit. |
| 4 | `tests: fake-clock no-RR full-lifecycle direct it.effect` | new `e2e-fake-clock-noRr.test.ts` | Fake-clock coverage with no harness changes — composes layer directly. |
| 5 | `tests: hybrid no-RR real-fabric registrar scenario + E2E` | new `k8s-register-call-bye-noRr.ts`, new `e2e-register-noRr-realFabric.test.ts` | Real-fabric coverage; exercises the new public API surface. |

Each commit must leave the codebase `npm run typecheck`-clean (including the Effect plugin warnings — see [CLAUDE.md](../../CLAUDE.md) "Never ignore a warning") and `npm run test:fake`-passing.

## Test fallout to confirm during implementation

- `tests/scenarios/registrar/core-call-to-registered-ext.ts:16,20` — doc comments reference `ruriOverride`. Body unchanged; update comments only.
- `tests/scenarios/registrar/ext-call-to-core-destination.ts:15` — doc comment references RR-on-egress. Body unchanged; update comment only.
- `tests/scenarios/registrar/k8s-register-call-bye.ts` / `k8s-register-call-reroute.ts` / `k8s-register-smoke.ts` — `E2E_KIND=1`-gated; b2bua-worker now receives original-RURI INVITEs. Validate worker-side routing still works with `sip:bob@kindlab`-shaped RURIs.
- `tests/scenarios/registrar/register-happy-path.ts`, `deregister-via-expires-zero.ts`, `ttl-expiry-under-testclock.ts` — REGISTER-only; unaffected.

## Verification

After commit 5:

```bash
npm run typecheck                                          # zero errors, zero warnings (incl. Effect plugin)
npm run test:fake                                          # all fake-clock tests pass
E2E_KIND=1 TEST_MODE=live npx vitest run \
  tests/fullcall/e2e-register-fakeExt-realCore.test.ts     # existing RR path
E2E_KIND=1 TEST_MODE=live npx vitest run \
  tests/fullcall/e2e-register-noRr-realFabric.test.ts      # new no-RR path
```

Open the merged HTML reports under `test-results/real-clock/registrarFrontProxy-kind/` (existing) and `test-results/real-clock/registrarFrontProxy-noRr-kind/` (new). Confirm in the no-RR report's trace that:
- The INVITE/180/200 path traverses `proxy(ext)` ↔ `proxy(core)` for the a-leg setup.
- The ACK and BYE flows show **no** proxy participants — direct alice ↔ b2bua and bob ↔ b2bua.

## Critical files

- [src/sip-front-proxy/ProxyCore.ts](../../src/sip-front-proxy/ProxyCore.ts)
- [src/sip-front-proxy/RegistrarProxyConfig.ts](../../src/sip-front-proxy/RegistrarProxyConfig.ts)
- [src/sip-front-proxy/CoreToExtRoutingStrategy.ts](../../src/sip-front-proxy/CoreToExtRoutingStrategy.ts)
- [src/test-harness/hybrid-runner.ts](../../src/test-harness/hybrid-runner.ts)
- [src/test-harness/hybrid-stacks/registrar-front-proxy.ts](../../src/test-harness/hybrid-stacks/registrar-front-proxy.ts)
- [src/test-harness/index.ts](../../src/test-harness/index.ts)
- [tests/support/registrarFrontProxyFakeStack.ts](../../tests/support/registrarFrontProxyFakeStack.ts)
- [tests/fullcall/framework/simulated-backend.ts](../../tests/fullcall/framework/simulated-backend.ts)
