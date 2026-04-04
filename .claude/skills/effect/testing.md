# Testing — Effect v4

`@effect/vitest` provides enhanced testing support for Effect code.

## Why @effect/vitest?

- **Native Effect support**: run Effect programs directly with `it.effect()`
- **Automatic cleanup**: scoped resources managed automatically (scope closes when test ends)
- **Test services**: `TestClock`, `TestRandom` for deterministic tests
- **Better errors**: full fiber dumps with causes, spans, and logs
- **Layer support**: provide dependencies with `Effect.provide()`

## Install

```bash
bun add -D vitest @effect/vitest@beta
```

`package.json`:
```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

`vitest.config.ts`:
```typescript
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
})
```

## Basic Testing

```typescript
import { Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

describe("Calculator", () => {
  it("creates instances", () => {
    expect(1 + 1).toBe(2)
  })

  it.effect("adds numbers", () =>
    Effect.gen(function* () {
      const result = yield* Effect.succeed(1 + 1)
      expect(result).toBe(2)
    })
  )
})
```

## it.effect — The Main Test Runner

```typescript
it.effect("processes data", () =>
  Effect.gen(function* () {
    const result = yield* processData("input")
    expect(result).toBe("expected")
  })
)
```

**Scoped resources are automatic in v4** — the scope closes when the test ends:

```typescript
import { FileSystem } from "effect"
import { NodeFileSystem } from "@effect/platform-node"

it.effect("temp directory is cleaned up", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const tempDir = yield* fs.makeTempDirectoryScoped()
    yield* fs.writeFileString(`${tempDir}/test.txt`, "hello")
    const exists = yield* fs.exists(`${tempDir}/test.txt`)
    expect(exists).toBe(true)
    // Scope closes → tempDir deleted automatically
  }).pipe(Effect.provide(NodeFileSystem.layer))
)
```

## it.live — Real Time

`it.effect` uses `TestContext` (TestClock starts at 0). Use `it.live` for real system time:

```typescript
import { Clock } from "effect"

it.effect("test clock starts at zero", () =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    expect(now).toBe(0) // TestClock
  })
)

it.live("real clock", () =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    expect(now).toBeGreaterThan(0) // Real time
  })
)
```

## TestClock

`TestClock` is from `effect/testing` (not `@effect/vitest`):

```typescript
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

it.effect("time-based test", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.delay(Effect.succeed("done"), "10 seconds").pipe(
      Effect.forkChild
    )
    yield* TestClock.adjust("10 seconds")
    const result = yield* Fiber.join(fiber)
    expect(result).toBe("done")
  })
)
```

## Providing Layers

```typescript
import { Effect, Layer, ServiceMap } from "effect"

class Database extends ServiceMap.Service<
  Database,
  { query: (sql: string) => Effect.Effect<string[]> }
>()("Database") {}

const testDatabase = Layer.succeed(Database, {
  query: (_sql) => Effect.succeed(["mock", "data"])
})

it.effect("queries database", () =>
  Effect.gen(function* () {
    const db = yield* Database
    const results = yield* db.query("SELECT * FROM users")
    expect(results.length).toBe(2)
  }).pipe(Effect.provide(testDatabase))
)
```

## Test Modifiers

```typescript
it.effect.skip("temporarily disabled", () => ...)
it.effect.only("focus on this test", () => ...)
it.effect.fails("known bug", () => ...)
```

## Logging in Tests

`it.effect` suppresses log output by default:

```typescript
import { Logger } from "effect"

// Option 1: provide a logger
it.effect("with logging", () =>
  Effect.gen(function* () {
    yield* Effect.log("This will be shown")
  }).pipe(Effect.provide(Logger.pretty))
)

// Option 2: use it.live (logging enabled by default)
it.live("live test with logs", () =>
  Effect.gen(function* () {
    yield* Effect.log("This will be shown")
  })
)
```

## Worked Example: Testing a Service

Complete example testing an `Events` service that orchestrates `Users`, `Tickets`, `Emails`:

```typescript
import { Clock, Effect, Layer, Option, Schema, ServiceMap } from "effect"
import { describe, expect, it } from "@effect/vitest"

const UserId = Schema.String.pipe(Schema.brand("UserId"))
type UserId = typeof UserId.Type
const EventId = Schema.String.pipe(Schema.brand("EventId"))
type EventId = typeof EventId.Type
const TicketId = Schema.String.pipe(Schema.brand("TicketId"))
type TicketId = typeof TicketId.Type

class User extends Schema.Class("User")({ id: UserId, name: Schema.String, email: Schema.String }) {}
class Ticket extends Schema.Class("Ticket")({ id: TicketId, eventId: EventId, code: Schema.String }) {}
class Email extends Schema.Class("Email")({ to: Schema.String, subject: Schema.String, body: Schema.String }) {}
class UserNotFound extends Schema.TaggedErrorClass("UserNotFound")("UserNotFound", { id: UserId }) {}

class Users extends ServiceMap.Service<
  Users,
  {
    readonly create: (user: User) => Effect.Effect<void>
    readonly findById: (id: UserId) => Effect.Effect<User, UserNotFound>
  }
>()("@app/Users") {
  static readonly testLayer = Layer.sync(Users, () => {
    const store = new Map<UserId, User>()
    return {
      create: (user) => Effect.sync(() => void store.set(user.id, user)),
      findById: (id) =>
        Option.fromNullishOr(store.get(id)).pipe(
          Effect.fromOption,
          Effect.catch(() => Effect.fail(new UserNotFound({ id })))
        ),
    }
  })
}

class Tickets extends ServiceMap.Service<
  Tickets,
  { readonly issue: (eventId: EventId, userId: UserId) => Effect.Effect<Ticket> }
>()("@app/Tickets") {
  static readonly testLayer = Layer.sync(Tickets, () => {
    let counter = 0
    return {
      issue: (eventId, _userId) =>
        Effect.sync(() =>
          new Ticket({ id: TicketId.makeUnsafe(`ticket-${counter++}`), eventId, code: `CODE-${counter}` })
        ),
    }
  })
}

class Emails extends ServiceMap.Service<
  Emails,
  {
    readonly send: (email: Email) => Effect.Effect<void>
    readonly sent: Effect.Effect<ReadonlyArray<Email>>
  }
>()("@app/Emails") {
  static readonly testLayer = Layer.sync(Emails, () => {
    const emails: Array<Email> = []
    return {
      send: (email) => Effect.sync(() => void emails.push(email)),
      sent: Effect.sync(() => emails),
    }
  })
}

// provideMerge exposes leaf services for setup/assertions in tests
const testLayer = Events.layer.pipe(
  Layer.provideMerge(Users.testLayer),
  Layer.provideMerge(Tickets.testLayer),
  Layer.provideMerge(Emails.testLayer)
)

describe("Events.register", () => {
  it.effect("creates registration", () =>
    Effect.gen(function* () {
      const users = yield* Users
      const events = yield* Events

      const user = new User({ id: UserId.makeUnsafe("user-123"), name: "Alice", email: "alice@example.com" })
      yield* users.create(user)

      const registration = yield* events.register(EventId.makeUnsafe("event-789"), user.id)
      expect(registration.userId).toBe(user.id)
    }).pipe(Effect.provide(testLayer))
  )
})
```
