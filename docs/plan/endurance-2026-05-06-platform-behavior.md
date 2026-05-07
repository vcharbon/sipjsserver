# Endurance Run 2026-05-06 — Platform Behavior Report

First 2 h endurance soak after the recent batch of call-leak / call-timeout
/ health-probe fixes (commits `1e7fda2 → e6f3105`). Command run:

```
npm run test:k8s:endurance -- --caps 20 --duration 2h
```

- runId: `endurance-2026-05-06t06-30-03-595z`
- caps: 20 cps short stream + long stream + limiter probe
- limiter cap: 10 (probe target)
- chaos: 11 events scheduled / 11 executed / 0 skipped
- artifacts: `test-results/k8s-endurance/endurance-2026-05-06t06-30-03-595z/`

## Verdict

**FAIL.** The run itself executed cleanly end-to-end (BRINGUP → WARMUP →
SOAK → COOLDOWN → DRAIN → SNAPSHOT → ANALYZE), and most chaos events
recovered as expected. Two real platform issues stand out and one
harness bug was uncovered along the way.

## Headline numbers (post-fix re-analysis)

| Category | OK | Failed | Success rate |
| --- | ---: | ---: | ---: |
| STEADY | 107 969 | 19 689 | 84.6 % |
| ESTABLISHING_DURING_CHAOS | 3 792 | 1 143 | 76.8 % |
| POST_RECOVERY (5 s grace) | 822 | 204 | 80.1 % |
| MID_DIALOG_DURING_CHAOS | 1 | 0 | n/a |
| LIMITER_PROBE | 913 | 15 254 | 5.6 % (probe — most rejections expected) |
| PRE_WARMUP / POST_DRAIN | 5 138 / 0 | 71 / 111 | informational |

Sipp's own counters back the steady-state number: short stream
117 523 successful / 19 087 failed / 137 226 created (≈ 86 %).

## Issue #1 — Edge-node restart breaks the proxy's worker-liveness view

The single chaos event with a non-recovering tail is event 9
(`node-shutdown-edge` on `sip-e2e-worker`, 08:23:42 → 08:24:44 UTC).
After the edge node came back, the short-stream `SuccessfulCall(C)`
counter in sipp's stat.csv **froze at 117 523 and never advanced again**
for the remaining ~12 min of soak, even though calls kept being
created. Concretely:

| t (UTC) | created | successful | failed |
| --- | ---: | ---: | ---: |
| 08:22:34 (just before event 9) | 117 160 | 116 314 | 336 |
| 08:27:22 (≈ 3 min after recovery) | 122 262 | **117 523** | 4 123 |
| 08:32:11 (just before event 10) | 127 363 | **117 523** | 9 224 |
| 08:37:00 (just after SOAK end) | 132 464 | **117 523** | 14 325 |

Root cause is in the surviving proxy's log. Pod
`sip-front-proxy-6fd8f9fb99-cdvgl` (running on `sip-e2e-worker2`, never
itself targeted by chaos) starts emitting at 08:24:43:

```
[ProxyCore] strategy LoadBalancer no target: no alive workers among 2 entries
```

— and continues to do so at ~2 400 / min for the remainder of the
soak:

```
07:51   5            (transient at proxy start)
08:24   511          ← edge node comes back
08:25   2 277
08:26   2 468
…
08:40   2 424
08:41   1 572        (cooldown ramp-down)
```

The two workers (`b2bua-worker-0` on worker3, `b2bua-worker-1` on
worker4) were never killed during event 9 — only the edge node was.
But the limiter Redis pod `redis-96b66f94c-5mz2b` is co-located on the
edge node (per snapshot.json), and worker liveness keys live in that
Redis. When the edge node is restarted the keys disappear, and the
proxies on the surviving nodes converge on "0 alive workers among 2
entries" without a recovery path that re-reads the workers' published
liveness. They never re-converge — workers stay routable to nobody for
the rest of the run.

This is the "call leak" regression the recent fixes were supposed to
guard against, but it manifests via a different mechanism:
**Redis-tenant loss after edge-node-shutdown silently zeros the proxy's
worker pool** instead of triggering re-discovery / re-subscription.

Suggested next steps:
- Have the proxy treat "all workers dead" as a signal to re-subscribe /
  re-read worker registry from scratch, with bounded backoff.
- Confirm whether workers re-publish liveness after a Redis flush; if
  the workers' heartbeat publisher uses CAS / keepalive that doesn't
  re-establish the key after Redis loses it, that's the symmetric bug
  on the worker side.
- Make `node-shutdown-edge` part of the regular endurance schedule (it
  already is — but its impact must become a hard-fail signal instead of
  being hidden in aggregate STEADY counts).

## Issue #2 — Limiter still overshoots cap

Limiter probe (cap=10):

```
maxInflight=16  mean=10.95  samples=783  exceededCap=true  stabilizedAtCap=true
```

Mean ~10 % over cap, peak 60 % over cap. After this round of call-leak
fixes, the limiter still does not enforce its cap monotonically — it
trends close to cap on average but can swing 6 entries above. Worth
isolating with a focused fake-clock test (a deterministic stress
scenario with concurrent enter/leave at cap) before chasing the spike
in a live cluster.

## Issue #3 (harness) — Analyzer silently drops > 512 MB sipp logs

The analyze step printed:

```
analyze: skipped …/endurance-short…/msg.log.gz: Error: Cannot create
  a string longer than 0x1fffffe8 characters
```

`analyze-endurance.ts` was reading the full gzipped sipp message log,
gunzipping it into a single Node string, and running the parser on
that. At 20 cps short calls × 2 h, the decompressed log is ~600 MB —
past Node's `Buffer`-backed string ceiling (~512 MB on x64). The
analyzer then `console.warn`-and-continued, producing a verdict where
STEADY showed `ok=16 / failed=1470` (≈ 1 % success) — looks
catastrophic, but is actually because the ~85 %-success short stream
just wasn't read.

Fix landed in this branch:

- `tests/k8s/fixtures/sippOutcomes.ts` — new
  `parseSippMessageTraceFromGzFile(filePath)` streaming variant
  (createReadStream → createGunzip → readline). Memory now scales with
  call count, not file size.
- `tests/k8s/endurance/analyze-endurance.ts` — both call sites
  switched. The old `gunzip` import and `promisify` wrapper are gone.

After the fix, re-running `test:k8s:endurance:analyze` over the same
artifacts produced the real verdict shown at the top of this report
without re-driving the 2 h soak.

## Notes on data the analyzer used

- Per-event "stabilized_after" buckets sum **all** calls in the 5 min
  after recovery whose tFirstInvite did not overlap any chaos window.
  That bucket therefore includes limiter-probe traffic (high failure
  by design). Per-event "after fail" baselines of ~640 in the clean
  events approximate (limiter-probe @ ~2 cps × 5 min × ~95 % fail) +
  the steady-state baseline (~10 % of short stream over 5 min). It is
  not a clean post-recovery success metric — events 9 and 10 stand out
  because the absolute "after ok" goes to **0**, which is the relevant
  signal.
- Pod-log capture only retained the original incarnation of each pod
  on which `chaos` events fired; pods that respawned on the same name
  after `kill -9` / node-down lost their pre-restart logs. Worth
  hardening if we plan to root-cause more chaos regressions from
  artifacts alone.

## Recommendation

Don't relaunch the 2 h test now — the data we have already pinpoints
the regressions. Instead:

1. Fix the proxy/worker liveness view of Redis loss (issue #1).
2. Add a focused fake-clock test for the limiter cap overshoot (issue
   #2).
3. Then re-run `npm run test:k8s:endurance -- --caps 20 --duration 2h`
   and expect: STEADY > 99 %, limiter `exceededCap=false`, every
   chaos event `after ok > 0`.
