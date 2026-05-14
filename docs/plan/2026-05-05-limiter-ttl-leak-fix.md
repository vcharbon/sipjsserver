# Call-limiter inflight leak — investigation + fix plan

## TL;DR

The shared call-limiter (limiter id `endurance-probe`, cap=10) shows
`maxInflight=20`, `mean=12.39`, `stabilizedAtCap=true` in the post-fix
1 h endurance run on 2026-05-05
([artifact](../../test-results/k8s-endurance/endurance-2026-05-05t19-38-38-468z/)).
The pre-existing test suite already covers the most-cited failure
shapes (TTL eviction, decrement-via-backup-BYE, decrement-after-respawn),
so the leak is **not** any of those — it is something else, observed
already in the *broken-proxy* run too (max=14 there), and now more
visible because the proxy actually forwards traffic.

This plan is **investigate first, fix second**. Two slices: a
diagnostic slice that pins down the root cause from the existing
artifact dir + targeted instrumentation, then a fix slice scoped to
the actual cause. We do **not** assume a single culprit up-front —
the design has three plausible failure modes (probe over-counts,
refresh-timer misses on takeover, double-INCR on retransmit) and the
diagnostic slice is what tells us which.

## Symptom from the run

| Metric | Pre-fix run | Post-fix run |
| --- | ---: | ---: |
| `cap` | 10 | 10 |
| `maxInflight` | 14 | **20** |
| `mean` | 6.02 | **12.39** |
| `stabilizedAtCap` | false | **true** |
| First breach | 06:15:08 (T+8 m into SOAK, **no chaos yet**) | TBD — re-derive from `limiter-probe.ndjson` |

The pre-fix-run timestamp matters: the breach started **before any
chaos event**, ruling out any chaos-mediated cause. So the leak is
present under steady-state offered load alone.

## Limiter design recap (so the hypothesis space is concrete)

Source-of-truth files:

- [src/call/CallLimiter.ts:29-65](../../src/call/CallLimiter.ts#L29) —
  three Lua scripts: `CHECK_AND_INCREMENT`, `REFRESH`, `DECREMENT`.
- [src/call/CallLimiter.ts:101-107](../../src/call/CallLimiter.ts#L101) —
  key shape: `limiter:<id>:<windowTimestamp>` where
  `windowTimestamp = epochSec - epochSec % windowSec`.
- [src/b2bua/rules/framework/FrameworkLimiterRefresh.ts:54-57](../../src/b2bua/rules/framework/FrameworkLimiterRefresh.ts#L54) —
  refresh fires every `limiterWindowSeconds`; INCRs the new window,
  DECRs the origin window (briefly over-counts, never under-counts).
- [src/b2bua/rules/framework/InvariantEnforcer.ts:42-52](../../src/b2bua/rules/framework/InvariantEnforcer.ts#L42) —
  on call termination, emits `decrement-limiter` for every
  `call.limiterEntries` entry that has not already been decremented.
- [src/sip/SipRouter.ts:358](../../src/sip/SipRouter.ts#L358) — case
  branch that actually calls `limiter.decrement(...)`.

Production defaults:
`limiterWindowSeconds=300`, `limiterActiveWindows=3`,
`limiterTtlSeconds=1200`. So Lua `CHECK` sums **3 × 5-min windows =
last 15 min**, and individual window keys live for 20 min after their
last write.

The endurance probe reads
[`tests/k8s/endurance/chaosOps.ts:432-457`](../../tests/k8s/endurance/chaosOps.ts#L432):

```
redis-cli --scan --pattern 'sipas:limiter:<id>:*' | xargs redis-cli mget | sum
```

— i.e. it sums **every** matching key, regardless of whether that
key falls in the active window range or in the 5-min "outside-active
but still-TTL'd" tail.

## Hypothesis space

### H1 — probe over-counts via stale-but-not-yet-TTL'd window keys

The active range is the *last 3 windows* (15 min). But key TTL is
20 min. So a key for window `W = current - 4 windows ago` can still
exist in Redis with non-zero count even though `CHECK` no longer sums
it. The probe scans ALL matching keys and **does** sum it.

Plausibility: **moderate**. The refresh path (every
`limiterWindowSeconds = 5 min`) migrates *active* call counts forward,
DECR-ing the old window. Calls that ended cleanly DECR the origin
window directly. So an old window key should converge to zero
*assuming every call refreshes or decrements correctly*. If any call
fails to refresh (e.g. its worker died and the takeover lost the
timer state), its INCR sticks in the original window for up to 20 min
of TTL — and the probe sees it.

Distinguishing test: dump full Redis state at a moment when
probe shows `inflight > cap`. If the over-count is concentrated in
a stale window, this is the cause.

### H2 — refresh timer is dropped on worker takeover

Per the project memory note on HA backup, calls survive a primary
worker death by being taken over from the backup. The taken-over call
should re-arm its `limiter_refresh` timer on the new primary. If that
re-arm is missing OR the limiter entries aren't replicated in the
backup payload, the count stays in the original window indefinitely
(up to TTL). Same end-state as H1 from the probe's perspective: a
non-zero stale-window count.

Distinguishing test: review the backup serialization to confirm
`call.limiterEntries` is round-tripped, and confirm
`handleLimiterRefresh` is scheduled on takeover (or that the timer
was already in `call.timers` and gets re-armed by whoever drives
that). The two existing tests
([limiter-decrement-via-backup-bye.test.ts](../../tests/sip-front-proxy/failover/limiter-decrement-via-backup-bye.test.ts),
[limiter-decrement-after-respawn.test.ts](../../tests/sip-front-proxy/failover/limiter-decrement-after-respawn.test.ts))
both terminate the call within one window so they do **not** exercise
refresh-on-takeover.

### H3 — double-INCR on INVITE retransmission

If the proxy or worker processes the same INVITE twice (sipp retrans
+ idempotency miss), `checkAndIncrement` runs twice for the same
Call-ID. The cap-check sees the post-INCR value and would correctly
reject the second; but if the order is `INCR, check ≥ limit`, the
first allowed call leaks an INCR. The current Lua at
[CallLimiter.ts:29-41](../../src/call/CallLimiter.ts#L29) is
`SUM, check, INCR, EXPIRE` — sums **before** INCR, so a duplicate of
an already-admitted call would still race past the check if the
client-side dedupe (transaction layer) does not kick first.

Plausibility: **low to moderate**. The B2BUA's transaction layer
should de-dupe INVITEs by Call-ID + Via branch + CSeq. If
`applyRoute` runs once per accepted Call-ID it is fine. But under
load surge + retrans, this is worth confirming.

Distinguishing test: count `applyRoute` invocations per Call-ID in a
worker log dump; compare to expected 1 per call.

### H4 — `limiterEntries` not removed on rejection

If `checkAndIncrement` returns rejected (allowed=false), the
`applyRoute` path must NOT push the entry into `call.limiterEntries`
— otherwise `InvariantEnforcer` will issue a DECR on call termination
for an INCR that never happened, producing a *negative* count in the
window key. A negative count would *reduce* the probe sum, not
inflate it — so this can only mask a leak, not cause one. Recorded
for completeness; check the source path at
[applyRoute.ts:135-141](../../src/decision/apply/applyRoute.ts#L135).

## Slice plan

### Slice 1 — diagnostic, no code change

Goal: pin the leak to one of H1/H2/H3 using the existing artifact
plus targeted ad-hoc Redis inspection on a fresh repro.

Step 1 — re-read the existing run's `limiter-probe.ndjson` and answer:

- [ ] First time `inflight > cap`. (Pre-fix: 06:15:08, no chaos.
      Verify post-fix.)
- [ ] Distribution of `inflight` over time: does it climb
      monotonically, or does it climb-and-decay-to-cap? Monotonic
      climb suggests H2 (lost-on-takeover). Sawtooth at TTL bound
      (every 20 min) suggests H1.
- [ ] Correlate `inflight` jumps with `chaos-timeline.ndjson` events.
      Worker-pod-kill events that exceed call duration (10 s for
      probe, 30 s for short, 20 min for long) should jump the leak;
      events outside any call's lifetime should not.

Step 2 — write a 5-min focused repro:

```bash
npm run test:k8s:endurance -- --caps 10 --duration 5m --seed 1 \
  --chaos-min-interval 10m --chaos-max-interval 11m
```

(Sets chaos interval bigger than soak duration ⇒ zero chaos
fired ⇒ pure steady-state leak observation.)

While running, every minute:

```bash
kubectl -n sip-test exec deploy/redis -c redis -- \
  redis-cli --scan --pattern 'sipas:limiter:endurance-probe:*' | \
  xargs -r kubectl -n sip-test exec deploy/redis -c redis -- redis-cli mget
```

Expected if H1: window keys appear, oldest ones still > 0 with no
fresh writes — i.e. they should have been DECR'd by refresh.

Expected if H2 + H1: same as H1 but tied to specific Call-IDs that
got migrated via takeover. (No takeover here — chaos disabled — so
this should NOT fire under this repro. If it DOES, H1 is enough.)

Step 3 — patch the probe scanner (not the platform) to count only
active windows, and re-run. If `maxInflight` drops to ≤ cap, the
leak was *probe-side over-counting* (H1) and the platform itself is
fine — the fix is then in the analyzer.

Patch shape:

```ts
// chaosOps.ts: derive active windows from config, sum only those.
const epochSec = Math.floor(Date.now() / 1000)
const windowSec = LIMITER_WINDOW_SECONDS  // pull from values
const active = LIMITER_ACTIVE_WINDOWS
const cur = epochSec - (epochSec % windowSec)
const keys = Array.from({length: active}, (_, i) =>
  `sipas:limiter:${limiterId}:${cur - i * windowSec}`
).join(' ')
// `redis-cli mget ${keys}` then sum
```

If `maxInflight` STILL exceeds cap after this change, the leak is
real (H2 or H3) and slice 2 applies.

### Slice 2 — fix, scoped to the diagnosed cause

#### If H1 only (probe over-counts)

- Update
  [tests/k8s/endurance/chaosOps.ts:432-457](../../tests/k8s/endurance/chaosOps.ts#L432)
  to mirror the Lua semantics: sum only `limiterActiveWindows` keys.
- Update
  [docs/k8s-endurance.md](../k8s-endurance.md) "Limiter probe"
  paragraph to document the change.
- Re-run 1 h endurance with seed `1777960808113`. Expect
  `exceededCap=false, stabilizedAtCap=true, max ≤ 10`.

No production code change. ~30 LOC change in the test harness.

#### If H2 (takeover loses refresh)

Surgical fix in the takeover path (file TBD by Slice 1; likely under
`src/sip-front-proxy/registry/` or `src/b2bua/`).

RFC notes for the fix:

- **RFC 3261 §17 (Transactions)**: takeover MUST NOT change the
  call's transaction id space. Refresh timer is internal —
  no-wire impact.
- **RFC 3261 §15 (Termination)**: the call's BYE MUST decrement
  exactly once. Re-arming refresh on takeover should NOT re-INCR.

Add a fake-clock test under
`tests/sip-front-proxy/failover/limiter-refresh-after-takeover.test.ts`:

1. Admit call A (count=1 in W0).
2. TestClock advance to W1 (5 min after admit).
3. Kill primary mid-call (before its refresh fires).
4. Drive backup takeover.
5. TestClock advance another 30 s.
6. Assert: limiter Redis shows count=0 in W0, count=1 in W1
   (refresh ran on takeover-side).
7. Issue BYE on takeover-side.
8. Assert: count=0 in both W0 and W1.

#### If H3 (double-INCR on retrans)

- Add idempotency check at
  [applyRoute.ts:135](../../src/decision/apply/applyRoute.ts#L135):
  if `call.limiterEntries` already has an entry for this limiter id,
  do NOT call `checkAndIncrement` again. Just preserve existing
  `originWindow`.
- Test under
  `tests/decision/limiter-idempotent-on-retrans.test.ts`.

## Slice 3 — re-validate

```bash
npm run test:k8s:endurance -- --caps 20 --duration 1h \
  --seed 1777960808113
```

Expected delta:

| Metric | Current (post-fix run) | Target |
| --- | ---: | ---: |
| `maxInflight` | 20 | ≤ 10 |
| `mean` | 12.39 | ~10 |
| `exceededCap` | true | **false** |
| `stabilizedAtCap` | true | true |

## Acceptance criteria

- [ ] Slice 1 produces a forensic note (markdown, in the artifact
      dir) naming the diagnosed cause: H1 / H2 / H3 / other.
- [ ] If H1: probe scanner change merged, harness doc updated.
- [ ] If H2 / H3: production code change + new fake-clock test that
      regresses on the leak.
- [ ] `npm run typecheck` clean (zero `tsc` + zero Effect plugin
      warnings — see [CLAUDE.md](../../CLAUDE.md)).
- [ ] `npm run test:fake` clean.
- [ ] 1 h endurance re-run with seed `1777960808113` shows
      `exceededCap=false`.

## Out of scope

- Limiter algorithm redesign (sliding window vs. fixed window vs.
  token bucket). The current windowed counter is fine; the leak
  is operational, not algorithmic.
- Multi-region limiter. Not in current scope.
- Per-call rate-limiting. Different concern.

## References

- Run artifacts:
  [pre-fix](../../test-results/k8s-endurance/endurance-2026-05-05t06-00-08-113z/)
  /
  [post-fix](../../test-results/k8s-endurance/endurance-2026-05-05t19-38-38-468z/).
- Limiter source:
  [src/call/CallLimiter.ts](../../src/call/CallLimiter.ts).
- Limiter framework:
  [src/b2bua/rules/framework/FrameworkLimiterRefresh.ts](../../src/b2bua/rules/framework/FrameworkLimiterRefresh.ts),
  [src/b2bua/rules/framework/InvariantEnforcer.ts](../../src/b2bua/rules/framework/InvariantEnforcer.ts).
- Limiter use site:
  [src/decision/apply/applyRoute.ts](../../src/decision/apply/applyRoute.ts).
- Existing limiter tests:
  [tests/sip-front-proxy/failover/limiter-*.test.ts](../../tests/sip-front-proxy/failover/),
  [tests/k8s/proxy-limiter-soak.test.ts](../../tests/k8s/proxy-limiter-soak.test.ts).
- Endurance probe scanner:
  [tests/k8s/endurance/chaosOps.ts:432-457](../../tests/k8s/endurance/chaosOps.ts#L432),
  [tests/k8s/endurance/recorder.ts:249-275](../../tests/k8s/endurance/recorder.ts#L249).
