# `@vcharbon/sipjs/b2bua` — embedded mode

Embed the full B2BUA in your own app, supplying a custom
`CallDecisionEngine` for the per-call "what should we do?" decision.
The b2bua's rule registry — every SIP state machine for INVITE / BYE /
CANCEL / REFER / OPTIONS / re-INVITE / failover — is fixed; only the
call-control decision is yours.

## Install

```bash
npm install @vcharbon/sipjs effect @effect/platform-node
```

## The 3 methods you implement

```ts
interface CallDecisionEngineApi {
  newCall(req: NewCallRequest): Effect<NewCallResponse, CallDecisionError>
  callFailure(req: CallFailureRequest): Effect<CallFailureResponse, CallDecisionError>
  callRefer(req: CallReferRequest): Effect<CallReferResponse, CallDecisionError>
}
```

- `newCall` — inbound INVITE arrived. Return `{ action: "route", destination: { host, port }, ... }` or `{ action: "reject", reject_code }`.
- `callFailure` — the b-leg failed. Return `{ action: "failover", destination: ... }` or `{ action: "terminate" }`.
- `callRefer` — REFER (transfer) authorization. Return `{ action: "allow", ... }` or `{ action: "reject", reject_code }`.

The full request and response Schemas are in
[src/decision/schemas/](../../src/decision/schemas/) and re-exported via
`@vcharbon/sipjs/b2bua` as TypeScript types.

## Quick-start (in-process decision)

```ts
import { Effect, Layer } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import {
  b2buaEmbeddedLayer,
  CallDecisionEngine,
  SipRouter,
  handlers,
} from "@vcharbon/sipjs/b2bua"

const inProcessDecision = Layer.succeed(CallDecisionEngine, {
  newCall: (_req) =>
    Effect.succeed({
      action: "route" as const,
      destination: { host: "10.0.1.5", port: 5060 },
    }),
  callFailure: (_req) => Effect.succeed({ action: "terminate" as const }),
  callRefer: (_req) =>
    Effect.succeed({ action: "reject" as const, reject_code: 403 }),
})

const program = Effect.gen(function* () {
  const router = yield* SipRouter
  yield* router.start(handlers) // blocks until interrupted
}).pipe(Effect.provide(b2buaEmbeddedLayer({
  callDecision: inProcessDecision,
  config: { sipLocalPort: 5060 },
})))

NodeRuntime.runMain(program)
```

## Quick-start (HTTP backend)

If your decision logic lives behind HTTP, build a `CallDecisionEngine`
layer that forwards each request to your service and decodes the
response. The shipped `HttpReferenceAdapterLayer` (under
`src/decision/adapters/http-reference/`) is the reference impl, but it
expects a specific server-side wire shape ("X-Api-Call"). For your own
server, write your own adapter:

```ts
import { Layer, Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
import { CallDecisionEngine, CallDecisionError } from "@vcharbon/sipjs/b2bua"

const myHttpDecision = Layer.effect(
  CallDecisionEngine,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    return {
      newCall: (req) => Effect.gen(function* () {
        const res = yield* http.post("https://my-cc.example/new-call", { body: req })
        // ...decode and return NewCallResponse...
      }),
      callFailure: (req) => /* ... */,
      callRefer:   (req) => /* ... */,
    }
  }),
)
```

## Defaults

`b2buaEmbeddedLayer({ callDecision })` sets up:

- **AppConfig** — `defaultEmbeddedAppConfig` (UDP `5060`, in-memory
  Redis-style URLs that the in-memory layers ignore).
- **Cache** — `PartitionedRelayStorage.memoryLayer` (in-process
  MutableHashMap, TTL on access).
- **Limiter** — `CallLimiter.memoryLayer`.
- **CDR** — `CdrWriter.testLayer` (in-memory, readable via `yield* CdrWriter`).
- **Tracing** — `TracingService.layer` with `traceSampleRate: 0` (no
  spans recorded — effectively a noop).
- **DrainingState** — `DrainingState.test` (no SIGTERM hook; the
  embedding app manages its own lifecycle).
- **Replication** — none. K8s peer pull / ReadyGate / ReplPuller are
  all standalone-mode features and are NOT wired in embedded mode.

Each can be overridden via the `B2buaEmbeddedOptions` fields (`cache`,
`callLimiter`, `cdr`, `tracing`).

### Overriding config

```ts
b2buaEmbeddedLayer({
  callDecision: myDecision,
  config: {
    sipLocalPort: 5070,
    noAnswerTimeoutSec: 60,
    callMaxDurationSec: 14400,
  },
})
```

Fields you don't override keep their `defaultEmbeddedAppConfig` values.
The full list of fields is in
[src/config/AppConfig.ts](../../src/config/AppConfig.ts).

### Enabling OTLP tracing

```ts
import { otlpHttpTracingLayer } from "@vcharbon/sipjs/observability"

b2buaEmbeddedLayer({
  callDecision: myDecision,
  tracing: otlpHttpTracingLayer({
    tracesUrl: "http://localhost:4318/v1/traces",
    serviceName: "my-app",
  }) as never, // (cast: NodeSdk layer satisfies TracingService transitively)
})
```

You must install the OTel optional peers:

```bash
npm install @effect/opentelemetry @opentelemetry/sdk-trace-base \
            @opentelemetry/exporter-trace-otlp-http \
            @opentelemetry/api @opentelemetry/resources \
            @opentelemetry/sdk-trace-node @opentelemetry/semantic-conventions
```

## What's NOT customizable in v1

- The rule registry (`ruleRegistry` from `B2buaCore`) is built at
  module load time. Custom rules / rule overrides are out of scope.
- The SIP parser is fixed at `customParser`. `jssip` is dead code
  slated for removal.
- The transport is UDP-only.
- Production HA (Redis-backed cache, K8s replication, ReadyGate) is
  not exposed via `b2buaEmbeddedLayer`. Compose `B2buaCoreLayer`
  manually if you need it — see [src/main.ts](../../src/main.ts) for
  the standalone-mode wiring.
