# Chaos test: abuse-stream as parallel traffic class

## Context

The existing endurance harness exercises **infrastructure chaos** (pod kill, redis kill, network cut, VRRP cutover, non-emergency burst). It does not exercise **protocol-level abuse**: a caller or callee that produces well-formed SIP bytes but uses the protocol in ways no normal peer would — infinite re-INVITE, 18x storm, dead-call, out-of-sequence dialog messages.

The contract under test is **no impact on real calls**: real-call KPIs during the soak must match the no-abuse baseline, AND post-soak resources (limiter inflight, call cache, worker RSS) must return to baseline. Whether the abuse calls themselves succeed or fail is irrelevant.

The four-axis taxonomy is now pinned in [CONTEXT.md](../../CONTEXT.md#abuse-classes). This plan owns axes 2 and 3 (**abusive-volume** + **out-of-sequence**), wired into the existing endurance harness as a new continuous traffic class. Axis 1 (**malformed**) belongs in [tests/sip/parser-compliance.test.ts](../../tests/sip/parser-compliance.test.ts). Axis 4 (**nefarious / injection**) is a separate risk-discovery plan referenced in *Out of scope*.

## Goals

- Discover whether *any* of the abuse archetypes degrade real-call KPIs (success rate, p99 setup delay, p99 BYE latency) below the no-abuse baseline.
- Discover whether *any* archetype causes a non-returning leak of limiter slots, call-cache entries, replication channel growth, or worker RSS during the 24-h soak.
- Drive the sizing of `MAX_MESSAGES_PER_CALL` (defense implementation deferred to a follow-up plan).

## Non-goals

- Verifying *how* the B2BUA treats abusive calls (e.g. exact 4xx/5xx code on a malformed in-dialog message). Abuse outcomes are excluded from KPI accounting.
- Catching malformed-byte parser regressions — that lives in [tests/sip/parser-compliance.test.ts](../../tests/sip/parser-compliance.test.ts).
- Discovering nefarious-injection surfaces — separate plan.
- Implementing `MAX_MESSAGES_PER_CALL` or any other defense — separate plan, driven by this test's findings.

## Design

### Traffic shape

Continuous parallel stream for the full soak duration, alongside the three existing real-call streams ([short-hold-stream], [long-options-stream], [limiter-probe-stream]). Abuse runs at `--abuse-caps=15` (the locked level — meaningful share without dominating; not claimed as representative production traffic; chosen to prove the platform absorbs the protocol-level abuse classes). Existing chaos schedule (pod kill etc.) still runs over the top; abuse stream is orthogonal.

`--abuse-caps` is a **mandatory CLI parameter** of `run-endurance.ts`: every invocation must pass it explicitly. Passing `0` disables abuse Jobs entirely (no abuse pods scheduled, no warning-log inflation in the worker logs). There is no default — forgetting to think about abuse must not silently fill logs.

Verdict: real-call success in `STEADY` category must match a clean-soak baseline within tight tolerance (initial proposal: ≤ 0.1 pp absolute drop). Abuse-call outcomes routed to a new `ABUSE_STREAM` category, displayed in the report but **not** factored into pass/fail.

### Pod isolation (no cross-contamination)

Abuse calls run from **dedicated sipp pods** — both UAC and UAS — distinct from the standard real-call pods. The standard pods must keep 100 % OK rate on their own real-call traffic; that is a separate verdict from the B2BUA's `STEADY` KPI, and the only way to guarantee it is structural separation.

Topology:
- **Standard sipp UAC pods** — existing Jobs running `uac-endurance-short.xml`, `uac-long-options.xml`, `uac-endurance-limiter.xml`. Untouched.
- **Standard sipp UAS pods** — existing `uas-basic.xml` deployment. Receives B-leg only from standard UAC calls. Must remain at 100 % success.
- **Abuse sipp UAC pods** — new Jobs, one per abuse archetype that originates abuse from the caller side. Call-ID prefix `abuse-`.
- **Abuse sipp UAS pods** — new deployment running the abuse-UAS archetypes (`uas-abuse-180-storm`, `uas-abuse-no-final`, etc.) on a separate Service. Only abuse UAC pods cause B-leg routing here.

Routing: the call-control mock decides the B-leg target. It detects abuse calls by Call-ID prefix `abuse-` and returns the **abuse-UAS Service IP**; otherwise it returns the **standard-UAS Service IP**. This keeps abuse traffic from ever touching the standard UAS pods, which is the structural guarantee for the 100 % standard-UAS success claim.

Verdict (added): standard sipp UAS pod success count from `parseSippStats` (rows received vs rows replied OK) must equal 100 % across the soak. Any deviation = cross-contamination bug in routing, fails the run.

### Tooling

**sipp only** for abuse-stream archetypes. Each archetype is one XML scenario in [tests/k8s/charts/sipp/scenarios/](../../tests/k8s/charts/sipp/scenarios/) + one CSV in the same chart, injected with sipp's `-inf` flag. Per-call variation comes from the CSV — sipp uses one row per launched call via `[fieldN]` placeholders. N rows = N distinct call shapes; we ship ~30 rows per archetype, ~20 archetypes → ~600 distinct shapes across the soak.

Why sipp-only:
- Existing scaffold ([tests/k8s/charts/sipp/](../../tests/k8s/charts/sipp/), [tests/k8s/endurance/sippJobs.ts](../../tests/k8s/endurance/sippJobs.ts)) covers all needs.
- sipp's wire is always RFC-compliant grammar — exactly what axes 2 + 3 require (parses then routed). Malformed bytes are out of scope here.
- No new image, no new chart, no new dependency.

### Archetype catalogue (≥ 20)

**Abusive-volume (UAC-side abuse):**
- `uac-abuse-reinvite-flood.xml` — INVITE / 200 / ACK then loop re-INVITE every `[interval_ms]` for `[count]` iterations.
- `uac-abuse-options-flood.xml` — establish call then loop in-dialog OPTIONS at high rate.
- `uac-abuse-info-flood.xml` — establish call then loop in-dialog INFO with random Content-Type.
- `uac-abuse-update-flood.xml` — establish call then loop in-dialog UPDATE.

**Abusive-volume (UAS-side abuse):**
- `uas-abuse-180-storm.xml` — receive INVITE, send `[count]` × 180 (count drawn from CSV: 50, 200, 1000), then 200.
- `uas-abuse-183-storm.xml` — same shape with 183 Session Progress.
- `uas-abuse-mixed-1xx-storm.xml` — interleaved 100/180/183.
- `uas-abuse-2xx-retransmit.xml` — send 200 OK repeatedly without waiting for ACK.

**Out-of-sequence (UAC-side):**
- `uac-abuse-ack-before-200.xml` — send ACK after the 180 instead of after 200.
- `uac-abuse-ack-wrong-cseq.xml` — send ACK with CSeq != INVITE's CSeq.
- `uac-abuse-bye-before-200.xml` — send BYE before 200.
- `uac-abuse-bye-no-totag.xml` — send BYE missing the To-tag.
- `uac-abuse-cancel-after-200.xml` — send CANCEL after 200.
- `uac-abuse-cseq-jump-back.xml` — re-INVITE with CSeq < prior INVITE's CSeq.
- `uac-abuse-prack-no-180.xml` — send PRACK with no preceding reliable 1xx.
- `uac-abuse-duplicate-invite.xml` — same Call-ID, fresh branch, no prior dialog.

**Ghost / silence (UAC-side):**
- `uac-abuse-ghost-after-ack.xml` — establish call then `<pause>` indefinitely, ignore incoming BYE/OPTIONS.
- `uac-abuse-ghost-mid-setup.xml` — send INVITE then never send anything else (no ACK, no CANCEL).

**Ghost / silence (UAS-side):**
- `uas-abuse-no-final.xml` — receive INVITE, send 180, then `<pause>` indefinitely.
- `uas-abuse-no-ack-response.xml` — receive INVITE, send 200, then ignore the ACK and any retransmits.

Each archetype runs as its own sipp Job at low CPS (~0.5–1 CPS). Total ~15 CPS abuse traffic.

### CSV-driven per-call variation

Each archetype ships a `*.csv` of N rows (~30) of parameters: counts, intervals, header values, optional CSeq deltas. sipp reads the CSV with `-inf` and exposes columns as `[field0]`, `[field1]`, etc. inside the scenario. Example for `uac-abuse-reinvite-flood.csv`:

```
count;interval_ms;sdp_variant
10;50;a
50;100;a
200;20;b
1000;5;a
```

This is how a fixed ~20 XML scenarios deliver ~600 distinct call shapes.

### Harness integration

Critical files to modify:

- [tests/k8s/endurance/sippJobs.ts](../../tests/k8s/endurance/sippJobs.ts) — add an `abuseJobs(opts)` builder that returns one Job per archetype, all carrying the Call-ID prefix `abuse-{archetype}-`. Daemon lifecycle mirrors the existing three streams. Skip entirely when `abuseCaps === 0`.
- [tests/k8s/endurance/run-endurance.ts](../../tests/k8s/endurance/run-endurance.ts) — add **mandatory** `--abuse-caps` CLI argument (no default). Start abuse jobs alongside existing streams in the SOAK phase when value > 0. Stop on DRAIN.
- [tests/k8s/endurance/categorize.ts](../../tests/k8s/endurance/categorize.ts) — add `ABUSE_STREAM` to `CallCategory`; route any `callId.startsWith("abuse-")` to this bucket before STEADY/MID_DIALOG_DURING_CHAOS logic runs.
- [tests/k8s/endurance/analyze-endurance.ts](../../tests/k8s/endurance/analyze-endurance.ts) — verdict thresholds: (1) `STEADY.success_rate` within `BASELINE_TOLERANCE_PP` of the no-abuse baseline, (2) standard-UAS sipp success rate must be 100 %, (3) report (no-fail) on `ABUSE_STREAM` totals.
- [tests/k8s/endurance/render-report.ts](../../tests/k8s/endurance/render-report.ts) — add abuse-stream lane to the timeline plot; per-archetype breakdown; separate panel for standard-UAS success-rate sanity check.
- [tests/k8s/charts/sipp/templates/scenarios-configmap.yaml](../../tests/k8s/charts/sipp/templates/scenarios-configmap.yaml) — pick up the new XML + CSV files.
- [tests/k8s/charts/sipp/templates/uas-deployment.yaml](../../tests/k8s/charts/sipp/templates/uas-deployment.yaml) + [tests/k8s/charts/sipp/templates/uas-service.yaml](../../tests/k8s/charts/sipp/templates/uas-service.yaml) — add a parallel `abuse-uas-*` deployment + service, gated by a values flag so abuseCaps=0 runs don't allocate them.
- [tests/k8s/charts/sipp/templates/call-control.yaml](../../tests/k8s/charts/sipp/templates/call-control.yaml) — mock routing logic: Call-ID prefix `abuse-` → abuse-UAS Service IP; else → standard-UAS Service IP.
- New: [tests/k8s/charts/sipp/scenarios/uac-abuse-*.xml](../../tests/k8s/charts/sipp/scenarios/), [tests/k8s/charts/sipp/scenarios/uas-abuse-*.xml](../../tests/k8s/charts/sipp/scenarios/), matching `*.csv` files.

Reuse points (no new code needed):
- `SippDaemonOpts.scenario` + `-cid_str` cidPrefix already covers per-stream tagging — same shape as the existing `limiter-probe` stream.
- `categorize.ts:113` cidPrefix routing is the exact precedent to copy for ABUSE_STREAM.
- `parseSippStats` already returns per-Job success rows — reuse for the standard-UAS 100 %-OK check.

### Verdict semantics

- **Pass**: real-call success rate in `STEADY` is within `BASELINE_TOLERANCE_PP` (initial 0.1 pp) of the no-abuse baseline AND standard sipp-UAS success rate is 100 % AND post-soak limiter inflight returns to ≤ cap within `LIMITER_RECONCILE_WINDOW_SEC` (10–15 min, per [CONTEXT.md cap-honoring target](../../CONTEXT.md)) AND active dialogs gauge returns to 0 within `TERMINATING_TIMEOUT_MS` + 60 s after DRAIN.
- **Diagnostic-only signals**: per-archetype abuse-call success rates, per-archetype dispatch-queue-drop and event-handler-timeout counts. Failure on these does *not* fail the verdict — they inform which defense to prioritize.
- **Fail**: real-call KPIs degraded beyond tolerance, OR any of the post-soak baselines fail to converge — points at a leak or contention surface that real chaos masked.

A no-abuse baseline run is required first (one 24-h soak with abuse jobs disabled) to fix the comparison point. Re-baseline whenever the harness or B2BUA defaults change materially.

## Out of scope (cross-references)

- **Malformed packet corpus** — extend [tests/sip/parser-compliance.test.ts](../../tests/sip/parser-compliance.test.ts) with PROTOS-style and other public RFC-malformed samples. Separate plan; small.
- **Nefarious / injection risk inventory** — discover and catalog every SIP field the B2BUA dereferences in ways an external caller can weaponize. The seed concern: **prevent internal-DNS attack via SIP signaling** — no externally-supplied hostname (Contact / Route / Record-Route / Path / Refer-To / Reply-To URI hosts, hostnames inside SDP `c=` or `o=` lines) must trigger a resolver lookup against internal cluster names; the resolver path must be allowlisted (or skipped entirely) for non-allowlisted suffixes. Past unintentional DNS-self-DDoS via lookups of bogus entries is the anchor incident. Other surfaces to investigate: oversized headers stored in call cache, log injection via header values, OTel span explosion via ghost calls, limiter-id derivation from caller-controlled fields. Output: catalog → per-surface ADR + targeted test. Separate plan.
- **`MAX_MESSAGES_PER_CALL` defense implementation** — sized after this test exposes which archetypes break the system worst without it.

## Deferred memory writes (to apply after ExitPlanMode)

Plan mode bars memory file edits. Once we exit:

- Save **project memory** `project_internal_dns_attack_risk.md`: the nefarious-injection axis includes a known concern around externally-supplied SIP hostnames triggering internal-cluster DNS lookups. Anchor incident: past unintentional self-DDoS via DNS lookups of bogus entries. Surfaces to audit: Contact / Route / Record-Route / Path / Refer-To / Reply-To URI hosts, SDP `c=` / `o=` hostnames. Defense pattern: resolver allowlist, no internal-name lookups from external signaling. Linked to this plan and the future nefarious-injection inventory plan.

## Verification

End-to-end test path (executes in CI nightly, not per-commit):

1. **Baseline run** — full endurance soak with abuse disabled: `npm run test:nightly -- --suite=endurance --abuse-caps=0`. Captures `verdict.json` with `STEADY.success_rate`, post-soak limiter probe, active-dialogs gauge zero-return time. Stored as the comparison anchor.
2. **Abuse run** — same soak with abuse on: `npm run test:nightly -- --suite=endurance --abuse-caps=15`. Same verdict file, with `ABUSE_STREAM` populated, standard-UAS 100 %-OK invariant checked.
3. **Comparison** — `analyze-endurance.ts` diffs against the stored baseline; report names the per-archetype contribution if `STEADY` regresses.
4. **Per-archetype isolation runs** — when something regresses, re-run with a single archetype enabled to attribute the cause: `--abuse-caps=15 --abuse-only=reinvite-flood`. Single-archetype runs use a short tier (~2 h) and exist for debugging only, not for the canonical verdict.

Forgetting `--abuse-caps` fails CLI parse-time — no default, no silent fallback.

Local fast loop (before pushing to CI):
- `npm run typecheck` clean.
- `npm run test:fake` clean (fake-stack changes — categorize.ts is reached by analyzer unit tests).
- One-archetype kind smoke: bring the kind cluster up with `tests/k8s/scripts/up-full.ts`, launch a single abuse archetype Job manually via `kubectl apply`, verify (a) Call-ID prefix routes to `ABUSE_STREAM`, (b) call-control mock routes B-leg to abuse-UAS Service, (c) standard-UAS pod logs show zero abuse-prefixed Call-IDs received.

## ADR

This plan changes the canonical robustness gate's scope: endurance now covers continuous protocol-level abuse, not only infrastructure chaos. That meets the three ADR criteria (hard to reverse: changes verdict semantics, scope expansion; surprising without context: a future reader sees abuse traffic running and wonders why it's "always on"; trade-off: chose continuous parallel stream over windowed chaos events for steady-state contract clarity). New ADR to draft once the test ships, amending [ADR-0002](../adr/0002-endurance-as-canonical-robustness-gate.md).
