# Endurance: stuck terminating, queue overload, and OTel overload hardening

## Context

Endurance run `endurance-2026-05-09t20-26-22-853z` failed with a worker
that, an hour after drain, still held ≈926 MB of live heap (1.6 GB
snapshot file), with ~1,300 unfinished spans, ~1,300 live `FiberImpl`s,
~178 K paused generators, ~4 M closure scopes, and ~29 K retained
parsed SIP messages. While the worker was quiescent, ~47 % of CPU was
spent in GC.

Diagnosis (see "Findings" below) identified three independent failure
modes that combined to produce the observed leak:

1.  **Calls do not reliably exit `terminating`.** A keepalive-timeout
    event firing while the call is in `terminating` re-emits
    `begin-termination`, which `cancel-all-timers` + reschedules the
    `terminating-timeout-{callRef}` safety timer 64 s further out. As
    long as a keepalive fires every 60 s, the safety net never expires,
    and the call drifts inside `terminating` until the 60-s orphan
    sweep eventually catches it. Compounding this:
    - `keepaliveRule` and `keepaliveTimeoutRule` both match
      `callState: ["active", "terminating"]`, allowing the loop in the
      first place.
    - `TimerService.schedule` overwrites the `fibersMap` entry on id
      collision **without** cancelling the prior fiber, leaking a
      sleeping fiber on every reschedule.
    - `executeBeginTermination` appends to `state.call.timers` rather
      than replacing by id, so the persisted timer list grows on every
      re-entry.

2.  **The inbound event queue is unbounded.** `TransactionLayer`
    feeds parsed `SipMessage`s into `Queue.unbounded` consumed by a
    single `Stream.runForEach` fiber in `SipRouter.start`. A slow
    consumer means events (including out-of-dialog OPTIONS keepalive
    probes from the proxy) accumulate without bound, retaining the
    entire `LazyHeaders` graph for each. ~21 K probe URIs and 29 K
    `LazyHeaders` retained at snapshot time match this pattern.

3.  **The OTel pipeline uses default `BatchSpanProcessor` + default
    `OTLPTraceExporter` settings**: `maxQueueSize=2048`,
    `maxExportBatchSize=512`, `scheduledDelayMillis=5000`,
    `exportTimeoutMillis=30000`, no retry, no SDK `diag` logger wired.
    Span creation has no backpressure: every `Effect.withSpan`
    allocates a `SpanImpl`, an `OtelSpan`, a captured-stack `Error`
    (via `addSpanStackTrace`), and a propagated `BaseContext`,
    regardless of BSP queue depth. With the OTel collector unreachable
    (the user's stated test condition), exports either fast-fail
    (acceptable) or block 30 s per batch (unacceptable, but not
    observed in this run's logs — see "Findings"). The architectural
    risk under collector overload exists today regardless.

## Goals (ordered by risk reduction)

1.  Calls in `terminating` reach `terminated` within bounded wall time,
    regardless of leg reachability or in-flight keepalive timeouts.
2.  Inbound SIP processing cannot retain unbounded heap when the
    consumer slows down.
3.  Independent calls do not head-of-line block each other.
4.  OTel collector overload cannot grow worker heap without bound.
5.  Operators see all four failure classes in metrics before they
    become incidents.

## Non-goals / explicit deferrals

- Fast-path bypass of OPTIONS keepalive in `TransactionLayer`. Earlier
  drafts proposed this; rejected because the proxy's `HealthProbe`
  intentionally uses OPTIONS to detect *worker SIP-stack health*. If
  the worker's SIP processing is unhealthy, OPTIONS must not answer
  either — that is the readiness signal. Bypassing OPTIONS would
  decouple it from the rest of the SIP path and leave a worker
  appearing alive while broken.
- Replacing the `keepalive` mechanism itself. Functionally fine once
  the timer-cancellation defect is fixed.
- Solving the "pod freezes 15 min after start" memory note from prior
  context. Separate issue, no evidence of shared root cause.

## RFC rules touched

The only SIP-protocol-facing changes are the keepalive matchers and
the worker-side queue-drop policy. Relevant rules:

- **RFC 3261 §17.1.2 / §17.1.3** — non-INVITE client transactions.
  Suppressing keepalive while a call is `terminating` is
  SBC-internal-only; OPTIONS keepalive is not RFC-mandated.
- **RFC 3261 §11** — UAS OPTIONS handling. The bounded-queue drop
  policy may shed *inbound* probe OPTIONS under sustained overload.
  Operators rely on the proxy's HealthProbe re-trying; a dropped
  OPTIONS produces "no response → demote worker," which is the
  correct semantics for an overloaded worker.
- **RFC 3261 §12.2** — re-INVITE and in-dialog requests. Per-callRef
  serialization in Slice 3 keeps same-call events ordered, preserving
  the "state updates before sending" invariant.
- **RFC 3261 §17.2.2** — Timer J. The bounded-queue work in Slice 2 does
  not change server-transaction lifetime.

---

## Slice 1 — fix the stuck-`terminating` defect

**Blocks endurance.** Land first; rerun endurance to confirm the
`terminating_calls{age>300s}` gauge from Slice 4 stays at zero.

### 1.1 Stop keepalive matching while `terminating`

Change the `match.callState` of both rules:

- `keepaliveRule` ([src/b2bua/rules/defaults/TimerRules.ts:55](src/b2bua/rules/defaults/TimerRules.ts#L55)):
  `["active", "terminating"]` → `["active"]`.
- `keepaliveTimeoutRule` ([src/b2bua/rules/defaults/TimerRules.ts:115](src/b2bua/rules/defaults/TimerRules.ts#L115)):
  `["active", "terminating"]` → `["active"]`.

Rationale: `begin-termination` already issues `cancel-all-timers` for
in-flight keepalive timers. The only way these rules can match in
`terminating` today is via the re-entry loop. Closing the matcher
prevents the loop. In-flight client OPTIONS transactions launched by
prior keepalives still complete via their own non-INVITE Timer F
(32 s) — independent of the rule chain.

### 1.2 Idempotent `begin-termination` and timer-list replace-by-id

In `executeBeginTermination` ([src/b2bua/rules/framework/ActionExecutor.ts:1804](src/b2bua/rules/framework/ActionExecutor.ts#L1804)):

- Guard the `cancel-all-timers` + safety-timer schedule on
  `state.call.state !== "terminating"`. If we are already in
  `terminating` and a `terminating_timeout` entry is present in
  `state.call.timers`, do nothing — `begin-termination` becomes a
  no-op when called for an already-terminating call.
- Replace `state.call.timers = [...state.call.timers, safetyTimer]`
  with a `replaceTimerById` helper that drops any prior entry with
  the same `id` before appending. Apply the helper everywhere a
  timer is added — at minimum the `keepalive_timeout` schedule in
  `keepaliveRule.handle` and the safety-timer schedule here.

### 1.3 `TimerService.schedule` cancels prior fiber on id collision

In `TimerService.schedule` ([src/call/TimerService.ts:71](src/call/TimerService.ts#L71)),
before the `MutableHashMap.set(fibersMap, entry.id, ...)`, look up the
existing entry and `Fiber.interrupt` it. Without this, a re-schedule
under the same id leaks the previous sleeping fiber.

This bug is independent of slice 1.1/1.2 and worth fixing on its own.

### Verification

- Fake-clock test in `tests/scenarios/`: drive a call to `terminating`
  while keepalive timers are pending, then `TestClock.adjust` past
  64 s with no responses on either leg → assert call reaches
  `terminated` and is removed from `callsMap` within 64 s.
- Defensive test: artificially re-inject `keepalive_timeout` events
  while `terminating` (simulating the historical loop) → call still
  terminates within 64 s.
- Add a fake-clock test that re-schedules a timer with the same id
  twice; assert `TimerService.activeCount() === 1` and the prior
  fiber's `await` of `Fiber.interrupt` succeeds.

---

## Slice 2 — bound the inbound event queue

Independent of Slice 1; together they make the worker safe under
extended consumer slowdowns.

### 2.1 Replace `Queue.unbounded` with `Queue.bounded`

[src/sip/TransactionLayer.ts:252](src/sip/TransactionLayer.ts#L252):

```
const eventQueue = yield* Queue.bounded<TransactionEvent, Cause.Done>(N)
```

Choose `N ≈ 4 × udp.queueMax` from `AppConfig`. Higher than the UDP
receive queue so a momentary scheduler pause doesn't drop events
unnecessarily; finite so a pathological stall caps retained heap.

### 2.2 Drop-on-full, never block the receive loop

`emit` and `handleInboundResponse` (and any other producer) must not
block on a full queue — that would push backpressure into the UDP
receive path and drop everything. Use `Queue.offer` (returns `boolean`)
or `Queue.offerIfNotFull`-style logic; on rejection:

- Increment `b2bua_worker_event_queue_drops_total{reason}`.
- WARN log on transition (drop rate going from 0 → non-zero), not per
  event.
- Drop policy: drop newest. Older events are likelier in-progress
  state we already started.

Per-message-class reason tags: `request_invite`, `request_other`,
`response`, `cancelled`, `timeout`. Operators want to know which class
is being shed.

### 2.3 Note on OPTIONS

OPTIONS deliberately rides the same path as everything else (see
"Non-goals"). Under sustained queue saturation the worker will drop
inbound OPTIONS probes; the proxy's HealthProbe correctly demotes
workers that fail to answer. This is the readiness signal we want.

### Verification

- Fake-clock test: artificially block the SipRouter consumer
  (e.g. via a never-resolving `Effect`), pump 10 × `N` events at
  `TransactionLayer`, assert `Queue.size === N` and
  `eventQueueDropsTotal === 9 × N`.
- Same scenario, then unblock the consumer: assert the queue drains
  to zero and the worker resumes normal processing.

---

## Slice 3 — per-callRef event concurrency (multiple fibers, ordered per call)

This addresses the user's question directly: yes, processing each call
in its own fiber prevents one call's stuck handler from blocking
events for unrelated calls. The constraint is that **same-call events
must remain serialised** so state mutations (relay BYE 200 → mark leg
terminated → write CDR) happen in order.

### 3.1 Replace `Stream.runForEach` with keyed concurrent processing

[src/sip/SipRouter.ts:864](src/sip/SipRouter.ts#L864):

```
yield* Stream.runForEach(txnLayer.events, ...)
```

becomes a keyed dispatch that groups events by their resolved
`callRef` (or by a synthetic key for events whose callRef is not yet
known — initial INVITE, parse errors, out-of-dialog OPTIONS).

Two implementation options, both viable:

- **Per-call mailbox.** Maintain a `MutableHashMap<callRef,
  Queue.bounded<CallEvent, never>>`. The main consumer routes events
  by callRef into the right mailbox. Each mailbox has a fiber forked
  in the layer scope running `Stream.runForEach` over its mailbox.
  Mailboxes are GCd when their owning call is removed from
  `callsMap` (use the existing `callState.remove` hook).
- **`Stream.groupByKey`.** Effect's `Stream.groupByKey` partitions a
  stream into per-key sub-streams; each sub-stream is processed in
  its own fiber. Less code to write; more abstract; needs care to
  ensure sub-streams terminate when the call ends so we don't leak
  fibers.

Pick option A (per-call mailbox). It maps cleanly to the existing
call lifecycle, makes mailbox-cleanup observable, and keeps backpressure
explicit.

### 3.2 Out-of-dialog and pre-callRef events

For events without a callRef yet (initial INVITE, OPTIONS keepalive
probes, parse errors, `cancelled` with no match, `timeout` for
already-removed calls), use a small fixed pool of N "shared" fibers
with `Stream.mapEffect(..., { concurrency: N })`. N=8 is enough to
absorb one stuck initial-INVITE without blocking new calls; tune
later if needed.

### 3.3 Per-mailbox bounded depth

Each call mailbox is bounded (small — say 32 entries). When a single
call's handler hangs, its mailbox fills, and *only that call's*
subsequent events are dropped or shed (with a counter). Other calls
continue. This is the property the user asked about.

### 3.4 Span propagation and tracer-context

The current single-consumer setup naturally inherits one tracer
context. With per-callRef fibers, each mailbox fiber starts with no
inherited Effect context — that is fine, because spans are created
fresh per event via `withProcessingSpan` / `withRootSpan` against the
call's persisted `traceId` / `rootSpanId`. Audit there is no implicit
context inheritance we depend on.

### Verification

- Test: pause the handler for one specific callRef (synthetic block),
  pump events for that callRef plus events for nine other callRefs,
  assert the nine other callRefs progress normally and only the
  blocked callRef's mailbox accumulates.
- Test: stuck call's mailbox reaches its cap → drop counter
  increments for *that callRef only*, healthy callRefs unaffected.
- Mutation test: bypass the per-call mailbox cleanup → assert lifetime
  test catches the leak (mailbox persists past `callState.remove`).

### Risk

This slice is the largest. It introduces:

- Per-call queue allocations (one bounded queue per active call —
  small, but multiplies by call concurrency).
- Mailbox-lifecycle bugs (forget to GC → fiber/queue leak).
- Subtle ordering bugs if events for the same call are ever routed
  to different mailboxes (e.g. callRef resolution races).

Land Slices 1, 2, 4 first. Use Slice 4's metrics on a short
endurance pass to confirm the simpler fixes are sufficient. Only
land Slice 3 if `terminating_calls{age>30s}` or queue-drop
counters are still non-zero — i.e. if there is a remaining
head-of-line story Slices 1+2 didn't cover.

---

## Slice 4 — observability for the failure classes patched here

Independent of all other slices; can land first. All metrics exposed
under `/debug/memory` (JSON) and `/metrics` (Prometheus).

### 4.1 New gauges

- `b2bua_worker_event_queue_depth` — `Queue.size(eventQueue)`.
- `b2bua_worker_event_queue_capacity` — static, set to N from Slice 2.
- `b2bua_worker_terminating_calls{age_bucket}` — count of calls in
  `terminating` state, bucketed `<10s`, `10-60s`, `60-300s`, `>300s`.
  Last bucket should always be 0; non-zero is the canary for the
  Slice-1 defect class.
- `b2bua_worker_active_timers` — `TimerService.activeCountSync()`.
- `b2bua_worker_call_mailbox_depth_max` (Slice 3 only) — max depth
  across active mailboxes.
- `b2bua_otel_bsp_queue_depth` — internal BSP queue size.

### 4.2 New counters

- `b2bua_worker_event_queue_drops_total{reason}` — Slice 2.
- `b2bua_worker_call_mailbox_drops_total` — Slice 3.
- `b2bua_otel_bsp_dropped_total` — Slice 5.
- `b2bua_otel_tracer_disabled_total{reason}` — Slice 5 kill-switch
  trips.

### 4.3 Transition logs

WARN log lines emitted **on transition** (not per-event):

- First non-zero `event_queue_drops` after a quiet period.
- First call entering `terminating_calls{age>300s}` bucket.
- BSP queue depth crossing 80 % of capacity.
- Tracer kill-switch raising / lowering (Slice 5).

---

## Slice 5 — OTel pipeline overload protection

Independent of all other slices.

### 5.1 Override BSP defaults

[src/main.ts:151-153](src/main.ts#L151) and
[src/observability/otlp-http-tracing-layer.ts:53-55](src/observability/otlp-http-tracing-layer.ts#L53-L55):

```
new BatchSpanProcessor(
  new OTLPTraceExporter({ url: opts.tracesUrl, timeoutMillis: 2000 }),
  {
    maxQueueSize: 1024,
    maxExportBatchSize: 256,
    scheduledDelayMillis: 1000,
    exportTimeoutMillis: 2000,
  }
)
```

Smaller queue + 2-s export timeout caps total in-flight retained span
objects at ≈ `maxQueueSize + maxExportBatchSize` ≈ 1.3 K and pinned
HTTP connections at ≤ 2 s × concurrent batches.

### 5.2 Wire SDK diagnostics into our logger

`diag.setLogger(...)` once at process boot, mapping SDK levels to
ours. Without it, BSP's "dropping span" warnings disappear into
stderr unobserved.

### 5.3 Tracer kill-switch on backpressure

Add a `TracerHealthSignal` driven by a periodic check of BSP queue
depth. When depth > 80 % of `maxQueueSize` for ≥ 3 s, raise the
"saturated" flag. When < 50 %, lower it.

`TracingService.withRootSpan` / `withProcessingSpan` / `emitSendSpan`
consult the flag — when raised, they execute the inner effect without
calling `Effect.withSpan`. `withErrorSpan` keeps tracing on (errors
are rare and worth the diagnostics).

Trade-off: spans are dropped at source during overload. Acceptable —
the alternative is OOM.

Implementation note: prefer wrapping BSP behind a thin
`SpanProcessor` decorator that exposes its queue depth, rather than
poking `(spanProcessor as any)._finishedSpans`. The decorator can
also surface the `bsp_queue_depth` and `bsp_dropped_total` metrics
without unsafe access.

### 5.4 Don't capture stack traces on cold spans

`Effect.withSpan` eagerly allocates an `Error` to populate
`addSpanStackTrace`. Confirm `withProcessingSpan` and `emitSendSpan`
are gated on `call.sampled === true` (they appear to be — confirm at
call sites). For `withErrorSpan` keep stack capture.

### Verification

- Fake-clock test: point `tracesUrl` at a black-hole endpoint, run a
  load-shaped test, assert BSP queue depth stays ≤ `maxQueueSize`
  and the kill-switch raises within ≤ 5 s.
- Heap-growth test: same scenario, assert worker heap stays bounded
  over a 5-min synthetic load.

---

## Slice 6 — opportunistic cleanup

Mechanical, low-risk, independent.

- **Cap `state.call.timers` length.** The replace-by-id helper in
  Slice 1.2 should be assertion-checked: at most one entry per
  `(type, legId)` tuple. Use `assert` in dev builds.
- **Confirm `originalRequest` / `originalBuffer` are nulled on every
  final-state transition.** [src/sip/TransactionLayer.ts:711-712](src/sip/TransactionLayer.ts#L711-L712)
  handles `sendResponse`; audit the INVITE-specific completion paths
  in `handleInboundRequest` and `handleInboundResponse` for
  consistency.
- **Demote `[diag] send-request-to-leg OPTIONS leg=…`** to
  `Effect.logDebug` (currently bare `console.log` lines bypass
  structured logging — visible in pod logs without timestamps).
- **Investigate the single
  `Unhandled error processing event [sip:200] SchemaError: Missing key`**
  from the failing run. Reproducible from `forensics/`. Likely a
  parser path failing open. ~10 minutes once Slices 1+2 land.

---

## Sequencing & ownership

- **Slice 1** unblocks endurance. Land first.
- **Slice 4** (metrics) can land alongside or before Slice 1 — gives
  the next endurance pass instrumentation to confirm the fix.
- **Slice 2** lands second. Independent safety net.
- **Slice 5** can land in parallel with any other slice.
- **Slice 6** opportunistic, any time.
- **Slice 3** evaluated *after* Slices 1+2+4 are validated by an
  endurance pass. Land only if metrics still show stuck-call /
  head-of-line symptoms.

Suggested PR breakdown:

1. PR1: Slice 1 (1.1, 1.2, 1.3) + Slice 4.1/4.2/4.3 (just the
   metrics needed to verify Slice 1).
2. PR2: Slice 2 + remaining Slice 4.
3. PR3: Slice 5.
4. PR4 (conditional): Slice 3.
5. PR5 (or rolled into 1-3 as suitable): Slice 6.

## Findings (supporting evidence)

Pulled from the run artifacts at
`test-results/k8s-endurance/endurance-2026-05-09t20-26-22-853z/`:

- Heap snapshot of `b2bua-worker-0` post-run-leak-snapshot:
  - 926 MB self-size across 17.3 M nodes; 4.10 M `system / Context`
    closure scopes (176 MB), 4.26 M closures, 178 K paused
    `Generator`s, 167 K `closure::loop`, 1,322 `FiberImpl`,
    2,622 `OtelSpan` + 2,622 `SpanImpl` (1:1), 1,310 retained
    `addSpanStackTrace … withSpan` `Error`s, 29 K `LazyHeaders`,
    21 K retained `<sip:probe@…>` strings (1 OPTIONS CSeq → proxy
    HealthProbe).
- CPU profile (11.2 s window): 47 % GC, 35 % idle, 11 % inspector
  self-cost (the profiler observing itself), ~7 % Effect run loop +
  OTel context machinery. No userland busy loop.
- Worker log:
  - `Orphan sweep recovering terminating call ... (age 935-969 ms)`
    — calls reaching 16-min total lifetime before cleanup. The "age"
    is `Date.now() - createdAt`, not "time spent in terminating";
    nonetheless the 60-s sweep is the cleanup of last resort because
    the rule path missed the call.
  - 700+ `Transaction timeout: non-invite branch=…` per 5-min after
    chaos events — outbound keepalive OPTIONS to legs that timed out
    via Timer F, one per stuck call × 60-s cycles × 2 legs.
  - `[diag] send-request-to-leg OPTIONS leg=a/b-1 pre.localCSeq=…
    post.localCSeq=…` — keepalive emissions, with high CSeq
    confirming many cycles per stuck call.
  - Single `Unhandled error processing event [sip:200] SchemaError:
    Missing key` at 20:35:04 — separate parser issue (Slice 6).
  - No OTel exporter warnings / drops logged. Defaults are still in
    place; instrumentation is missing — confirms Slice 4.2 + 5.2
    are needed even if no exporter problem occurred this run.
- Code paths confirmed in source:
  - `keepaliveRule` matches `[active, terminating]` ([TimerRules.ts:55](src/b2bua/rules/defaults/TimerRules.ts#L55)).
  - `keepaliveTimeoutRule.handle` re-emits `begin-termination`
    ([TimerRules.ts:131](src/b2bua/rules/defaults/TimerRules.ts#L131)).
  - `executeBeginTermination` cancels all timers and reschedules
    `terminating-timeout-{callRef}` 64 s out, every call
    ([ActionExecutor.ts:1804-1866](src/b2bua/rules/framework/ActionExecutor.ts#L1804)).
  - `TimerService.schedule` overwrites `fibersMap` without cancelling
    the prior fiber ([TimerService.ts:71](src/call/TimerService.ts#L71)).
  - `eventQueue` is `Queue.unbounded`
    ([TransactionLayer.ts:252](src/sip/TransactionLayer.ts#L252)).
  - `BatchSpanProcessor` constructed with default options at both
    wiring sites ([main.ts:151](src/main.ts#L151),
    [otlp-http-tracing-layer.ts:53](src/observability/otlp-http-tracing-layer.ts#L53)).
