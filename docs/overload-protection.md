# Overload Protection & Emergency Priority

Reference for the three-tier overload-protection model implemented in this
B2BUA. Companion to [b2bua-sip-headers.md](b2bua-sip-headers.md).

## Goals

Under traffic spikes, shed *new* call attempts as early and as cheaply as
possible so already-admitted calls keep flowing without packet loss or
retransmit-induced amplification. Emergency calls
(`Resource-Priority: esnet.0|wps.0|q735.0`) are never dropped at any tier.

## Three-tier model

```
UDP recv ─► Tier 1 (UdpTransport, pre-parse byte brake)
         │   │
         │   └─► stateless 503 (templated, no parse, no txn, no fiber)
         │
         ▼
    bounded UDP queue ─► dispatcher (cluster mode only)
                         │
                         ▼
                    Tier 2 (Dispatcher, per-worker class queues)
                         │   ├─► emergency  (drained 1st, bound 500)
                         │   ├─► inDialog   (drained 2nd, bound 400)
                         │   └─► normalNewCall (drained last, bound 100)
                         │
                         ▼
                    worker IPC ─► TransactionLayer
                                       │
                                       ▼
                                  Tier 3 (OverloadController)
                                  token bucket + max-of-fractions shedder
                                       │
                                       ▼
                                  SipRouter ─► handlers ─► CallLimiter
```

### Tier 1 — pre-parse emergency brake

Lives in [src/sip/UdpTransport.ts](../src/sip/UdpTransport.ts). Activates
when the bounded recv queue depth crosses
`UDP_QUEUE_TIER1_THRESHOLD_PCT` of `UDP_QUEUE_MAX`. The recv callback runs
two cheap byte-level checks (`isInviteRequestBuffer`,
`bufferHasEmergencyMarker`) and templates a stateless 503 directly from
the inbound buffer for new, non-emergency INVITEs:

- copies Via / From / To / Call-ID / CSeq verbatim from the inbound buffer
- does **not** add a To-tag (orphan ACK is deliberately absorbed)
- sets `Reason: SIP;cause=503;text="overload"` and a jittered `Retry-After`
- `Content-Length: 0`

No JsSIP parse, no transaction, no fiber. Emergency INVITEs, in-dialog
traffic, ACKs, BYEs, and responses pass through. When the queue is fully
saturated even after the brake, the recv callback tail-drops the packet
and increments a counter.

### Tier 2 — class-based per-worker queues (cluster mode)

Lives in [src/cluster/Dispatcher.ts](../src/cluster/Dispatcher.ts). Each
worker has three bounded queues drained in strict priority order:

| Class           | Bound (default) | Drop policy on overflow |
|-----------------|-----------------|-------------------------|
| `emergency`     | 500             | drop oldest + page |
| `inDialog`      | 400             | drop oldest + mark worker overloaded + start kill timer |
| `normalNewCall` | 100             | drop newest + dispatcher sends stateless 503 directly |

Classification is a pure byte-scan, no SIP parse:

1. `bufferHasEmergencyMarker` (`;emerg=1` / `;em=1` / `Resource-Priority`) → `emergency`
2. `isInviteRequestBuffer` && **no** To-tag → `normalNewCall`
3. `isInviteRequestBuffer` && To-tag → `inDialog`
4. else → `inDialog`

When a worker's `inDialog` queue stays full continuously for
`WORKER_INDIALOG_FULL_KILL_AFTER_MS` (default 60s), the dispatcher sends
SIGTERM and the cluster respawns the worker. While in inDialog-full mode,
the dispatcher pre-emptively 503s every new call attempt routed to that
worker.

### Tier 3 — token bucket + adaptive shedder

Lives in [src/b2bua/OverloadController.ts](../src/b2bua/OverloadController.ts)
and is invoked from
[src/sip/TransactionLayer.ts](../src/sip/TransactionLayer.ts) before any
INVITE server-transaction allocation. Algorithm:

```
admit(req):
  if req.emergency:
    bucket.consumeForced()      # bucket can go negative
    return ADMIT
  if !bucket.tryConsume():
    return REJECT_503 reason=bucket_empty
  p = max(
    fraction(loop_lag_ewma_ms,        soft=50,  hard=200),
    fraction(active_calls,            soft=80%, hard=100% of CALL_LIMIT),
    fraction(inDialog_queue_depth,    soft=50%, hard=90% of bound),
    fraction(routingApi_newCall_p95,  soft=200, hard=1000),
  )
  return random() < p ? REJECT_503 reason=shedder : ADMIT
```

- Token bucket: `CPS_BUCKET_SIZE` capacity, `CPS_BUCKET_RATE` tokens/sec.
- Loop-lag is sampled by a `setInterval`-driven EWMA (independent of
  `TestClock` so the host runtime drives it directly).
- Routing-API latency is fed by `CallControlClient.observeRoutingApiLatency`
  with `new_call` and `in_dialog` stages tracked separately.

### Emergency classification & propagation

[src/b2bua/InitialInviteHandler.ts](../src/b2bua/InitialInviteHandler.ts)
detects `Resource-Priority: esnet.0|wps.0|q735.0` on the initial INVITE
and sets `call.emergency = true` on the Call model.
[src/sip/SipRouter.ts](../src/sip/SipRouter.ts) then stamps `;emerg=1` on
the Contact URI and `;em=1` on the Via custom params of every outbound
message for that call. Subsequent in-dialog packets carry these markers
into Tier 1 / Tier 2 byte-scans, so dispatcher and UDP layer can recognise
emergency dialogs without state.

### Orphan ACK absorption

[src/sip/TransactionLayer.ts](../src/sip/TransactionLayer.ts) drops ACKs
that match neither a server INVITE transaction nor an existing dialog
rather than emitting them upstream. Required so that the ACK responses to
templated stateless 503s never reach SipRouter (which would reject them).

### Order of gates for a new INVITE

```
Tier 1 (UDP queue threshold + byte brake)
  └─► Tier 2 (Dispatcher class queue)
        └─► Tier 3 (OverloadController bucket + shedder)
              └─► routing API (CallControlClient.newCall)
                    └─► CallLimiter (per-customer windowed counter)
```

Emergency calls bypass Tier 1 reject, never see a Tier 3 reject, and the
HTTP backend is expected to omit `call_limiter` for them. The SIP stack
itself always applies whatever limiters the backend returns — emergency
exemption from CallLimiter is a backend policy, not a SIP-stack one.

### Optional emergency dual UDP listener

Controlled by `EMERGENCY_LISTENER_ENABLED` /
`EMERGENCY_LISTENER_HOST` / `EMERGENCY_LISTENER_PORT`. When enabled, a
second UDP socket binds on the configured loopback host:port. Admitted
emergency calls publish their b-leg Contact / Via on this socket so that
carrier-side in-dialog traffic for emergency dialogs lands in a physically
isolated kernel buffer. Off by default. **Implementation deferred** —
config flags are wired through but the second socket is not yet bound.

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `UDP_QUEUE_MAX` | 100 | Bounded UDP recv queue |
| `UDP_QUEUE_TIER1_THRESHOLD_PCT` | 70 | Tier 1 brake activation |
| `WORKER_QUEUE_EMERGENCY_MAX` | 500 | Per-worker emergency class queue |
| `WORKER_QUEUE_INDIALOG_MAX` | 400 | Per-worker in-dialog class queue |
| `WORKER_QUEUE_NEWCALL_MAX` | 100 | Per-worker normal new-call class queue |
| `WORKER_INDIALOG_FULL_KILL_AFTER_MS` | 60000 | Worker-kill escalation timer |
| `CPS_BUCKET_SIZE` | 1000 | Token bucket capacity |
| `CPS_BUCKET_RATE` | 500 | Token refill rate (tokens/sec) |
| `OVERLOAD_LOOP_LAG_SOFT_MS` / `_HARD_MS` | 50 / 200 | Tier 3 loop-lag thresholds |
| `OVERLOAD_ROUTING_NEWCALL_SOFT_MS` / `_HARD_MS` | 200 / 1000 | Backend latency thresholds |
| `RETRY_AFTER_BASE_SEC` / `_JITTER_SEC` | 5 / 5 | 503 `Retry-After` value |
| `EMERGENCY_LISTENER_ENABLED` | false | b-leg dual UDP socket (deferred) |
| `EMERGENCY_LISTENER_HOST` / `_PORT` | 127.0.0.1 / 5070 | Emergency listener bind |

## Observability

Two complementary export surfaces, both backed by
[src/observability/MetricsRegistry.ts](../src/observability/MetricsRegistry.ts).
Each subsystem (`UdpTransport`, `OverloadController`, `Dispatcher`)
publishes its plain-object metric snapshot into the registry on layer
init; the StatusServer reads from the registry on every request.

### `GET /status`

JSON. Adds an `overload` block alongside the existing `concurrent`/`total`/
`uptimeMs` fields. Subfields are `null` when the corresponding subsystem is
not running in this process (e.g. cluster main has no `tier3`; workers have
no `udp` / `worker`). Sipp drivers poll at 1Hz and post-process to CSV.

```json
{
  "ok": true,
  "concurrent": 42,
  "total": 1234,
  "uptimeMs": 567890,
  "overload": {
    "udp": {
      "queue_depth": 12,
      "queue_max": 100,
      "drops_total": { "tier1_brake": 0, "tail_drop": 0 },
      "tier1_503_sent_total": 0
    },
    "worker": {
      "queue_depth": { "emergency": 0, "inDialog": 5, "normalNewCall": 2 },
      "queue_drops_total": { "emergency": 0, "inDialog": 0, "normalNewCall": 0 },
      "dispatcher_503_sent_total": 0,
      "kill_total": 0
    },
    "tier3": {
      "admit_total": 12345,
      "reject_total": { "bucket_empty": 0, "shedder": 0 },
      "shed_probability": 0.0,
      "token_bucket_level": 987,
      "loop_lag_ms_p95": 8.4,
      "routing_api_p95_ms": { "new_call": 142, "in_dialog": 23 }
    }
  }
}
```

### `GET /metrics`

Prometheus text-format. Same data as `/status.overload`, with stable metric
names:

```
b2bua_udp_queue_depth
b2bua_udp_queue_max
b2bua_udp_drops_total{reason="tier1_brake"}
b2bua_udp_drops_total{reason="tail_drop"}
b2bua_tier1_503_sent_total
b2bua_worker_queue_depth{class="emergency|inDialog|normalNewCall"}
b2bua_worker_queue_drops_total{class="..."}
b2bua_dispatcher_503_sent_total
b2bua_worker_kill_total
b2bua_tier3_admit_total
b2bua_tier3_reject_total{reason="bucket_empty|shedder"}
b2bua_tier3_shed_probability
b2bua_tier3_token_bucket_level
b2bua_loop_lag_ms_p95
b2bua_routing_api_p95_ms{stage="new_call|in_dialog"}
```

All counters are monotonic; gauges reflect instantaneous values.

## Verification

Verification is sipp-driven as a follow-up task. The existing `npm test`
suite (unit + e2e) is the regression gate. The byte-scan classifier and
stateless 503 builder are too combinatorial for meaningful unit tests, and
the controller's behaviour under load is only meaningful end-to-end via
sipp. Planned scenarios:

| Scenario | Setup | Pass criteria |
|---|---|---|
| `tier1-brake.sipp` | 2000 cps INVITE flood, 30s | RSS bounded; `udp.drops_total.tier1_brake` increments; `tier1_503_sent_total` increments |
| `protect-indialog.sipp` | 100 established calls + parallel 1500 cps new-INVITE flood | Zero retransmissions on established calls; new INVITEs receive 503s |
| `emergency-priority.sipp` | Saturate `normalNewCall` + interleave Resource-Priority emergency INVITEs | 100% emergency admitted; normals 503'd by dispatcher |
| `escalation-ladder.sipp` | Inject artificial slow handler so `inDialog` fills | Dispatcher transitions to "503 all new"; `worker.kill_total` increments after 60s |
| `token-bucket-recovery.sipp` | Drain bucket > 500 cps; cut load; observe recovery | 503s carry `Retry-After`; `tier3.token_bucket_level` recovers; admission resumes |
| `dual-listener.sipp` *(optional)* | Emergency b-leg traffic on second port; flood main port | Emergency in-dialog packets unaffected by main-port flood |
