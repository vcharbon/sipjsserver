# Call Limiter on HA — shared Redis + decrement on backup paths

## Context

The `CallLimiter` is meant to enforce a **global** concurrent-call cap across the
entire B2BUA fleet. In production, workers point at a single shared Redis URL
and the windowed counter at `limiter:{id}:{window}` works correctly across all
workers.

In the kind/k8s test stack today, however, each worker pod runs its own
sidecar Redis (`REDIS_URL=redis://localhost:6379`) and the shared Redis
deployment was removed as collateral when sidecars were introduced (commit
`db1c106`, "data-replication topology: per-pod Redis sidecar"). This means:

1. **In the k8s test stack**, every limiter increment/decrement hits the local
   sidecar — counters are silently per-worker, so multi-worker rejection
   semantics are not validated end-to-end.
2. **In the fake stack**, `CallLimiter.memoryLayer` is composed inside the
   per-worker `MidServices` ([tests/support/networkLeaves.ts:152](../../tests/support/networkLeaves.ts#L152)),
   so each worker holds its own `MutableHashMap` — the existing
   `two-calls-routed-to-two-workers` HA scenario cannot exercise cross-worker
   limit enforcement.
3. **In production**, the limiter and the call-context cache currently share
   the *same* `RedisClient` (single `REDIS_URL`). For an HA deployment that
   wants per-pod sidecars for the call context (see below) plus a shared
   limiter, this collapses into one connection target — which forces a choice
   between correct limiter or low-latency call-context writes.

This plan introduces a **second, dedicated Redis target for the limiter**,
restores the shared Redis pod in kind, lifts the in-memory limiter to a SUT-
level shared instance for fake tests, and adds tests that prove the limiter is
correctly decremented when BYE is processed by the backup worker (primary
draining/dead) or by a respawned primary.

The split also lets us **document a load-bearing architectural decision**:
the call-context cache uses per-pod sidecars *on purpose* to keep SIP
hot-path writes off any cross-pod hop (the SIP timers in
`docs/replication/call-cache-backup.md` §1 do not tolerate the latency of a
shared Redis even in-cluster). The limiter has no such constraint — its writes
sit outside the SIP retransmission path — and should live on a shared Redis.
This is mentioned in passing today (`call-cache-backup.md:55`, `:259`) but not
as a top-level rationale.

## Architecture

| Concern         | Storage             | Endpoint                      |
| --------------- | ------------------- | ----------------------------- |
| Call context    | Per-pod sidecar     | `redis://localhost:6379`      |
| Call limiter    | Cluster-shared pod  | `redis://redis-shared:6379`   |

Two separate `ServiceMap.Service` tags so the layers cannot be confused at
composition time. One `RedisClient` for the cache, one
`LimiterRedisClient` for the limiter.

## Code changes

### 1. New service & config

- **[src/redis/RedisClient.ts](../../src/redis/RedisClient.ts)** — extract a
  generic factory `RedisClient.makeLayer({ urlField, tag })` so both clients
  share the connection logic. Existing `RedisClient.layer` continues to
  produce the cache client from `AppConfig.redisUrl`.
- **[src/redis/LimiterRedisClient.ts](../../src/redis/LimiterRedisClient.ts)** (new)
  — `class LimiterRedisClient extends ServiceMap.Service<...>("@sipjsserver/LimiterRedisClient")`,
  `LimiterRedisClient.layer` reads `AppConfig.limiterRedisUrl`.
- **[src/config/AppConfig.ts](../../src/config/AppConfig.ts)** — add
  `limiterRedisUrl: Schema.String` (line ~14) and read
  `LIMITER_REDIS_URL` with fallback to `REDIS_URL` and a
  startup `Effect.logWarning` ("limiter and cache share Redis — OK for
  single-Redis dev/embedded; broken for sidecar HA").
- **[src/call/CallLimiter.ts:83-151](../../src/call/CallLimiter.ts#L83)** —
  switch `redisLayer` to depend on `LimiterRedisClient` instead of
  `RedisClient`.

### 2. Shared in-memory variant for fake stack

- **[src/call/CallLimiter.ts](../../src/call/CallLimiter.ts)** — add
  `static readonly sharedMemoryLayer = (map: MutableHashMap<...>) => Layer.effect(...)`.
  Identical body to `memoryLayer` but takes the map externally so a single
  instance can be peeked/reset by tests and shared across worker layer stacks.
- **[tests/support/networkLeaves.ts:152](../../tests/support/networkLeaves.ts#L152)** —
  remove `CallLimiter.memoryLayer` from `MidServices`. The limiter is now
  injected from the SUT-level builder.
- **[tests/support/proxyB2bFakeStack.ts](../../tests/support/proxyB2bFakeStack.ts)**
  and **[tests/support/k8sFakeStack.ts](../../tests/support/k8sFakeStack.ts)**
  — instantiate one shared `MutableHashMap` per SUT, build
  `CallLimiter.sharedMemoryLayer(map)` once, and merge it into every worker's
  layer stack so every worker sees the same instance. Expose the map handle
  on the test cluster object for assertions.

### 3. Documentation

- **[docs/replication/call-cache-backup.md](../../docs/replication/call-cache-backup.md)** —
  add a top-level subsection (under §1 or §2) titled "Why per-pod sidecar (not
  a shared Redis) for call context" that consolidates the latency rationale
  scattered today across `:55`, `:259`, `:401`, `:499`. Explicitly contrast
  with the limiter, which lives on a shared Redis precisely because it has no
  hot-path latency budget.

## K8s harness changes

Single stack, restored shared Redis pod, always deployed.

- **[deploy/helm/redis-shared/](../../deploy/helm/redis-shared/)** (new chart)
  — recover the shape of the chart removed in `db1c106`
  (`tests/k8s/charts/redis/`): one `Deployment` + `Service`, in-memory only
  (no PV, no AOF), single replica. Service name `redis-shared`.
- **[tests/k8s/scripts/install-stack.ts](../../tests/k8s/scripts/install-stack.ts)** —
  add `redis-shared` to the Helm install list, before workers.
- **[tests/k8s/values/b2bua-worker.yaml](../../tests/k8s/values/b2bua-worker.yaml)** —
  add `LIMITER_REDIS_URL=redis://redis-shared.{{ .Release.Namespace }}.svc.cluster.local:6379`
  to `extraEnv`. `REDIS_URL` continues to point at the local sidecar.
- **[deploy/helm/b2bua-worker/templates/statefulset.yaml](../../deploy/helm/b2bua-worker/templates/statefulset.yaml)** —
  if not already, accept a `limiterRedisUrl` value and set the env var.

All existing failover tests continue to use the same single stack — they
simply gain a working shared-limiter Redis on the side, at no behavioral cost
(none of them currently exercise the limiter).

## Test plan

### Fake-clock scenarios (added under `tests/sip-front-proxy/failover/` since they need `cluster.kill`/`respawn`)

All four scenarios use the `k8sFakeStack` SUT with the shared limiter map
exposed by the cluster handle. Limit set to 1 to keep assertions trivial,
except #4 which uses the configured production-like values.

| # | Name | What it proves |
|---|------|----------------|
| 1 | `limiter-shared-cross-worker-rejection` | Call A → worker 1 (accepted, counter=1). Call B → worker 2 (rejected with 486). Counter stays 1. **Without shared limiter, B is wrongly accepted.** |
| 2 | `limiter-decrement-via-backup-bye`      | Call A → worker 1 (counter=1). `cluster.kill(W1)`. BYE for A arrives → proxy `decode_forward_backup` to W2. W2 reads from `bak:1:`, terminates, decrements. Counter=0. Call B → W2 → accepted (counter=1). |
| 3 | `limiter-decrement-after-respawn`       | Call A → W1 (counter=1). `cluster.kill(W1)`. `cluster.respawn(W1, { preserveStorage: true })`. ReadyGate drains. BYE for A arrives at W1 → terminates locally → decrements. Counter=0. |
| 4 | `limiter-ttl-leak-budget`               | Limit=1, `LIMITER_WINDOW_SECONDS=120`, `limiterTtlSeconds=120`. Call A → W1 (counter=1). `cluster.kill(W1)` permanently. Advance TestClock by ~125s. Counter drops to 0 via Redis TTL. Documents the leak window. |

For #4, the test explicitly composes a small `AppConfig` override (or
parameterised limiter constructor) to set the 2-minute window. Realistic but
bounded — long enough to exceed any plausible call-establishment timer, short
enough to keep the test under ~3s of real wall time under TestClock.

### Live k8s soak (nightly tier)

- **[tests/k8s/proxy-limiter-soak.test.ts](../../tests/k8s/proxy-limiter-soak.test.ts)** (new) —
  uses existing `runSippJob` harness ([tests/k8s/fixtures/sippJob.ts](../../tests/k8s/fixtures/sippJob.ts)).
  - **Generation**: 10 cps, 10s ACK→BYE hold per call. Steady state ≈ 100 in
    flight.
  - **Limiter config**: limit = 50.
  - **Duration**: ~20 min sustained load.
  - **Sampling**: every minute, count `200 OK` vs `486 Busy Here` from the
    sipp stat file (or worker metrics). Assert `486 / (200+486)` is in
    `[0.35, 0.65]` for each post-warmup minute (skip first 30s warmup).
  - **End-of-run**: assert total accepted ≤ ~limit-bounded (loose).
  - **Limiter ID**: unique per run (`Date.now()`-suffixed) so reruns don't
    collide on the windowed counter.
- Tier-gate: declare in describe block with a flag the existing nightly
  runner can pick up. Add npm script `test:k8s:nightly` (or extend
  `test:nightly`) to include this file.

## Files modified / created — quick reference

**New**
- `src/redis/LimiterRedisClient.ts`
- `deploy/helm/redis-shared/Chart.yaml` + `templates/{deployment,service}.yaml` + `values.yaml`
- `tests/sip-front-proxy/failover/limiter-shared-cross-worker-rejection.test.ts`
- `tests/sip-front-proxy/failover/limiter-decrement-via-backup-bye.test.ts`
- `tests/sip-front-proxy/failover/limiter-decrement-after-respawn.test.ts`
- `tests/sip-front-proxy/failover/limiter-ttl-leak-budget.test.ts`
- `tests/k8s/proxy-limiter-soak.test.ts`

**Modified**
- `src/redis/RedisClient.ts` (factory extraction)
- `src/config/AppConfig.ts` (add `limiterRedisUrl` + warning)
- `src/call/CallLimiter.ts` (depend on `LimiterRedisClient`; add `sharedMemoryLayer`)
- `tests/support/networkLeaves.ts` (remove per-worker `CallLimiter.memoryLayer`)
- `tests/support/proxyB2bFakeStack.ts` and `tests/support/k8sFakeStack.ts` (inject shared limiter map)
- `tests/k8s/values/b2bua-worker.yaml` (`LIMITER_REDIS_URL` env)
- `tests/k8s/scripts/install-stack.ts` (install `redis-shared` chart)
- `deploy/helm/b2bua-worker/templates/statefulset.yaml` (plumb `limiterRedisUrl` if needed)
- `docs/replication/call-cache-backup.md` (promote sidecar-latency rationale)

## Verification

1. `npm run typecheck` — zero errors, zero warnings (incl. Effect plugin).
2. `npm run test:fake` — new fake-clock failover tests #1–#4 pass; existing
   `two-calls-routed-to-two-workers` still passes (it does not use the
   limiter beyond default `limit=∞`).
3. `npm run test:k8s` — existing failover suite still passes after the harness
   gains the shared Redis pod.
4. `npm run test:k8s:nightly` (new or extended) — the 20-min sipp soak runs
   and per-minute rejection ratio stays in `[0.35, 0.65]`.
5. **Manual one-shot smoke**: bring up kind, exec into a worker, run
   `redis-cli -h redis-shared GET 'sip:limiter:<id>:<window>'` and confirm
   the key exists under shared Redis (not under the sidecar).
6. **Negative check**: temporarily set `LIMITER_REDIS_URL=REDIS_URL` and rerun
   the cross-worker rejection k8s soak — it should fail (rejection ratio ~0),
   demonstrating the test catches the original bug.
