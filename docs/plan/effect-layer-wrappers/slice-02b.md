# Slice 2b — Vitest config unification (`TEST_MODE` env switch)

Parent plan: [review-this-plan-and-noble-goblet.md](../review-this-plan-and-noble-goblet.md)
ADR: [0013-effect-layer-wrappers-and-typed-recorder.md](../../adr/0013-effect-layer-wrappers-and-typed-recorder.md)

**Status:** DONE. **Irreversible** — `vitest.config.fake.ts` and
`vitest.config.live.ts` have been deleted; their content folded into a
single `vitest.config.ts` switched by the `TEST_MODE` env var.

## What changed

1. **New unified `vitest.config.ts`** — single source of truth for the
   fake-stack and live-stack runners. Branches on `process.env.TEST_MODE`:
   - `fake` (default): includes `tests/**/*.test.ts`, excludes the
     real-clock e2e file, the live limiter-rejection probe, the hybrid
     kind smoke, the replication-stream medium-tier soak, and
     `tests/k8s/*.test.ts`. Forks pool sized for WSL constraints
     (`maxForks=2`, `--max-old-space-size=1536`).
   - `live`: includes the real-clock e2e file, the limiter-rejection
     probe, the hybrid kind smoke (`E2E_KIND=1`), and the
     replication-stream medium-tier soak. Worker args
     `--max-old-space-size=1024 --expose-gc`.
   An invalid `TEST_MODE` value throws early at config-load time.

2. **`TEST_TIER` is orthogonal** — unchanged. `e2e-real-clock.test.ts`
   and `replication-stream-medium.test.ts` consult
   `process.env.TEST_TIER` directly (default `short`). The config does
   not branch on it.

3. **Deleted** `vitest.config.fake.ts` and `vitest.config.live.ts`.

4. **`vitest.config.k8s.ts` is preserved** — its `globalSetup`,
   `singleFork`, and `fileParallelism: false` semantics don't compose
   cleanly with the binary `TEST_MODE` switch. The `test:k8s*` scripts
   continue to point at it explicitly. Documented in the new config's
   header comment.

## Env-var contract

| Var | Default | Effect |
|---|---|---|
| `TEST_MODE` | `fake` | Selects the include/exclude pattern. Allowed values: `fake`, `live`. Anything else throws. |
| `TEST_TIER` | `short` | Selects which tiered scenarios run inside the live suite. Allowed: `short`, `medium`, `long`. Higher tiers include lower ones. |

Both can be set together: `TEST_MODE=live TEST_TIER=medium npm run test:live:medium`.

## npm scripts: before / after

Only the `-c <config>` argument was replaced by an env-var prefix.
Script names are unchanged; effective semantics are unchanged.

| Script | Before | After |
|---|---|---|
| `test:fake` | `vitest run -c vitest.config.fake.ts` | `TEST_MODE=fake vitest run` |
| `test:ns-real` | `vitest run -c vitest.config.fake.ts tests/replication-ns` | `TEST_MODE=fake vitest run tests/replication-ns` |
| `test:live:short` | `TEST_TIER=short vitest run -c vitest.config.live.ts` | `TEST_MODE=live TEST_TIER=short vitest run` |
| `test:live:medium` | `TEST_TIER=medium vitest run -c vitest.config.live.ts` | `TEST_MODE=live TEST_TIER=medium vitest run` |
| `test:live:long` | `TEST_TIER=long vitest run -c vitest.config.live.ts` | `TEST_MODE=live TEST_TIER=long vitest run` |
| `test:watch` | `vitest -c vitest.config.fake.ts` | `TEST_MODE=fake vitest` |

Aggregate scripts (`test`, `test:ci`, `test:nightly`) compose the above
unchanged — same effective scenario set, same order. `test:k8s*` is
untouched.

## Manual invocation of live mode

```bash
# Live + short tier (same as `npm run test:live:short`)
TEST_MODE=live TEST_TIER=short npx vitest run

# Live, single scenario by name pattern
TEST_MODE=live TEST_TIER=short npx vitest run -t "p2p-extra-message"

# Hybrid kind cluster smoke (requires up'd cluster + E2E_KIND=1)
E2E_KIND=1 TEST_MODE=live npx vitest run \
  tests/fullcall/e2e-register-fakeExt-realCore.test.ts
```

## Comment / doc sweeps

In-tree references to the deleted config paths were updated to the
`TEST_MODE` form:

- `CLAUDE.md` (test-structure paragraph)
- `README.md` (single-test invocation examples)
- `tests/fullcall/README.md` (running-tests section)
- `tests/consumer-api/test-harness.test.ts` (header comment)
- `tests/fullcall/e2e-real-clock.test.ts` (tier-gating comment)
- `tests/fullcall/e2e-register-fakeExt-realCore.test.ts` (header comment)
- `tests/fullcall/ha-cdr-attribution.diagnostic.test.ts` (header comment)
- `tests/fullcall/replication-stream-medium.test.ts` (gate doc)
- `tests/harness/_capture.test.ts` (header comment)
- `tests/sip-front-proxy/failover/mid-ring-primary-killed.test.ts` (header comment)
- `tests/k8s/scripts/sanity.ts` (vitest invocation now passes `TEST_MODE=live` via env)
- `docs/K8S_test.md`, `docs/howto_proxy_register_test.md`, `docs/test-api-external.md` (manual run snippets)
- `docs/rule-coverage-and-killing.md`, `docs/sip-front-proxy/resilience-model.md`, `docs/todos/SIP-Front-Proxy.md`, `docs/todos/SIGNALING-NETWORK-REFACTOR-SURPRISES.md` (paragraph references)

Historical plan documents under `docs/plan/2026-*` and
`docs/plan/usage-of-stream-in-atomic-cake.md` were left as-is — they
are completed/archived plans and the `vitest.config.fake.ts` /
`vitest.config.live.ts` strings in them are historical record.

## Verification

- `npm run typecheck` — zero tsc errors, zero Effect-plugin warnings.
- `npm run test:fake` — 205 files / 1471 tests passed, 1 file / 8
  tests skipped. (Same numbers as Slice 2a, modulo the skip count;
  see "Anomalies" below.)
- `npm run test` (fake + short-tier live) — fake suite green; live
  short tier: 2 files / 6 tests passing, 2 files / 13 tests skipped
  (tier-gated — same as Slice 2a baseline).
- `TEST_MODE=live TEST_TIER=short npx vitest run` reached live mode
  cleanly via the unified config.
- `git grep -l "vitest.config.fake\|vitest.config.live"` — only
  historical plan documents under `docs/plan/2026-*` remain (8 files,
  all archived plans). No active source, test, doc, or script
  references the deleted paths.

## CI

The repository does not currently ship `.github/workflows/*.yml`
files. Nothing CI-related was touched.

## Anomalies / deviations from the plan

- The slice spec referenced "1471 tests + 12 skipped" as the Slice 1
  baseline. The actual current baseline is **1471 + 8 skipped**
  (4 fewer skips than the spec's tally, with the matching skipped
  file count dropping from 3 to 1). Same effective number of *running*
  tests; the change predates this slice (no test files were touched
  here). Flagging for the parent plan to refresh the running count
  marker.
- Vitest 4 emits a `DEPRECATED test.poolOptions was removed` warning
  when the fake-mode config is loaded. The shape was preserved
  byte-for-byte from `vitest.config.fake.ts` to keep the slice
  behavior-preserving; the deprecation existed before this slice and
  applies equally to a future migration. **Not in scope here.** A
  follow-up should move `forks: { ... }` to the top level of the
  `test` section (the live branch already uses the new shape).

## Slice 3 handoff

The `TEST_MODE` axis is now load-bearing for the runner. Slice 3 will
introduce `SipHarness` as a typed-channel Tag and migrate the runner
to write events to `Recorder.forTag(SipHarness)`. That work is mode-
agnostic — `stackLayer({ mode })` already wires `Recorder` and
`RunContext.testWithRecorder` outward for both `fake` and `live`
(per Slice 2a), so no further runner-side mode branching is needed.

If a future slice needs a third mode (e.g. `TEST_MODE=k8s` to fold the
k8s config in), the binary `as "fake" | "live"` cast in `vitest.config.ts`
is the spot to extend — and the early throw guards against typos.
