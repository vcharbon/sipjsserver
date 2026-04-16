# Rule coverage and rule-kill (mutation) testing

The B2BUA's in-dialog behavior is entirely rule-driven. Every rule registered in `ruleRegistry` ([src/b2bua/B2buaCore.ts](../src/b2bua/B2buaCore.ts)) should be exercised by the e2e suite — otherwise it is either dead code or a silent regression waiting to happen.

Two complementary audits are available:

1. **Coverage** — which rules fired in which scenarios. Runs automatically on every `npm test`; the report is part of the e2e HTML index.
2. **Rule-kill (mutation)** — disables one rule at a time, re-runs the full simulated-clock suite, and flags rules whose removal leaves the suite green. Opt-in; run before packaging a release or when investigating a suspected gap.

Both audits read directly from `ruleRegistry.definitions`, so **no rule list needs to be maintained by hand** — newly registered rules show up automatically.

---

## 1. Coverage report (every test run)

Run the tests normally:

```bash
npm test
```

Open the e2e index:

```bash
# fake-clock suite (simulated backend — this is what coverage tracks)
open test-results/fake-clock/index.html
```

The bottom of the page includes a **Rule coverage** section with one row per rule:

| Rule id | Name | Priority | Scenarios | Exercised by |
|---------|------|----------|-----------|--------------|
| … | … | 500 | 4 | `basic-call, call-reject, …` |
| `some-rule` | … | 700 | **NEVER FIRED** | — |

Rules that never fired are listed first and highlighted. The summary line shows `X/Y rules fired — Z never fired in any scenario`.

### What "fired" means

A rule is counted as fired if its `handle()` returned a non-`undefined` `RuleHandleResult` — i.e. it actually claimed an event. Rules whose declarative `match` accepts an event but whose `handle()` returns undefined (passthrough) are **not** counted. See the collector in [tests/e2e/framework/rule-usage-collector.ts](../tests/e2e/framework/rule-usage-collector.ts).

### Scope

- Simulated-clock e2e scenarios only (the `tests/e2e/e2e-fake-clock.test.ts` suite).
- Live/real-clock backends do not record coverage — the wiring is in [tests/e2e/framework/simulated-backend.ts](../tests/e2e/framework/simulated-backend.ts) and runs only when that backend builds the B2BUA.

### What "never fired" means today

It is a **warning, not a failure** — `npm test` still passes. This may tighten into an allowlist-gated failure later once a clean baseline exists. For now, treat the list as a review checklist whenever a rule is added or moved.

---

## 2. Rule-kill mutation testing (opt-in)

Use this when:
- Preparing a release and you want proof that every rule matters.
- A rule has coverage but you suspect no assertion actually depends on it.
- You're stuck and want to know whether a specific rule is actually being exercised.

### Run the whole campaign

```bash
npm run test:rule-kill
```

What happens:
1. The script ([scripts/rule-kill.ts](../scripts/rule-kill.ts)) reads every rule id from `ruleRegistry.definitions`.
2. For each rule id, it spawns `vitest run tests/e2e/e2e-fake-clock.test.ts` with `KILL_RULE=<id>` in the environment.
3. The simulated backend reads `KILL_RULE` and wraps the registry with `disableRule(id)` — the named rule's `match.filter` is replaced with an always-false predicate, so the Matcher never picks it and the rule is functionally absent for that run.
4. The suite's exit code is collected:
   - **Non-zero** → the rule is KILLED (at least one test depends on it).
   - **Zero** → the rule SURVIVED (no test fails without it — it is not meaningfully tested).

Runtime is roughly `rule_count × simulated_suite_runtime` — plan for ~10–20 minutes on the current rule set. Run on a machine you're not actively using.

### Read the report

Each run writes `test-results/rule-kill-report.txt`:

```text
# Rule kill report — 2026-04-14T21:40:00.000Z
# Target: tests/e2e/e2e-fake-clock.test.ts
# 29 rules evaluated

KILLED   absorb-bye-200
KILLED   confirm-dialog
SURVIVED handle-timeout
…

# Summary: 17 killed, 12 survived
# Surviving rules (remove or add a test):
#   - handle-timeout
#   - …
```

The script exits with status `1` if any rule survived — useful for CI gating of a release job.

### Spot-check a single rule

You don't need the whole campaign to test one rule. Disable it by hand:

```bash
KILL_RULE=relay-bye npx vitest run tests/e2e/e2e-fake-clock.test.ts
```

Expected outcomes:
- A rule with good coverage (e.g. `relay-bye`) → the suite should go red with several failing scenarios. This confirms the disable path works end-to-end.
- A suspected-untested rule → the suite stays green. This matches the coverage report's warning and is the signal that a test is missing.

### Interpreting "SURVIVED"

A surviving rule is not automatically dead code. Valid cases:
- **Defensive / safety rule** — fires on pathological inputs the suite does not yet reproduce. Either add a scenario or document it as intentionally uncovered.
- **Structurally unreachable** — an earlier-priority rule always claims the same events. Review the priority band.
- **Actually unused** — remove the rule, or add the missing test.

`SURVIVED` should always lead to one of: add a scenario, lower the rule's priority, or delete the rule.

---

## Scope and non-goals

- **Simulated clock only.** Live-UDP and real-clock runs are non-deterministic (retransmits, wall-clock timers); the mutation signal would be too noisy to be useful.
- **Campaign-level, not per-scenario.** We explicitly do not run "for each rule, re-run only the scenarios that fired it." The campaign-level signal is what release gating cares about.
- **Not run on every commit.** Coverage is cheap and always on. Kill-mode is expensive and opt-in — run it when stuck or before packaging.

## Where the pieces live

| Concern | File |
|---------|------|
| Registry transforms (`transformRegistry`, `disableRule`) | [src/b2bua/rules/framework/RuleRegistry.ts](../src/b2bua/rules/framework/RuleRegistry.ts) |
| Production registry + `buildHandlers(registry)` | [src/b2bua/B2buaCore.ts](../src/b2bua/B2buaCore.ts) |
| Coverage collector | [tests/e2e/framework/rule-usage-collector.ts](../tests/e2e/framework/rule-usage-collector.ts) |
| Test-side registry wrapping (`KILL_RULE` + tracking) | [tests/e2e/framework/simulated-backend.ts](../tests/e2e/framework/simulated-backend.ts) |
| Coverage section in HTML index | [tests/e2e/framework/html-report.ts](../tests/e2e/framework/html-report.ts) |
| Kill orchestrator | [scripts/rule-kill.ts](../scripts/rule-kill.ts) |
| Unit tests for the transforms | [tests/b2bua/RuleRegistry-transform.test.ts](../tests/b2bua/RuleRegistry-transform.test.ts) |
