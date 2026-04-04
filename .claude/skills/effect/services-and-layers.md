# Services & Layers — Effect v4

Effect's service pattern provides a deterministic way to organize your application through dependency injection. Define services as `ServiceMap.Service` classes, compose them into Layers.

## Defining a Service

```typescript
import { Effect, ServiceMap } from "effect"

class Database extends ServiceMap.Service<
  Database,
  {
    readonly query: (sql: string) => Effect.Effect<unknown[]>
    readonly execute: (sql: string) => Effect.Effect<void>
  }
>()("@app/Database") {}
```

**Rules:**
- Tag identifiers must be **unique** — use `@path/to/ServiceName` pattern
- Service methods should have **no dependencies** (`R = never`) — dependencies are handled via Layer composition
- Use **readonly properties** — services should not expose mutable state

## Defining a Layer

A Layer is an implementation of a service:

```typescript
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Effect, Layer, Schema, ServiceMap } from "effect"

const UserId = Schema.String.pipe(Schema.brand("UserId"))
type UserId = typeof UserId.Type

class User extends Schema.Class("User")({
  id: UserId,
  name: Schema.String,
  email: Schema.String,
}) {}

class UserNotFoundError extends Schema.TaggedErrorClass("UserNotFoundError")(
  "UserNotFoundError",
  { id: UserId }
) {}

class Users extends ServiceMap.Service<
  Users,
  {
    readonly findById: (id: UserId) => Effect.Effect<User, UserNotFoundError>
    readonly all: () => Effect.Effect<readonly User[]>
  }
>()("@app/Users") {
  static readonly layer = Layer.effect(
    Users,
    Effect.gen(function* () {
      // 1. yield* services you depend on
      const http = yield* HttpClient.HttpClient

      // 2. define methods with Effect.fn for call-site tracing
      const findById = Effect.fn("Users.findById")(
        function* (id: UserId) {
          const response = yield* http.get(`https://api.example.com/users/${id}`)
          return yield* HttpClientResponse.schemaBodyJson(User)(response)
        },
        Effect.catchTag("ResponseError", (error) =>
          error.response.status === 404
            ? new UserNotFoundError({ id })
            : Effect.die(error),
        ),
      )

      const all = Effect.fn("Users.all")(function* () {
        const response = yield* http.get("https://api.example.com/users")
        return yield* HttpClientResponse.schemaBodyJson(Schema.Array(User))(response)
      })

      // 3. return the service
      return { findById, all }
    })
  )
}
```

**Layer naming:** camelCase with `Layer` suffix: `layer`, `testLayer`, `postgresLayer`, etc.

## Service-Driven Development

Sketch leaf service tags first (without implementations), then write higher-level orchestration that type-checks even though leaf services aren't runnable yet:

```typescript
import { Clock, Effect, Layer, Schema, ServiceMap } from "effect"

// Branded IDs
const EventId = Schema.String.pipe(Schema.brand("EventId"))
type EventId = typeof EventId.Type
const UserId = Schema.String.pipe(Schema.brand("UserId"))
type UserId = typeof UserId.Type

// Leaf services: contracts only (no implementations yet)
class Users extends ServiceMap.Service<
  Users,
  { readonly findById: (id: UserId) => Effect.Effect<{ email: string }> }
>()("@app/Users") {}

class Tickets extends ServiceMap.Service<
  Tickets,
  { readonly issue: (eventId: EventId, userId: UserId) => Effect.Effect<{ code: string }> }
>()("@app/Tickets") {}

// Higher-level service: orchestrates leaf services
class Events extends ServiceMap.Service<
  Events,
  { readonly register: (eventId: EventId, userId: UserId) => Effect.Effect<void> }
>()("@app/Events") {
  static readonly layer = Layer.effect(
    Events,
    Effect.gen(function* () {
      const users = yield* Users
      const tickets = yield* Tickets

      const register = Effect.fn("Events.register")(function* (eventId: EventId, userId: UserId) {
        const user = yield* users.findById(userId)
        const ticket = yield* tickets.issue(eventId, userId)
        yield* Effect.logInfo(`Ticket ${ticket.code} issued to ${user.email}`)
      })

      return { register }
    })
  )
}
```

Benefits: leaf contracts are explicit, higher-level code type-checks immediately, leaf implementations can be added later without changing `Events`.

## Test Implementations

```typescript
import { Effect, Layer, ServiceMap } from "effect"

class Cache extends ServiceMap.Service<
  Cache,
  {
    readonly get: (key: string) => Effect.Effect<string | null>
    readonly set: (key: string, value: string) => Effect.Effect<void>
  }
>()("@app/Cache") {
  static readonly testLayer = Layer.sync(Cache, () => {
    const store = new Map<string, string>()
    return {
      get: (key) => Effect.succeed(store.get(key) ?? null),
      set: (key, value) => Effect.sync(() => void store.set(key, value)),
    }
  })
}
```

## Providing Layers

Use `Effect.provide` **once at the entry point**:

```typescript
import { Effect, Layer } from "effect"

// Compose all layers
const appLayer = UserService.layer.pipe(
  Layer.provideMerge(Database.layer),
  Layer.provideMerge(Config.layer)
)

// Provide once at the entry point
const main = program.pipe(Effect.provide(appLayer))
Effect.runPromise(main)
```

## Layer Memoization

Effect memoizes layers by reference identity. Always store parameterized layers in constants:

```typescript
// BAD: calling the constructor twice = two connection pools
const badLayer = Layer.merge(
  UserRepo.layer.pipe(Layer.provide(Postgres.layer({ url: "...", poolSize: 10 }))),
  OrderRepo.layer.pipe(Layer.provide(Postgres.layer({ url: "...", poolSize: 10 }))) // Different reference!
)

// GOOD: store in a constant, share the same reference
const postgresLayer = Postgres.layer({ url: "...", poolSize: 10 })
const goodLayer = Layer.merge(
  UserRepo.layer.pipe(Layer.provide(postgresLayer)),
  OrderRepo.layer.pipe(Layer.provide(postgresLayer)) // Same reference → memoized
)
```

## Sharing Layers Between Tests

By default, provide a fresh layer inside each `it.effect`. Use `it.layer` only when sharing an expensive resource (like a DB connection) across an entire suite.

```typescript
// Per-test (preferred): fresh state per test, no leakage
it.effect("test", () =>
  Effect.gen(function* () { ... }).pipe(Effect.provide(Counter.layer))
)

// Suite-shared (only when needed):
it.layer(Counter.layer)("counter suite", (it) => {
  it.effect("first test", () => Effect.gen(function* () { ... }))
  it.effect("second test", () => Effect.gen(function* () { ... })) // State may have leaked!
})
```
