# CLAUDE.md

SIP B2BUA (Back-to-Back User Agent) that listens on incoming UDP SIP packets, calls a backend HTTP server to decide how to process each call, then forwards accordingly.

Always reply and write in English, even when the user writes in French.

## Commands

```bash
npm run typecheck   # Type-check all packages (run after every change)
npm run build       # Build the project
npm run test        # Run tests
npm run dev         # Start the server in development mode
```

After every code change, run `npm run typecheck` and verify zero errors and zero warnings. Warnings and Effect TS messages must be fixed, not ignored. Only suppress a warning with a lint-disable comment as a last resort, always with an explanation.

## Commit policy

Only create commits for complex tasks (multi-slice feature, architectural refactor, or when the user explicitly asks). For one-off edits, leave the changes uncommitted for user review. Commits land on the `main` branch with a clear message.

## File creation

- Use the `Write` tool to create files. Never use `cat`, `echo`, heredoc (`<< EOF`), or shell redirection.
- Use the `Edit` tool to modify existing files.

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
