# CLAUDE.md

SIP B2BUA (Back-to-Back User Agent) that listens on incoming UDP SIP packets, calls a backend HTTP server to decide how to process each call, then forwards accordingly.

Always reply and write in English, even when the user writes in French.

## Commands

```bash
npm run typecheck       # Type-check all packages (run after every change)
npm run build           # Build the project
npm run test            # Fake stack + short-tier live (default dev loop)
npm run test:ci         # Fake stack + medium-tier live (CI)
npm run test:nightly    # Fake stack + all live tiers (nightly)
npm run test:fake       # Fake stack only (no real-clock scenarios)
npm run dev             # Start the server in development mode
```

After every code change, run `npm run typecheck` and verify zero errors and zero warnings. Warnings and Effect TS messages must be fixed, not ignored. Only suppress a warning with a lint-disable comment as a last resort, always with an explanation.


## Agent Strategy

For complex multi-step tasks, prefer delegating independent implementation
subtasks to subagents via the Task tool rather than executing inline.
Reserve the main context for planning, coordination, and review.

## Subagent Delegation

When spawning subagents via Task(), always include in the task description:
- Relevant file paths and their purpose
- Conventions or patterns to follow
- Acceptance criteria / expected output
- Any prior decisions that affect this subtask
- explicit instruction to 

## Commit policy

On complex multi slice tasks with on line comment the intermediate slice.

## File creation

- Use the `Write` tool to create files. Never use `cat`, `echo`, heredoc (`<< EOF`), or shell redirection.
- Use the `Edit` tool to modify existing files.

## Test structure (fake vs live)

Tests are split into two non-mixing modes — a scenario is either fully fake or fully live:

- **Fake stack** (`vitest.config.fake.ts`). Every test uses `it.effect` + TestClock, the in-memory `CallStateCache`/`CallLimiter` variants, simulated `SignalingNetwork`, and a mock HTTP call-control backend. No real sockets, no Redis, no wall clock. Includes all unit suites and `tests/fullcall/e2e-fake-clock.*`. This is the fast inner loop.
- **Live stack** (`vitest.config.live.ts`). `it.live` + real `Effect.sleep` + real UDP. Currently only `tests/fullcall/e2e-real-clock.test.ts`. Each scenario advertises a tier (`short` ≤ 2s real, `medium` ≤ 30s real, `long` > 30s real); `TEST_TIER` env var (short|medium|long) gates which describe blocks run.

Shared assets:
- `tests/scenarios/` — scenario DSL modules, imported by both fake and live test files.
- `tests/support/fakeStack.ts` / `liveStack.ts` — stack-layer builders.
- `tests/support/harness.ts` — runner consumed by both sides.
- `tests/fullcall/` — near-real call simulation harness (was `tests/e2e/`).

When adding a test: if it can run under TestClock, put it in the fake-clock file. Only move to real-clock if it needs real UDP, real Redis timing, or peer-to-peer sockets.

## Planning discipline

When writing or modifying SIP manipulation code, list every relevant RFC rule the UAC and/or UAS must honour in the plan before coding. When the user describes a custom encoding or data format, ask clarifying questions before implementing.

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
| Authoring multi-agent SIP scenarios (hybrid kind harness) | [docs/test-api-external.md](docs/test-api-external.md) |
