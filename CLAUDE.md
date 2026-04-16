# CLAUDE.md

This project provides a SIP B2BUA (Back-to-Back User Agent) that listens on incoming UDP SIP packets, calls a backend HTTP server to decide how to process the incoming call, then forwards accordingly.
ALWAYS reply and write in english even when user speaks french!!!

## Language & Stack

- TypeScript with the [Effect](https://effect.website/) library (effect-smol / Effect v4 style)
- All code must use Effect patterns: services, layers, `Effect.gen`, `Schema`, typed errors
- mock and test implementation of services are implemented in the service as test layers 
- When adding dependencies, verify they are installed in the correct workspace package

**When writing designing complex architecture or modifying TypeScript code in this project, always activate the `effect` skill first.**

**Before modifying any SIP message-building, relay, or header logic, read [docs/b2bua-sip-headers.md](docs/b2bua-sip-headers.md) first.** It documents exactly how each header (Via, Contact, From, To, Call-ID) is rewritten at each hop, the placeholder stamping pipeline, tag ownership per leg, and known architectural gaps.

## Commands

```bash
npm run typecheck   # Type-check all packages (run after every change)
npm run build       # Build the project
npm run test        # Run tests
npm run dev         # Start the server in development mode
```

**After every code change, run `npm run typecheck` and verify there are zero errors and zero warnings before considering the task complete.** Warnings and Effect TS message must be fixed, not ignored. Only suppress a warning with a lint-disable comment as a last resort, always with an explanation.

Once a work slice is done, and test past, commit with nice message on master branch.

## Architecture

```
src/
  main.ts                      Entry point — composes all layers, runs Effect
  sip/
    types.ts                   SipRequest, SipResponse, SipMessage, header types
    Parser.ts                  SipParser service — wraps pluggable parser adapters
    Serializer.ts              SipMessage → Buffer serialization (single wire-format point)
    MessageFactory.ts          Structured SIP message builders (returns SipRequest/SipResponse,
                               Via/Contact left as __PLACEHOLDER__ for SipRouter to stamp)
    UdpTransport.ts            UdpTransport service — Layer.scoped dgram socket + Stream
    TransactionLayer.ts        RFC 3261 transaction state machine — deduplication, retransmit,
                               CANCEL/ACK-for-error handling, emits TransactionEvent stream
    SipRouter.ts               withCall wrapper, Via/Contact param encoding/decoding,
                               call resolution, effect execution pipeline
    parsers/
      interface.ts             SipParserImpl contract — pure sync parse fn, no Effect
      jssip-adapter.ts         JsSIP Parser.parseMessage() adapter
      sip-parser-adapter.ts    sip-parser (Formup) npm package adapter
      custom/
        index.ts               Custom RFC 3261 parser — zero regex, state-machine based
        scanner.ts             Byte-level cursor scanner over Buffer
        start-line.ts          Request-Line / Status-Line parser
        headers.ts             Header extraction with folding + compact form expansion
        compact-forms.ts       RFC 3261 §7.3.3 compact header form map
        structured-headers.ts  From/To/Via/Contact/CSeq structured field extraction
  b2bua/
    B2buaCore.ts               Single source of truth: handler registry (rules + initial INVITE)
                               and composed B2buaCoreLayer used by main, worker, and tests
    InitialInviteHandler.ts    New call creation, routing API, limiter, timer setup
    OverloadController.ts      Adaptive overload protection — token bucket + multi-signal shedder
    helpers.ts                 Shared cleanup effects, b-leg creation for failover
    rules/
      framework/               Rule engine infrastructure
        ActionExecutor.ts      Translates RuleAction[] → HandlerResult (CSeq, tags, SIP wire)
        Matcher.ts             Declarative Match → specificity-ranked candidate picker
        RuleExecutor.ts        Walks Matcher.pickRanked, runs handle(), composes base rules
        RuleDefinition.ts      Rule system types (Match discriminated union, RuleContext, RuleAction)
        RuleRegistry.ts        Immutable registry of rule definitions, built at startup
        PolicyModule.ts        Type-safe module-level rule grouping with guard
        InvariantEnforcer.ts   Post-processing safety net (limiter/timer/CDR cleanup)
        FrameworkLimiterRefresh.ts  Framework-level limiter_refresh timer handler
      defaults/                Built-in B2BUA rules (always-active):
        CornerCaseRules.ts       cancel-200-crossing, retransmit-200, reinvite-glare, relay-reinvite-response
        DialogRules.ts           relay-provisional, confirm-dialog, absorb-bye-200, absorb-options-200, relay-non-invite-200
        FailureRules.ts          route-failure, no-answer-failover, absorb-stale-failure
        LifecycleRules.ts        handle-timeout, handle-cancel, handle-481, resolve-cancel-response
        RelayRules.ts            relay-options, relay-info, relay-bye, relay-ack, relay-reinvite, relay-prack
        TimerRules.ts            max-duration, keepalive, keepalive-timeout
        TerminatingRules.ts      resolve-bye-response, resolve-cross-bye, terminating-safety-timeout, terminating-drop-{request,response,timer,timeout,cancelled}
      custom/                  Policy-module rules (HTTP-piloted):
        relayFirst18xTo180.ts    suppress-18x / force-tag-consistency / absorb-prack-200
  call/
    CallModel.ts               Call/Leg/Dialog Schema types + lens helpers
    CallState.ts               Redis-backed call state with per-call semaphore
    CallStateCache.ts          Swappable persistence interface for CallState (Redis / in-memory)
    CallLimiter.ts             Windowed concurrent call counters via Redis Lua
    TimerService.ts            Runtime timer fibers from serializable TimerEntry intents
  cdr/
    CdrWriter.ts               JSON-line CDR file writer
  cluster/
    Dispatcher.ts              Main process cluster coordinator — UDP socket, worker routing,
                               priority queues, worker lifecycle management
    HashUtils.ts               Call-ID extraction from raw buffers + FNV-1a worker hashing
    IpcProtocol.ts             IPC message types between dispatcher and workers
    IpcTransport.ts            UdpTransport-compatible layer backed by IPC (for workers)
    WorkerConfig.ts            Per-worker configuration (workerIndex, totalWorkers)
    WorkerEntry.ts             Child process entry point for cluster mode
  config/
    AppConfig.ts               Env-based configuration
  http/
    CallControlClient.ts       HTTP client for external call control API
    CallControlSchemas.ts      Effect Schema for call control API request/response
    MockCallControlServer.ts   Mock call control endpoints (test infrastructure, X-Api-Call driven)
    StatusServer.ts            HTTP status server on :3002
  observability/
    MetricsRegistry.ts         Central metric snapshot registry — subsystems write, StatusServer reads
  redis/
    RedisClient.ts             Redis client service
  tracing/
    TracingService.ts          Per-call OpenTelemetry tracing (root/child/error spans)
```

### Layered processing pipeline

```
UDP packets (UdpTransport)
  → TransactionLayer     — RFC 3261 transactions, dedup, retransmit, CANCEL, ACK-for-error
    → SipRouter/withCall  — resolve call, checkout, tracing, stamp Via/Contact, execute effects
      → Handlers          — pure: (ResolvedContext) → HandlerResult { call, outbound[], effects[] }
    ← withCall serializes outbound, applies effects in fixed order
  ← TransactionLayer retransmits outbound as needed
```

### Key design decisions

- **Call resolution via SIP header params**: `callRef` and `leg` are encoded in Contact URI params (`sip:b2bua@host;callRef=abc;leg=a`) and Via custom params (`;cr=abc;lg=b-1`). Inbound messages are resolved by parsing these params — no ambiguous tag matching.
- **TransactionLayer**: RFC 3261 compliant in-memory transaction state machine. Owns retransmission (Timer A/B/E/F), duplicate detection, CANCEL handling (200+487), ACK-for-non-2xx absorption. Application layer only sees deduplicated events.
- **withCall wrapper**: Single entry point for all call processing. Resolves call, does checkout/release, wraps in tracing span, executes handler, processes result. Initial INVITEs get a skeleton call + root span; in-dialog messages get child spans.
- **Pure handlers**: Handlers receive `ResolvedContext` and return `HandlerResult` (updated Call + outbound envelopes + side effects). No direct service access — all deps passed through context.
- **Effect execution order**: withCall enforces: 1) update state, 2) stamp+send outbound, 3) schedule/cancel timers, 4) decrement limiters, 5) write CDR, 6) flush Redis, 7) remove call.
- **B-leg Call-ID format**: `{legNumber}-{originalCallId}` for troubleshooting (not used for resolution).
- **JsSIP usage**: `Parser.parseMessage(data, null)` for robust SIP parsing. Output adapted to `SipMessage` types.
- **Call model**: Three-level hierarchy (Call → Leg → Dialog) with lens helpers for immutable updates.
- **UDP transport**: `Layer.scoped` ensures socket cleanup. Incoming packets → unbounded Queue → Stream.
- **Rule-based in-dialog processing**: All in-dialog call processing is handled by rules under `src/b2bua/rules/defaults/`. The rule chain is the sole in-dialog handler — there is no fallback dispatcher. See [docs/AdvancedCallModel.md](docs/AdvancedCallModel.md) for the full rule framework design, action types, priority bands, and framework guarantees.
- **Declarative match + specificity ranking**: Every rule carries a `match: Match` descriptor (discriminated on `kind: "request" | "response" | "timer" | "timeout" | "cancelled"`). The Matcher ranks candidates by strict specificity (singleton > array, exact `status` > `statusClass`, `filter` adds one point) and runs them in order until one `handle()` returns non-undefined. `defaultPriority` is a tiebreaker only. Policy modules gate their rules via `match.filter` composition with the module guard; `overrides:` replaces a base rule, `composesWith:` layers additively. There is no imperative `matches()` — adding a rule means declaring its `match`.
- **B2buaCore — single wiring point**: `src/b2bua/B2buaCore.ts` exports `handlers` (the HandlerRegistry) and `B2buaCoreLayer` (the composed layer). All three entry points (`main.ts`, `WorkerEntry.ts`, `simulated-backend.ts`) import from B2buaCore. Adding a new rule or policy module requires changing **only B2buaCore** — never the entry points.
- **Test infrastructure uses the same core**: `tests/e2e/framework/simulated-backend.ts` provides B2buaCoreLayer with mock transport, mock call control, noop tracing, and noop CDR — but the rule registry, handler wiring, and service composition are identical to production. Changes to production wiring automatically apply to tests.
- **Rule coverage + kill testing**: `npm test` writes a rule-coverage section into `test-results/fake-clock/index.html` flagging never-fired rules. `npm run test:rule-kill` runs the opt-in mutation pass (disables each rule in turn, re-runs the simulated e2e suite, reports surviving mutants). See [docs/rule-coverage-and-killing.md](docs/rule-coverage-and-killing.md) before adding a new rule.
- **MutableHashMap for in-memory state**: High-throughput maps (transactions, calls, SIP index, semaphores, timer fibers) use `MutableHashMap` from Effect instead of `Ref<Map>`. This avoids O(N) full-copy on every update. See **MutableHashMap usage rules** below.

### MutableHashMap usage rules

All shared mutable maps in services (`TransactionLayer`, `CallState`, `TimerService`) use `MutableHashMap.empty<K, V>()` — **not** `Ref<Map<K, V>>`. Follow these rules strictly:

1. **Always wrap mutations in `Effect.sync`**. Every `MutableHashMap.set` / `MutableHashMap.remove` call must be inside `yield* Effect.sync(() => ...)` in a generator, or returned as `Effect.sync(() => ...)` from a helper. Mutating shared state is a side effect — Effect must control when it executes.

   ```typescript
   // CORRECT — mutation wrapped in Effect.sync
   yield* Effect.sync(() => MutableHashMap.set(myMap, key, value))
   yield* Effect.sync(() => MutableHashMap.remove(myMap, key))

   // CORRECT — batch multiple mutations in one Effect.sync
   yield* Effect.sync(() => {
     MutableHashMap.remove(myMap, key1)
     MutableHashMap.remove(myMap, key2)
   })

   // CORRECT — helper that returns an Effect
   const indexCall = (call: Call): Effect.Effect<void> =>
     Effect.sync(() => {
       MutableHashMap.set(sipIndex, key1, call.callRef)
       MutableHashMap.set(sipIndex, key2, call.callRef)
     })

   // WRONG — bare mutation outside Effect.sync
   MutableHashMap.set(myMap, key, value)
   ```

2. **Reads via `MutableHashMap.get` return `Option`**. Use `Option.getOrUndefined` to convert:

   ```typescript
   const value = Option.getOrUndefined(MutableHashMap.get(myMap, key))
   ```

3. **Iteration** uses `for...of` directly (MutableHashMap is `Iterable<[K, V]>`):

   ```typescript
   for (const [key, value] of myMap) { ... }
   ```

4. **Size** via `MutableHashMap.size(myMap)` — O(1).

5. **Never use `Ref<Map>` for hot-path maps**. `Ref.update` copies the entire Map on every write. At high CPS this causes GC thrashing and CPU climbing over time. `Ref` is fine for simple scalar counters.

### Tracing rules for new code

Full design: [docs/tracing-design.md](docs/tracing-design.md). Follow these rules when adding or modifying handlers and SIP processing:

1. **Every handler invocation runs inside a processing span.** `SipRouter.withCall` wraps handlers in `withProcessingSpan` automatically. Custom effects run outside `withCall` must create their own span.

2. **Outbound messages must emit a send span.** `processResult` calls `tracing.emitSendSpan()` for every message in `HandlerResult.outbound`. Only needed manually if sending outside the normal flow.

3. **Internal decisions go in `spanEvents`.** Add entries to `HandlerResult.spanEvents` for routing decisions, failover triggers, timer actions — anything that explains *why* a message was sent or not sent.

4. **Use `sip.*` attribute namespace.** Key attributes: `sip.method`, `sip.status_code`, `sip.direction`, `sip.raw_message`, `sip.call_id.a_leg`, `sip.call_id.b_leg`. See [docs/tracing-design.md](docs/tracing-design.md) for the full reference.

5. **Never access TracingService directly from handlers.** Handlers are pure — use `spanEvents` on `HandlerResult`. `SipRouter` owns all span lifecycle.

6. **Gate large attributes on `call.sampled`.** Attributes like `sip.raw_message` must only be set when `call.sampled === true` to avoid payload overhead on non-sampled calls.

7. **Tombstones are automatic.** Non-sampled calls get tombstone spans via `SipRouter` — no handler action needed.

8. **OTel layer MUST use `Layer.provideMerge`, not `Layer.provide`.** `NodeSdk.layer` sets the `Tracer.Tracer` FiberRef (the OTel-backed tracer). If provided via `Layer.provide(OtelLayer)`, the FiberRef only reaches layer construction — runtime effects silently fall back to Effect's built-in `NativeSpan`, which is never exported to Tempo. Use `Layer.provideMerge(OtelLayer)` so the FiberRef propagates to the runtime fiber. **Symptom:** spans appear in Effect logs but are missing from Tempo; `ConsoleSpanExporter` shows other spans but not yours; diagnostic shows `NativeSpan` instead of `OtelSpan`. This applies to both `main.ts` (standalone) and `WorkerEntry.ts` (cluster).

### TestClock vs. real-time samplers/timers

E2E tests use `@effect/vitest`'s `it.effect`, which runs under `TestClock` — `Effect.sleep` and any fiber that yields to the clock will **not** advance unless the test explicitly calls `TestClock.adjust`. This is a recurring landmine.

**Rule:** Any background sampler, periodic gauge, or watchdog that should keep ticking *in real wall-clock time* even under tests must use raw `setInterval` (or `setTimeout`) — not `Effect.sleep`. Pattern:

```typescript
const interval = setInterval(() => { /* sample */ }, 100)
interval.unref()  // don't keep the Node event loop alive just for this
yield* Effect.addFinalizer(() => Effect.sync(() => clearInterval(interval)))
```

Examples in the codebase:
- `OverloadController` loop-lag EWMA sampler ([src/b2bua/OverloadController.ts](src/b2bua/OverloadController.ts))
- `Dispatcher` worker-kill escalation timer ([src/cluster/Dispatcher.ts](src/cluster/Dispatcher.ts))

**Symptom of getting this wrong:** e2e tests hang at the 30s timeout because the sampler fiber is suspended waiting on a virtual clock that nothing advances. If only `it.effect` cases hang while `it.live` cases pass, suspect a missed `setInterval`.

### SIP B2BUA message flow

| Message | Layer | Action |
|---------|-------|--------|
| Initial INVITE (a→) | SipRouter | Create skeleton call, root span; handler calls routing API, creates b-leg |
| CANCEL (a→) | TransactionLayer | Send 200+487, emit `cancelled` event; handler cancels all b-legs |
| Retransmitted INVITE | TransactionLayer | Absorb, retransmit 100 Trying |
| ACK for non-2xx | TransactionLayer | Absorb (completes INVITE server transaction) |
| 18x (←b) | Handler | Track early dialog, relay to a-leg |
| 200 OK INVITE (←b) | Handler | Confirm dialog, ACK b-leg, relay 200 to a-leg, cancel other b-legs |
| ACK for 2xx (a→) | Handler | Relayed end-to-end to b-leg (may carry SDP) |
| BYE (either direction) | Handler | Relay to other side, terminate call, cleanup |
| PRACK (a→) | Handler | Relay to b-leg with CSeq bump, match dialog by To-tag |
| 200 OK non-INVITE (←b) | Handler | Relay to a-leg (PRACK, UPDATE, INFO, etc.) |
| Transaction timeout | TransactionLayer | Emit `timeout` event; handler terminates call |

### Ports
- UDP SIP: `:5060` (listen)
- HTTP status: `:3002`
- Call control API: `CALL_CONTROL_URL` env var (default `http://localhost:3002`)

## SIP Domain Knowledge

- when designing and writing code on SIP manipulation and on planning phase systematicall list in the plan all the rules from relevant RFC that must be traeted by UAC and/or UAS.
- SIP B2BUA terminates the incoming leg and creates a new independent outgoing leg — a-leg and b-leg have **different Call-IDs**.
- ACK for 2xx is end-to-end (application-level, new transaction); ACK for non-2xx is hop-by-hop (part of INVITE transaction, handled by TransactionLayer).
- CANCEL must reuse the original INVITE's Request-URI and branch — handled by TransactionLayer matching callId+fromTag.
- Via/Contact params (`callRef`, `leg`, `cr`, `lg`) are the primary call resolution mechanism for in-dialog messages. CallId+fromTag fallback is only used for CANCEL (absorbed by TransactionLayer) and edge cases.
- When the user describes a custom encoding or data format, ask clarifying questions before implementing.


## File Creation Rules
- NEVER use `cat`, `echo`, heredoc (`<< EOF`), or shell redirection to create or write files.
- ALWAYS use the Write tool for creating files, regardless of path (inside or outside CWD).
- ALWAYS use the Edit tool for modifying existing files.