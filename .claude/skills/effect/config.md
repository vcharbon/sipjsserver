# Config — Effect v4

Effect's `Config` module provides type-safe configuration loading with validation, defaults, and transformations.

## How Config Works

By default, Effect loads config from **environment variables**. Override the source with `ConfigProvider.layer`:
- **Production:** environment variables (default)
- **Tests:** `Layer.succeed(MyConfig, { ... })` directly
- **Development:** JSON files or hardcoded values

## Basic Usage

```typescript
import { Config, Effect } from "effect"

const program = Effect.gen(function* () {
  const apiKey = yield* Config.redacted("API_KEY")  // hidden in logs
  const port = yield* Config.int("PORT")
  console.log(`Starting on port ${port}`)
})

Effect.runPromise(program)
```

## Recommended Pattern: Config Service Layer

```typescript
import { Config, Effect, Layer, Redacted, ServiceMap } from "effect"

class ApiConfig extends ServiceMap.Service<
  ApiConfig,
  {
    readonly apiKey: Redacted.Redacted
    readonly baseUrl: string
    readonly timeout: number
  }
>()("@app/ApiConfig") {
  static readonly layer = Layer.effect(
    ApiConfig,
    Effect.gen(function* () {
      const apiKey = yield* Config.redacted("API_KEY")
      const baseUrl = yield* Config.string("API_BASE_URL").pipe(
        Config.orElse(() => Config.succeed("https://api.example.com"))
      )
      const timeout = yield* Config.int("API_TIMEOUT").pipe(
        Config.orElse(() => Config.succeed(30000))
      )
      return { apiKey, baseUrl, timeout }
    })
  )
}
```

**Why this pattern?**
- Separates config loading from business logic
- Easy to swap (layer vs testLayer)
- Config errors caught early at layer composition
- Type-safe throughout

## Config Primitives

```typescript
import { Config } from "effect"

Config.string("MY_VAR")
Config.number("PORT")
Config.int("MAX_RETRIES")
Config.boolean("DEBUG")
Config.redacted("API_KEY")        // Hidden in logs
Config.url("API_URL")
Config.duration("TIMEOUT")
Config.array(Config.string(), "TAGS")  // Comma-separated env var
```

## Defaults and Optional

```typescript
import { Config } from "effect"

// With fallback
const port = yield* Config.int("PORT").pipe(
  Config.orElse(() => Config.succeed(3000))
)

// Optional (returns Option<string>)
const optionalKey = yield* Config.option(Config.string("OPTIONAL_KEY"))
```

## Validation with Schema (Recommended)

```typescript
import { Config, Effect, Schema } from "effect"

const Port = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  Schema.brand("Port")
)
type Port = typeof Port.Type

const Environment = Schema.Literals(["development", "staging", "production"])

const program = Effect.gen(function* () {
  const port = yield* Config.schema(Port, "PORT")          // branded Port type
  const env = yield* Config.schema(Environment, "NODE_ENV")
  return { port, env }
})
```

## Redacted Secrets

```typescript
import { Config, Effect, Redacted } from "effect"

const program = Effect.gen(function* () {
  const apiKey = yield* Config.redacted("API_KEY")

  const headers = {
    Authorization: `Bearer ${Redacted.value(apiKey)}`  // Extract with Redacted.value()
  }

  console.log(apiKey) // Output: <redacted> — safe to log
  return headers
})
```

## Usage in Tests

Best practice: provide values directly with `Layer.succeed()`. No need for `ConfigProvider.fromMap`:

```typescript
import { Effect, Layer, Redacted } from "effect"

// In tests: inline values
Effect.runPromise(
  program.pipe(
    Effect.provide(
      Layer.succeed(ApiConfig, {
        apiKey: Redacted.make("test-key"),
        baseUrl: "https://test.example.com",
        timeout: 5000,
      })
    )
  )
)
```

## Config Providers (Advanced)

```typescript
import { ConfigProvider, Effect, Layer } from "effect"

// From in-memory map (for tests when using Config primitives directly)
const testLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ API_KEY: "test-key", PORT: "3000" })
)

// Prefixed env vars: reads APP_API_KEY, APP_PORT, etc.
const prefixedLayer = ConfigProvider.layer(
  ConfigProvider.fromEnv().pipe(ConfigProvider.nested("APP"))
)

Effect.runPromise(program.pipe(Effect.provide(testLayer)))
```
