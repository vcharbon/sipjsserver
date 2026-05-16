# Plan: self-healing OTel exporter circuit-breaker (replace "abandoned" with hysteresis)

## Problem statement

The current OTel circuit-breaker
([src/observability/otel-circuit-breaker.ts](../../src/observability/otel-circuit-breaker.ts))
is a three-state machine: `closed → open → abandoned`. Once
`abandoned`, **the process drops every span silently for the rest of
its lifetime** (line 25-29, 110-114):

```
ABANDONED   — drop spans permanently (callback SUCCESS) and never
              touch the inner exporter again.
```

The trigger is a single failed probe after a 30 s cooldown. The
rationale (lines 31-34) is CPU efficiency — avoid retry chatter and
log spam against a permanently-dead collector.

This was a reasonable default, but it loses *all* tracing for any pod
that survives a transient collector outage. The 2026-05-15 5 h
endurance run hit exactly this: at `2026-05-15T23:50:37Z` worker-1
emitted

```
ERROR [otel] exporter circuit ABANDONED — collector unreachable after probe;
              spans will be dropped silently for the rest of this process
```

…and worker-1 went tracing-dark for the remaining ~ 4 h of the run.
The collector itself was healthy minutes later (worker-0 kept
exporting fine). A self-healing policy with backoff would have caught
the recovery automatically.

## Goal

Replace `abandoned` with a self-healing `open` state whose cooldown
grows on consecutive probe failures and resets on a probe success.
Keep the CPU/log-spam advantages of the original design — probes are
exponentially spaced, so a permanently-dead collector costs ~ log₂(t)
HTTP attempts over the whole run, not one-per-batch.

## Design

Two states only: `closed`, `open`.

| Transition | When | Action |
|---|---|---|
| `closed → open` | Inner export fails | Set `cooldownMs = base` (30 s). Log "circuit opened (cooldown 30s)". |
| `open → open` (drop)  | Export call during cooldown | Drop spans, callback SUCCESS, no log. |
| `open → open` (probe-fail) | Export call after cooldown, inner fails | Double `cooldownMs` up to `maxCooldownMs` (5 min). Log only on state changes or first probe attempt after long quiet (rate-limited). |
| `open → closed` | Probe succeeds | Reset `cooldownMs = base`. Log "circuit closed (collector reachable)". |

### Cooldown schedule

`base = 30 s`, `cap = 300 s` (5 min), double on each consecutive
probe failure: 30s → 60s → 120s → 240s → 300s → 300s → ... .

For a permanently dead collector, that's ~ 8 probes in the first hour,
~ 4 per hour after — significantly cheaper than the BSP's natural 1 Hz
attempt rate, while preserving the recovery guarantee. (Compare to
the current design: 1 real attempt + 1 probe = 2 attempts total, then
silent forever.)

### Log rate-limiting

To avoid log spam, only emit a `WARN` on transitions:
- `closed → open` — first failure of an outage.
- `open → closed` — recovery.

Probe failures while already `open` are silent (count them via the
existing `_attempts` counter and a new `_probeFailures` counter
exposed via `MeasuredSpanExporter`).

### What about queued spans?

Out of scope. The BSP drops spans when we return SUCCESS during
cooldown — that's the same as today. A queue across the outage would
need a bounded ring buffer and back-pressure protocol; deal with that
separately if needed.

## Implementation sketch

In [otel-circuit-breaker.ts](../../src/observability/otel-circuit-breaker.ts):

1. Drop the `"abandoned"` variant from `CircuitState`.
2. Add `_baseCooldownMs`, `_maxCooldownMs` fields (constructor opts;
   defaults `30_000` / `300_000`).
3. Replace the `wasProbe && failure → state = "abandoned"` branch
   (line 132-137) with `wasProbe && failure → _cooldownMs = min(
   _cooldownMs * 2, _maxCooldownMs); _openedAt = now;` (stay open,
   longer cooldown, no log).
4. Replace `closed → open` log to include the next probe time so
   operators can predict recovery attempts.
5. On `open → closed`, reset `_cooldownMs = _baseCooldownMs`.

That's a ~ 15-line diff. No call-site change needed.

## Test plan

A unit test in `tests/observability/` driving the breaker through:

1. CLOSED, exports succeed → no state change.
2. Failure → OPEN with base cooldown.
3. Export during cooldown → dropped, SUCCESS callback, no inner call.
4. After cooldown, inner still failing → cooldown doubles, still OPEN.
5. Repeat (4) until cap reached, then verify cooldown is clamped.
6. After cap, inner returns SUCCESS → CLOSED, cooldown reset to base,
   transition logged.
7. Bench (advisory only) — confirm probe attempts during a 1 h
   simulated outage stay ≤ 10.

Existing tests in `tests/observability/bsp-measured.test.ts` and
`tests/observability/tracer-health.test.ts` should still pass without
modification.

## Acceptance

1. After an OTel collector outage of any length, the next BSP batch
   following a successful probe resumes export — no operator action
   required.
2. The unit test above passes; `npm run typecheck` is clean (no v3 /
   catch-all anti-pattern regressions introduced).
3. The 2026-05-15-style failure mode (one worker stops emitting
   spans for the rest of the run while the other keeps reporting)
   no longer reproduces under chaos.
4. A re-read of the file header (lines 1-43) accurately describes
   the new state machine — update the doc comment as part of the
   change.

## Out of scope

- Span queueing across outages (separate plan if needed).
- A circuit breaker for any other backend (HTTP call-control,
  limiter Redis, etc.) — each has its own failure semantics. Cross-
  reference: the limiter-Redis fail-open plan
  ([2026-05-15-limiter-redis-spof-cascade-fix.md](2026-05-15-limiter-redis-spof-cascade-fix.md))
  is the right model for that one.
- Changing the BSP `scheduledDelayMillis` — orthogonal.
