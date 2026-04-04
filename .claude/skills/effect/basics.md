# Basics — Effect v4

Guidelines for structuring basic Effect code: sequencing with `Effect.gen`, naming with `Effect.fn`, and instrumentation with `.pipe()`.

## Effect.gen

Just as `async/await` provides sequential, readable `Promise` composition, `Effect.gen` and `yield*` do the same for `Effect` values.

```typescript
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const data = yield* fetchData
  yield* Effect.logInfo(`Processing data: ${data}`)
  return yield* processData(data)
})
```

## Effect.fn

Use `Effect.fn` with generator functions for traced, named effects. It traces **where the function is called from**, not just where it's defined.

```typescript
import { Effect } from "effect"

const processUser = Effect.fn("processUser")(function* (userId: string) {
  yield* Effect.logInfo(`Processing user ${userId}`)
  const user = yield* getUser(userId)
  return yield* processData(user)
})
```

### Effect.fn with Transformation

`Effect.fn` accepts a second argument: a function that transforms the entire effect. Useful for cross-cutting concerns:

```typescript
import { Effect, flow, Schedule } from "effect"

const fetchWithTimeout = Effect.fn("fetchWithTimeout")(
  function* (url: string) {
    const data = yield* fetchData(url)
    return yield* processData(data)
  },
  flow(
    Effect.retry(Schedule.recurs(3)),
    Effect.timeout("5 seconds")
  )
)
```

**Benefits of Effect.fn:**
- Call-site tracing for each invocation
- Stack traces with location details
- Automatic spans for telemetry/OpenTelemetry
- Use it for nullary methods (thunks) too — `Effect.fn("Service.method")(function* () { ... })`

## Pipe for Instrumentation

Use `.pipe()` to add cross-cutting concerns to Effect values:

```typescript
import { Effect, Schedule } from "effect"

const program = fetchData.pipe(
  Effect.timeout("5 seconds"),
  Effect.retry(Schedule.exponential("100 millis").pipe(Schedule.compose(Schedule.recurs(3)))),
  Effect.tap((data) => Effect.logInfo(`Fetched: ${data}`)),
  Effect.withSpan("fetchData")
)
```

**Common instrumentation:**
- `Effect.timeout` — fail if effect takes too long
- `Effect.retry` — retry on failure with a schedule
- `Effect.tap` — run side effect without changing the value
- `Effect.withSpan` — add tracing span

## Retry and Timeout

Combine retry and timeout for production-grade resilience:

```typescript
import { Effect, Schedule } from "effect"

const retryPolicy = Schedule.exponential("100 millis").pipe(
  Schedule.compose(Schedule.recurs(3))
)

const resilientCall = callExternalApi.pipe(
  Effect.timeout("2 seconds"),   // Timeout per attempt
  Effect.retry(retryPolicy),     // Retry failed attempts
  Effect.timeout("10 seconds")   // Overall timeout across all attempts
)
```

**Schedule combinators:**
- `Schedule.exponential` — exponential backoff
- `Schedule.recurs(n)` — limit to n retries
- `Schedule.spaced` — fixed delay between retries
- `Schedule.compose` — combine schedules (both must continue)
