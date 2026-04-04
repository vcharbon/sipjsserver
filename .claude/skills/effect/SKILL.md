---
name: effect
description: Guide for writing idiomatic Effect v4 (effect-smol) TypeScript code. Triggered when working with Effect, writing services/layers, data modeling with Schema, error handling, config, testing with @effect/vitest, or CLI with effect/unstable/cli.
triggers:
  - "effect"
  - "Effect.gen"
  - "ServiceMap"
  - "Schema.Class"
  - "Layer"
---

# Effect v4 Skill

This skill provides idiomatic patterns for Effect v4 (the `effect-smol` / beta line). All examples use Effect v4 APIs.
Notify user in case of surprising errors or unexpected behavior when working with Effect.

## How to Use This Skill

When working on an Effect-related task, read the relevant sub-file from this skill directory:

| Topic | File | When to read |
|-------|------|--------------|
| Quick Start | [quick-start.md](quick-start.md) | First time setup, general orientation |
| Project Setup | [project-setup.md](project-setup.md) | Effect Language Service, reference repos |
| TypeScript Config | [tsconfig.md](tsconfig.md) | tsconfig.json settings for Effect projects |
| Basics | [basics.md](basics.md) | Effect.gen, Effect.fn, pipe, retry/timeout |
| Services & Layers | [services-and-layers.md](services-and-layers.md) | ServiceMap.Service, Layer composition, DI |
| Data Modeling | [data-modeling.md](data-modeling.md) | Schema.Class, branded types, JSON encode/decode |
| Error Handling | [error-handling.md](error-handling.md) | Schema.TaggedErrorClass, catch/catchTag, defects |
| Config | [config.md](config.md) | Config primitives, Config.schema, providers |
| Testing | [testing.md](testing.md) | @effect/vitest, it.effect, TestClock, layers |
| CLI | [cli.md](cli.md) | effect/unstable/cli, commands, flags, arguments |

Read sub-files with the Read tool: `~/.claude/skills/effect/<filename>`

## Effect v4 API Reference (Critical Differences from v3)

These APIs changed in v4 and will cause compile errors or subtle bugs if you use v3 names:

| v3 (wrong) | v4 (correct) |
|------------|-------------|
| `Effect.catchAll` | `Effect.catch` |
| `Effect.forkDaemon` | `Effect.forkDetach` |
| `Fiber.RuntimeFiber` | `Fiber.Fiber` |
| `Effect.Effect.Success<T>` | `Effect.Success<T>` |
| `Schema.literal("a", "b")` | `Schema.Literals(["a", "b"])` |
| `Schema.union(A, B)` | `Schema.Union([A, B])` |
| `Data.TaggedError` | `Schema.TaggedErrorClass` |
| `Data.Class` | `Schema.Class` |
| `Context.Tag` | `ServiceMap.Service` |
| `Schema.decode` | `Schema.decodeEffect` |
| `Schema.encode` | `Schema.encodeEffect` |
| `Schema.decodeUnknown` | `Schema.decodeUnknownEffect` |
| `Option.fromNullable` | `Option.fromNullishOr` |

## Key v4 Import Paths

```typescript
import { Effect, Layer, Schema, ServiceMap, Option, Config, Redacted } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "@effect/vitest"
```

## Core Principles

1. **Always use Effect.gen** — prefer generator syntax over flatMap chains
2. **Always use Effect.fn** for named top level effectful functions — enables call-site tracing
3. **ServiceMap.Service for all services** — not Context.Tag
4. **Schema.TaggedErrorClass for errors** — serializable, matchable by `_tag`
5. **Provide layers once at the entry point** — never scatter `Effect.provide` calls
6. **Use Scope for resources** — `Effect.addFinalizer` inside acquire, consumers use `Effect.scoped`. Never provide user ability to miss calling release.
7. **Reflect failures in the type** — `Effect<A, E, R>` — don't hide errors with `orDie` unless truly unrecoverable
8. **Always use Schema to model Data**

## Local Effect Source

The Effect v4 source is at `~/.local/share/effect-solutions/effect`. Grep it for real API usage when in doubt.
