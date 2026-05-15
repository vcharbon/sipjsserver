# Post-proxy-graceful Unroutable-BYE wave (481) — investigation plan

**Status:** investigation completed 2026-05-14. Original "proxy graceful aftershock"
framing is **wrong** — see §0 below. The 5-minute gap is coincidence.
**Source run:** `endurance-1h-2026-05-14t18-20-33` (verdict FAIL).
**Owner:** TBD — pick up in a fresh session with this doc as context.

---

## 0. CONCLUSION — root cause is heapdump-volume eviction, not proxy graceful

The 481 burst at 18:51–53 is caused by a **K8s eviction cascade of both workers**
driven by the `/heapdumps` `emptyDir` volume filling its 2 GiB `sizeLimit`. The
"5 minutes after proxy chaos" framing throughout the rest of this doc is a
coincidence of timing, not causation. Evidence (`k8s-events.ndjson` for the
source run):

```
18:51:36  Warning Evicted   Pod/b2bua-worker-1  Usage of EmptyDir volume "heapdumps" exceeds the limit "2Gi".
18:51:36  Normal  Killing   Pod/b2bua-worker-1  Stopping container worker
18:51:37  Normal  Started   Pod/b2bua-worker-1  Started container worker (NEW IP 10.244.5.4)
18:52:06  Warning Evicted   Pod/b2bua-worker-0  Usage of EmptyDir volume "heapdumps" exceeds the limit "2Gi".
18:52:06  Normal  Killing   Pod/b2bua-worker-0  Stopping container worker
```

End-to-end trace of one failing call (`67722@det`) in proxy `fphgq`:

```
18:51:29.055  INVITE  → 10.244.5.3:5060  decision=select_new           (worker-1 OLD pod)
18:51:29.074  ACK     → 10.244.5.3:5060  decision=decode_forward       (worker-1 OLD pod)
                                                  knownWorkers=[10.244.5.3, 10.244.1.2]
[18:51:36 worker-1 evicted; new pod IP 10.244.5.4]
18:51:59.079  BYE     → 10.244.5.4:5060  decision=decode_forward       (worker-1 NEW pod)
                                                  knownWorkers=[10.244.5.4, 10.244.1.2]
                                                  cookie still names w_pri=b2bua-worker-1
18:51:59.081  worker-1: Unroutable BYE … no callRef in URI, fallback miss → 481
```

`b2bua_worker_call_force_purge_total = 0` because there was no purge — the
worker process **was killed and restarted** with an empty Redis sidecar. The
RSS step-down (322 → 128 MB) is the new pod's startup baseline, not GC.

This run's heapdump-recorder fired every 60 s (`heapdump-triggers.ndjson`,
130 entries, all `periodic@60s`) and never cleaned up — `kubectl cp` only
runs at the end of the suite (`tests/k8s/endurance/snapshot.ts:117`). At
~40 MB per snapshot, 30 minutes × 1/min ≈ 1.2 GiB → both volumes pass 2 GiB
within ~50 minutes of pod start.

**This is a TEST infrastructure bug, not a SIP bug.** It is, however,
a useful HA stressor that exposed the real residual gap (see §0.1 below).

### 0.1 Real production-relevant residual: `decode_forward` to a respawned primary still 481s

Even though the eviction was test-only, the proxy's behaviour during the
respawn window is the same as a real worker restart, and the call
survival rate proves the existing fix
([`docs/plan/2026-05-01-decode-forward-respawn-bye-481-fix.md`](./2026-05-01-decode-forward-respawn-bye-481-fix.md))
is incomplete:

- **Slice E1 / E2 (`not-ready` → backup promotion)** — should have caught
  the new pod via the `503 + Reason: not-ready (boot drain)` OPTIONS
  reply. Verify that the `WorkerHealth` for the respawned pod was
  `not-ready` at 18:51:59 (BYE arrival), and if so, why
  `decodeStickiness` still emitted `decode_forward` at that instant.
- **Slice E3 (fresh-pod guard window)** — defaults to **20 s**
  ([`src/sip-front-proxy/strategies/LoadBalancer.ts:115`](../../src/sip-front-proxy/strategies/LoadBalancer.ts#L115)).
  Worker-1's new pod started at 18:51:37, the failing BYE arrived 18:51:59
  — about 22 s later — JUST outside the guard window. Tightening the
  default upward (and/or driving the value from
  `keepaliveIntervalSec` so it scales with operator config) would cover
  this exact respawn race.
- **Bigger gap that no slice currently addresses:** when **both** primary
  AND backup are unhealthy at the same instant, `decode_forward_backup`
  has nowhere to go. Today's matrix falls back to fresh
  `selectForNewDialog`, which 481s on a worker that has neither the
  call body nor the index. This is a known limitation
  ([call-cache-backup.md](../replication/call-cache-backup.md), §0
  corollary 1) but the test workload now reproduces it, so it should
  be elevated from "documented" to "tested + flagged in an alert".

A fix plan should treat §0.1 as a separate plan and reference this doc as
the post-mortem. The §1–§5 hypothesis tree below is preserved for
historical context only.

---

## 1. The bug we're chasing

5 minutes after **chaos[1] proxy-pod-graceful** (proxy `t6d6l` killed at
18:46:29 UTC, recovered 18:46:33 — 4-second outage), a tightly-clustered
wave of 481 mid-dialog rejections appeared:

```
worker-0:  18:51 → 0     18:52 → 648    18:53 → 2
worker-1:  18:51 → 31    18:52 → 779    18:53 → 0
                                      ── total: 1460 Unroutable-BYE log lines
```

Of the 736 STEADY failures the analyzer counted:

- **731 / 736** got `Last response: 481 Call/Transaction Does Not Exist`
- **730 / 736** had `Outcome: mid-dialog-error`
- **733 / 736** had `First INVITE` between **18:51 and 18:53** (5–7 min after
  chaos[1]).

The 1460 log lines vs. 736 distinct calls indicates each failed BYE arrived
~2× (proxy retransmit / dual-route).

The other four chaos events (node-shutdown-edge, second proxy graceful,
worker-pod-graceful, worker-pod-kill9) did **not** produce this signature.
This is specifically a *proxy graceful* aftershock.

---

## 2. What the worker logged at the time

A representative rejection (worker-1, 18:51:59):

```
Unroutable BYE sip:test@172.20.255.250:5060 from 172.20.255.250:5060
  Call-ID=endurance-short-…-67738@det fromTag=11SIPpTag0067738 toTag=dfikg0bi
  [no callRef in URI, fallback: callId=… fromTag=…] — rejecting
```

Two lookups failed in sequence:

1. **callRef-in-URI lookup**: the worker tried to extract a `callRef=…`
   parameter from the BYE's Request-URI. There was none.
2. **(Call-ID, fromTag) fallback**: the worker then looked the call up by
   Call-ID + fromTag. Also nothing.

So the worker's view of the call was completely gone by the time the BYE
arrived ~30 s after the call was established.

For reference, a healthy 200 OK from earlier in the run carries:

```
Record-Route: <sip:172.20.255.250:5060
   ;w_pri=b2bua-worker-0
   ;w_bak=b2bua-worker-1
   ;v=2
   ;kid=3c7c534b0e585180
   ;sig=MLldgaaFNeJxgQu-Y3K4jA;lr>
Contact: <sip:b2bua@10.244.2.2:5060
   ;callRef=b2bua-worker-0%7Cendurance-…@det%7C11SIPpTag00173;leg=a>
```

The Contact (with `callRef`) and Record-Route (with `w_pri`/`w_bak`/`sig`)
together pin a dialog to a specific worker. After ACK, the UAC's route set
should make in-dialog requests follow that pinning.

---

## 3. Strange correlated signals at the same instant

| Signal | Worker-0 | Worker-1 | Notes |
|---|---|---|---|
| `VmRSS` 18:51 → 18:52 | 322 → 141 MB (Δ −181) | 322 → **128 MB (Δ −194)** | Same window as failures. |
| `b2bua_worker_call_force_purge_total` | 0 throughout | 0 throughout | Force-purge safety net did NOT trigger. |
| Orphan-sweep events 18:50–18:54 | 4 | 6 | Sweeper *did* recover terminating/terminated calls. |
| Loop-lag p95 max 18:53 | **417 ms** | **419 ms** | Above OVERLOAD_LOOP_LAG_HARD_MS (200 ms). |

The RSS step-down isn't a force-purge — but a chunk of state was released.
The fact that both workers show big RSS drops at the same wall clock
suggests a *correlated* trigger, not random GC.

---

## 4. Working hypothesis

**A proxy graceful restart leaves a window where calls established immediately
after the bounce end up with a route set that points the BYE back through a
different proxy worker than the one that saw the INVITE.** The downstream
worker can't find the dialog and returns 481.

There are several supporting observations:

- The 5-minute gap from chaos to the failure cluster is suspiciously close
  to the keepalive interval (`KEEPALIVE_INTERVAL_SEC=300s`). Either the
  failures depend on a timer-driven action or the orphan sweeper's age
  buckets fire ~5 min after a chaos event.
- The "no callRef in URI" diagnostic is the dominant fallback — meaning the
  proxy *forwarded* the BYE to the worker but the URI didn't carry the
  `callRef` param the worker uses to look up call state.
- The proxy that was killed (`t6d6l`) signed routes with a `kid=…;sig=…`
  that came from its own keystore. After it came back, did it re-derive the
  same `kid` (from a shared secret) or get a new one? If a different proxy
  pod ends up validating the BYE, a `kid` mismatch could short-circuit the
  loose-routing logic and strip route params.

**This needs to be either confirmed or refuted before any code change.**

---

## 5. What the next session should do

A complete narrowing pass should produce one of:

  (a) "Confirmed root cause: <X>, fix is <Y>, plan a follow-up."
  (b) "Hypothesis ruled out, here is the next ranking of suspects."

Do *not* skip directly to a fix. The cost of a wrong fix here is another
endurance run (≈1 h 35 m wall time + cluster rebuild).

### 5.1 Reproduce deterministically before touching code

- Re-run the endurance harness with `--proxy-chaos-disabled` removed (or
  explicitly chaos-weight only `proxy-pod-graceful=10`, others=0) and a
  short soak (e.g. `--duration 15m --warmup 60s`). Keep two proxies. Goal:
  make the 481 wave reproducible inside one short run so iteration is fast.
- Capture artifacts the renderer doesn't currently surface — full pcap on
  the proxy-side podport and on at least one worker pod for the 60 s before
  and 5 min after the proxy bounce. `tcpdump -i any -w … udp port 5060`.

### 5.2 Trace one failing call end-to-end

Pick a single failing call from the next reproduction and follow it
through every log + capture:

1. `sipp` `msg.log` — record the exact INVITE, 200 OK, ACK, BYE bytes.
2. Both proxy pod logs — find the routing-decision lines for both INVITE
   and BYE; record the worker IP each was routed to and the
   Record-Route/Route header values.
3. Both worker logs — find the call-state allocation event for the INVITE
   and the rejection event for the BYE. Verify they're on the same worker.
4. Worker-side metrics — sample `b2bua_worker_active_calls`,
   `b2bua_worker_terminating_calls{age_bucket}` at 1 s granularity around
   the bounce.

If the INVITE landed on worker-A and the BYE on worker-B, that immediately
narrows the bug to proxy-side routing (5.3). If both went to worker-A but
the call state is gone, it narrows to worker-side state loss (5.4).

### 5.3 Possible root causes — proxy side

Each item below is a hypothesis to explicitly accept or reject with
evidence. Don't conflate them.

#### H1. Replacement-proxy keystore mismatch — **REJECTED**

The HMAC key is provided by a single shared K8s Secret
([`deploy/helm/sip-front-proxy/templates/secret.yaml`](../../deploy/helm/sip-front-proxy/templates/secret.yaml))
and the kid is **content-derived** from the key bytes
([`HmacKeyProvider.ts:280-292`](../../src/sip-front-proxy/security/HmacKeyProvider.ts#L280)).
Every proxy pod that mounts the same Secret computes the same kid
deterministically. Confirmed against the run logs: every cookie carries
`kid=3c7c534b0e585180` regardless of which proxy emitted it. No mismatch
possible.

Original hypothesis text below for reference.

After the killed proxy is replaced, the new pod issues route signatures
under a new `kid`. If the SURVIVING proxy validates an incoming BYE under a
different `kid` than was on the original Record-Route, signature
verification fails, and the proxy may strip or rewrite the route.

- **What to check:** sample `Record-Route` header on a 200 OK *before* the
  bounce vs the `Route` header on a BYE *after* the bounce — same `kid`?
- **Code paths:** `src/sip/proxy/...` (need to grep for `kid`, `sig`,
  signature verification).

#### H2. Proxy-side call-pinning state lost on graceful — **REJECTED**

The proxy is intentionally stateless w.r.t. per-call routing:
`encodeStickiness` reads the `WorkerRegistry.snapshot` (a `Ref`) plus the
HMAC key, and `decodeStickiness` reverses it
([`LoadBalancer.ts:254-509`](../../src/sip-front-proxy/strategies/LoadBalancer.ts#L254)).
The only per-call state is `CancelBranchLru` (CANCEL→INVITE branch
correlation), which is irrelevant to mid-dialog BYE. Both surviving and
respawned proxies reconstruct identical decisions from the wire alone.

Original hypothesis text below.

If the proxy keeps any per-call state (e.g. for sticky routing) and that
state is in-process, the graceful restart of one proxy means the surviving
proxy doesn't know about calls that were in flight via the killed proxy.
For the call's BYE 30 s later, the surviving proxy would have to reconstruct
the route from the URI / Route headers alone. If anything in that path
relies on local state, the BYE gets misrouted.

- **What to check:** is there *any* in-process state in the proxy that
  isn't reproducible from the SIP message itself? Specifically look for
  caches keyed by Call-ID / branch / callRef.
- **Code paths:** `src/sip-front-proxy/`.

#### H3. Loose-routing rewrite drops the `callRef` param — **REJECTED (mis-framed)**

The proxy never rewrites the Request-URI on forward — it only strips its
own top Route header and re-serializes the message
([`ProxyCore.ts:709-728`, `:996-998`](../../src/sip-front-proxy/ProxyCore.ts#L709)).
The endurance UAC's BYE Request-URI is `sip:test@VIP:5060` (the dialog
target the sipp scenario uses), **not** the worker's Contact — so there
is no `callRef` to drop in the first place. The worker's
`[no callRef in URI, fallback: …]` log is the **expected** path for
this scenario; the real failure is that the (Call-ID, fromTag) fallback
also missed (because the worker process had been restarted — see §0).

Original hypothesis text below.

Per RFC 3261 §16.6 (request forwarding) and §16.4 (route information
processing), a strict/loose-routing proxy must take the topmost Route header
(if it points to itself) and rewrite the URI. If the rewrite logic strips
*custom* URI parameters when constructing the new Request-URI, the worker's
`callRef` lookup from URI fails — exactly what we see in the log
(`[no callRef in URI, fallback: …]`).

- **What to check:** under what conditions does the proxy emit a BYE
  Request-URI WITHOUT `callRef`? If we always require `callRef` on the
  Contact stamp (it IS there in the 200 OK we sampled), why does the BYE
  arrive at the worker without it?
- **Code paths:** look for proxy-side URI construction during request
  forwarding; cross-reference with `docs/b2bua-sip-headers.md`.

#### H4. Replacement proxy serves traffic before its routing tables are warm — **NOT RELEVANT**

The 5-minute gap argued against this in the original plan, and §0 now
shows the failures are tied to **worker** respawn, not proxy respawn.
There is a related, separately-tracked issue (replacement proxy
receiving zero traffic due to UDP-conntrack pinning,
[2026-05-05-replacement-proxy-zero-traffic-fix.md](./2026-05-05-replacement-proxy-zero-traffic-fix.md))
that was superseded by the keepalived-VIP architecture; not at play
here.

Original hypothesis text below.

After the new proxy pod becomes Ready, it starts accepting traffic
immediately. If it relies on a control-plane peer-list or a
worker-discovery sweep that hasn't completed yet, its first few seconds of
routing decisions are sub-optimal — a BYE arriving in that window could
land on the wrong worker. The 5-minute gap argues against this (the wave
is too late), but it could combine with another factor.

- **What to check:** time-to-first-correct-route after a graceful restart.
  Add a probe that fires N test INVITEs immediately after the new pod
  becomes Ready and verify routing tables are populated before traffic is
  admitted. (See [2026-05-05-replacement-proxy-zero-traffic-fix.md] for
  precedent.)

### 5.4 Possible root causes — worker side

#### H5. Worker call state evicted by an OPTIONS-keepalive cascade — **REJECTED**

Code review of [`TimerRules.ts:45-100`](../../src/b2bua/rules/defaults/TimerRules.ts#L45)
+ [`TimerRules.ts:104-135`](../../src/b2bua/rules/defaults/TimerRules.ts#L104):
the keepalive timeout path runs `terminate-leg` + `begin-termination`,
which puts the call into `state="terminating"` and eventually into
`terminated` via the normal lifecycle. That would bump
`b2bua_worker_call_force_purge_total` only on the safety-timer / orphan
path, but **also** would generate BYE traffic out of the worker that we
do not see in the proxy logs. The actual cause is the K8s pod restart
in §0; no keepalive cascade was needed to explain the lost state.

Original hypothesis text below.

Every 5 min, the worker fires keepalive OPTIONS for every active long-call.
We've already proved the keepalive timer-handler exceeds its 5 s budget
under load (6 + 11 = 17 occurrences during the run). If the keepalive
handler error path purges call state when the OPTIONS times out, calls
established right before the 5-min boundary would lose their state when the
keepalive fires — and a subsequent BYE would 481.

- **What to check:** under what error paths does the keepalive handler
  release call state? Does it remove the call from `CallStateCache`?
- **Code paths:** keepalive rule (`src/b2bua/rules/...keepalive...`),
  CallState eviction.

#### H6. Orphan sweeper purges live calls — **REJECTED**

The sweeper at [`CallState.ts:874-889`](../../src/call/CallState.ts#L874)
only iterates calls whose `state === "terminated" || state === "terminating"`.
`active` calls are never touched. The reported sweep ages (30–84 s) are
also too small to overlap with calls established at 18:51 (which is
**after** the sweep window 18:50–18:54). H6 also cannot explain the
180+ MB RSS step-down on each worker (a sweep of ~10 calls would not
move RSS).

Original hypothesis text below.

Sweeper events at 18:50–18:54 had ages 30–84 s. If the sweeper's age
threshold is 30 s for `terminating` calls and a chaos-related state
desync misclassifies a live call as `terminating`, the sweeper would
purge the call's state ~30 s after the misclassification. A BYE 30 s
after INVITE → exactly the failure window.

- **What to check:** who marks a call `terminating`? Can chaos transiently
  flip a live call into that state?
- **Code paths:** `src/cache/CallStateCache*`, `src/decision/...` (any
  state machine that tags calls).

#### H7. Replication queue swallowed a state update — **REJECTED but adjacent issue confirmed**

Replication-queue overflow is not the cause: per §0, the workers were
restarted, so there was no surviving in-memory state for any drop to
matter against. However, an adjacent gap is confirmed and contributed:
the `bak:` partition's index keys (`idx:leg:…`) are not co-replicated
with the call body, so even when `decode_forward_backup` correctly
routes a BYE to the surviving peer, that peer cannot resolve the call
([`CallState.ts:589-627`](../../src/call/CallState.ts#L589) — see the
"single-owner invariant" caveat). Tracked separately in
[2026-04-30-bye-takeover-replicated-indexes-fix.md](./2026-04-30-bye-takeover-replicated-indexes-fix.md)
Slice A. Status: still open as of 2026-05-14.

Original hypothesis text below.

The worker pair replicates call state to each other (per
`docs/replication/call-cache-backup.md`). A proxy bounce is a downstream
event the workers don't observe directly, but it could trigger a flood of
re-INVITEs / re-ACKs that overflow the replication channel. If a state
update is silently dropped, both peers can end up with stale views, and
the call-state cache lookup would miss.

- **What to check:** replication queue depth / drop counters during
  18:46–18:53. (We have `repl: sampler-window` lines in worker logs.)
- **Code paths:** `src/replication/`, related rules.

### 5.5 Once root cause is confirmed

- Add a fake-clock test under `tests/scenarios/` (see
  `docs/test-api-external.md`) that reproduces the failure deterministically
  with TestClock — proxy bounce at t=0, INVITE batch at t=10 s, BYE batch
  at t=40 s, expect zero 481s.
- Decide whether the fix belongs in the proxy (5.3) or the worker (5.4) and
  draft a separate implementation plan; this doc becomes the post-mortem
  reference for that plan.

---

## 6. Sibling questions surfaced by the same run

These are *not* in scope for this plan but the next session should keep
them on the wall:

### 6.1 Long-call OPTIONS thundering herd is not actually uniform — **PARTIALLY REFUTED**

The TimerService is per-fiber, not tick-based: every scheduled timer
gets its own `Effect.sleep(Duration.millis(delayMs))` fiber
([`src/call/TimerService.ts:101-134`](../../src/call/TimerService.ts#L101)).
There is no rounded-tick scheduler that could quantize many keepalives
into a single tick.

What the run actually shows (loop-lag p95):

```
18:26:46  worker-0 443.4 ms   worker-1 436.1 ms
18:32:11  worker-0 465.9 ms   worker-1 494.3 ms
18:37:36  worker-0 455.8 ms   worker-1 467.5 ms
18:45:13  worker-0 444.2 ms   worker-1 466.5 ms
18:49:31  worker-0 426.4 ms   worker-1 429.3 ms
18:53:49  worker-0 417.8 ms   worker-1 419.9 ms
…  (every ~5 min until 19:09; then steady drop after 19:11 worker-0 chaos)
```

The bursts are real and roughly 5-min-aligned across both workers, but
the most likely driver is the **admission-time distribution** of long
calls (sipp's long-stream emits in clusters; KEEPALIVE_INTERVAL_SEC=300
preserves that clustering 5 min later). Code-side mitigation would be
to add a small uniform jitter to the keepalive reschedule
(`delaySec: keepaliveIntervalSec + jitter(±10%)`) at
[`TimerRules.ts:91-96`](../../src/b2bua/rules/defaults/TimerRules.ts#L91)
and at the initial scheduling at
[`DialogRules.ts:117-122`](../../src/b2bua/rules/defaults/DialogRules.ts#L117).
This would smear the burst across a 60 s window without touching the
timer infrastructure. Worth a one-pager fix plan; not on the critical
path of §0/§0.1.

In-dialog OPTIONS keepalives should be spread evenly across time (each
long-call's keepalive fires 5 min after that call's connection time, so
with calls established uniformly over a soak, OPTIONS rate should be
**flat**, not bursty). But the inbound event-queue depth metric shows
sharp spikes every ~5 min that hit *both* workers simultaneously, plus
loop-lag p95 spikes to 400+ ms in those same windows.

This shape implies all keepalive timers fire from a *single* schedule
aligned to the worker's clock (or to the call's quantized connection time)
rather than to per-call wall clock. Investigate whether the timer
scheduler's tick granularity is rounding hundreds of timers into the same
tick. Code path: `src/...TimerService...`, keepalive rule.

### 6.2 `sipp` short stream crashed at 19:09:44 — not chaos-related

Sipp short stopped sending **80 s before** chaos[3]. The pod log's last
entry is:

```
2026-05-14 19:09:44.263893 1778785784.263893:
  wheel_base is 2832074, clock_tick is 2832073 -
  expected wheel_base to be less than or equal to clock_tick
```

This is sipp's internal scheduler invariant; sipp 3.6 dies on it. It's a
known sipp issue under sustained load (~100k+ established calls). Either
patch sipp, restart it from the harness when it dies, or add a watchdog
that re-launches the stream. Tracking issue should reference this plan.

### 6.3 Overload protection fires but doesn't reject — **PARTIALLY CONFIRMED**

Two distinct sub-claims; verdicts differ.

**Sub-claim A: EWMA decays faster than the scrape sees.** Plausible.
`OverloadController.shouldAdmit` decides per-INVITE on the **current**
EWMA value, not the value at the next scrape
([`OverloadController.ts:281-345`](../../src/b2bua/OverloadController.ts#L281)).
With `alpha=0.2` (5-sample window) the EWMA collapses across a few
INVITEs, so a `shedProbability=1.0` reading at scrape time T may have
been `0.0` for most of the seconds before/after T. The
"10–12 / 377 scrapes ≈ 3 % of run wall time" extrapolation in the
original sibling is mathematically wrong — a gauge sample is an
instant, not a duration.

Across the run's final incarnation, the actual counters are:

```
worker-0  admit=2607  shedder_reject=39  bucket_empty=0
worker-1  admit=892   shedder_reject=13  bucket_empty=0
udp_drops_total=0  tier1_503_sent=0
```

The shedder is firing exactly when it should — the discrepancy with
"131 k INVITEs offered" is because that figure counts retransmits +
re-INVITEs across the **whole run** (multiple worker incarnations),
not only the admission-gated initial INVITEs.

**Sub-claim B: The TransactionLayer's duplicate-detection short-
circuits before the admission gate.** Confirmed at
[`TransactionLayer.ts:573-583`](../../src/sip/TransactionLayer.ts#L573).
Re-reads of an already-cached response correctly bypass the gate (we
must not re-decide admission for a packet we've already responded to).
This is **correct** behavior for retransmits of admitted INVITEs — they
get the cached 100 / 200 / 503 back and never increment `admitTotal`
again. Sub-claim B is real but not a bug.

**Verdict:** the metrics are doing what the code says. The user-facing
problem ("we never see a 503 attributed to the shedder on the sipp
side") is more about **reporting** than the shedder itself: the
synthetic admission counters reset every restart, and the renderer
doesn't roll them up across incarnations. Worth a small renderer fix
to surface a cumulative `shedder_reject_total` across all incarnations
of each worker — but the underlying admission machinery is sound.

`b2bua_overload_shed_probability` reached **1.00** for 10–12 of 377
metric scrapes (~3 % of run wall time). Yet the actual reject counters
show only **39 + 13 = 52** shedder rejections across both workers for the
full run, despite ~131 k INVITEs offered. Even within the bursts where
shedProbability reads as 1.0, fewer than 5 % of arriving INVITEs were
actually 503'd.

Two likely contributors:

- The shedder's `Math.random() < p` decision is per-call, but `p` is the
  EWMA sample at INVITE arrival time; the EWMA decays so fast that most
  INVITEs see a smaller `p` than the scrape captures.
- The TransactionLayer's duplicate-detection path (`Absorbing duplicate`,
  `Retransmit cached response`) returns *before* the admission gate
  (`src/sip/TransactionLayer.ts:592`). Under load, retransmits inflate
  the count of "INVITEs handled" without triggering admission.

This deserves its own plan — overload protection is supposed to keep
sipp seeing 503s during bursts, and we never see a single 503 attributed
to the shedder on the sipp side.

---

## 6.4 Action items decided 2026-05-15

These came out of reviewing §0 with the user.

### 6.4.1 Heapdump cadence + pre-kill capture

The 60 s `periodicHeapSnapshotMs` was set aggressively for an active leak
hunt. It's no longer the right default — drop to **once per hour**.

Change at [`tests/k8s/endurance/run-endurance.ts:343`](../../tests/k8s/endurance/run-endurance.ts#L343):

```diff
- periodicHeapSnapshotMs: 60_000,
+ periodicHeapSnapshotMs: 3_600_000,
```

Wrap every chaos kill in [`tests/k8s/endurance/chaosOps.ts`](../../tests/k8s/endurance/chaosOps.ts)
so it does, in this order:

1. POST `/debug/heap-snapshot` to the target pod, **wait for completion**.
2. POST `/debug/cpu-profile?seconds=N` to the target pod, **wait for completion**.
   (CPU-profile endpoint does not exist yet — needs to be added in
   `src/http/StatusServer.ts` alongside the existing `/debug/heap-snapshot`
   handler at [`StatusServer.ts:633`](../../src/http/StatusServer.ts#L633).)
3. Issue the kill / SIGTERM / `docker stop` / `kubectl delete`.

This changes the "what happened just before the kill?" forensics from
"hope the periodic recorder caught it" to "always have it".

### 6.4.2 Copy heap/CPU artifacts out as soon as they're written

Today `kubectl cp` runs only at the end of the run
([`tests/k8s/endurance/snapshot.ts:117`](../../tests/k8s/endurance/snapshot.ts#L117)).
A pod evicted mid-run loses everything. Change `triggerHeapSnapshot` in
[`tests/k8s/endurance/recorder.ts:247-279`](../../tests/k8s/endurance/recorder.ts#L247)
so that immediately after the snapshot returns the file path, the
recorder:

1. `kubectl cp` the file to `<artifactDir>/heapdumps/<pod>/<incarnation>/<file>`.
2. `kubectl exec ... rm /heapdumps/<file>` to free the volume.

Same change for the new CPU-profile endpoint. With these two together,
the 2 GiB `sizeLimit` becomes a high-water mark, not a ticking timer.

### 6.4.3 Visibility on "context load time on last reboot"

**Already exists, partially:**

- Per-peer bootstrap duration: `b2bua_replication_bootstrap_duration_ms{peer}`
  is emitted by `PeerScanBootstrap` ([`PeerScanBootstrap.ts:70-239`](../../src/replication/PeerScanBootstrap.ts#L70)).
- Per-incarnation `Loaded N owned calls from cache for worker N` info log
  at [`CallState.ts:719`](../../src/call/CallState.ts#L719).
- Worker-side **T_max ceiling WARN** at [`ReadinessController.ts:175`](../../src/replication/ReadinessController.ts#L175):
  ```
  ReadinessController: T_max=60000ms ceiling reached; flipping Ready with un-caught peers: [<peer>, …]
  ```
  This **already** loud-logs the "I gave up waiting for replication and
  flipped Ready by timeout, not because peers caught up" path you asked
  about — on the worker side. Confirmed in code; no change needed there.

**What's missing:**

A single end-to-end **`ready_in_ms`** metric: wall time from worker
process boot (`bootMs` in `ReadinessController.run`) to the Ready
transition, with a label naming **why** it flipped (`reason="all_caught_up"`
vs `reason="t_max_timeout"`). Add at the Ready-transition sites in
[`ReadinessController.ts:156-181`](../../src/replication/ReadinessController.ts#L156).
Pair with an `INFO` (caught-up) or `WARN` (timeout) log naming the
elapsed time. Renderer should plot this as one bar per worker
incarnation in `report.md` so a regression jumps out.

### 6.4.4 Proxy-side `freshPodGuard` expiry has NO warning today

You asked whether the proxy logs a warning when it routes to a
just-respawned primary "because the timeout expired, not because we
got positive evidence the worker is ready". **It does not.**

[`LoadBalancer.ts:435-457`](../../src/sip-front-proxy/strategies/LoadBalancer.ts#L435):

```ts
if (firstSeenAtMs !== undefined) {
  const nowMs = yield* Clock.currentTimeMillis
  if (nowMs - firstSeenAtMs < freshPodGuardMs) {
    // (loud INFO log when promoting to backup)
    return promoted
  }
}
return DecodeResult.forward(primary.address)   // ← silent
```

The `health === "alive"` check above does mean the proxy's SIP probe
returned 200 OK at least once — so it isn't pure timeout — but the
proxy doesn't distinguish "I trust this because the SIP probe just
went green for the first time after respawn" from "I trust this
because the K8s informer says Ready=true and the guard timer ticked
past 20 s".

Decision: emit a **WARN** at this site whenever the promoted-to-backup
branch was NOT taken AND `nowMs - firstSeenAtMs < (freshPodGuardMs * 3)`
— i.e. the worker is still in its early-life window even after the
guard. Include the per-pod metric `b2bua_routing_fresh_pod_forward_total{age_bucket="0-20s","20-60s",...}`
so dashboards can correlate with downstream 481 spikes.

### 6.4.5 Sipp scheduler crash (`wheel_base > clock_tick`) — fix exists upstream

The assertion is `timewheel::task2list()` in `src/task.cpp` defending
the invariant `wheel_base ≤ clock_tick` on sipp's internal timing wheel.
A thread race in `getmicroseconds()` (which used to update `clock_tick`
as a side effect) can publish a stale `clock_tick`, slipping it behind
`wheel_base`; sipp `ERROR`s and exits — exactly the line we observed.

Tracked upstream as
[issue #280](https://github.com/SIPp/sipp/issues/280) (Jan 2017),
fixed by [PR #619](https://github.com/SIPp/sipp/pull/619), commit
`2548582` (Rob Day, merged 2 Apr 2023). The fix introduces an explicit
`update_clock_tick()` owned by the traffic thread and removes the
implicit update from `getmicroseconds()`. Confirmed in
[`CHANGES.md`](https://github.com/SIPp/sipp/blob/master/CHANGES.md):

> Prevent clock_tick moving backwards (and getting behind wheel_base
> and causing an assert) (by Rob Day)

**Released in sipp 3.7.0; NOT backported to 3.6.x (unmaintained).**

**Action:** patch the sipp image's Dockerfile to build from tag
`v3.7.7` (or any 3.7.x ≥ 3.7.0). Six-file fix, contained, no scenario
or CLI changes needed. Both calling-sipp and called-sipp images must
be rebuilt.

This **eliminates** the auto-restart fallback we were considering and
the open called-sipp question. We do not need a watchdog or a port-
distinct restart path; we just need the upgraded sipp.

References:
- https://github.com/SIPp/sipp/issues/280
- https://github.com/SIPp/sipp/pull/619
- https://github.com/SIPp/sipp/blob/master/CHANGES.md

---

## 7. Artifacts to attach when starting work

- `test-results/k8s-endurance/endurance-1h-2026-05-14t18-20-33/`
  - `verdict.json`
  - `report.md`
  - `forensics/endurance-short-…-67738@det.txt` (representative 481)
  - `pod-logs/b2bua-worker-{0,1}.log`
  - `pod-logs/sip-front-proxy-*.log` (4 incarnations)
  - `metrics/b2bua-worker-{0,1}.{ndjson,proc.ndjson}`
  - `timeline.html` (chart with the 18:51–18:53 burst clearly visible)
- This doc.
