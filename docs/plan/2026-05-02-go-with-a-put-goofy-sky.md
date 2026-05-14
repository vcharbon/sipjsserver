# Cleanup project for external usage as `@vcharbon/sipjs`

## Context

This repo today is a runnable B2BUA + front-proxy with an internal test
harness in `tests/`. We want to publish it as a library so external
projects can consume two surfaces:

1. **Test harness with auto-started registrar front-proxy** — an external
   tester writes `alice.register()` / `bob.register()` scenarios, runs
   them through an in-process registrar-mode `sip-front-proxy`, and the
   proxy forwards INVITEs to the consumer's real third-party system on
   the core side. Target shape is very close to
   [tests/fullcall/e2e-register-fakeExt-realCore.test.ts](../../tests/fullcall/e2e-register-fakeExt-realCore.test.ts).
2. **Full B2BUA embedded in consumer's app with custom HTTP backend** —
   consumer provides their own `CallDecisionEngine` `Layer` (the per-call
   "what should we do?" decision); we provide everything else with sane
   defaults. Rule customization is **out of scope for v1**.

Decisions already locked:
- Single package `@vcharbon/sipjs` with multiple **subpath exports**.
- **Effect-native public API** (consumers know Effect; no Promise wrapper).
- v1 ships **only Position A** for the test harness (consumer's SUT lives
  on the proxy's core side at a real IP/port).
- **Default in-process layer** for the test harness so consumer just
  plugs scenario + small "how to use" doc.
- B2BUA ships with **noop OTel default**; consumer provides
  `@effect/opentelemetry NodeSdk` layer if they want exporters.

## Public surface (exports map)

```jsonc
// package.json
{
  "name": "@vcharbon/sipjs",
  "exports": {
    "./test-harness":    "./dist/test-harness/index.js",
    "./b2bua":           "./dist/b2bua/index.js",
    "./sip-front-proxy": "./dist/sip-front-proxy/index.js",
    "./sip":             "./dist/sip/index.js",
    "./observability":   "./dist/observability/index.js"
  }
}
```

`@vcharbon/sipjs` (root, no entry) — types-only re-exports if needed.

## Dependency split

Per [findings from the dep-graph trace](#references):

- **`dependencies`** (always installed): `effect`, `@effect/platform-node`.
- **`peerDependencies` + `peerDependenciesMeta` (optional)** — installed
  only when consumer opts into the feature: `ioredis` (b2bua w/ Redis
  cache), `@kubernetes/client-node` (front-proxy K8s registry mode),
  `@effect/opentelemetry` + `@opentelemetry/*` (observability subpath).
- **Move to `devDependencies`**: `jssip` (dead code in `src/`; only
  `src/sip/parsers/jssip-adapter.ts` references it via `require()` and
  it's never wired in — `customParser` is the default at
  [src/sip/Parser.ts:24](../../src/sip/Parser.ts#L24)).

## Slices

### Slice 1 — Package skeleton (no functional change)

- Add `exports` map to [package.json](../../package.json) with the 5
  subpaths above. All initially point at empty `index.ts` stubs that
  re-export `{}` so the new entry points compile.
- Reorganize `dependencies` / `peerDependencies` / `peerDependenciesMeta`
  / `devDependencies` per the split above.
- Add a build target that emits `dist/<subpath>/index.js` with proper
  `.d.ts`. Confirm `tsconfig.build.json` covers the new directory layout.
- Add `tests/consumer-api/` directory with one smoke `.test.ts` per
  subpath that imports **only** from `@vcharbon/sipjs/<subpath>`. Wire
  TypeScript `paths` in `tsconfig.json` so this resolves to local `src/`
  during dev. This is the regression gate: if a public symbol is
  removed or renamed without updating the consumer test, CI fails.
- Run `npm run typecheck` — expect zero errors and zero warnings (per
  [CLAUDE.md](../../CLAUDE.md) policy).

**Verification:** `npm run typecheck` clean. `npm pack --dry-run`
shows the new exports map without errors.

### Slice 2 — `/test-harness` subpath (the use-case-#1 surface)

**Move** (preserve git history with `git mv`):

| From | To |
|---|---|
| `tests/fullcall/framework/*.ts` (16 files) | `src/test-harness/framework/` |
| `tests/support/registrarFrontProxyFakeStack.ts` | `src/test-harness/fake-stacks/registrar-front-proxy.ts` |
| `tests/support/registrarFrontProxyHybridStack.ts` | `src/test-harness/hybrid-stacks/registrar-front-proxy.ts` |
| `tests/support/hybridRunner.ts` | `src/test-harness/hybrid-runner.ts` |
| `tests/support/testAppConfigDefaults.ts` | `src/test-harness/config-defaults.ts` |
| `tests/support/networkLeaves.ts`, `topologies.ts` | `src/test-harness/topologies.ts` (merge if small) |

**Internal-only support files that stay in `tests/`** (used by other
internal tests but not by the public harness):
- `tests/support/fakeStack.ts`, `proxyB2bFakeStack.ts`, `k8sFakeStack.ts`,
  `proxy-only-fakeStack.ts`, `pumpAll.ts`, `SimulatedK8sCluster.ts` —
  these are fully-fake-stack helpers tied to internal scenarios. Keep
  in `tests/support/` and re-import the moved framework files via the
  new `src/test-harness/` paths.

**Curated [src/test-harness/index.ts](../../src/test-harness/index.ts) public surface:**

```ts
// Scenario DSL
export { scenario, sequence, or } from "./framework/dsl.js"
export type { Scenario, ScenarioResult, AgentConfig, Step, TestTransport,
              AllowedExtraPattern, ScenarioTier, Sut } from "./framework/types.js"

// Execution
export { executeScenario } from "./framework/interpreter.js"
export { createLiveTransport } from "./framework/live-backend.js"

// Reports
export { formatReport } from "./framework/report.js"
export { writeScenarioReport, writeIndexReport } from "./framework/html-report.js"
export { writeTextReports } from "./framework/text-report.js"

// One-call convenience for use case #1 — the "default I just plug in"
export { createRegistrarTestProxyRunner,
         discoverHostReachableIp,
         flushHybridIndexReport } from "./hybrid-runner.js"

// Layer-level seam for advanced users
export { registrarFrontProxyHybridStackLayer } from "./hybrid-stacks/registrar-front-proxy.js"
```

**Add a thin convenience wrapper** in `src/test-harness/hybrid-runner.ts`:
```ts
export const createRegistrarTestProxyRunner = (opts: {
  coreDestination: SocketAddr   // consumer's third-party SUT IP:port
  extPort?: number              // proxy ext-side bind, default auto
  corePort?: number             // proxy core-side bind, default auto
  advertisedIp?: string         // default: discoverHostReachableIp()
  outputDir?: string            // default: "test-results"
}) => /* same shape as today's createHybridRunner, minus the kind-specific defaults */
```

This is the function that lets a tester write 5 lines + a scenario.

**Verification:**
- All existing internal tests still pass (`npm run test:fake` and
  `npm run test:live:short`) — they now import from `src/test-harness/`.
- `tests/consumer-api/test-harness.test.ts` defines a scenario with two
  agents, runs it with `createRegistrarTestProxyRunner` against a
  loopback echo target, and asserts `result.passed`. Demonstrates the
  full v1 ergonomic.

### Slice 3 — `/sip` subpath (low-level SIP primitives)

Curated re-exports from `src/sip/`. No file moves; just an `index.ts`.

[src/sip/index.ts](../../src/sip/index.ts) (new):
```ts
export { SipParser, customParser } from "./Parser.js"
export { serialize } from "./Serializer.js"
export type { SipMessage, SipRequest, SipResponse, SipHeader } from "./types.js"
export { newBranch, newTag, newCallId, getHeader, getHeaders } from "./MessageHelpers.js"
export { hydrateRequest, hydrateResponse } from "./parsers/extract-fields.js"
export { parseNameAddr, parseCSeq } from "./parsers/custom/structured-headers.js"
export { SignalingNetwork } from "./SignalingNetwork.js"
export type { UdpEndpoint, NetworkTraceEntry } from "./SignalingNetwork.js"
```

**Verification:** `tests/consumer-api/sip.test.ts` parses a raw SIP
message with `SipParser`, mutates a header with `getHeader/setHeader`
helpers, re-serializes, and asserts byte equivalence on a fixture.

### Slice 4 — `/b2bua` subpath (the use-case-#2 surface)

**Public seam (the consumer must implement this):**

```ts
// re-exported under @vcharbon/sipjs/b2bua
export { CallDecisionEngine } from "./decision/CallDecisionEngine.js"
export { CallDecisionError } from "./decision/CallDecisionError.js"
export type { NewCallRequest, CallFailureRequest, CallReferRequest }
       from "./decision/schemas/requests.js"
export type { NewCallResponse, CallFailureResponse, CallReferResponse }
       from "./decision/schemas/responses.js"
```

**The "I want a working b2bua, just take my HTTP backend" entry point:**

```ts
// src/b2bua/embedded.ts (new)
export const b2buaEmbeddedLayer = (opts: {
  callDecision: Layer.Layer<CallDecisionEngine, never, never>
  config?: Partial<AppConfigData>
  // optional overrides; everything below has sane defaults
  cache?: Layer.Layer<CallStateCache, never, never>           // default: in-memory
  callLimiter?: Layer.Layer<CallLimiter, never, never>        // default: in-memory
  tracing?: Layer.Layer<TracingService, never, never>         // default: noop
  cdr?: Layer.Layer<CdrWriter, never, never>                  // default: noop
}): Layer.Layer<B2buaCore, ConfigError, never>
```

This composes `B2buaCoreLayer` from
[src/b2bua/B2buaCore.ts:129](../../src/b2bua/B2buaCore.ts#L129) with
default in-memory layers for everything but the consumer-supplied
`callDecision`. Replication, Redis, K8s readiness, OTel exporter — all
**off** by default. Consumer who wants production wiring composes the
optional layers manually.

**Required new in-memory implementations** (none should already exist —
verify before writing):
- `InMemoryCallStateCacheLayer` — already exists for tests; promote
  from `tests/support/` to `src/cache/in-memory/` if not already public.
- `InMemoryCallLimiterLayer` — same.
- `NoopTracingLayer` — wraps Effect's built-in tracer with no exporter.
- `NoopCdrLayer` — drop-on-floor `Sink`.

**Re-curate [src/b2bua/index.ts](../../src/b2bua/index.ts) (new):**
```ts
export { B2buaCore, B2buaCoreLayer } from "./B2buaCore.js"
export { b2buaEmbeddedLayer } from "./embedded.js"
export { CallDecisionEngine } from "../decision/CallDecisionEngine.js"
export { CallDecisionError } from "../decision/CallDecisionError.js"
export type * from "../decision/schemas/requests.js"
export type * from "../decision/schemas/responses.js"
// AppConfig partial type for consumer overrides
export type { AppConfigData } from "../config/AppConfig.js"
```

**Hardcoded gotchas in `main.ts` to refactor:**
- OTel layer hardcoded → factor `OtelLayer` builder so `main.ts` calls
  it with env vars, but `b2buaEmbeddedLayer` defaults to noop.
- `WorkerReadiness` / `DrainingState` MutableRefs hoisted to
  `standaloneMain` scope — keep that wiring inside `main.ts` (the
  standalone entry point), don't push it into `b2buaEmbeddedLayer`.

**Verification:**
- `tests/consumer-api/b2bua.test.ts` builds `b2buaEmbeddedLayer` with a
  trivial in-memory `CallDecisionEngine` (`newCall` → route to fixed
  destination), runs an INVITE through it via the test-harness, asserts
  200 OK and CDR-equivalent state.
- `npm run dev` (which runs `main.ts`) still boots — proves we didn't
  regress the standalone entry point.

### Slice 5 — `/sip-front-proxy` and `/observability` subpaths

**`/sip-front-proxy`** — already has
[src/sip-front-proxy/index.ts](../../src/sip-front-proxy/index.ts);
audit and trim to the public surface (`ProxyCore`,
`RegistrarProxyConfig`, `RegisterStrategy`, `CoreToExtRoutingStrategy`,
`Registrar`, registry layers). Keep `kubernetesStatefulSetLayer` and
`kubernetesSecretLayer` exports — they import `@kubernetes/client-node`
lazily via dynamic import so the optional peer dep stays optional.

**`/observability`** (new, small):
```ts
// src/observability/index.ts
export { otlpHttpTracingLayer } from "./otlp-http-tracing-layer.js"
// thin wrapper around @effect/opentelemetry NodeSdk + OTLPTraceExporter
// extracted from main.ts
```

**Verification:** `tests/consumer-api/sip-front-proxy.test.ts` boots a
`ProxyCore` with `staticRegistry`, sends a REGISTER from a fake agent,
asserts 200 OK.

### Slice 6 — Documentation

**Add** `docs/external-usage/`:

- `README.md` — overview of the package, the 5 subpaths, when to use
  which.
- `test-harness.md` — the "how to use the register-proxy test framework"
  document the user explicitly asked for. ~2 pages: install, define
  scenario with `alice.register()` / `bob.register()`, run with
  `createRegistrarTestProxyRunner`, read the report. Code copy-pasteable
  from a working example.
- `b2bua-embedded.md` — "how to embed the B2BUA". Implementing
  `CallDecisionEngine`, providing the layer, optional overrides for
  cache/limiter/tracing/cdr.
- `examples/test-harness/` (new top-level dir) — 2 working scenarios
  copied from `tests/scenarios/registrar/` with imports rewritten to
  `@vcharbon/sipjs/test-harness`. CI runs them via the consumer-api
  vitest config.

Update root [README.md](../../README.md) — add a "Use as a library"
section pointing at `docs/external-usage/`.

**Verification:** `npm run test` runs `tests/consumer-api/` plus
`examples/test-harness/`. All green.

## Critical files

To be **created**:
- `src/test-harness/index.ts` (new, curated re-exports)
- `src/test-harness/hybrid-runner.ts` (moved + refactored from `tests/support/hybridRunner.ts`)
- `src/sip/index.ts` (new, curated re-exports)
- `src/b2bua/index.ts` (new, curated re-exports)
- `src/b2bua/embedded.ts` (new, `b2buaEmbeddedLayer` factory)
- `src/observability/index.ts` (new)
- `src/observability/otlp-http-tracing-layer.ts` (extracted from `main.ts`)
- `src/cache/in-memory/index.ts` (promoted from tests if not already public)
- `tests/consumer-api/*.test.ts` (one per subpath)
- `examples/test-harness/*.ts` (2 working scenarios)
- `docs/external-usage/{README,test-harness,b2bua-embedded}.md`

To be **modified**:
- [package.json](../../package.json) — exports map, dep split.
- [tsconfig.json](../../tsconfig.json) + [tsconfig.build.json](../../tsconfig.build.json) — paths, output layout.
- [src/main.ts](../../src/main.ts) — extract OTel and HTTP-decision wiring into reusable layers; standalone entry point keeps current behavior.
- [src/sip-front-proxy/index.ts](../../src/sip-front-proxy/index.ts) — curate to public surface.
- All internal scenarios under `tests/scenarios/` — rewrite imports from `../../fullcall/framework/*` to `../../../src/test-harness/framework/*`.

To **move** (with `git mv` to preserve history):
- 16 framework files: `tests/fullcall/framework/*.ts` → `src/test-harness/framework/`
- 5 hybrid/registrar support files: `tests/support/registrarFrontProxy*.ts`, `hybridRunner.ts`, `testAppConfigDefaults.ts`, `networkLeaves.ts`, `topologies.ts` → `src/test-harness/`

## Reused (do not reinvent)

- `CallDecisionEngine` Tag at [src/decision/CallDecisionEngine.ts](../../src/decision/CallDecisionEngine.ts) — already the seam. Just expose it.
- `MockCallControlLayer` at [tests/fullcall/framework/MockCallControlLayer.ts](../../tests/fullcall/framework/MockCallControlLayer.ts) — moves with the framework; serves as the reference impl for consumers writing test-only `CallDecisionEngine`.
- `B2buaCoreLayer` at [src/b2bua/B2buaCore.ts:129](../../src/b2bua/B2buaCore.ts#L129) — `b2buaEmbeddedLayer` is a thin wrapper that picks defaults.
- `ProxyCore` from [src/sip-front-proxy/index.ts](../../src/sip-front-proxy/index.ts) — already exported as a public-facing layer. Just curate the re-exports.
- `customParser` from [src/sip/Parser.ts:24](../../src/sip/Parser.ts#L24) — already the default; `jssip` is dead code and demoted to devDep.
- All scenario DSL primitives in [tests/fullcall/framework/dsl.ts](../../tests/fullcall/framework/dsl.ts) — moves verbatim into `src/test-harness/framework/dsl.ts`.
- `discoverHostReachableIp` from `tests/support/hybridRunner.ts` — re-export through `src/test-harness/`.
- `staticRegistryFromString` from [src/sip-front-proxy/registry/static.ts](../../src/sip-front-proxy/registry/static.ts) — keep public for consumers wiring proxies without K8s.

## Verification (end-to-end)

After all slices:

1. `npm run typecheck` — zero errors, zero warnings (tsc + Effect plugin).
2. `npm run build` — emits `dist/{test-harness,b2bua,sip-front-proxy,sip,observability}/index.js` and `.d.ts`.
3. `npm pack --dry-run` — output package contains only `dist/`, `package.json`, `README.md`, `LICENSE`. No `tests/`, `docs/plan/`, `bin/`.
4. `npm run test:fake` — full internal suite passes after import rewrites.
5. `npm run test:live:short` — confirms the moved live-backend wiring is intact.
6. `npm run dev` — standalone server still boots (regression gate for `main.ts` refactor).
7. `vitest run tests/consumer-api/` — 4 smoke tests, one per public subpath, all green. This is the load-bearing gate that the public API actually works from a consumer's perspective.
8. Manual: in a scratch directory, `npm pack` → `tar -xf` → `tsc` a 10-line file that imports `createRegistrarTestProxyRunner` and defines a scenario. Confirm types resolve and the file compiles against the published shape.

## Out of scope (deferred to v1.x)

- Position B (agents-only, no proxy) for the test harness.
- Promise-facade public API.
- Rule customization for the b2bua.
- Workspace / monorepo split.
- Custom transport (UDP-only is hardcoded; TCP/TLS would be a follow-up).
- Custom SIP parser (jssip stays dead; only `customParser` is wired).
