# 0002 — Endurance is the canonical robustness gate; failover is a historical sub-case

**Status:** accepted (2026-05-15); amended 2026-05-15 — see "2026-05-15 amendment" below

## Context

Two K8s test surfaces grew up in parallel: the failover suite (`npm run test:k8s:failover`, ~5 min, 7 hand-picked `(state-at-kill × kill-mode)` cells) and the endurance suite (`npm run test:k8s:endurance`, 1–24 h, semi-random chaos schedule covering worker/proxy/VRRP/node-shutdown). Both assert the fleet survives faults, but readers consistently ask which one gates a release. Operator practice has drifted: dashboards aren't wired into the failover path, the endurance run's BRINGUP doesn't rebuild images or apply the observability collector, and the docs treat the two suites as co-equal. The result is an ambiguous "robustness" surface where pre-flight mistakes ("the collector wasn't deployed", "the image wasn't rebuilt", "the cluster wasn't fresh") routinely waste hours.

## Decision

**The endurance suite is the canonical robustness gate.** It runs from a freshly recreated kind cluster, with `--reuse-cluster` removed, and its chaos schedule covers every failover case the standalone failover suite exercises plus the ones it doesn't (VRRP cutoff, node shutdown, sustained-load interactions). The full bring-up — host observability stack, kind-addons (vmagent + fluent-bit + node-exporter + kube-state-metrics), image rebuild + `kind load`, chart install, host-side post-up sanity call against [tests/fullcall/e2e-register-fakeExt-realCore.test.ts](../../tests/fullcall/e2e-register-fakeExt-realCore.test.ts) — is folded into a single `npm run test:k8s:up` entry point that endurance consumes verbatim.

**The failover suite is retained as a debugging zoom-in tool**, documented as an appendix to the endurance guide rather than as a parallel suite. It exists to iterate on one specific `(state-at-kill × kill-mode)` cell without paying the full robustness-run cost — not as a regression gate.

## Considered options

- **Keep both as co-equal regression gates.** Rejected — runs into the operator ambiguity above and forces double-maintenance of two pre-flight surfaces.
- **Promote failover to the gate, keep endurance as the soak.** Rejected — failover doesn't cover VRRP-cutoff, node-shutdown, or sustained-load interactions, and its hand-picked cells miss interaction effects between successive failures that endurance's random schedule catches.
- **Merge both into one suite.** Rejected — failover's strength is its targetability for debugging a specific cell in <5 min; endurance's strength is its breadth in 1–24 h. Different operator personas, kept as different entry points.

## Consequences

- The endurance BRINGUP becomes the single source of truth for "what does a ready cluster look like". The collector, the observability stack, the images, and a representative sanity call are all guaranteed by the same script — eliminating the class of bad-launch errors where a 6-hour run starts on a half-broken cluster.
- `--reuse-cluster` is gone; the inner-loop orchestrator-iteration use case it served is covered by an undocumented `tests/k8s/scripts/up.ts` helper that the regular `up-full` path supersedes for any verdict-bearing run.
- The failover suite moves from `docs/K8S_test.md §7` to an appendix of `docs/k8s-endurance.md`, explicitly framed as a sub-case. Future engineers reading the suite-list will see one gate, not two.
- Reversing this decision means re-introducing two parallel surfaces, with the maintenance burden that motivated this ADR in the first place. The structural cost makes it a deliberate choice to revisit rather than a drift.

## 2026-05-15 amendment — chaos catalog admission rule

The original ADR locked the chaos catalog to events whose proper handling has *near-zero traffic impact* — `proxy-cutoff-workers` and `proxy-cutoff-ingress` were explicitly rejected on that basis. That rule is now retired.

New rule: **an event is admissible iff its impact on running traffic is explicitly modelled in an `ExpectedImpact` spec.** The spec lives in `tests/k8s/endurance/expectedImpact.ts` keyed by `ChaosEventType` and combines:

- *Tolerance rules* (verdict mask): "during this window, the metric may be as bad as X." Breach above X fails the verdict; everything below is absorbed and the verdict still PASSes.
- *Chaos-effectiveness assertions*: "the chaos primitive must visibly affect metric Y." A silently-no-op chaos event fails the assertion and surfaces in the report.
- *Recovery assertions*: "Z seconds after `tRecovered`, the metric must return to baseline." Catches "the cut left the system in a degraded state that didn't self-heal."

Motivation: the catalog was getting brittle. Failure modes that have real-world analogs (worker isolated from proxy, partial-loss links, overload bursts from misbehaving customers) were excluded because their *expected* traffic impact wasn't zero. Capturing that expectation explicitly is more honest and turns the catalog from "things that are silent" into "things whose behaviour we can defend against regression in."

Consequences:

- The previously-rejected `proxy-cutoff-workers` is admitted under the new rule as `worker-cut-from-proxy-hard` (plus three more `worker-cut-from-*` variants and a triple cut), each with its own ExpectedImpact spec.
- A new `non-emergency-burst` event spawns an ad-hoc sipp Job at 200 CAPS without a `Resource-Priority` header for 60 s, exercising all three overload tiers. The existing baseline scenarios are marked `Resource-Priority: esnet.0` so they're unaffected by the burst.
- A new `proxy-full-isolate` event complements `proxy-cutoff-vrrp`: VRRP-only drops test split-brain handling under `nopreempt`, full isolation tests clean VIP fail-over.
- A new `--no-chaos` mode + `npm run test:k8s:chaos` sub-command exist as the inner-loop iteration entry points: baseline campaign runs long-running, chaos events fire on demand into the running campaign via a separate process that owns the chaos primitive + analyzer + verdict end-to-end. Transport is the shared artifact dir (no HTTP). This lets us edit chaos / ExpectedImpact code and re-fire without bouncing the cluster.

Reversing this amendment means going back to the old admission rule, dropping all worker-network-isolation events from the catalog, and removing the ExpectedImpact infrastructure. Plausible if the false-positive cost of structured impact specs ever outweighs the coverage gain — but the structural cost makes it a deliberate decision to revisit, not a drift.
