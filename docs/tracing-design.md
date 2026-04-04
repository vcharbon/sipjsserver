# Tracing Design

Per-call OpenTelemetry tracing for the SIP B2BUA, exported to Tempo and queried via a Grafana plugin.

## Trace structure

One trace per call. Every SIP message and internal decision is a span or span event within that trace.

```
[root: call.lifecycle]  ← searchable: both Call-IDs, From URI, Request-URI
  ├─ [sip.recv.INVITE]  ← inbound trigger, raw payload
  │    ├─ event: route_decision {action, destination}
  │    ├─ [sip.send.100]  ← outbound, raw payload
  │    └─ [sip.send.INVITE]  ← outbound to b-leg
  ├─ [sip.recv.180]
  │    └─ [sip.send.180]
  ├─ [sip.recv.200]
  │    ├─ [sip.send.ACK]
  │    └─ [sip.send.200]
  ├─ [sip.recv.BYE]
  │    └─ [sip.send.BYE]
  ├─ [sip.recv.200]  (BYE response)
  └─ [timer.no_answer]  ← internal trigger
       ├─ [sip.send.CANCEL]
       └─ [sip.send.408]
```

**Hierarchy:**
- **Root span** (`call.lifecycle`): created at initial INVITE, carries all searchable call-level attributes.
- **Processing spans** (`sip.recv.*`, `timer.*`): one per handler invocation. Represents a single inbound trigger + the decision logic.
- **Send spans** (`sip.send.*`): zero-duration children of the processing span that triggered them. One per outbound SIP message.
- **Span events**: attached to processing spans for internal decisions (e.g., `route_decision`, `overload_shed`).

## Span naming conventions

| Pattern | When used | Examples |
|---------|-----------|----------|
| `sip.recv.{METHOD}` | Inbound SIP request | `sip.recv.INVITE`, `sip.recv.BYE`, `sip.recv.ACK` |
| `sip.recv.{STATUS}` | Inbound SIP response | `sip.recv.180`, `sip.recv.200` |
| `sip.send.{METHOD}` | Outbound SIP request | `sip.send.INVITE`, `sip.send.CANCEL` |
| `sip.send.{STATUS}` | Outbound SIP response | `sip.send.100`, `sip.send.200`, `sip.send.408` |
| `timer.{TYPE}` | Timer fire | `timer.no_answer`, `timer.max_duration` |
| `sip.cancelled` | CANCEL event | Transaction-layer CANCEL handling |
| `sip.timeout` | Transaction timeout | Timer B / Timer F expiry |
| `call.lifecycle` | Root span | One per call |
| `call.started` | Tombstone | Non-sampled call creation marker |
| `call.ended` | Tombstone | Non-sampled call teardown marker |
| `sip.unroutable` | Error span | Messages that cannot be routed to a call |

## Attribute reference

All SIP-domain attributes use the `sip.*` namespace. Standard OTel resource/network attributes follow OTel conventions.

### Root span attributes (searchable in Tempo via TraceQL)

| Attribute | Type | Description |
|-----------|------|-------------|
| `sip.call_ref` | string | Internal call reference (`callId\|fromTag`) |
| `sip.call_id.a_leg` | string | A-leg (external caller) SIP Call-ID |
| `sip.call_id.b_leg` | string | B-leg SIP Call-ID (set after b-leg creation) |
| `sip.from_uri` | string | From header URI |
| `sip.request_uri` | string | INVITE Request-URI |
| `sip.method` | string | SIP method (`INVITE` on root) |
| `sip.direction` | string | `inbound` or `outbound` |
| `net.peer.addr` | string | Remote `address:port` |

### Processing/send span attributes

| Attribute | Type | Description |
|-----------|------|-------------|
| `sip.call_ref` | string | Call reference |
| `sip.method` | string | SIP method (on request spans) |
| `sip.status_code` | number | SIP status code (on response spans) |
| `sip.direction` | string | `inbound` / `outbound` |
| `sip.raw_message` | string | Full raw SIP wire format (**sampled calls only**) |
| `net.peer.addr` | string | Remote `address:port` |

### Tombstone span attributes

| Attribute | Type | Description |
|-----------|------|-------------|
| `sip.call_ref` | string | Call reference |
| `sip.tombstone` | boolean | Always `true` on tombstone spans |
| `sip.duration_ms` | number | Call duration (on `call.ended` only) |
| `sip.final_status` | string | Call state at teardown (on `call.ended` only) |

### Span event attributes

| Event name | Attributes | When emitted |
|------------|------------|--------------|
| `route_decision` | `route.action`, `route.destination`, `route.reject_code`, `route.reject_reason` | After routing API response |
| `overload_shed` | `shed.reason`, `shed.fractions.*` | When a call is shed by overload controller |

## Sampling model

### Global sample rate
Configured via `TRACE_SAMPLE_RATE` env var (default `1.0`). Applied as a head-based sampling decision at initial INVITE time.

### Per-call override: `X-Full-Trace-Sample-Rate`
A proprietary SIP header on the initial INVITE. Value is a float `0.0`–`1.0` that **overrides** (replaces) the global rate for this call's sampling coin flip.

- `X-Full-Trace-Sample-Rate: 1.0` — force full sampling regardless of global rate
- `X-Full-Trace-Sample-Rate: 0.0` — force no sampling regardless of global rate
- Header on non-INVITE requests is ignored (sampling is decided once at call creation)

### Non-sampled calls: tombstone model
Non-sampled calls still emit two lightweight spans:
1. **`call.started`** — emitted immediately at INVITE time (zero-duration, closed instantly). Makes the call findable in Tempo right away.
2. **`call.ended`** — emitted at call teardown with `sip.duration_ms` and `sip.final_status`. Both share the same `traceId`.

Tombstone spans carry `sip.tombstone: true` and the searchable call-level attributes, but **no raw SIP payloads**.

## Payload capture

Sampled calls store the full raw SIP wire format (headers + body) as the `sip.raw_message` attribute on every recv and send span.

### Header scrubbing
Sensitive headers are redacted before storage. Configured via `SCRUB_HEADERS` env var (comma-separated, default: `Authorization,Proxy-Authorization`). Matching is case-insensitive. Redacted values are replaced with `[REDACTED]`.

### Attribute size limit
OTel SDK `attributeValueLengthLimit` is set to `32768` (configurable via `OTEL_MAX_ATTRIBUTE_VALUE_LENGTH`). A typical SIP INVITE with SDP is 1–2KB, well within this limit.

## Cluster mode

- All workers share `service.name: "sip-b2bua"` (not per-worker names)
- Worker index is exposed as the `worker.index` OTel resource attribute
- A call is pinned to one worker via Call-ID hash, so all spans for a call come from the same worker
- TraceQL filter: `{ resource.worker.index = 2 }` to scope to a specific worker

## Platform observability (orthogonal)

Overload controller state is tracked via metrics, not traces:

| Metric | Type | Description |
|--------|------|-------------|
| `fractionLoopLag` | gauge (0.0–1.0) | Event loop lag fraction toward shed threshold |
| `fractionActiveCalls` | gauge (0.0–1.0) | Active calls fraction toward limit |
| `fractionInDialogQueue` | gauge (0.0–1.0) | In-dialog queue depth fraction |
| `fractionRoutingLatency` | gauge (0.0–1.0) | Routing API latency fraction |
| `shedProbability` | gauge (0.0–1.0) | Overall shed probability (max of all fractions) |
| `tokenBucketRatio` | gauge (0.0–1.0) | Token bucket fill level / capacity |

When a call is shed, a `overload_shed` span event is added to the call's trace (if sampled), linking the platform decision to the call's timeline.

## Trace context storage

Trace context is stored on the `Call` record (persisted in Redis):
- `traceId: string` — OTel trace ID (32 hex chars)
- `rootSpanId: string` — root span ID (16 hex chars)
- `sampled: boolean` — sampling decision

This allows reconstructing parent context across separate `dispatchMessage` invocations via `Tracer.externalSpan()`.

## TraceQL query examples

```
# Find a call by a-leg Call-ID
{ span.sip.call_id.a_leg = "abc123@10.0.0.1" }

# Find all calls from a specific caller
{ span.sip.from_uri = "sip:alice@example.com" }

# Find all calls to a specific destination
{ span.sip.request_uri = "sip:+15551234567@gateway.example.com" }

# Find all shed calls
{ name = "route_decision" && span.route.action = "reject" }

# Find tombstone-only calls (non-sampled)
{ span.sip.tombstone = true }
```


## Curl requests

147-2327261@127.0.0.1

Traces go to Tempo (not Loki — Loki is for logs). Tempo's default HTTP API port is 3200.

Search by a-leg Call-ID:


curl -G 'http://localhost:3200/api/search' \
  --data-urlencode 'q={span.sip.call_id.a_leg = 50-2366776@127.0.0.1"}' \
  --data-urlencode 'limit=10'
Search by b-leg Call-ID:


curl -G 'http://localhost:3200/api/search' \
  --data-urlencode 'q={span.sip.call_id.b_leg = "1-abc123@10.0.0.1"}' \
  --data-urlencode 'limit=10'
Once you have a traceID from the search result, fetch the full trace:


curl 'http://localhost:3200/api/traces/<traceID>'
Search by From URI or Request-URI:


curl -G 'http://localhost:3200/api/search' \
  --data-urlencode 'q={span.sip.from_uri = "sip:alice@example.com"}'

curl -G 'http://localhost:3200/api/search' \
  --data-urlencode 'q={span.sip.request_uri = "sip:+15551234567@gw.example.com"}'
Note: these queries work because sip.call_id.a_leg, sip.from_uri, and sip.request_uri are set as span attributes on the root call.lifecycle span. Tempo needs to have search enabled in its config (metrics_generator or search block in tempo.yaml).