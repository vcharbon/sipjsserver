# Replace OTel tracing with log-correlation + on-demand wire capture

## Context

Today the B2BUA and the front-proxy ship full OpenTelemetry spans for every SIP message at `TRACE_SAMPLE_RATE=1.0` (worker) and `PROXY_TRACE_SAMPLE_RATE=0.1` (proxy). The pipeline pays CPU+GC on the worker hot path (`OtelSpan` / `BaseContext` allocs + `Effect.withSpan` propagation) AND backend bytes on Victoria Traces (dominated by the `sip.raw_message` attribute carrying the full scrubbed wire content on every recv/send span).

The actual operator workflow is **CDR-first**: incidents are investigated starting from a per-call record that already carries the call identity, then drilling into logs for that call. The tracing features that *are* used during a deep-dive — visual waterfall, raw SIP wire, cross-system stitch — are needed for a tiny fraction of calls, not all of them. The current "always trace everything" posture pays full cost continuously for that rare drill-down need.

Outcome we want: delete the OTel exporter pipeline and span wrappers; correlate logs by `sip.callref`; capture raw SIP wire only when explicitly requested per-call; keep the `traceparent` cross-system join even with sampled=0 so the routing-backend logs can be joined to ours in Grafana.

## Goal

1. Cut worker per-message OtelSpan/BaseContext allocations to zero on the hot path.
2. Cut Victoria Traces ingest to zero (decommissionable backend).
3. Preserve cross-system correlation through `traceparent` propagation only — no spans emitted.
4. Preserve raw-wire deep-dive via opt-in `X-Wire-Debug` header and a low-rate ambient `WIRE_DEBUG_SAMPLE_RATE`.
5. Universal `sip.callref` log annotation on every router/handler log so `{sip.callref="…"}` in Loki yields the full per-call history.

## Out of scope

- Tail-based sampling / OTel-Collector tail sampler — would re-introduce the worker cost we're killing.
- Content-pattern wire activation (`WIRE_DEBUG_FROM_URI_PATTERN`) — declined; only header + sample-rate triggers.
- Runtime `/debug` endpoint to enable wire logging mid-call — YAGNI until an incident demands it.
- Schema migration tooling for in-flight Redis-persisted `Call` records — removed/added fields are `Schema.optional`; older records round-trip with the unused field ignored.

## Design

### 1. Delete the OTel exporter + span machinery

**Files removed:**

- [src/tracing/TracingService.ts](src/tracing/TracingService.ts) — full delete.
- [src/observability/otlp-http-tracing-layer.ts](src/observability/otlp-http-tracing-layer.ts) — full delete.
- [src/observability/tracer-health.ts](src/observability/tracer-health.ts) — full delete (BSP saturation kill-switch).
- [src/observability/bsp-measured.ts](src/observability/bsp-measured.ts) — full delete.
- [src/observability/otel-circuit-breaker.ts](src/observability/otel-circuit-breaker.ts) — full delete.
- [src/observability/otel-diag.ts](src/observability/otel-diag.ts) — full delete.
- [src/sip-front-proxy/observability/Tracing.ts](src/sip-front-proxy/observability/Tracing.ts) — full delete (`ProxyTracing` + `PROXY_TRACE_SAMPLE_RATE`).

**Call-sites stripped:**

- [src/sip/SipRouter.ts](src/sip/SipRouter.ts):
  - Drop `import TracingService`, the `const tracing = yield* TracingService` binding, and every `tracing.withRootSpan` / `withProcessingSpan` / `emitSendSpan` / `emitTombstone` / `emitSpanEvents` / `scrubMessage` call.
  - The `withCall` handler runs without a span wrapper — replace `tracing.withProcessingSpan({ ..., effect: inner })` with `inner` directly.
  - Drop the `DETACHED_FORK_PARENT` (line 241), the timer-fire `Effect.withSpan("timer.fire", { parent: Tracer.externalSpan(...) })` (line 460), and the parent-restoration block in `timerHandler` (line 458).
  - Drop the `X-Full-Trace-Sample-Rate` header read + `decideSampling` (line 1111-1115).
- [src/sip/TransactionLayer.ts](src/sip/TransactionLayer.ts):
  - Drop `DETACHED_PARENT` (line 297) and the `Effect.withSpan("sip.parse_error", …)` wrap (line 785). Parse errors become `Effect.logError` with the call-correlation annotation already in scope.
- [src/call/TimerService.ts](src/call/TimerService.ts):
  - Drop `DETACHED_PARENT` (line 66) and its consumers.
- [src/main.ts](src/main.ts):
  - Drop `NodeSdk`, `BatchSpanProcessor`, `OTLPTraceExporter` imports (lines 17-19) and the `TracingLayer` construction.
  - Drop the `runTracerHealthSupervisor` fork.
- [src/b2bua/embedded.ts](src/b2bua/embedded.ts):
  - Drop the `tracing?: Layer.Layer<TracingService, …>` option, the `TracingL` plumbing, and the `provideMerge(TracingL)`.
- [src/b2bua/index.ts](src/b2bua/index.ts):
  - Drop the `TracingService` re-export.

**Deps:** in `package.json`, remove `@effect/opentelemetry`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/api`, `@opentelemetry/resources`, `@opentelemetry/sdk-logs`, `@opentelemetry/sdk-metrics` **only after** confirming nothing else (Prometheus exporter, log exporter) needs them — a final grep gate before the deletion commit.

### 2. Universal `sip.callref` log annotation

Add a thin helper analogous to [src/sip-front-proxy/observability/Logger.ts](src/sip-front-proxy/observability/Logger.ts)'s `withCallCorrelation` for the worker side. Two annotation sites:

- **`SipRouter.withCall`** — once `callRef` is resolved (line ~835 region), wrap the entire handler body with `Effect.annotateLogs({ "sip.callref": callRef, "sip.callid": leg.callId, "sip.method": <method or status>, "sip.direction": direction, "sip.traceid": call.traceId })`. Every `Effect.log*` inside the handler picks up the annotations through the FiberRef. This subsumes today's ad-hoc `Call ${callRef}` string interpolation in log messages.
- **`SipRouter.handleInitialInvite`** — annotate the initial-INVITE handler body the same way.

Reuse `Effect.annotateLogs` (Effect-native, FiberRef-based). The `ProxyLogger.withCallCorrelation` pattern is the precedent — keep proxy unchanged structurally, just add `sip.callref` and `sip.traceid` to its annotation set so worker and proxy share keys.

The fork detachment notes at [src/sip/TransactionLayer.ts:766](src/sip/TransactionLayer.ts#L766) and [src/sip/SipRouter.ts:241](src/sip/SipRouter.ts#L241) become moot for spans but still apply to log annotations: forks that outlive the request (REFER async HTTP) should *not* inherit the request's annotations. Use `Effect.unannotateLogs` or fork with a fresh FiberRef snapshot in those paths.

### 3. `Call.wireDebug` flag + activation triggers

**Schema:** in [src/call/CallModel.ts](src/call/CallModel.ts), add `wireDebug: Schema.optional(Schema.Boolean)`. Keep `traceId` (used by traceparent below). Drop `rootSpanId` and `sampled` from the schema — they're now unused. Both fields are already `Schema.optional`, so unmigrated Redis records ignore the leftovers gracefully.

**AppConfig:** in [src/config/AppConfig.ts](src/config/AppConfig.ts):
- Add `wireDebugSampleRate: Schema.Number` (env `WIRE_DEBUG_SAMPLE_RATE`, default `0`).
- Remove `traceSampleRate`, `scrubHeaders`, `traceTombstoneEnabled`, `otelMaxAttributeValueLength`, and any other tracing-only knobs that have no remaining reader after the deletion.

**Trigger evaluation** (in `handleInitialInvite`):
```
const wireHeader = getHeader(req.headers, "X-Wire-Debug")
const headerOptIn = wireHeader === "1" || wireHeader?.toLowerCase() === "true"
const sampleHit = Math.random() < config.wireDebugSampleRate
const wireDebug = headerOptIn || sampleHit
```
Stamped on the `Call` record at creation. `wireDebug` is decided once at INVITE; subsequent messages on the same call inherit it.

### 4. Raw-wire log emission gated on `wireDebug`

Today [src/sip/SipRouter.ts:565](src/sip/SipRouter.ts#L565) already does `Effect.logDebug(serialize(msg).toString("utf-8"))` for outbound messages. Plan:

- **Outbound** (inside `applyOutbound`): when `result.call.wireDebug === true`, emit `Effect.logInfo` (not Debug) with the serialized message and annotation `wire.direction = "out"`. When `false`, drop the existing logDebug entirely (saves the `serialize().toString()` cost in production where debug is off).
- **Inbound** (inside `withCall`, the same place that used to set `sip.raw_message` at [SipRouter.ts:1010](src/sip/SipRouter.ts#L1010)): when `call.wireDebug === true`, emit `Effect.logInfo(serialize(event.message).toString("utf-8"))` with annotation `wire.direction = "in"`. The existing `sip.callref` log annotation provides the join key.

Header scrubbing (`Authorization` / `Proxy-Authorization`) — port the `scrubMessage` regex helper to a free function `scrubSipMessage(raw, headerNames)` and call it on the wire-log path. No service plumbing needed. Default header set baked in.

### 5. Cross-system: `traceparent` propagation without spans

**TraceContext generation:** in `handleInitialInvite`, after deciding `wireDebug`:
```
const traceId = randomBytes(16).toString("hex")
const rootSpanId = randomBytes(8).toString("hex")  // local var, not persisted
const flags = "00"                                  // sampled=0; we don't emit spans
```
Persist `call.traceId` (already in schema). The `rootSpanId` does not need persistence — each outgoing HTTP request can generate a fresh `spanId` since the join key downstream is `traceId`.

**HTTP propagation:** in [src/decision/adapters/http-reference/HttpReferenceAdapter.ts](src/decision/adapters/http-reference/HttpReferenceAdapter.ts), thread the `Call.traceId` through the `CallDecisionEngine` call sites and stamp `traceparent: 00-{traceId}-{freshSpanId}-00` on every outgoing `HttpClientRequest`. The routing backend logs the traceId; Loki joins by `sip.traceid`.

**No `Tracer.externalSpan`** anywhere — we don't reify spans, we just propagate the W3C header.

### 6. Tombstones, error spans, `spanEvents` — all replaced by logs

- `call.started` / `call.ended` tombstones — deleted. CDR already records call creation and teardown with timestamps + final status.
- `sip.unroutable` / `sip.parse_error` error spans — replaced by their existing `Effect.logWarning` / `Effect.logError` siblings, now annotated with `sip.callref` / `sip.traceid` automatically.
- `HandlerResult.spanEvents` array (carries `route_decision`, `overload_shed`, …) — replace with `HandlerResult.logEvents` of shape `{ name: string; level: "info" | "warning"; fields: Record<string, unknown> }`. `SipRouter.processResult` iterates and emits `Effect.logInfo(name).pipe(Effect.annotateLogs(fields))`. Internal decisions become first-class structured log lines.

The two existing event producers are: routing decisions in [src/decision/apply/applyRoute.ts](src/decision/apply/applyRoute.ts) and overload shedding (search for `overload_shed` emitters). Both are small; refactor in the same PR as the deletion.

### 7. Test churn

- **Delete:** [tests/observability/tracing-service-killswitch.test.ts](tests/observability/tracing-service-killswitch.test.ts).
- **Update:** [tests/support/networkLeaves.ts](tests/support/networkLeaves.ts) — drop `NoOpTracingLayer`; remove from the merged fake stack layer.
- **Update:** [tests/support/liveStack.ts](tests/support/liveStack.ts) — drop the `TracingLayer` block.
- **Update:** [tests/consumer-api/sip-front-proxy.test.ts](tests/consumer-api/sip-front-proxy.test.ts) — drop the `expect(ProxyTracing).toBeDefined()` assertion.
- **Update:** [tests/sip-front-proxy/observability/logger.test.ts](tests/sip-front-proxy/observability/logger.test.ts) (already modified locally) — make sure its expectations align with the new annotation key set (`sip.traceid` added).
- **Update:** [tests/bench/call-codec/fixture.ts](tests/bench/call-codec/fixture.ts) and [tests/b2bua/helpers/reach.ts](tests/b2bua/helpers/reach.ts) — drop `sampled` / `rootSpanId` from `Call` fixtures; add `wireDebug` only where the test exercises the new path.
- **Add:** one `it.effect` test covering the wireDebug trigger logic (header opt-in path + sample-rate path) and one covering raw-message log emission gated on the flag.
- **Add:** one test that verifies `Effect.annotateLogs` carries `sip.callref` through the handler effect (smoke).

### 8. Operator-side (out of code-change scope, but flagged)

- Update [CLAUDE.md](CLAUDE.md)'s "Progressive reading guide" to point `docs/tracing-design.md` at a new `docs/log-correlation.md` describing the callref/traceid join.
- Update Grafana dashboards: replace TraceQL panels (`{ span.sip.call_id.a_leg = … }`) with Loki LogQL panels (`{sip_callref="…"} | json`). Document the new query patterns in `docs/log-correlation.md`.
- Routing-backend team: action to log `traceparent` → `traceId` on their side so the cross-system join works.

## Critical files

- [src/sip/SipRouter.ts](src/sip/SipRouter.ts) — main span-callsite strip + log annotation introduction.
- [src/tracing/TracingService.ts](src/tracing/TracingService.ts) — delete.
- [src/sip-front-proxy/observability/Tracing.ts](src/sip-front-proxy/observability/Tracing.ts) — delete.
- [src/observability/{otlp-http-tracing-layer,tracer-health,bsp-measured,otel-circuit-breaker,otel-diag}.ts](src/observability/) — delete.
- [src/call/CallModel.ts](src/call/CallModel.ts) — schema fields swap.
- [src/config/AppConfig.ts](src/config/AppConfig.ts) — knob swap.
- [src/main.ts](src/main.ts) and [src/b2bua/embedded.ts](src/b2bua/embedded.ts) — layer wiring removal.
- [src/decision/adapters/http-reference/HttpReferenceAdapter.ts](src/decision/adapters/http-reference/HttpReferenceAdapter.ts) — traceparent header stamp.
- [src/sip/TransactionLayer.ts](src/sip/TransactionLayer.ts) and [src/call/TimerService.ts](src/call/TimerService.ts) — strip detached-parent vestiges.
- [package.json](package.json) — OTel deps removal (last, gated on final grep).

## Reuse

- `Effect.annotateLogs` — Effect-native log annotation, already used by [src/sip-front-proxy/observability/Logger.ts:99-122](src/sip-front-proxy/observability/Logger.ts#L99-L122).
- `randomBytes(16).toString("hex")` traceId / `randomBytes(8).toString("hex")` spanId — pattern lifted directly from [src/tracing/TracingService.ts:31-34](src/tracing/TracingService.ts#L31-L34).
- `serialize(msg).toString("utf-8")` — same path the existing logDebug uses at [src/sip/SipRouter.ts:565](src/sip/SipRouter.ts#L565).
- The header-scrub regex from [TracingService.ts:138-144](src/tracing/TracingService.ts#L138-L144) — port to a free function.

## Verification

1. `npm run typecheck` — both `tsc` and the Effect plugin must be clean (per CLAUDE.md: an Effect-plugin warning is a real warning).
2. `npm run test:fake` — fake stack passes after the layer rewires.
3. `npm run test:ci` — medium-tier live runs through real UDP without any OTel layer present.
4. Manual: run `npm run dev` with `WIRE_DEBUG_SAMPLE_RATE=1.0` and `LOG_LEVEL=info`; send an INVITE via sipp; verify the worker log stream carries `wire.direction=in` / `wire.direction=out` lines with the serialized SIP message. Repeat with `WIRE_DEBUG_SAMPLE_RATE=0` and `X-Wire-Debug: 1` on the INVITE — same result.
5. Manual with `WIRE_DEBUG_SAMPLE_RATE=0` and no header — confirm zero wire-content lines, just decision-level logs annotated with `sip.callref`.
6. k8s endurance run (`tests/k8s/endurance/`) — confirm sustained worker ELU drops vs the pre-change baseline and that grafana dashboards still surface every call-event source (limiter decisions, route decisions, overload shed) via the new structured log entries.
7. Cross-system smoke: hit the routing backend with a single call, confirm the backend logs the incoming `traceparent` and that Grafana joins `{sip_traceid="…"}` across the two log streams.
8. Heap-snapshot baseline: confirm `OtelSpan` / `BaseContext` / `BatchSpanProcessor` constructors are absent from a post-change snapshot of a saturated worker (compare against the May-2026 heap-snapshot artifact described in the OOM-investigation memory).
