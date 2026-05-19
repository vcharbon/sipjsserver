# Plan: graceful worker drain with <1.5/N seconds of CAPS-failure impact

## Context

The endurance report shows a row `worker-pod-graceful | b2bua-worker-0 | 2026-05-18T07:30:40Z | 2026-05-18T07:30:49Z | 8.86s`. The user wants **graceful shutdown to have ~zero impact on traffic** — concretely: sipp-observed final-failed call count per drain event ≤ `(1.5 / num_worker_pods) × system_cps`.

Investigation surfaced three problems:

1. **The event is misnamed.** [tests/k8s/fixtures/podKill.ts:62-74](tests/k8s/fixtures/podKill.ts#L62-L74) implements `worker-pod-graceful` as `kubectl delete pod --grace-period=0 --force` — which skips the kubelet's graceful protocol entirely. SIGTERM is followed by SIGKILL with no `terminationGracePeriodSeconds`. The DrainingState SIGTERM handler at [src/b2bua/DrainingState.ts:69-91](src/b2bua/DrainingState.ts#L69-L91) **never runs**. The mode's own docstring at [tests/k8s/fixtures/podKill.ts:38-41](tests/k8s/fixtures/podKill.ts#L38-L41) admits it "models the 'node-lost' failure". So the 8.86s "graceful" row in the report is, by code, a fast force-delete.
2. **There is no active drain protocol.** [src/b2bua/DrainingState.ts](src/b2bua/DrainingState.ts) only flips a flag; OPTIONS replies become 503-draining, the proxy demotes via `deletionTimestamp` + 503 reason, and `drainGraceMs=5s` covers in-dialog grace. But the worker has no two-tier graceful exit, no synchronization with the proxy before exit, no proof that the backup partition is current before in-flight traffic rolls over.
3. **The expected-impact contract is empty.** [tests/k8s/endurance/expectedImpact.ts:129](tests/k8s/endurance/expectedImpact.ts#L129) ships `"worker-pod-graceful": EMPTY` with a TODO. The test cannot fail on impact regression because no bar exists.

## Goals

A true graceful drain in this codebase that:

- Lets the proxy fully exclude the worker from new-INVITE routing **before** the worker stops handling traffic.
- Lets the proxy fully exclude the worker from in-dialog routing **before** the worker exits.
- Gives the replication channel ~1-2 s to catch the backup up, then exits.
- Holds sipp-observed final-fail count ≤ `(1.5 / N) × system_cps` per drain event. SIP retransmission absorbs the inevitable transaction-layer gap (transaction state is not replicated).
- Lets `terminationGracePeriodSeconds` drop from 200 s to **20 s** (still leaves headroom). Documented as the budget for the two-tier drain + replication settle, NOT for Timer C waiting.

## Design

### Two-tier drain protocol

Reuses the existing **overload signal** infrastructure ([src/sip-front-proxy/WorkerLoadObserver.ts](src/sip-front-proxy/WorkerLoadObserver.ts); CONTEXT.md "ELU band"). The `above_critical` band already filters a worker out of `selectForNewDialog` ([src/sip-front-proxy/strategies/LoadBalancer.ts:303](src/sip-front-proxy/strategies/LoadBalancer.ts#L303)).

| Phase | Worker behaviour | Proxy observation | Effective state |
|-------|------------------|-------------------|-----------------|
| `serving` | OPTIONS → 200 OK with normal `X-Overload` payload | `alive`, band per ELU | Normal |
| **Tier 1 — `draining-new`** (SIGTERM fires) | OPTIONS → 200 OK but with `X-Overload: v=1; elu=1.0; gc=…; adm=…; reason=draining`. Continues to serve in-dialog. | `above_critical` band → filtered from `selectForNewDialog`. In-dialog routing unchanged. | New INVITEs go elsewhere; in-dialog still on this worker |
| **Tier 2 — `draining-quiet`** (after `DRAIN_TIER1_MS`) | OPTIONS → no reply (silence). | HealthProbe timeout → `dead` after `unhealthyAfterMisses`. | Worker fully out of LB; in-dialog falls back to `selectForNewDialog` (→ peer's backup partition for those calls) |
| **Exit** (after `DRAIN_TIER2_MS`) | `process.exit(0)` | Pod terminates; statefulset replaces it | New pod boots, bootstraps from peer |

Why this works for the 0-impact contract:

- **New INVITEs** (gate 4 → `selectForNewDialog`): tier 1 immediately excludes the worker. The OPTIONS interval is 1 s, so the worst-case window between SIGTERM and the proxy hearing the new band is ≤ 1 s. INVITEs that arrived inside that window get a 503 from the worker (the OPTIONS handler at [src/sip/SipRouter.ts:667-708](src/sip/SipRouter.ts#L667-L708) already drops to 503 when `DrainingState.mode === "draining"`); the proxy retries them to the peer worker. Retry success → sipp sees no failure.
- **In-dialog requests** (`drainGraceMs=5s` window): during tier 1 they continue to land on the draining worker. The worker keeps handling them — replication keeps the peer's `bak:` partition current. The dying worker's replog stream stays open ([src/main.ts:303-317](src/main.ts#L303-L317) — not closed on drain).
- **Tier 2 entry**: silencing OPTIONS causes the proxy's HealthProbe to mark the worker `dead` after a few misses. In-dialog requests then `selectForNewDialog`-fall back. The peer worker serves out of its `bak:` partition.
- **Exit**: by the time the worker exits, the proxy has already moved on. Replication has had `DRAIN_TIER1_MS + DRAIN_TIER2_MS ≈ 5 s` to flush. Transaction-layer in-flights are absorbed by **UAC retransmission** (Timer A / Timer E on the originator); response retransmits from upstream peers fill the same role for outbound transactions. The accepted residual is "slightly more than 1 s of traffic" — matched to the CAPS-failure budget.

### Timer floors (constants to add)

In a new module or beside DrainingState:

```ts
const DRAIN_TIER1_MS = 3_000   // 3× OPTIONS interval — covers worst-case proxy scrape miss
const DRAIN_TIER2_MS = 5_000   // HealthProbe unhealthy detection + replication settle
const TERMINATION_GRACE_SEC = 20  // hard ceiling for the whole sequence
```

`DRAIN_TIER1_MS + DRAIN_TIER2_MS = 8 s`. Helm value `terminationGracePeriodSeconds: 20` leaves 12 s of safety headroom + kubelet bookkeeping.

### Worker-side changes

1. **`DrainingState`** gains a third mode value:

   ```ts
   export type DrainingMode = "serving" | "draining-new" | "draining-quiet"
   ```

   Backwards-compatible API: callers that switched on `mode === "draining"` get migrated to `mode !== "serving"`. The flag flip becomes `draining-new` on SIGTERM.

2. **SIGTERM handler** ([src/b2bua/DrainingState.ts:86-89](src/b2bua/DrainingState.ts#L86-L89)) is hoisted to a small drain-orchestrator fiber that runs:

   ```
   markDraining("draining-new")
   yield* Effect.sleep("3 seconds")
   markDraining("draining-quiet")
   yield* Effect.sleep("5 seconds")
   process.exit(0)
   ```

   Placement: replace the silent `process.exit` deferral with an explicit drain-fiber forked from `main.ts` after the SIGTERM signal. Keeps DrainingState a pure flag service; orchestration sits next to other lifecycle code.

3. **OPTIONS reply branch** in [src/sip/SipRouter.ts:667-708](src/sip/SipRouter.ts#L667-L708):

   - `serving` → 200 OK with current `X-Overload` payload (unchanged).
   - `draining-new` → 200 OK with `X-Overload: elu=1.0; …; reason=draining`. **Important:** must remain 200 OK (not 503), so the proxy still treats the worker as alive for in-dialog routing; the high `elu` signal is what excludes it from new-INVITE selection.
   - `draining-quiet` → no reply at all (drop the OPTIONS without responding).

4. **No active BYE/CANCEL emission** is part of this plan. Transaction-state replication is out of scope; SIP retransmission absorbs the gap.

### Proxy-side changes

Verify (do not need to change):
- `selectForNewDialog` filter on `above_critical` already excludes the worker on the next OPTIONS scrape.
- HealthProbe's `unhealthyAfterMisses` already marks the worker `dead` on consecutive OPTIONS timeouts. Confirm `unhealthyAfterMisses × optionsIntervalMs ≤ DRAIN_TIER2_MS - replication_settle_margin`. If not, lower the threshold for this code path or raise `DRAIN_TIER2_MS`.

### Test changes

1. **Rename existing event**: `worker-pod-graceful` → `worker-pod-api-delete-force` in:
   - [tests/k8s/endurance/dispatchChaos.ts:52-80](tests/k8s/endurance/dispatchChaos.ts#L52-L80)
   - [tests/k8s/endurance/expectedImpact.ts:129](tests/k8s/endurance/expectedImpact.ts#L129)
   - [tests/k8s/endurance/scheduler.ts:52-78](tests/k8s/endurance/scheduler.ts#L52-L78) (weights)
   - [tests/k8s/endurance/categorize.ts](tests/k8s/endurance/categorize.ts) (event-type unions)
   - [tests/k8s/endurance/render-report.ts](tests/k8s/endurance/render-report.ts) (label tables)
   - `ChaosEventType` type definition (grep for the literal)

2. **Add new event**: `worker-pod-graceful` that calls `killPod` with a new mode `delete-grace20`:
   ```
   kubectl delete pod --grace-period=20 --ignore-not-found
   ```
   The kubelet sends SIGTERM and waits up to 20 s. The new mode goes in [tests/k8s/fixtures/podKill.ts](tests/k8s/fixtures/podKill.ts) as a third `KillMode` literal.

3. **Expected-impact contract** for the new event in [tests/k8s/endurance/expectedImpact.ts](tests/k8s/endurance/expectedImpact.ts):
   ```ts
   "worker-pod-graceful": {
     description: "Graceful drain via SIGTERM → two-tier OPTIONS → exit. " +
       "Budget: sipp-observed final-fail count ≤ ceil(1.5 / num_workers × system_cps).",
     rules: [
       {
         kind: "sipp-final-fail-budget",
         expression: "(1.5 / numWorkers) * systemCps",
         streams: ["endurance-short", "endurance-long-options", "endurance-limiter"],
       },
       // Mid-dialog calls established before chaos: zero tolerance — backup serves them.
       { kind: "category-fail-rate", category: "MID_DIALOG_DURING_CHAOS", max: 0 },
     ],
   }
   ```
   The exact rule shape may need adapter code in [categorize.ts](tests/k8s/endurance/categorize.ts) — use the same machinery the modelled events use (e.g. `node-shutdown-edge` at lines 156-201).

4. **Helm value default**: drop `terminationGracePeriodSeconds: 200` to `20` in [deploy/helm/b2bua-worker/values.yaml:34](deploy/helm/b2bua-worker/values.yaml#L34). Update the README at [deploy/helm/b2bua-worker/README.md:127](deploy/helm/b2bua-worker/README.md#L127) to explain the new bound (two-tier drain budget, NOT Timer C). Leave the proxy's 200 s in place — proxy graceful drain is a different conversation and has its own ADR backlog.

5. **Fake-stack regression test** under [tests/](tests/) that drives the two-tier protocol via the test `DrainingState.test` layer:
   - Set up two `embeddedB2bua` workers (peer pair) with active calls in trying / early / confirmed states.
   - Flip worker-0 to `draining-new`. Assert OPTIONS replies carry `elu=1.0; reason=draining` and that 200 OK still flows. New INVITEs routed through a simulated proxy land on worker-1.
   - Flip to `draining-quiet`. Assert OPTIONS get no reply. In-dialog requests for confirmed calls route to worker-1, which serves them out of its `bak:` partition.
   - Kill worker-0. Assert sipp-observed-final-fail count for the simulated traffic == 0 (the SIP retransmission window absorbs the rest in the fake-clock test because TestClock can advance Timer A explicitly).

## Critical files to modify

| File | Change |
|------|--------|
| [src/b2bua/DrainingState.ts](src/b2bua/DrainingState.ts) | `DrainingMode` gains `"draining-new" \| "draining-quiet"`. Replace inline `process.on("SIGTERM", …)` flag-flip with a forked drain-orchestrator fiber that walks `draining-new` → sleep → `draining-quiet` → sleep → `process.exit(0)`. Constants `DRAIN_TIER1_MS=3000`, `DRAIN_TIER2_MS=5000` live in this file. |
| [src/sip/SipRouter.ts:667-708](src/sip/SipRouter.ts#L667-L708) | OPTIONS handler: branch on `DrainingMode`. `serving` → 200 OK as-is. `draining-new` → 200 OK with `X-Overload: v=1; elu=1.0; gc=…; adm=…; reason=draining`. `draining-quiet` → no reply. Remove the existing 503-draining branch — superseded. |
| [src/main.ts](src/main.ts) | Hoist the drain-orchestrator fiber (created above) into the application Layer so it can call `process.exit` with full context. |
| [tests/k8s/fixtures/podKill.ts](tests/k8s/fixtures/podKill.ts) | Add `KillMode` literal `"delete-grace20"` that invokes `kubectl delete pod --grace-period=20 --ignore-not-found` (no `--force`). |
| [tests/k8s/endurance/dispatchChaos.ts](tests/k8s/endurance/dispatchChaos.ts) | Rename existing `worker-pod-graceful` → `worker-pod-api-delete-force` (mode `delete-grace0`). Add new `worker-pod-graceful` → mode `delete-grace20`. |
| [tests/k8s/endurance/expectedImpact.ts:129](tests/k8s/endurance/expectedImpact.ts#L129) | Replace `EMPTY` with the budget rules above. Add an `EMPTY`-ish entry for `worker-pod-api-delete-force` (TODO — its contract is a separate concern). |
| [tests/k8s/endurance/scheduler.ts:52-78](tests/k8s/endurance/scheduler.ts#L52-L78) | Add the new event to weight table (keep total weight roughly balanced; e.g. 5 → 3 each). |
| [tests/k8s/endurance/categorize.ts](tests/k8s/endurance/categorize.ts) | Add the literal to the `ChaosEventType` union; ensure the report tables render both rows. |
| [tests/k8s/endurance/render-report.ts](tests/k8s/endurance/render-report.ts) | Add label/description for both event types. |
| [deploy/helm/b2bua-worker/values.yaml:34](deploy/helm/b2bua-worker/values.yaml#L34) | `terminationGracePeriodSeconds: 200` → `20`. |
| [deploy/helm/b2bua-worker/README.md:127](deploy/helm/b2bua-worker/README.md#L127) | Replace the "RFC 3261 Timer C" justification with the two-tier drain budget explanation. |
| [CONTEXT.md](CONTEXT.md) | Add glossary entries: **draining-new**, **draining-quiet**, **two-tier drain**. Note the disambiguation between the old `worker-pod-graceful` (now `worker-pod-api-delete-force`) and the new one. |

## Verification

### Typecheck
`npm run typecheck` — zero TS errors, zero Effect-plugin warnings. The `DrainingMode` change touches one switch site and one OPTIONS handler; the compiler will surface any forgotten branch.

### Fake-stack regression test
New file `tests/drain/graceful-two-tier.test.ts` (or co-located with existing drain tests):
- `it.effect` against `DrainingState.test` + TestClock.
- Walks `serving → draining-new → draining-quiet → exit`.
- Asserts OPTIONS replies in each phase + cross-worker in-dialog routing transitions to backup at tier 2.
- Asserts no sipp-equivalent final-fail.

### Endurance re-run
`npm run test:k8s:endurance` with the renamed/added events. Acceptance:
- New `worker-pod-graceful` events: per-event `sipp_failed_count ≤ ceil((1.5 / num_workers) × system_cps)` AND `MID_DIALOG_DURING_CHAOS` fail rate == 0.
- Renamed `worker-pod-api-delete-force` events: unchanged behaviour (its contract stays TODO, separate plan).
- `b2bua_zombie_timeout_total = 0` across the run (regression guard).

### Helm contract check
Manual: render the chart and confirm `terminationGracePeriodSeconds: 20` in the rendered StatefulSet. The K8S_DEV_TEST.md note about "Don't lower [200s] without re-running CHAOS-11" gets updated to reference this plan as the new contract.

## Open trade-offs (intentional, document inline)

- **`DRAIN_TIER1_MS=3s`**: covers OPTIONS interval (1 s) × 3 = high confidence the proxy sees the new band. Lower this only if `optionsIntervalMs` is lowered too.
- **`DRAIN_TIER2_MS=5s`**: covers HealthProbe unhealthy detection (`unhealthyAfterMisses × optionsIntervalMs`) PLUS replication settle (~1-2 s observed). Lowering it risks in-dialog requests arriving at a dying worker after exit.
- **`terminationGracePeriodSeconds: 20`**: hard ceiling. Above the 8 s drain budget by 12 s. If a deployment's OPTIONS interval is non-default, raise this proportionally.
- **No active BYE/CANCEL**: the small residual fail count (≤ `(1.5/N) × cps` per drain) is the accepted price of skipping transaction-state replication. Documented as the contract, not as a bug.

## ADR to draft as part of execution

A new ADR `docs/adr/0008-two-tier-graceful-drain.md` should be added in the same change. It clears all three ADR bars:

- **Hard to reverse** — lowering `terminationGracePeriodSeconds` to 20 s eliminates the Timer C drain window the chart README currently cites as the justification for 200 s.
- **Surprising without context** — using `elu=1.0` on OPTIONS to drain is reusing the overload signal for a non-overload purpose. Without the ADR, a future reader will mistake a draining worker for an overloaded one (and the `reason=draining` field will look like dead weight).
- **Real trade-off** — alternatives considered (active BYE-out, transaction-state replication, keeping 200 s grace) all rejected for specific reasons (user-visible call drops, replication cost, kubelet-bookkeeping overhead). Capture those rejections so the next reviewer knows why.

Plan-mode constraint prevents creating the ADR file now; it is the FIRST execution step after this plan is approved.

## CONTEXT.md updates (also blocked by plan mode)

Per grill-with-docs, the new vocabulary should land in [CONTEXT.md](CONTEXT.md) alongside the code change. Terms to add:

- **draining-new** — first phase of the two-tier drain. OPTIONS still 200 OK; payload signals `elu=1.0; reason=draining` so the proxy excludes from new-INVITE selection via the existing `above_critical` band path. In-dialog routing unchanged.
- **draining-quiet** — second phase. Worker stops replying to OPTIONS entirely. HealthProbe marks worker `dead` on consecutive misses; in-dialog falls back to `selectForNewDialog` (→ peer's backup partition).
- **two-tier drain** — the worker-side SIGTERM-driven sequence walking `serving → draining-new → draining-quiet → exit`.
- Disambiguation entry: under "Abuse classes" or near the chaos vocabulary, note that **`worker-pod-graceful`** (the test event) is now `kubectl delete --grace-period=20`, distinct from **`worker-pod-api-delete-force`** which is the renamed fast-API-delete chaos.
