# CLAUDE.md

SIP B2BUA (Back-to-Back User Agent) that listens on incoming UDP SIP packets, calls a backend HTTP server to decide how to process each call, then forwards accordingly.

Always reply and write in English, even when the user writes in French.

When adding comments be brief, only comment non obvious behavior. Do not reference slice or plan number.

Project use [Effect v4](./repos/effect/LLMS.md) extensively. ALways read the doc before writing or designing effect systems.

Project is NOT IN PRODUCTION. Do not worry about upgrade path or rollout, we can deply platform from scratch at each release.

## Commands

```bash
npm run typecheck       # Type-check all packages (run after every change)
npm run build           # Build the project
npm run test            # Fake stack + short-tier live (default dev loop)
npm run test:fake       # Fake stack + various, MUST ALWAYS BE RUN
npm run test:ci         # Fake stack + medium-tier live (CI)
npm run test:nightly    # Fake stack + all live tiers (nightly)
npm run dev             # Start the server in development mode
```

After every code change, run `npm run typecheck` and verify zero errors and zero warnings.

## Vendored Repositories

This project vendors external repositories under @repos/

  - Use vendored repositories as read-only reference material when working with related libraries
  - Prefer examples and patterns from the vendored source code over generated guesses or web search results
  - Do not edit files under @repos/ unless explicitly asked
  - Do not import from @repos/ - application code should continue importing from normal package dependencies

## Never ignore a warning

Two independent gates run during typecheck and BOTH must be clean:

- **`tsc`** — the standard TypeScript compiler. Catches type errors and ordinary lint-style issues.
- **The Effect TS language-service plugin** — runs *inside* `tsc` and is the only thing that flags v4-specific footguns: deprecated v3 APIs that still type-check, `preferSchemaOverJson` on opaque payloads, `Global 'Error' loses type safety`, catch-all error handling, missing `yield*` on Effects.

A `tsc`-clean build with the Effect plugin silenced is **not** a clean build. Fix every warning. `eslint-disable` comments do not silence the Effect plugin (it's not eslint) — if the plugin fires inside `Effect.gen`, the workaround is usually to refactor (e.g. extract a pure JSON helper out of the generator), not to suppress.

The single most common silent mis-fix when migrating from v3: replacing `Effect.catchAll` with `Effect.catchCause`. v4 removed `catchAll` *on purpose* — catch-all is an anti-pattern that erases the typed error channel and swallows defects. The right replacement is `catchTag`/`catchTags`. Use `catchCause` only when you genuinely need to handle defects+interrupts together, and document why at the call site. See [docs/typescript-effect.md](docs/typescript-effect.md) for the full v4 migration cheat-sheet.

Only suppress a warning with a lint-disable comment as a last resort, always with an explanation.


## test strategy

Never deactivate failing test without proper investigation first and explicit confirmation. If the test cannot be fixed in the scope create a dedicated precursor plan.

## Test structure (fake vs live)

Default: fake (`it.effect` + TestClock + in-memory deps + simulated `SignalingNetwork` + mock HTTP). Complex scenarios belong here. Live (`it.live`, `TEST_MODE=live` against the unified `vitest.config.ts`) is reserved for behaviour TestClock can't model — real UDP, real Redis timing, P2P sockets. Tiers `short` / `medium` / `long` via `TEST_TIER`.

**Mixing is allowed but dangerous.** TestClock advances on yield; real-delay fibers advance on wall time. Pairing them races. If you must mix: use `it.live`, annotate `/* MIXED CLOCK: <what> — <why> */`, minimise the real-delay surface, and prefer a `Clock.currentTimeMillis`-backed fake.

Shared: `tests/scenarios/` (DSL), `tests/support/stackLayer.ts` (`stackLayer({ mode })`).

**`tests/support/testLayers.ts` is the single shelf for test-layer bundles.** Pull RunContext, Recorder, per-Tag contract wrappers, and pre-composed stacks from here — never compose them ad-hoc with `Layer.merge` in a test file. Example:

```ts
import { testLayers } from "../support/testLayers.js"

it.effect("scenario", () =>
  Effect.gen(function* () { /* ... */ })
    .pipe(Effect.provide(testLayers.stacks.fake({ config })))
)
```

## Planning discipline

When writing or modifying SIP manipulation code, list every relevant RFC rule the UAC and/or UAS must honour in the plan before coding. When the user describes a custom encoding or data format, ask clarifying questions before implementing.

When modifying any of `src/b2bua/rules/framework/RuleExecutor.ts`, `src/b2bua/rules/framework/ActionExecutor.ts`, `src/b2bua/rules/framework/RuleDefinition.ts`, `src/sip/SipRouter.ts:processResult`, `src/call/CallState.ts:update`, or `src/call/CallState.ts:forcePurge*`, read [docs/adr/0003-must-run-effects-under-interruption.md](docs/adr/0003-must-run-effects-under-interruption.md) FIRST. The interpreter's safety contract is load-bearing and easy to break silently.

## Progressive reading guide

Load these only when the task touches the area:

| Topic | Doc |
|-------|-----|
| TypeScript & Effect conventions (MutableHashMap, TestClock, patterns) | [docs/typescript-effect.md](docs/typescript-effect.md) |
| SIP header rewriting, Via / Contact stamping, tag ownership | [docs/b2bua-sip-headers.md](docs/b2bua-sip-headers.md) |
| Call, Leg, Dialog data model and SIP method handling | [docs/CallModel.md](docs/CallModel.md) |
| Rule framework, action types, priority bands, framework guarantees | [docs/AdvancedCallModel.md](docs/AdvancedCallModel.md) |
| Adding a new policy-module rule | [docs/rule-extension-guide.md](docs/rule-extension-guide.md) |
| Rule coverage and mutation testing | [docs/rule-coverage-and-killing.md](docs/rule-coverage-and-killing.md) |
| Tracing / OpenTelemetry rules | [docs/tracing-design.md](docs/tracing-design.md) |
| Overload protection | [docs/overload-protection.md](docs/overload-protection.md) |
| LB-proxy HA / shared VIP / keepalived / VRRP | [docs/lb-proxy-ha.md](docs/lb-proxy-ha.md) |
| Authoring multi-agent SIP scenarios (hybrid kind harness) | [docs/test-api-external.md](docs/test-api-external.md) |
| Replication / call cache backup mechanism |        [docs/replication/call-cache-backup.md](../replication/call-cache-backup.md) |
| Must-run effect categories + buffered IO contract | [docs/adr/0003-must-run-effects-under-interruption.md](docs/adr/0003-must-run-effects-under-interruption.md) |
| Worker memory sizing model, assumptions, escape valves | [docs/adr/0012-b2bua-memory-sizing-model.md](docs/adr/0012-b2bua-memory-sizing-model.md) |
