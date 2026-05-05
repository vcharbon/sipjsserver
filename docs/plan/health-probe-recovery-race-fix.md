# HealthProbe recovery race — fix plan

## TL;DR

Under sustained UDP traffic surge a SIP front proxy can mark every
worker `dead` on its **probe-side** health and never recover, even
though the workers are healthy and answering OPTIONS 200 OK. The
defect was uncovered by the 1 h k8s endurance run on 2026-05-05
(seed `1777960808113`, artifact dir
`test-results/k8s-endurance/endurance-2026-05-05t06-00-08-113z/`):
proxy `6nmjs` flipped to `no alive workers among 2 entries` at
06:22:14 — 53 s into chaos[0] (`node-shutdown-edge sip-e2e-worker2`)
— and stayed there for the **next 50 minutes**, blackholing ≈ 50 %
of cluster traffic until DRAIN. STEADY failure rate for the run was
78 % (51 169 / 65 689). See
[platform-behavior.md](../../test-results/k8s-endurance/endurance-2026-05-05t06-00-08-113z/platform-behavior.md)
for the full forensic.

The fix is small and self-contained: in
[src/sip-front-proxy/health/HealthProbe.ts](../../src/sip-front-proxy/health/HealthProbe.ts)
make the inbound 200 OK path **idempotent and non-pending-dependent**
so a late-but-valid probe reply still resets the probe-side health to
`alive`, instead of being silently discarded because `reapTimeouts`
already cleared its `pendingByCallId` entry.

The race reproduces deterministically with TestClock + the existing
simulated-network harness; it does **not** require k8s for fix
verification, only for end-to-end re-validation afterwards.

## Why the cluster broke (one sentence)

`6nmjs`'s probe fiber missed enough OPTIONS replies during the traffic
surge (caused by kube-proxy redirecting all UDP from the dying
`mp9v2` to `6nmjs`) to flip both workers to `dead` via the
`threshold` rule, and **the only path that could re-mark them
`alive`** — `inboundDrain` matching `pendingByCallId[callId]` — was
unable to recover because every late reply landed *after* the
matching reap had already removed that pending entry, so the late
reply was discarded silently.

## Root cause

Two pieces of code in
[HealthProbe.ts](../../src/sip-front-proxy/health/HealthProbe.ts)
race against each other on the same `MutableHashMap<callId,
WorkerId>`:

1. **`reapTimeouts`**
   ([HealthProbe.ts:241-272](../../src/sip-front-proxy/health/HealthProbe.ts#L241))
   fires `timeoutMs` after `fanOutOptions`. For every `callId` still
   in `pendingByCallId` it removes the entry and increments
   `consecutiveMisses`. Crossing `threshold` calls
   `setHealth(id, "dead")`.
2. **`inboundDrain`**
   ([HealthProbe.ts:281-323](../../src/sip-front-proxy/health/HealthProbe.ts#L281))
   on every received UDP packet that parses as a SIP response, looks
   up `pendingByCallId[callId]`. If the entry is **None** the handler
   returns early
   ([HealthProbe.ts:294](../../src/sip-front-proxy/health/HealthProbe.ts#L294)).

Under load, the Node.js event-loop ordering can place `reapTimeouts`
before `inboundDrain`'s effect for a packet that arrived *before* the
reap deadline. The reap clears the entry; the inbound handler then
sees `None` and returns. The probe's `consecutiveMisses` counter is
incremented as if the worker had not replied, and **never** reset by
the late reply. A handful of consecutive races flips the worker to
`dead` and pins it there.

Once `dead`, the only way back to `alive` is for some future cycle's
reply to arrive **before** that cycle's reap. As long as the load
that caused the original race persists, that condition fails on
every cycle.

### Why `mp9v2` recovered but `6nmjs` did not

`mp9v2` was on the chaos-killed edge node and went through a
sandbox-recreate at 06:22:24 — its container restarted, wiping
`pendingByCallId` and `consecutiveMisses` to zero. Fresh probe state
+ healthy workers ⇒ recovers within one tick.

`6nmjs` was on a healthy edge node. `restartCount=0` in the snapshot.
Its corrupted probe state persisted for the rest of the run.

## RFC considerations

The fix touches only how the proxy *interprets* its own outbound
OPTIONS replies — it does not change the SIP messages on the wire.
Relevant rules to honour while editing:

- **RFC 3261 §11 (OPTIONS)** — the UAS responds to OPTIONS with its
  capabilities. Status 200 indicates the worker is alive and willing
  to accept dialogs. Our probe does not parse the body; only the
  status line + `Reason` header (RFC 3326) matter.
- **RFC 3261 §17.1.1.2 (Call-ID uniqueness)** — Call-IDs are minted
  per probe cycle and are globally unique; using the Call-ID prefix
  to extract the WorkerId is safe because the probe is the sole
  minter and uses a deterministic prefix
  ([HealthProbe.ts:204](../../src/sip-front-proxy/health/HealthProbe.ts#L204)):
  `probe-<workerId>-<nowMs>-<tag>@<probeAddr>`.
- **RFC 3261 §8.1.3 (Receiving a response)** — UAC SHOULD discard
  responses that don't match an outstanding transaction. We bend this
  *for the probe socket only* (which has no transaction layer — it's a
  one-shot keepalive) and only as a positive liveness signal; we do
  NOT use stray packets for any routing decision.
- **RFC 3326 (Reason header)** — already correctly used in
  `classify503` to distinguish `not-ready` from `draining`. Behaviour
  preserved.

No new SIP-level behaviour. No header rewriting. No tag/Via changes.

## Fix design

Two surgical changes in
[src/sip-front-proxy/health/HealthProbe.ts](../../src/sip-front-proxy/health/HealthProbe.ts):

### Change 1 — late-reply recovery (the actual bug)

Inside `inboundDrain`, when `pendingByCallId.get(callId)` is None,
attempt a **fallback identification** before giving up:

```ts
const idOpt = MutableHashMap.get(pendingByCallId, callId)
if (Option.isSome(idOpt)) {
  // Existing path — fast match.
  const id = idOpt.value
  MutableHashMap.remove(pendingByCallId, callId)
  // ... reset consecutiveMisses + setHealth as today
  return
}

// Fallback — late reply for an already-reaped probe. Recover the
// WorkerId from the Call-ID prefix WE minted (`probe-<id>-...`).
// This must NOT trust packets we did not mint, so:
//   - require the `probe-` prefix
//   - require the parsed WorkerId to be currently registered
const fallbackId = parseProbeCallId(callId)
if (fallbackId === undefined) return
const reg = yield* registry.resolve(fallbackId)
if (Option.isNone(reg)) return  // unknown id — drop

// Idempotently reset miss counter + flip probe-side back to `alive`
// if the response is 200. 503 is also honoured (draining/not-ready).
const ent = MutableHashMap.get(perWorker, fallbackId)
if (Option.isSome(ent)) ent.value.consecutiveMisses = 0
let next: WorkerHealth
if (msg.status === 200) next = "alive"
else if (msg.status === 503)
  next = classify503(getHeader(msg.headers, "reason"))
else next = "alive"
yield* control.setHealth(fallbackId, next).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning(`HealthProbe: late-reply setHealth(${fallbackId}, ${next}) failed`, cause)
  )
)
```

Helper to add at module scope:

```ts
const PROBE_CID_RE = /^probe-(.+?)-\d+-/
const parseProbeCallId = (callId: string): WorkerId | undefined => {
  const m = PROBE_CID_RE.exec(callId)
  if (!m || m[1] === undefined) return undefined
  return WorkerId(m[1])
}
```

### Change 2 — defensive: clamp consecutiveMisses

Independent of change 1, a single late-reply burst should not
incorrectly age toward `dead` when **subsequent** cycles do match in
time. The current reset only happens via `inboundDrain` matching
`pendingByCallId`; with change 1 in place this is already covered for
the late path. No code change needed here — but the test plan below
includes an explicit assertion that a steady-state of late replies
does NOT walk the worker into `dead`.

### Why parse Call-ID rather than reverse-look-up by source address

`registry.lookupByAddress` would also work and is exposed
([WorkerRegistry.ts:153](../../src/sip-front-proxy/registry/WorkerRegistry.ts#L153)),
but Call-ID parsing is preferable because:

- The Call-ID was minted with the WorkerId we want — zero ambiguity.
- It survives pod-IP rotation between probe-out and reply-in. A reply
  arriving from a new IP because the pod was rescheduled mid-flight
  would be misattributed by `lookupByAddress` (or unmatchable). The
  Call-ID still identifies the original target.
- The CalI-ID has a per-cycle `nowMs` stamp; future hardening can
  reject obviously stale replies if needed (we don't need that for
  this fix).

## Slice plan (commit-friendly)

Each slice typechecks (`npm run typecheck`) and runs `npm run
test:fake` before commit. Per [CLAUDE.md](../../CLAUDE.md), watch
for Effect plugin warnings, not just `tsc` errors.

### Slice 1 — failing fake-clock test

File:
`tests/sip-front-proxy/transparency/health-probe-late-reply.test.ts`
(new — do not extend
[health-probe.test.ts](../../tests/sip-front-proxy/transparency/health-probe.test.ts)
because the existing scenarios assume `transitDelayMs < timeoutMs`).

Reuse helpers from `health-probe.test.ts`:

- `simulatedAdapterLayer`
- `workerRegistrySimulatedLayer`
- `optionsKeepaliveLayer`
- `SignalingNetwork.simulated({ transitDelayMs })`
- `customParser`, `serialize`, `generateResponse` for crafting the
  worker-side reply

Test parameters chosen to force the race deterministically:

| Constant | Value | Why |
| --- | --- | --- |
| `INTERVAL_MS` | `1_000` | match production default |
| `TIMEOUT_MS` | `200` | match production default |
| `TRANSIT_MS` | `300` | **strictly greater** than `TIMEOUT_MS` so every reply lands AFTER `reapTimeouts` |
| `THRESHOLD` | `3` | match production default |

Test cases (one `describe`, three `it.effect`):

1. **`reaps_dead_when_replies_always_late_today` (XFAIL → PASS post-fix)** —
   Initial worker `alive`. Worker endpoint **does** answer every
   probe, but the 200 OK arrives 100 ms after `reapTimeouts`. Drive
   TestClock through `THRESHOLD + 1` cycles. Assert worker health is
   currently `dead` BEFORE the fix is applied (capture-then-fix).
   After the fix lands this assertion flips to **`alive`** —
   document in the test what changed and why.
2. **`stable_alive_under_late_replies` (post-fix)** — Same setup but
   drive 10 cycles. Assert health is `alive` throughout (no flap).
3. **`spoofed_call_id_does_not_revive_dead_worker`** — Send a 200 OK
   with a Call-ID that does NOT match the `probe-<id>-` prefix into
   the probe socket while the worker is `dead`. Assert the worker
   stays `dead`. Then send a properly-prefixed 200 OK with an
   **unknown** WorkerId — assert no state change. Then send a
   properly-prefixed 200 OK with a registered WorkerId — assert it
   recovers to `alive`.

TestClock pacing per the project memory note: alternate
`TestClock.adjust` to the next deadline + `Effect.yieldNow` rather
than fixed-chunk stepping. Concretely:

```ts
yield* Effect.yieldNow
yield* TestClock.adjust(`${INTERVAL_MS} millis`)  // probe fanOut fires
yield* Effect.yieldNow
yield* TestClock.adjust(`${TIMEOUT_MS} millis`)   // reapTimeouts fires
yield* Effect.yieldNow
yield* TestClock.adjust(`${TRANSIT_MS - TIMEOUT_MS + 1} millis`)  // late reply lands
yield* Effect.yieldNow
```

(See
[health-probe.test.ts](../../tests/sip-front-proxy/transparency/health-probe.test.ts)
for the canonical worker-endpoint-drain helper to copy.)

### Slice 2 — fix

Apply Change 1 to
[HealthProbe.ts](../../src/sip-front-proxy/health/HealthProbe.ts).
Add the `parseProbeCallId` helper at module scope (not exported).
Re-run `npm run typecheck && npm run test:fake`. The slice-1 tests
should all pass.

Audit-checklist while editing:

- [ ] No new `Effect.catchAll` (use `catchTag` /  `catchCause` —
      [CLAUDE.md](../../CLAUDE.md)).
- [ ] No silent error swallow in the new fallback path; log warnings
      on `setHealth` failure (mirroring the existing pending-match
      path).
- [ ] `MutableHashMap` reads/writes inside the `inboundDrain`
      generator only — keep the routing path lock-free
      (D4 invariant in
      [WorkerRegistry.ts:14-18](../../src/sip-front-proxy/registry/WorkerRegistry.ts#L14)).
- [ ] No reliance on `Option.value` getter — use `Option.isSome` /
      `Option.getOrUndefined` (project convention).
- [ ] `parseProbeCallId` runs no I/O; registry.resolve is
      `Ref.get` + HashMap lookup, fine on hot path.

### Slice 3 — non-regression on the existing test

Re-run
[tests/sip-front-proxy/transparency/health-probe.test.ts](../../tests/sip-front-proxy/transparency/health-probe.test.ts).
The existing scenarios use `TRANSIT_MS=1`, well within
`TIMEOUT_MS=200`, so they exercise only the fast path. They MUST stay
green. If they don't, the fallback path is interfering with the
fast path — that's a code-bug, not a test-bug.

### Slice 4 — k8s endurance re-validation

```bash
npm run test:k8s:endurance -- --caps 20 --duration 1h \
  --seed 1777960808113
```

Same seed ⇒ same chaos schedule (deterministic per `scheduler.ts`).
Expected delta vs. the broken run:

| Metric | Pre-fix (this run) | Post-fix expectation |
| --- | ---: | ---: |
| STEADY failure rate | 78 % | < 5 % during chaos windows, ~0 % during steady |
| chaos[0] `during_issue.failed` | 1 195 | a few dozen (only the in-flight calls on the killed node) |
| chaos[0] `stabilized_after.failed` | 5 671 | < 200 |
| `no alive workers` warnings on `6nmjs` | 105 000+ | 0 |
| Limiter `exceededCap` | true | true (separate defect — out of scope) |

If the verdict is still FAIL with `STEADY` failures concentrated AFTER
chaos[3] (`proxy-pod-graceful`), the secondary `ck74t-routes-zero-traffic`
defect is unmasked — that becomes a follow-up plan, not part of this
fix.

## Acceptance criteria

- [ ] New file
      `tests/sip-front-proxy/transparency/health-probe-late-reply.test.ts`
      with three `it.effect` cases passes.
- [ ] Existing
      `tests/sip-front-proxy/transparency/health-probe.test.ts` is
      unchanged and still passes.
- [ ] `npm run typecheck` clean (zero `tsc` errors, zero Effect
      plugin warnings — see
      [CLAUDE.md](../../CLAUDE.md)).
- [ ] `npm run test:fake` clean.
- [ ] K8s endurance re-run with same seed yields STEADY failure
      rate ≤ 5 % and zero `no alive workers` warnings on either
      proxy pod.
- [ ] Single commit per slice (slice 1, slice 2 + 3 together, slice 4
      excluded — that's a run, not a code change).

## Out of scope (logged for follow-up)

- **Limiter TTL leak** (`maxInflight=14` vs `cap=10` pre-chaos):
  separate defect, unrelated code path. Document in a new plan.
- **`ck74t` routed-zero-traffic after chaos[3]**: smells like a
  K8s-watch reconnect bug or a NodePort/conntrack quirk on the
  re-enabled node. Re-run + inspect; if reproducible, new plan.
- **Watch-reconnect resilience on transient API-server outage**: the
  kubernetes client lib does NOT auto-relist on watch reconnect.
  Worth a separate hardening PR but not the cause of this run's
  symptom.
- **Proxy `/metrics` server in `bin/proxy.ts`**: per
  [docs/k8s-endurance.md](../k8s-endurance.md) the metrics dir was
  empty in this run. Without `sip_worker_health` time-series we had
  to infer probe-side flips from absence of routing. Wiring that in
  would let future endurance runs surface this kind of bug from
  graphs alone.

## Reproducer (without re-running 1 h endurance)

For local iteration, the fake-clock test is the reproducer.

For wall-clock reproducer (≈ 15 min) once the fix lands:

```bash
# 15-minute soak, same seed, one chaos event guaranteed at relSec~873
npm run test:k8s:endurance -- --caps 20 --duration 15m \
  --seed 1777960808113
```

The first chaos event (`node-shutdown-edge sip-e2e-worker2`) at
T+873 s suffices to validate the fix — it is the event that broke
`6nmjs` in the original run. If `6nmjs` survives chaos[0] without
flipping into `no alive workers`, the bug is closed.

## File-by-file change set

```
src/sip-front-proxy/health/HealthProbe.ts                     EDIT
tests/sip-front-proxy/transparency/health-probe-late-reply.test.ts NEW
docs/plan/health-probe-recovery-race-fix.md                   NEW (this file)
```

No public API change. No layer-signature change. No new dependency.

## References

- Forensic & numbers: [test-results/k8s-endurance/endurance-2026-05-05t06-00-08-113z/platform-behavior.md](../../test-results/k8s-endurance/endurance-2026-05-05t06-00-08-113z/platform-behavior.md)
- Probe code: [src/sip-front-proxy/health/HealthProbe.ts](../../src/sip-front-proxy/health/HealthProbe.ts)
- Registry health composition (most-restrictive-wins, D5): [src/sip-front-proxy/registry/kubernetes.ts:185-188](../../src/sip-front-proxy/registry/kubernetes.ts#L185)
- Registry routing-path D4 invariant: [src/sip-front-proxy/registry/WorkerRegistry.ts:14-18](../../src/sip-front-proxy/registry/WorkerRegistry.ts#L14)
- Existing transparency test (fast path): [tests/sip-front-proxy/transparency/health-probe.test.ts](../../tests/sip-front-proxy/transparency/health-probe.test.ts)
- Endurance harness operator guide: [docs/k8s-endurance.md](../k8s-endurance.md)
- Project conventions (warnings, Effect v4, file creation): [CLAUDE.md](../../CLAUDE.md)
