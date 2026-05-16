# TypeScript & Effect Conventions

All code uses TypeScript with Effect v4 (effect-smol). When designing or modifying TypeScript in this project, activate the `effect` skill first to load the idiomatic-usage guide.
If `<ide_diagnostics>` errors look stale or contradict `npm run typecheck`, trust typecheck — the IDE process is sometimes one edit behind.

NEVER use resource reservation in a way that doesnt guarnatee that the resourec is cleared. Always use the safe resource usage way. For Semaphore this means never use  Semaphore.take(sem, X) then code then Semaphore.release() , always use Semaphore.withPermit instead.

## Core patterns

- Services, Layers, `Effect.gen`, `Schema`, typed errors.
- Mocks and test implementations live alongside the production service as test layers.
- When adding dependencies, verify they are installed in the correct workspace package.
- `npm run typecheck` must return zero errors and zero warnings after every change. Fix warnings — do not ignore them. Only suppress with a lint-disable comment as a last resort, always with an explanation.
- for pure function that may return an error, use effect Result construct

## Effect v4 vs v3

The LLM's Effect priors come from v3 examples. v4 renamed or removed enough surface that every Effect-touching slice would otherwise hit a compile-failure → grep-the-d.ts → fix loop. Most v3 names that survive type-check at all are flagged by the Effect plugin as `outdatedApi` warnings — never ignore those.

### Genuine renames

- `Effect.fork` → `Effect.forkChild` (or `forkScoped` / `forkDetach` per scope). The bare `fork` is gone; the language service tags it `outdatedApi`.
- `Layer.scoped` → `Layer.effect`, `Layer.scopedDiscard` → `Layer.effectDiscard`, `Layer.scopedContext` doesn't exist (use `Layer.effectServices`).
- `Effect.async` → `Effect.callback`.
- `Effect.clock` → `Clock.currentTimeMillis` (direct module access — no service-fetching helper).
- `TimeoutException` → `TimeoutError` (the catch tag for `Effect.timeout`).
- `Duration.DurationInput` → `Duration.Input`.
- `Duration.decode` → `Duration.fromInputUnsafe`.
- `Stream.mapConcat` → `Stream.flatMap` + `Stream.fromIterable`.
- `Stream.runCollect` returns `Array<A>`, **not** `Chunk<A>`. Wrapping with `Chunk.toReadonlyArray` panics at runtime with an opaque `Cannot read properties of undefined (reading '_tag')`. Drop the Chunk reflex.
- `Effect.runFork` inside an Effect surface loses parent service context; use `Effect.runForkWith(parentServices)(...)`.
- `Ref.unsafeSet` doesn't exist; for sync state use `MutableRef` + `Effect.sync` wrappers.
- `Effect.fail(new TaggedError(...))` is wrong; the v4 idiom is `yield* new TaggedError({...})` directly.
- `Effect.Logger.make`'s annotations moved to `opts.fiber.getRef(References.CurrentLogAnnotations)`.

### Things that look like renames but aren't

- `Stream.interruptAfter` doesn't exist — use `Stream.haltWhen(Effect.sleep(...))` or `Stream.interruptWhen(...)`.
- `ServiceMap.Service.Of` doesn't exist — there is no resolved-shape helper.
- `Effect.makeSemaphore` returns an `Effect`. For code paths that have to stay synchronous (e.g. fabric layers built outside an Effect scope), use `Semaphore.makeUnsafe(1)`.
- `PubSub` has no unsafe constructor — only `make` / `bounded` / `sliding` / `unbounded`, all returning Effects. Forces async construction in places that should be sync.

### `Effect.catchAll` is gone — on purpose

This is the most commonly mis-fixed v3 → v4 case, and the mis-fix is silent (compiles, runs, swallows defects). v4 removed `catchAll` because it's an anti-pattern: it erases error-channel typing, swallows defects, and hides intent. The replacements are narrow:

- `Effect.catchTag` / `Effect.catchTags` for known typed errors (preferred — keeps the error channel honest).
- `Effect.catchCause` only when you genuinely need to handle defects + interrupts together. Rare; document at the call site why a defect-swallowing catch is correct here.

Reaching for `catchCause` as a drop-in replacement for v3 `catchAll` is a regression — it re-introduces the same anti-pattern v4 removed.


### `preferSchemaOverJson` plugin warning

The Effect plugin flags `JSON.parse` / `JSON.stringify` calls inside `Effect.gen` with: *"Effect Schema provides Effect-aware APIs"*. The rule is enforced by the plugin running inside `tsc`, not eslint — `eslint-disable-next-line` is noise, the warning ignores it.

For genuinely opaque payload pass-through (e.g. round-tripping a `string` body the caller already validated), extract the `JSON.stringify` / `JSON.parse` call into a top-level pure helper *outside* `Effect.gen`. The rule doesn't apply to plain functions. For payloads where the schema is known, switch to the Schema-based codec — that's what the rule is steering toward.

```ts
// Plugin warns inside Effect.gen
yield* Effect.sync(() => MutableHashMap.set(store, key, JSON.stringify(payload)))

// No warning — pure helper outside the generator
const encodeOpaque = (x: unknown): string => JSON.stringify(x)
yield* Effect.sync(() => MutableHashMap.set(store, key, encodeOpaque(payload)))
```



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

E2E tests use `@effect/vitest`'s `it.effect`, which runs under `TestClock`. `Effect.sleep` and any fiber that yields to the clock will **not** advance on its own — virtual time only moves when something calls `TestClock.adjust` (or the new `pumpAll`).

### Fake-stack tests: use `pumpAll`, not hand-tuned adjusts

The fake-stack test layer (`tests/support/fakeStack.ts`, `tests/support/proxy-fakeStack.ts`, `tests/support/proxyB2bFakeStack.ts`) provides `PumpableClockLayer` ([tests/support/PumpableClock.ts](../tests/support/PumpableClock.ts)) under `Clock.Clock`. It satisfies the upstream `TestClock` contract (so `TestClock.adjust(...)` keeps working) AND exposes pending-sleep introspection used by `pumpAll`.

`pumpAll` ([tests/support/pumpAll.ts](../tests/support/pumpAll.ts)) advances exactly to the next pending deadline, fires it, yields the scheduler, repeats — until the simulated network and pending-sleep queue are both empty. It is what powers:

- `topology.pump()` in [tests/support/topologies.ts](../tests/support/topologies.ts)
- `settle()` in [tests/fullcall/framework/simulated-backend.ts](../tests/fullcall/framework/simulated-backend.ts)

**Rule for new fake-stack scenarios:** prefer `yield* Effect.sleep(...)` in scenario code and let the harness's between-step pump drive convergence. Reach for `TestClock.adjust("N millis")` only when the test deliberately needs to fire a *named* time boundary (e.g. registry watcher tests, draining grace tests).

`pumpAll` returns a `PumpReport` — `realProbeWasUseful: true` means the test depends on real I/O (Redis / disk / live socket); `periodicSuspects` lists durations that fired more than the threshold. The simulated-backend `settle` surfaces both as warnings.

### Real-time samplers must escape the virtual clock

Any background sampler, periodic gauge, or watchdog that must keep ticking in real wall-clock time under tests must use raw `setInterval` / `setTimeout` — not `Effect.sleep`.

```typescript
const interval = setInterval(() => { /* sample */ }, 100)
interval.unref()  // don't keep the Node event loop alive just for this
yield* Effect.addFinalizer(() => Effect.sync(() => clearInterval(interval)))
```

Existing instances:
- `OverloadController` loop-lag EWMA sampler ([src/b2bua/OverloadController.ts](../src/b2bua/OverloadController.ts))
- `Dispatcher` worker-kill escalation timer ([src/cluster/Dispatcher.ts](../src/cluster/Dispatcher.ts))

**Symptom of getting this wrong:** e2e tests hang at the 30s timeout because the sampler fiber is suspended on a virtual clock that nothing advances. If only `it.effect` cases hang while `it.live` cases pass, suspect a missed `setInterval`.

### TestClock + scheduler-invisible async work

A more subtle hazard: async producers whose work is **invisible to both** of the harness's quiescence signals (pending sleeps, simulated-network in-flight). The canonical example is `PerCallDispatcher` — its worker fiber is parked on `Queue.take` when idle, and a fiber parked on `Queue.take` is invisible to TestClock (no pending sleep) and invisible to `SignalingNetwork` (no packet in transit). The test fiber then resumes from its own pause via `Latch.openUnsafe → flushWaiters → fiber.evaluate`, which runs the test continuation **synchronously** — straight through to the next assertion, before the worker has had a single scheduler tick to dequeue.

We hit this trying to wire the dispatcher into fake-clock matrix tests. The order of attempts and why each failed is the cautionary tale:

| Attempt | Why it fails |
|---|---|
| `yield* Effect.yieldNow` after `Queue.offerUnsafe` | The test fiber's resume is synchronous via `flushWaiters` — it bypasses the scheduler queue entirely. yieldNow gives a setImmediate cycle, but the test fiber already ran its synchronous chain. |
| `yieldNow ×5` | Same root cause — more yields don't help when the competing fiber doesn't yield through the scheduler at all. |
| `yieldNowWith(priority)` | Priority orders tasks **within** one setImmediate batch. The test fiber's continuation isn't *in* the batch — it's a synchronous chain triggered earlier. |
| `yieldNow + Effect.sleep("1 millis")` | The sleep registers AFTER yieldNow yields. By then the test fiber has already blasted through to the failing assertion. |
| `Deferred` await on worker dequeue | Blocks the router fiber, but the test fiber doesn't care about the router being blocked. The test fiber and router are independent. |
| `pumpAll` reads dispatcher pendingWork | Wrong code path — most fake-clock tests use `TestClock.adjust` directly (via the harness's `clockSleep`), not `pumpAll`. |

The **correct** fix is to share a counter between the producer and the clock, and have the clock's `adjust` drain the counter to zero between latch fires. We expose this via the `TestPace` service ([src/observability/TestPace.ts](../src/observability/TestPace.ts)):

```ts
// Optional service — resolved with Effect.serviceOption so production
// composition can omit it and the producer's begin/end calls become no-ops.
interface TestPaceShape {
  readonly beginWork: () => void  // producer submits async work
  readonly endWork: () => void    // producer completes async work
  readonly pendingWork: () => number
}
```

- `PumpableClock` ([tests/support/PumpableClock.ts](../tests/support/PumpableClock.ts)) provides the real implementation. The same internal counter drives a `drainAsyncWork` Effect that loops `Effect.yieldNow` (bounded budget, default 32 yields) until `pendingWork() === 0`. `adjust` invokes `drainAsyncWork` after firing each latch and once more in a tail position. Sharing a single SUT-scoped counter means multi-worker test stacks all feed into the same drain.
- `PerCallDispatcher` resolves `Effect.serviceOption(TestPace)` at layer-build time. `beginWork` runs after a successful `Queue.offerUnsafe`; `endWork` runs after the worker body completes. Production composition omits the layer; both calls become no-ops at runtime.

**The rule for any new async producer that mirrors this shape:**

If your service submits work to a fiber that parks on something invisible to `pendingSleeps` / `network.inFlight` (a Queue.take, a PubSub subscription, a custom Latch you opened from somewhere the harness doesn't know about), **register the work with `TestPace`**. Without it, the test fiber's continuation will race ahead of the producer's body execution under TestClock — and the failure mode is silent (an assertion sees stale state, no exception, no hang).

```ts
// Wrong — fake-clock tests will race the assertion ahead of the worker
const enqueue = (item) =>
  Effect.gen(function* () {
    Queue.offerUnsafe(myQueue, item)
    yield* Effect.yieldNow  // does not solve the problem, see table above
  })

// Right — fake-clock harness can drain the producer's work between latch fires
const enqueue = (item) =>
  Effect.gen(function* () {
    const paceOpt = yield* Effect.serviceOption(TestPace)
    Queue.offerUnsafe(myQueue, item)
    if (paceOpt._tag === "Some") paceOpt.value.beginWork()
    // ... worker calls paceOpt.value.endWork() after the item is fully processed ...
  })
```

**Symptom of getting this wrong:** assertions in matrix-style multi-step scenarios pass under `it.live` but fail intermittently under `it.effect` with the assertion reading state from "before" the worker's body ran. The dispatcher's POISON / DECR / write-cdr effects look like they "didn't happen" — they did, just after the assertion. Add a debug `console.log` at the worker's body-start and the assertion's read site; if the body-start prints **after** the assertion, this is the bug.

### Two clocks under one test, one mental model

There are conceptually two clocks in a fake-clock test, but Effect lets the harness make them look like one:

- **Virtual clock** (`Clock.Clock` / `TestClock`): advanced explicitly by the test harness via `TestClock.adjust` or `pumpAll`. `Effect.sleep` reads it. The clock the SUT thinks it's running under.
- **Real clock** (Node event loop, setImmediate): drives fiber scheduling — what `yieldNow` and `Effect.callback` resumes ride on. The clock the JS engine actually runs under.

Code that lives entirely under one of those clocks is fine. The hazard is **producer/consumer pairs split across the two**: a producer registering work that the consumer will pick up via the **real** scheduler (the Queue.take wake-up uses setImmediate via `scheduleReleaseTaker`), while the test fiber's pacing is on the **virtual** clock. The two clocks have independent notions of "ready" — and `pumpAll`'s quiescence model only knows about the virtual side.

`TestPace` is the bridge. Any code that crosses the boundary — virtual-clock-driven offer → real-scheduler-driven dequeue → virtual-clock-driven completion (via outbound transit, internal sleep, …) — should funnel its "pending" state through this single service so the harness has a unified ready-signal.

## Layer combinator direction

Layer composition is the single most common source of confusion when wiring services. The combinator names are subtle, the type errors land far from the cause, and bottom-up vs top-down reading flips depending on which combinator you're looking at. Internalise the direction-arrow contract below before writing new layer compositions.

| Combinator | Reads as | Output | Notes |
|------------|----------|--------|-------|
| `parent.pipe(Layer.provide(child))` | "child satisfies parent's requirements; only `parent`'s services are exposed" | `Layer<A, E1\|E2, R_parent_remaining \| R_child>` | child is BELOW parent in the dependency graph; child is *consumed*, not re-exported |
| `parent.pipe(Layer.provideMerge(child))` | "child satisfies parent's requirements; both outputs are exposed" | `Layer<A_parent \| A_child, ..., ...>` | same direction as `provide`, but the merged result lets downstream code see both sets of services |
| `Layer.merge(a, b)` | "two siblings combined; neither satisfies the other" | `Layer<A_a \| A_b, ..., R_a \| R_b>` | requirements are unioned; nothing wired |
| `Layer.mergeAll(...layers)` | n-ary `merge` | union of all outputs | use for hoisting shared layers (e.g. a single `WriteNotifier.layer` consumed by multiple peers) |

**Direction arrow:** `provide` and `provideMerge` push *child below parent*. The pipe reads top-to-bottom but the dependency graph reads bottom-up — `parent.pipe(provide(child))` means child is the foundation, parent rests on it.

**Most common mistake:** reading `parent.pipe(Layer.provideMerge(child))` as "parent provides child". It's the reverse.

### Debugging recipe — "Service not found: X"

When `Service not found: X` surfaces deep inside a `Stream` pull or a forked fiber (i.e. far from where the layer was constructed), the answer is almost always one of two things:

1. **A `provide` that should have been `provideMerge`.** The layer that *constructed* X correctly sees its dependency, but downstream code (a Stream subscriber, a forked effect) loses access because `provide` consumed X without re-exporting it.
2. **A provider memoized in the wrong scope** — see "Single shared instance for in-process PubSub" below. Two layers each `Layer.provide(WriteNotifier.layer)` on themselves end up with two distinct hubs; the producer publishes to one, the subscriber subscribes to the other, and writes silently never reach subscribers.

If the error is at runtime (not at layer build), it's almost never an actual missing service — Effect would have failed layer construction. It's a duplicated instance.

## Single shared instance for in-process PubSub / Hub bridges

When a `PubSub` (or any in-process `Hub` service) is the *bridge* between a producer service and a separate consumer service, both must see the same memoized instance. Embedding the hub layer inside the producer's layer (so it appears as an internal detail of `producer.layer`) breaks the bridge: the consumer's parallel `provide(hub.layer)` builds a second hub, and the producer publishes into a hub the consumer never subscribed to.

**Rule:** hoist the hub's layer to the outermost composition. Both producer and consumer layers should require it externally.

```ts
// WRONG — producer's redisLayer internally provides WriteNotifier.
// ReplLog elsewhere does its own Layer.provide(WriteNotifier.layer)
// and ends up subscribed to a different hub.
const ProducerLayer = makeProducer.pipe(
  Layer.provide(WriteNotifier.layer)   // hidden internal instance
)

// CORRECT — single hub at the top, both consumers reach the same one.
const NotifierLayer = WriteNotifier.layer
const ProducerLayer = makeProducer.pipe(Layer.provide(NotifierLayer))
const ConsumerLayer = makeConsumer.pipe(Layer.provide(NotifierLayer))
const HttpLayer = serverLayer.pipe(
  Layer.provide(ProducerLayer),
  Layer.provide(ConsumerLayer),
  Layer.provide(NotifierLayer)
)
```

This is the contract for [`src/replication/WriteNotifier.ts`](../src/replication/WriteNotifier.ts) — the writer publishes through it, `ReplLog` subscribes through it. Same applies to any future in-process hub used to decouple producer/consumer in a worker process.

**Symptom of getting this wrong:** the second test in a producer/consumer integration suite times out (5s default in `it.effect`) because the consumer's stream never receives anything. There's no exception — the published events go into the void.

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
## Must-run patterns (uninterruptible regions, finalizers, scope cleanup)

| Wrapper                              | Body must be                                       |
|--------------------------------------|----------------------------------------------------|
| `Effect.uninterruptibleMask(...)`  | sync JS or non-blocking submit                     |
| `Effect.ensuring(finalizer)`       | sync JS or non-blocking submit                     |
| `Effect.onExit((exit) => ...)`     | sync JS or non-blocking submit                     |
| `Semaphore.withPermits(1)(release)`| sync JS (the v4 release IS sync)                   |
| Layer / Scope finalizer              | sync JS or non-blocking submit                     |

Blocking IO (Redis call, NDJSON `appendFile`, DNS-resolving `dgram.send`) inside any of these positions creates an un-killable fiber. Route the IO through a buffered drainer pool — see [BufferedUdpEndpoint](../src/sip/BufferedUdpEndpoint.ts) (template), [BufferedCdrLayer](../src/cdr/BufferedCdrLayer.ts), and [BufferedTerminateWriter](../src/cache/BufferedTerminateWriter.ts).

Read [docs/adr/0003-must-run-effects-under-interruption.md](adr/0003-must-run-effects-under-interruption.md) before modifying the rule framework, the SipRouter consumer loop, or call-lifecycle code.
