# Plan: stop limiter-Redis loss from cascading into total worker service loss

## SLA constraint (from operator)

Outside explicit *deactivate* scenarios, **no single chaos event may impact
more than the equivalent of 1–2 seconds of calls**. At 40 CAPS that is
≈ 40–80 failed calls across the entire chaos + recovery window. Everything
in this plan is graded against that bound.

## Problem statement

An incidental loss of the **shared limiter Redis** (single replica, no
node-affinity in the kind test stack) currently produces total service loss
on the affected workers for ~60–90 s, far above the 1–2 s SLA. The limiter
is documented as fail-open on `RedisError`
([src/decision/apply/applyRoute.ts:197-208](../../src/decision/apply/applyRoute.ts#L197-L208)),
but observation shows INVITE handlers stalling for the full 10 s handler
timeout, the transaction-layer queue saturating, and a follow-on wave of
"Call not found / Unroutable" mid-dialog failures driven by the call-state
orphan-sweep purging in-flight dialogs.

The HA proxy pair and worker pair survive node loss as designed. What does
not survive is the **single-replica limiter Redis** being co-tenant with a
killed node *or* losing connectivity in any other way.

## Finding — 2026-05-15 endurance run

Run id: `endurance-5h-40caps-2026-05-15t22-13-47`
([artifact dir](../../test-results/k8s-endurance/endurance-5h-40caps-2026-05-15t22-13-47/)).

Chaos event #1 — `node-shutdown-edge` — fired at `2026-05-15T20:42:41.028Z`
and recovered at `2026-05-15T20:43:47.398Z` (61 s outage of the kind node
`sip-e2e-worker`). Pure scheduling luck placed the limiter Redis pod
(`redis-96b66f94c-724hr`, see `k8s-events.ndjson`:
`Successfully assigned sip-test/redis-96b66f94c-724hr to sip-e2e-worker`)
on the killed node — so node-shutdown collapsed into limiter-Redis-shutdown.

Observed cascade on `b2bua-worker-0` (live, unaffected by the kill):

| T+ms  | Event                                                                           |
|------:|---------------------------------------------------------------------------------|
|   258 | `WARN Redis (limiter): error — read ECONNRESET`                                 |
|   311 | `WARN Redis (limiter): connect ECONNREFUSED 10.96.44.111:6379`                  |
|  5361 | `WARN TransactionLayer event queue full (capacity=400); first drop=request_other` |
| 10183 | `ERROR Event handler timed out after 10000ms — event=sip method=INVITE`         |
| 14922 | first `WARN [CallState] Orphan sweep recovering terminating call … (age 44756ms)` (continues for ~1 s) |
| 40454 | first `WARN Unroutable BYE …`                                                   |
| 76866 | wave of `WARN Call … not found on checkout for 200 OK leg=b-1 — rejecting`      |
| 110000 | `WARN Transaction timeout: invite branch=…` wave begins                        |

Limiter-probe NDJSON cross-confirms the outage:

```
20:42:39 inflight=10 redisReady=true     ← steady state (cap-saturated)
20:42:49 inflight= 0 redisReady=true     ← +8 s after kill
20:43:34 inflight= 0 redisReady=false    ← +53 s, scanner gives up
20:43:54 inflight= 0 redisReady=true     ← +73 s, Redis back
20:44:04 inflight=10 redisReady=true     ← +83 s, recovered
```

Worker-0 VmRSS drop in the same window confirms in-flight call state was
shed: 216 MB → 162 MB → 142 MB → 160 MB (`metrics/b2bua-worker-0.proc.ndjson`).

Net business impact: ~60 s of zero-traffic on the `endurance-short` stream
(35 CPS × 60 s ≈ 2 100 calls lost on that stream alone) plus mid-dialog
casualties for ~1 minute after recovery as in-flight 200 OK / 180 Ringing
responses arrived for calls whose state had already been purged.

## Cause chain (what is actually broken)

1. **SPOF — shared limiter Redis is single-replica with no nodeSelector.**
   `tests/k8s/charts/redis/templates/deployment.yaml` requests
   `replicas: 1` and does not pin to a tier, so the kube-scheduler can
   place it on any node — including `tier: edge`. When edge is the
   chaos target, killing one edge node kills the limiter Redis as well.

2. **Fail-open path doesn't actually fail open under TCP black-hole.**
   `applyRoute.ts:197` catches `RedisError` and `continue`s past the
   limiter entry. The 2026-05-15 log shows
   `Redis (limiter): error — read ECONNRESET` and
   `connect ECONNREFUSED 10.96.44.111:6379` — yet INVITE handlers
   nevertheless stalled for the full 10 s handler timeout and the
   transaction queue saturated. **The catchTag is not firing on every
   failure mode.** Two candidates to verify:
   - the underlying Redis client buffers commands during reconnect
     instead of erroring them out;
   - or `checkAndIncrement` is awaiting an ack that never arrives, so
     the Effect never reaches the `catchTag` continuation.
   Until proven otherwise, treat this as the load-bearing bug.

2b. **Increment/decrement asymmetry leaks negative counters.** When (2)
    *does* eventually fire `RedisError` and the call is admitted
    fail-open ([applyRoute.ts:208](../../src/decision/apply/applyRoute.ts#L208)
    — `result === undefined ⇒ continue`), the call carries its
    `limiterEntries` through the cleanup path. On termination,
    [CallState.ts:878](../../src/call/CallState.ts#L878) calls
    `limiter.decrement(entry.limiterId, entry.originWindow)`
    *unconditionally* — including for entries whose increment was
    skipped. The Lua decrement is a bare `DECR`
    ([CallLimiter.ts:63-65](../../src/call/CallLimiter.ts#L63-L65))
    with no clamp at zero. Observed in the 2026-05-15 run: limiter
    probe `inflight` dropped to **−5** and stayed there for the rest
    of the run (verdict `limiterProbe.mean = 3.14` vs the cap=10
    nominal of ~10). Once below zero, the limiter under-counts and
    admits over-cap traffic. **The fix to (2) must also tag each
    `limiterEntry` with `incrementSucceeded: boolean` and skip
    decrement when false.**

3. **Orphan-sweep amplifies a transient limiter outage into permanent
   dialog loss.** The 2026-05-04 ADR-0003 + commit `8903ea76` arm a
   safety timer when a call enters terminating. Under Redis stall the
   handler times out before cleanup completes; the sweep then fires
   (`age 44756ms` matches ~10 s handler-timeout + the configured sweep
   delay) and **purges in-flight dialogs**. After purge, the legitimate
   peer responses (200 OK, 180 Ringing, BYE) arrive at a worker that no
   longer has the call → rejection. This converts a ~73 s limiter
   outage into a ~110 s service outage and corrupts calls that were on
   their way to a clean completion.

The detection rules already added in
[tests/k8s/endurance/expectedImpact.ts](../../tests/k8s/endurance/expectedImpact.ts)
for `node-shutdown-edge` will catch (1). Items (2) and (3) need code
fixes; (2) is the primary, (3) is mitigation for any future limiter
outage that does slip past the fail-open path.

## Reproduction

The cascade reproduces in two ways. Both should be added to the
inner-loop chaos iteration harness (`npm run test:k8s:chaos`).

### A. Direct limiter-Redis loss (isolates the limiter path)

```
npm run test:k8s:chaos -- --type limiter-redis-kill9
```

(`limiter-redis-kill9` already exists in
[tests/k8s/endurance/chaosOps.ts](../../tests/k8s/endurance/chaosOps.ts).)
This kills only the limiter Redis pod and waits for recovery — the
proxy pair, both workers, and the call-context sidecars are untouched.
If the cascade reproduces here, the cause is fully isolated to the
limiter-Redis dependency on the worker hot path. **This is the
canonical isolation test.**

### B. Network-isolated worker ↔ limiter-Redis (`worker-cut-from-limiter-redis-hard`)

```
npm run test:k8s:chaos -- --type worker-cut-from-limiter-redis-hard
```

Already covered by an `ExpectedImpact` rule
([expectedImpact.ts:158](../../tests/k8s/endurance/expectedImpact.ts#L158))
which today permits up to 85 % failure rate — too lenient by an order
of magnitude against the 1–2 s SLA. Use this scenario as a second
witness: if (A) reproduces but (B) does not, the issue is in
client-side reconnect/queueing, not the cap path.

### C. Node-shutdown-edge with Redis pinned to edge

For the production-realistic version of today's incident, pin the
limiter Redis to a specific edge node via a temporary `nodeSelector`
patch and fire `node-shutdown-edge`. Reproduces today's exact
observation; should pass once the fix lands and the SPOF is removed.

### Acceptance for "reliably reproduces"

In all three scenarios, the recorder must show:
- `endurance-short` failure rate > 50 % across a ≥ 15 s window from
  `tFire` (the regression we are fixing);
- mid-dialog (post-recovery) failure-rate wave on `endurance-short`
  (the orphan-sweep amplification fingerprint).

## Isolation — proving the cause is the limiter path, not something else

Run the three reproductions and the analyzer; the ExpectedImpact
catalog gives us per-rule pass/fail granularity:

| Scenario | Expectation if hypothesis correct | If not |
|---|---|---|
| `limiter-redis-kill9` (A) | All 4 node-shutdown-edge-style rules fail | Cause is elsewhere (proxy? call-cache?) |
| `worker-cut-from-limiter-redis-hard` (B) | Same rules fail | Cause is in TCP connect logic, not in command-path |
| `node-shutdown-edge` after Redis pin to `tier: app` (C) | All 4 rules **pass** | Edge-node death itself is still cascading — investigate proxy/worker connectivity. |

The contrast between (A)/(B) failing and (C) passing is the proof that
the cascade is gated on the limiter Redis reachability.

## Fix plan (staged — land in order)

### Stage 1 — defensive: stop the SPOF from being scheduled on an edge node

**cancled this part**

### Stage 2 — make the limiter actually fail-open on every failure mode

**Goal.** When the limiter Redis is unreachable, `checkAndIncrement`
returns `undefined` (or a fail-open marker) **within ≤ 100 ms**, so the
handler proceeds and the call is admitted. This is what
`applyRoute.ts:197` already assumes.

**Investigation.**
1. Read the limiter implementation (likely
   `src/cache/CallLimiter*.ts` and the shared `RedisClient`) and confirm:
   - Does `checkAndIncrement` use a hard per-call timeout?
   - When the underlying socket is `ECONNRESET`, does the client surface
     this to the awaiter or queue the command for the next connect?
   - When `connect ECONNREFUSED` repeats, does each command await the
     next reconnect attempt or fail fast?
2. Trace which failure modes produce `RedisError` (caught by
   `applyRoute.ts:202`) and which produce something else (uncaught) or
   simply never resolve.

**Likely change.**
- Wrap `checkAndIncrement` in `Effect.timeout(100ms)` at the
  `applyRoute` call-site, with the timeout mapped to the same
  `result === undefined ⇒ continue` outcome as the existing
  `RedisError` branch. *Justification: the limiter is best-effort
  background bookkeeping; it must never block the SIP hot path.*
- **Tag each admitted `limiterEntry` with the increment outcome.** When
  the timeout/RedisError path skips the increment, record
  `incrementSucceeded: false` (or omit the entry from the call's
  `limiterEntries` array). On cleanup, both the rule-path decrement
  ([InvariantEnforcer](../../src/b2bua/rules/framework/InvariantEnforcer.ts))
  *and* the force-purge decrement
  ([CallState.ts:878](../../src/call/CallState.ts#L878)) must skip
  entries whose increment never succeeded. This is the fix for cause
  (2b) — without it, every fail-open admission leaks one decrement and
  the counter goes negative.
- Verify the Redis client's `enableOfflineQueue` is **off** for the
  limiter connection. If it is on, commands issued during reconnect
  queue silently and resolve after reconnect — that matches the
  observed stall.
- Confirm with [docs/typescript-effect.md](../typescript-effect.md)
  that `Effect.timeout` interrupts the underlying fiber so the Redis
  command is not leaked (must-run categorisation per ADR-0003).

**Reverify.** Run (A) and (B); the four new rules must pass — i.e.
`endurance-short` failure rate stays within the 1–2 s SLA bound. **Also
recheck the limiter probe trace after (A): `inflight` must stay
≥ 0 throughout the run** (no symmetric-DECR leak); add a new analyzer
rule `limiterInflight >= 0` as a regression guard if the probe trace
makes it convenient.

### Stage 3 — stop orphan-sweep from purging dialogs that are only "slow"

**Goal.** A 10 s handler timeout while waiting on a transient
dependency must not result in the dialog being purged. The sweep
should distinguish *truly orphaned* (no traffic on the dialog, no
peer state) from *cleanup-in-progress* / *peer still responding*.

**Investigation.**
1. Locate the orphan-sweep predicate (`src/call/CallState.ts`,
   probably the `forcePurge*` family per CLAUDE.md). Identify the
   exact condition that triggers a purge.
2. Cross-reference with ADR-0003 categorisation: which effects in the
   terminate path are tagged must-run? If the cleanup is "best-effort"
   and gets aborted by handler interruption, the sweep mistakenly sees
   an abandoned dialog.
3. Determine whether the wave of `Call … not found on checkout for
   200 OK leg=b-1` is caused by (i) the sweep firing while the peer
   is still responding, or (ii) the sweep racing with the peer's
   200 OK arriving on a different fiber. Behaviours differ — (i) is
   a predicate bug, (ii) is a concurrency bug.

**Likely change.** Add a "last-peer-activity" timestamp on CallState;
the sweep only purges when *both* the safety timer has fired *and*
no peer message arrived in the last N seconds. Land alongside a
fake-clock unit test that drives the same cascade (limiter stall +
peer 200 OK arriving 11 s later) and asserts the dialog is *not*
purged.

**Reverify.** Run (A), (B), (C); confirm the post-recovery
mid-dialog wave is gone (the third rule, `midDialogFailureRate < 5 %`,
should pass with margin).

### Stage 4 — production HA for limiter Redis (out of scope here)

Tracked separately. Once Stages 1–3 land, the system tolerates a
single limiter Redis loss within SLA; making the limiter Redis HA
itself is the next ring of defence and belongs in its own plan.

## Acceptance criteria

The plan is fully landed only when **all** of the following hold:

1. Reproductions (A), (B), and (C) above all pass the four
   `node-shutdown-edge` `ExpectedImpact` rules
   ([expectedImpact.ts:137](../../tests/k8s/endurance/expectedImpact.ts#L137)).
2. In each reproduction, the `endurance-short` stream sees no more
   than the equivalent of 2 s of calls failing across the entire
   chaos+recovery window — i.e. ≤ ~70 failed calls at 35 CPS.
3. In each reproduction, no `Call … not found on checkout` warnings
   appear in worker logs in the 30 s following `tRecovered`.
4. The limiter-probe trace (`limiter-probe.ndjson`) has
   `inflight >= 0` for every sample across the full run — no symmetric
   `DECR`-without-`INCR` leak from fail-open admissions.
5. A new fake-clock unit test reproduces the orphan-sweep race
   without touching kind/k8s and pins the Stage 3 behaviour.

## Out of scope

- Production-grade Redis HA (sentinel / cluster) for the limiter.
- Call-context sidecar Redis (different topology, different SIP-timer
  constraints — see `docs/replication/call-cache-backup.md`).
- Generalising the timeout-and-fail-open pattern to other backends
  (call-control HTTP, OTel exporter, etc.); each one has its own
  failure semantics and should be evaluated separately.
