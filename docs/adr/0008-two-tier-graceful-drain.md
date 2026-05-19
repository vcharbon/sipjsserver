# ADR 0008 — Two-tier graceful drain via overload-signal reuse

**Status:** Accepted (2026-05-18)

## Context

Production rolling upgrades issue `kubectl delete pod` against a B2BUA worker. K8s sends SIGTERM and waits `terminationGracePeriodSeconds` before SIGKILL. The pre-existing default was **200 s**, justified in the Helm READMEs as "RFC 3261 Timer C (180 s) + 20 s safety" — under the assumption that an in-INVITE call must be allowed to run to natural completion or Timer C expiry before the worker exits.

Two facts made that justification obsolete:

1. **All call state is replicated** to a peer's `bak:` partition. A confirmed call's in-dialog traffic is served by the backup the moment the proxy stops routing to the primary. There is no need to wait Timer C on the dying worker.
2. **Transaction-layer state is NOT replicated.** Timer A/B/E/F retransmissions, client-txn / server-txn matching, response buffers all live in worker memory only. A trying or early-state call straddling the drain WILL drop the in-flight transaction — but UAC retransmission (Timer A on the originator) bridges the gap to the backup within ≤ 1-2 s.

What the worker actually needs is a protocol that gives the proxy time to **stop sending new INVITEs**, then more time to **stop sending in-dialog traffic**, then enough time to **let replication settle**, then exit. The 200 s window was scaffolding for a missing protocol.

The pre-existing drain mechanism — `DrainingState` flips to `draining` on SIGTERM, OPTIONS replies become `503 + Reason: draining`, proxy demotes via K8s `deletionTimestamp` accelerant + 503 classification, `drainGraceMs=5s` covers in-dialog grace — gets the proxy *demoted* but offers no synchronization point for actual exit.

## Decision

Replace the single `serving / draining` boolean with a **two-tier drain protocol** that reuses the existing overload-signal infrastructure for the proxy-side exclusion path. The worker walks:

```
SIGTERM → draining-new (3 s) → draining-quiet (5 s) → process.exit(0)
```

| Mode | OPTIONS reply | Proxy effect |
|---|---|---|
| `serving` | 200 OK + normal `X-Overload` | Normal routing |
| `draining-new` | 200 OK + `X-Overload: elu=1.0; reason=draining; ...` | Worker enters `above_critical` band → excluded from `selectForNewDialog`. In-dialog routing unchanged. |
| `draining-quiet` | No reply | HealthProbe times out → worker marked `dead` → all routing falls back via `selectForNewDialog` to the peer (which serves out of `bak:`). |

Constants live in `src/b2bua/DrainingState.ts`:

```ts
const DRAIN_TIER1_MS = 3_000   // 3× OPTIONS interval (1 s) — high-confidence proxy scrape
const DRAIN_TIER2_MS = 5_000   // HealthProbe unhealthy detection + replication settle
```

Helm `terminationGracePeriodSeconds` drops from `200` to `20` — `DRAIN_TIER1_MS + DRAIN_TIER2_MS = 8 s` budget + 12 s safety headroom + kubelet bookkeeping.

### Why reuse the overload signal (`elu=1.0`)

The proxy's `WorkerLoadObserver.bandFor(workerId)` already returns `above_critical` when `elu > eluCritical`. The LB already filters `above_critical` out of `selectForNewDialog`. Reusing this path means **zero proxy-side changes** for tier 1. A new field `reason=draining` on the `X-Overload` payload is purely diagnostic — it disambiguates real overload from drain in logs / metrics.

### Why 200 OK in tier 1, not 503

In-dialog routing keys off `health === "alive"`, not the overload band. Keeping OPTIONS at 200 OK during tier 1 ensures:

- The proxy continues to forward in-dialog requests to the draining worker for the `drainGraceMs=5s` window — the worker is still authoritative for those calls.
- The dying worker keeps writing to its replog stream; the peer's `bak:` partition stays current.
- ACK on 2xx + CANCEL remain routable.

If tier 1 used 503, the proxy would mark the worker `draining` *and* lose the in-dialog path — the call would land on the peer's `bak:` partition immediately, with a 1-2 s replication lag potentially fatal to a re-INVITE.

### Why silence (not 503) in tier 2

Silence is what triggers the existing `unhealthyAfterMisses`-driven `dead` transition. A 503 with a different reason would require new proxy classification logic; silence reuses the existing failure path verbatim. Once `dead`, the worker is invisible to the LB — even in-dialog requests fall back to `selectForNewDialog`, landing on the peer (which serves them from `bak:`).

## Accepted impact contract

Per chaos event (one graceful drain):

- **sipp-observed final-fail count ≤ `(1.5 / num_workers) × system_cps`** — measured by the endurance analyzer.
- **MID_DIALOG_DURING_CHAOS fail rate == 0** — calls established before the drain MUST survive (backup serves them).
- New INVITEs that landed on the draining worker during the ≤ 1 s OPTIONS-scrape gap are retried by the proxy to the peer; retries are not counted as failures.

The residual fail count comes from trying / early-state calls whose UAC transaction lived only in the dying worker's memory and whose response or retransmit landed after the worker exited. SIP retransmission absorbs most; the budget covers the rest.

## What was rejected

- **Active BYE-out on SIGTERM** for confirmed calls — would end live user conversations. The whole point of replication is to avoid that.
- **CANCEL all trying/early on SIGTERM** — partial value, but every CANCEL itself generates two transactions that must complete before exit. Pushes the drain budget higher than the retransmission-absorbed alternative.
- **Replicate transaction-layer state** — order-of-magnitude bigger change. Doesn't justify the marginal improvement in residual fail count.
- **Keep 200 s grace period** — Timer C is no longer the binding constraint. The whole point is that a worker doesn't need to wait for Timer C if the backup serves the call.
- **503 in tier 1 instead of 200 OK with `elu=1.0`** — see "Why 200 OK in tier 1".

## Invariants

- `DRAIN_TIER1_MS ≥ 3 × optionsIntervalMs` (proxy must observe the new band).
- `DRAIN_TIER2_MS ≥ unhealthyAfterMisses × optionsIntervalMs + replication_settle_margin`.
- `terminationGracePeriodSeconds ≥ (DRAIN_TIER1_MS + DRAIN_TIER2_MS) / 1000 + safety`. Default Helm value 20 s.

A future deployment that lowers `optionsIntervalMs` must re-check these.

## References

- Chaos events `worker-pod-graceful` (the new event using `--grace-period=20`) and `worker-pod-api-delete-force` (renamed from the previous misnamed `worker-pod-graceful` that was actually `--grace-period=0 --force`).
- `tests/k8s/endurance/expectedImpact.ts` — encodes the budget rule.
- CONTEXT.md — glossary entries `draining-new`, `draining-quiet`, `two-tier drain`.
