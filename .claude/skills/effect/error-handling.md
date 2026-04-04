# Error Handling — Effect v4

Effect provides structured error handling with Schema integration for serializable, type-safe errors.

## Schema.TaggedErrorClass

Define domain errors with `Schema.TaggedErrorClass`:

```typescript
import { Schema } from "effect"

class ValidationError extends Schema.TaggedErrorClass("ValidationError")(
  "ValidationError",
  {
    field: Schema.String,
    message: Schema.String,
  }
) {}

class NotFoundError extends Schema.TaggedErrorClass("NotFoundError")(
  "NotFoundError",
  {
    resource: Schema.String,
    id: Schema.String,
  }
) {}

// Union of errors
const AppError = Schema.Union([ValidationError, NotFoundError])
type AppError = typeof AppError.Type
```

**Benefits:**
- Serializable (send over network, save to DB)
- Type-safe with `_tag` for pattern matching
- Custom methods via class extension
- **Yieldable**: yield directly without `Effect.fail`

```typescript
import { Effect, Random, Schema } from "effect"

class BadLuck extends Schema.TaggedErrorClass("BadLuck")(
  "BadLuck",
  { roll: Schema.Number }
) {}

const rollDie = Effect.gen(function* () {
  const roll = yield* Random.nextIntBetween(1, 6)
  if (roll === 1) {
    yield* new BadLuck({ roll }) // No Effect.fail needed!
  }
  return { roll }
})
```

## Recovering from Errors

### Effect.catch — handle all errors

```typescript
import { Effect } from "effect"

// v4: Effect.catch (NOT Effect.catchAll — that was v3)
const recovered = program.pipe(
  Effect.catch((error) =>
    Effect.gen(function* () {
      yield* Effect.logError("Error occurred", error)
      return `Recovered from ${error._tag}`
    })
  )
)
```

### Effect.catchTag — handle specific error by tag

```typescript
const recovered = program.pipe(
  Effect.catchTag("HttpError", (error) =>
    Effect.gen(function* () {
      yield* Effect.logWarning(`HTTP ${error.statusCode}: ${error.message}`)
      return "Recovered from HttpError"
    })
  )
)
// ValidationError still propagates
```

### Effect.catchTags — handle multiple errors at once

```typescript
const recovered = program.pipe(
  Effect.catchTags({
    HttpError: () => Effect.succeed("Recovered from HttpError"),
    ValidationError: () => Effect.succeed("Recovered from ValidationError"),
  })
)
```

## Expected Errors vs Defects

**Use typed errors** for domain failures the caller can handle: validation, "not found", permission denied, rate limits.

**Use defects** for unrecoverable situations (bugs, invariant violations):

```typescript
import { Effect } from "effect"

// At app entry: if config fails, nothing can proceed — convert to defect
const main = Effect.gen(function* () {
  const config = yield* loadConfig.pipe(Effect.orDie)
  yield* Effect.log(`Starting on port ${config.port}`)
})
```

**When to catch defects:** Almost never. Only at system boundaries for logging. Use `Effect.catchAllDefect` only for plugin sandboxing or similar.

## Schema.Defect — Wrapping Unknown Errors

Use `Schema.Defect` to wrap errors from external libraries:

```typescript
import { Schema, Effect } from "effect"

class ApiError extends Schema.TaggedErrorClass("ApiError")(
  "ApiError",
  {
    endpoint: Schema.String,
    statusCode: Schema.Number,
    error: Schema.Defect, // Wraps unknown errors from fetch/axios/etc
  }
) {}

const fetchUser = (id: string) =>
  Effect.tryPromise({
    try: () => fetch(`/api/users/${id}`).then((r) => r.json()),
    catch: (error) => new ApiError({
      endpoint: `/api/users/${id}`,
      statusCode: 500,
      error
    })
  })
```

`Schema.Defect` handles:
- JavaScript `Error` instances → `{ name, message }` objects
- Any unknown value → string representation
- Serializable for network/storage

## Resources with Scope

For resources that need cleanup, use `Effect.addFinalizer` inside the acquire function. Make misuse impossible by requiring `Scope`:

```typescript
import { Effect, Scope } from "effect"

// Acquire returns Effect<Resource, E, Scope> — consumer MUST use Effect.scoped
const acquireResource = Effect.gen(function* () {
  const resource = yield* openConnection()
  yield* Effect.addFinalizer(() => resource.close())
  return resource
})

// Consumer uses Effect.scoped — cleanup is automatic
const program = Effect.gen(function* () {
  const resource = yield* acquireResource
  yield* resource.doWork()
}).pipe(Effect.scoped)
```

Never expose separate `acquire`/`release` methods — callers forget to call `release`.
