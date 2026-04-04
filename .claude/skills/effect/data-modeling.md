# Data Modeling — Effect v4

Effect's `Schema` library provides runtime validation, serialization, and type safety in one place.

## Why Schema?

- **Single source of truth**: define once, get TypeScript types + runtime validation + JSON serialization
- **Parse safely**: validate HTTP/CLI/config data with detailed errors
- **Rich domain types**: branded primitives, classes with methods
- **Ecosystem integration**: works with RPC, HttpApi, CLI, frontend, backend

## Records (AND Types) — Schema.Class

```typescript
import { Schema } from "effect"

const UserId = Schema.String.pipe(Schema.brand("UserId"))
type UserId = typeof UserId.Type

export class User extends Schema.Class("User")({
  id: UserId,
  name: Schema.String,
  email: Schema.String,
  createdAt: Schema.Date,
}) {
  // Custom getters and methods
  get displayName() {
    return `${this.name} (${this.email})`
  }
}

const user = new User({
  id: UserId.makeUnsafe("user-123"),
  name: "Alice",
  email: "alice@example.com",
  createdAt: new Date(),
})

console.log(user.displayName) // "Alice (alice@example.com)"
```

## Variants (OR Types) — Schema.TaggedClass + Schema.Union

For simple string/number alternatives:

```typescript
import { Schema } from "effect"

// Note: Schema.Literals (plural) takes an array — NOT Schema.literal("a", "b")
const Status = Schema.Literals(["pending", "active", "completed"])
type Status = typeof Status.Type // "pending" | "active" | "completed"
```

For structured variants with fields:

```typescript
import { Match, Schema } from "effect"

export class Success extends Schema.TaggedClass("Success")("Success", {
  value: Schema.Number,
}) {}

export class Failure extends Schema.TaggedClass("Failure")("Failure", {
  error: Schema.String,
}) {}

// Note: Schema.Union takes an array argument
export const Result = Schema.Union([Success, Failure])
export type Result = typeof Result.Type

// Pattern match
const renderResult = (result: Result) =>
  Match.valueTags(result, {
    Success: ({ value }) => `Got: ${value}`,
    Failure: ({ error }) => `Error: ${error}`,
  })
```

## Branded Types

Brand nearly all primitives — not just IDs, but emails, URLs, counts, etc:

```typescript
import { Schema } from "effect"

export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

export const PostId = Schema.String.pipe(Schema.brand("PostId"))
export type PostId = typeof PostId.Type

export const Email = Schema.String.pipe(Schema.brand("Email"))
export type Email = typeof Email.Type

// With validation
export const Port = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  Schema.brand("Port")
)
export type Port = typeof Port.Type

// Usage
const userId = UserId.makeUnsafe("user-123")
const email = Email.makeUnsafe("alice@example.com")

function getUser(id: UserId) { return id }
// getUser(postId) // Type error: PostId not assignable to UserId
```

## JSON Encoding & Decoding

`Schema.fromJsonString` combines `JSON.parse` + schema decoding in one step:

```typescript
import { Effect, Schema } from "effect"

class Move extends Schema.Class("Move")({
  from: Schema.String,
  to: Schema.String,
}) {}

// Schema that takes JSON string and returns Move
const MoveFromJson = Schema.fromJsonString(Move)

const program = Effect.gen(function* () {
  const jsonString = '{"from":"A1","to":"B2"}'

  // Parse + validate in one step — use MoveFromJson, not Move
  const move = yield* Schema.decodeUnknownEffect(MoveFromJson)(jsonString)

  // Encode to JSON string — use MoveFromJson, not Move
  const json = yield* Schema.encodeEffect(MoveFromJson)(move)
  return json
})
```

**Important:** Use `MoveFromJson` (the `fromJsonString` wrapper) for encode/decode, not the raw `Move` schema.

## Decoding and Encoding Effects

```typescript
import { Schema, Effect } from "effect"

class User extends Schema.Class("User")({
  id: Schema.String,
  name: Schema.String,
}) {}

// Decode unknown input (from external source)
const decoded = yield* Schema.decodeUnknownEffect(User)(unknownData)

// Decode already-typed but potentially invalid data
const decoded2 = yield* Schema.decodeEffect(User)(someData)

// Encode to plain object
const encoded = yield* Schema.encodeEffect(User)(user)
```
