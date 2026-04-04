# Quick Start — Effect v4

This is a field manual for Effect. It is neither exhaustive nor encyclopedic. Instead, you will find patterns and best practices for writing idiomatic Effect code.

## What is Effect?

Effect is a TypeScript library for building type-safe, composable applications. The core type is:

```typescript
Effect<A, E, R>
// A = success value type
// E = expected failure type (tracked in type system)
// R = required services (dependencies)
```

## CLI

Effect solutions are available from the command line:

```bash
# List all topics
effect-solutions list

# Show specific topics
effect-solutions show project-setup tsconfig

# Show multiple topics at once
effect-solutions show basics services-and-layers error-handling
```

## The Three Rules

1. **Use Effect.gen** — generator syntax for sequencing effects (like async/await)
2. **Use Effect.fn** — wrap named functions to get call-site tracing
3. **Use ServiceMap.Service** — define all services as tagged service classes

## Minimal Program

```typescript
import { Effect } from "effect"

const program = Effect.gen(function* () {
  yield* Effect.logInfo("Hello, Effect!")
  return 42
})

Effect.runPromise(program).then(console.log) // 42
```

## What to Read Next

- [Basics](basics.md) — Effect.gen, Effect.fn, pipe patterns
- [Services & Layers](services-and-layers.md) — dependency injection
- [Data Modeling](data-modeling.md) — Schema.Class, branded types
- [Error Handling](error-handling.md) — typed errors
- [Project Setup](project-setup.md) — tooling setup
