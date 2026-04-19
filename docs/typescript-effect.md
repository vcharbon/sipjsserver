# TypeScript & Effect Conventions

All code uses TypeScript with Effect v4 (effect-smol). When designing or modifying TypeScript in this project, activate the `effect` skill first to load the idiomatic-usage guide.

## Core patterns

- Services, Layers, `Effect.gen`, `Schema`, typed errors.
- Mocks and test implementations live alongside the production service as test layers.
- When adding dependencies, verify they are installed in the correct workspace package.
- `npm run typecheck` must return zero errors and zero warnings after every change. Fix warnings — do not ignore them. Only suppress with a lint-disable comment as a last resort, always with an explanation.

## MutableHashMap for shared mutable state

All hot-path shared maps in services (`TransactionLayer`, `CallState`, `TimerService`, transaction tables, SIP index, semaphores, timer fibers) use `MutableHashMap.empty<K, V>()` — **never** `Ref<Map<K, V>>`. `Ref.update` copies the entire Map on every write; at high CPS this causes GC thrashing and CPU climbing over time. `Ref` is fine for simple scalar counters.

### Rules

1. **Always wrap mutations in `Effect.sync`.** Every `MutableHashMap.set` / `MutableHashMap.remove` call must be inside `yield* Effect.sync(() => ...)` in a generator, or returned as `Effect.sync(() => ...)` from a helper. Mutating shared state is a side effect — Effect must control when it executes.

   ```typescript
   // CORRECT — mutation wrapped in Effect.sync
   yield* Effect.sync(() => MutableHashMap.set(myMap, key, value))
   yield* Effect.sync(() => MutableHashMap.remove(myMap, key))

   // CORRECT — batch multiple mutations in one Effect.sync
   yield* Effect.sync(() => {
     MutableHashMap.remove(myMap, key1)
     MutableHashMap.remove(myMap, key2)
   })

   // CORRECT — helper that returns an Effect
   const indexCall = (call: Call): Effect.Effect<void> =>
     Effect.sync(() => {
       MutableHashMap.set(sipIndex, key1, call.callRef)
       MutableHashMap.set(sipIndex, key2, call.callRef)
     })

   // WRONG — bare mutation outside Effect.sync
   MutableHashMap.set(myMap, key, value)
   ```

2. **Reads via `MutableHashMap.get` return `Option`.** Use `Option.getOrUndefined` to convert:

   ```typescript
   const value = Option.getOrUndefined(MutableHashMap.get(myMap, key))
   ```

3. **Iteration** uses `for...of` directly (MutableHashMap is `Iterable<[K, V]>`):

   ```typescript
   for (const [key, value] of myMap) { ... }
   ```

4. **Size** via `MutableHashMap.size(myMap)` — O(1).

## TestClock vs real-time samplers / timers

E2E tests use `@effect/vitest`'s `it.effect`, which runs under `TestClock`. `Effect.sleep` and any fiber that yields to the clock will **not** advance unless the test explicitly calls `TestClock.adjust`. This is a recurring landmine.

**Rule:** any background sampler, periodic gauge, or watchdog that must keep ticking in real wall-clock time under tests must use raw `setInterval` / `setTimeout` — not `Effect.sleep`.

```typescript
const interval = setInterval(() => { /* sample */ }, 100)
interval.unref()  // don't keep the Node event loop alive just for this
yield* Effect.addFinalizer(() => Effect.sync(() => clearInterval(interval)))
```

Existing instances:
- `OverloadController` loop-lag EWMA sampler ([src/b2bua/OverloadController.ts](../src/b2bua/OverloadController.ts))
- `Dispatcher` worker-kill escalation timer ([src/cluster/Dispatcher.ts](../src/cluster/Dispatcher.ts))

**Symptom of getting this wrong:** e2e tests hang at the 30s timeout because the sampler fiber is suspended on a virtual clock that nothing advances. If only `it.effect` cases hang while `it.live` cases pass, suspect a missed `setInterval`.

## Provide scoped layers at the outermost effect

Resources allocated inside a scope — including any layer whose build yields `Effect.acquireRelease` / `Effect.addFinalizer` or a scoped service — are torn down the moment the scoping effect returns.

**Rule — full-application-lifetime layers:** layers meant to live for the whole app or whole test (UdpTransport, SignalingNetwork, AppConfig, MetricsRegistry, etc.) must be provided at the outermost effect, typically via `Layer.mergeAll(...)` at the test or app entrypoint. Providing them on a sub-effect binds their scope to that sub-effect's lifetime and the finalizers fire as soon as it returns — silently.

Short-lived, intentionally scoped resources (e.g. a DB connection you want to release after a block) are the exception: providing those at the sub-effect level is *the* point.

```ts
// WRONG — scope closes when the inner gen returns; UdpTransport's
// bindUdp finalizer fires before the test body ever sends a packet.
const udp = yield* Effect.gen(function* () {
  return yield* UdpTransport
}).pipe(Effect.provide(UdpLayer))

// CORRECT — one outer scope spans the whole test body.
Effect.gen(function* () {
  const udp = yield* UdpTransport
  // ... use udp ...
}).pipe(Effect.provide(Layer.mergeAll(UdpLayer, NetworkLayer, AppConfigLayer)))
```

**Symptom of getting this wrong:** counters read 0, routing-table lookups miss, `bindUdp` finalizers log teardown before the test asserts — indistinguishable on the surface from a metrics bug.

## `Global 'Error' loses type safety`

The Effect language-service surfaces this warning when an untyped `Error` reaches a code path that expects a typed failure:

> Global 'Error' loses type safety. Consider using a tagged error with `Data.TaggedError` or `Schema.TaggedError`.

The offender is usually a plain `throw new Error(...)` inside an `Effect.gen` or an `Effect.try` that returns `Effect<..., unknown>`. Replacing the throw with a `Data.TaggedError` makes the failure channel typed and satisfies the warning.

When the error is genuinely infrastructure-level (socket gone, malformed test fixture, assertion failure) and the caller cannot meaningfully recover, use `Effect.orDie` instead — it promotes the error to a defect, removes it from the typed channel entirely, and silences the warning at the boundary:

```ts
// Before — typed channel includes `unknown`, warning fires
const runScoped = <A, E>(eff: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.scoped(eff)

// After — infrastructure errors become defects at the harness boundary
const runScoped = <A, E>(eff: Effect.Effect<A, E, Scope.Scope>): Effect.Effect<A, never> =>
  Effect.orDie(Effect.scoped(eff))
```

Pick `Data.TaggedError` when the caller needs to branch on the failure, `Effect.orDie` when they don't.