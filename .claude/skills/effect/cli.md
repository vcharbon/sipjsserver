# Command-Line Interfaces — Effect v4

Effect's CLI module provides typed argument parsing, automatic help generation, and seamless Effect service integration.

## Installation

```bash
bun add effect@beta @effect/platform-bun@beta
# or for Node.js:
bun add effect@beta @effect/platform-node@beta
```

## Import Paths (v4)

```typescript
import { Argument, Command, Flag } from "effect/unstable/cli"
import { BunServices, BunRuntime } from "@effect/platform-bun"
// or: import { NodeServices, NodeRuntime } from "@effect/platform-node"
```

## Minimal Example

```typescript
import { Argument, Command, Flag } from "effect/unstable/cli"
import { BunServices, BunRuntime } from "@effect/platform-bun"
import { Console, Effect } from "effect"

const name = Argument.string("name").pipe(Argument.withDefault("World"))
const shout = Flag.boolean("shout").pipe(Flag.withAlias("s"))

const greet = Command.make("greet", { name, shout }, ({ name, shout }) => {
  const message = `Hello, ${name}!`
  return Console.log(shout ? message.toUpperCase() : message)
})

const cli = Command.run(greet, { name: "greet", version: "1.0.0" })

cli(process.argv).pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
)
```

Built-in `--help` and `--version` flags work automatically.

## Arguments

Positional values. **Flags must come before arguments**: `cmd --flag arg` works, `cmd arg --flag` doesn't.

```typescript
import { Argument } from "effect/unstable/cli"

Argument.string("file")                           // Required
Argument.string("output").pipe(Argument.optional) // Optional
Argument.string("format").pipe(Argument.withDefault("json")) // With default
Argument.string("files").pipe(Argument.variadic()) // Zero or more
Argument.string("files").pipe(Argument.atLeast(1)) // At least one

// With Schema for custom types
Argument.integer("id").pipe(Argument.withSchema(TaskId))
```

## Flags

Named options with `--name` syntax:

```typescript
import { Flag } from "effect/unstable/cli"

Flag.boolean("verbose").pipe(Flag.withAlias("v"))
Flag.string("output").pipe(Flag.withAlias("o"))
Flag.string("config").pipe(Flag.optional)
Flag.choice("format", ["json", "yaml", "toml"])
Flag.integer("count").pipe(Flag.withDefault(10))
```

## Subcommands

```typescript
import { Argument, Command } from "effect/unstable/cli"
import { Console } from "effect"

const add = Command.make("add", { task: Argument.string("task") }, ({ task }) =>
  Console.log(`Adding: ${task}`)
)

const list = Command.make("list", {}, () =>
  Console.log("Listing tasks...")
)

const app = Command.make("tasks").pipe(
  Command.withSubcommands([add, list])
)
```

## Full Example: Task Manager CLI

```typescript
import { Argument, Command, Flag } from "effect/unstable/cli"
import { BunServices, BunRuntime } from "@effect/platform-bun"
import { Array, Console, Effect, FileSystem, Layer, Option, Schema, ServiceMap } from "effect"

// Domain model
const TaskId = Schema.Number.pipe(Schema.brand("TaskId"))
type TaskId = typeof TaskId.Type

class Task extends Schema.Class("Task")({
  id: TaskId,
  text: Schema.NonEmptyString,
  done: Schema.Boolean,
}) {
  toggle() { return new Task({ ...this, done: !this.done }) }
}

class TaskList extends Schema.Class("TaskList")({ tasks: Schema.Array(Task) }) {
  static Json = Schema.fromJsonString(TaskList)
  static empty = new TaskList({ tasks: [] })

  get nextId(): TaskId {
    if (this.tasks.length === 0) return TaskId.makeUnsafe(1)
    return TaskId.makeUnsafe(Math.max(...this.tasks.map((t) => t.id)) + 1)
  }

  add(text: string): [TaskList, Task] {
    const task = new Task({ id: this.nextId, text, done: false })
    return [new TaskList({ tasks: [...this.tasks, task] }), task]
  }

  toggle(id: TaskId): [TaskList, Option.Option<Task>] {
    const index = this.tasks.findIndex((t) => t.id === id)
    if (index === -1) return [this, Option.none()]
    const updated = this.tasks[index]!.toggle()
    const tasks = Array.modify(this.tasks, index, () => updated)
    return [new TaskList({ tasks }), Option.some(updated)]
  }
}

// Service
class TaskRepo extends ServiceMap.Service<
  TaskRepo,
  {
    readonly list: (all?: boolean) => Effect.Effect<ReadonlyArray<Task>>
    readonly add: (text: string) => Effect.Effect<Task>
    readonly toggle: (id: TaskId) => Effect.Effect<Option.Option<Task>>
    readonly clear: () => Effect.Effect<void>
  }
>()("TaskRepo") {
  static layer = Layer.effect(
    TaskRepo,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = "tasks.json"

      const load = Effect.gen(function* () {
        const content = yield* fs.readFileString(path)
        return yield* Schema.decodeEffect(TaskList.Json)(content)
      }).pipe(Effect.orElseSucceed(() => TaskList.empty))

      const save = (list: TaskList) =>
        Effect.gen(function* () {
          const json = yield* Schema.encodeEffect(TaskList.Json)(list)
          yield* fs.writeFileString(path, json)
        })

      return {
        list: Effect.fn("TaskRepo.list")(function* (all?: boolean) {
          const taskList = yield* load
          return all ? taskList.tasks : taskList.tasks.filter((t) => !t.done)
        }),
        add: Effect.fn("TaskRepo.add")(function* (text: string) {
          const list = yield* load
          const [newList, task] = list.add(text)
          yield* save(newList)
          return task
        }),
        toggle: Effect.fn("TaskRepo.toggle")(function* (id: TaskId) {
          const list = yield* load
          const [newList, task] = list.toggle(id)
          yield* save(newList)
          return task
        }),
        clear: Effect.fn("TaskRepo.clear")(function* () {
          yield* save(TaskList.empty)
        }),
      }
    })
  )
}

// Commands
const addCmd = Command.make(
  "add",
  { text: Argument.string("task").pipe(Argument.withDescription("Task description")) },
  ({ text }) =>
    Effect.gen(function* () {
      const repo = yield* TaskRepo
      const task = yield* repo.add(text)
      yield* Console.log(`Added task #${task.id}: ${task.text}`)
    })
).pipe(Command.withDescription("Add a new task"))

const listCmd = Command.make(
  "list",
  { all: Flag.boolean("all").pipe(Flag.withAlias("a"), Flag.withDescription("Show all including completed")) },
  ({ all }) =>
    Effect.gen(function* () {
      const repo = yield* TaskRepo
      const tasks = yield* repo.list(all)
      if (tasks.length === 0) { yield* Console.log("No tasks."); return }
      for (const task of tasks) {
        yield* Console.log(`${task.done ? "[x]" : "[ ]"} #${task.id} ${task.text}`)
      }
    })
).pipe(Command.withDescription("List pending tasks"))

const toggleCmd = Command.make(
  "toggle",
  { id: Argument.integer("id").pipe(Argument.withSchema(TaskId)) },
  ({ id }) =>
    Effect.gen(function* () {
      const repo = yield* TaskRepo
      const result = yield* repo.toggle(id)
      yield* Option.match(result, {
        onNone: () => Console.log(`Task #${id} not found`),
        onSome: (task) => Console.log(`Toggled: ${task.text} (${task.done ? "done" : "pending"})`),
      })
    })
).pipe(Command.withDescription("Toggle a task's done status"))

const clearCmd = Command.make("clear", {}, () =>
  Effect.gen(function* () {
    const repo = yield* TaskRepo
    yield* repo.clear()
    yield* Console.log("Cleared all tasks.")
  })
).pipe(Command.withDescription("Clear all tasks"))

const app = Command.make("tasks", {}).pipe(
  Command.withDescription("A simple task manager"),
  Command.withSubcommands([addCmd, listCmd, toggleCmd, clearCmd])
)

// Wire up and run
const cli = Command.run(app, { name: "tasks", version: "1.0.0" })
const mainLayer = Layer.provideMerge(TaskRepo.layer, BunServices.layer)
cli(process.argv).pipe(Effect.provide(mainLayer), BunRuntime.runMain)
```

## API Summary

| Concept | API |
|---------|-----|
| Define command | `Command.make(name, config, handler)` |
| Positional args | `Argument.string`, `Argument.integer`, `Argument.optional`, `Argument.variadic()` |
| Named flags | `Flag.boolean`, `Flag.string`, `Flag.choice`, `Flag.integer` |
| Flag alias | `Flag.withAlias("v")` |
| Descriptions | `Argument.withDescription`, `Flag.withDescription`, `Command.withDescription` |
| Subcommands | `Command.withSubcommands([...])` |
| Run CLI | `Command.run(cmd, { name, version })` |
| Platform layer | `BunServices.layer` or `NodeServices.layer` |

## Version from package.json

```typescript
import pkg from "./package.json" with { type: "json" }

const cli = Command.run(app, { name: "tasks", version: pkg.version })
```

Requires `"resolveJsonModule": true` in tsconfig.
