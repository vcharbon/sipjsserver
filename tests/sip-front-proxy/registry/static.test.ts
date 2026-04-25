/**
 * PR3a — `WorkerRegistry.static` (env-driven dev/local impl).
 *
 * Coverage:
 *   - Env parsing happy-path: PROXY_WORKERS → ordered alive entries.
 *   - Snapshot is non-suspending: `Effect.runSync` works.
 *   - resolve(unknown) → Option.none.
 *   - resolve(known) → Option.some(entry).
 *   - changes is empty (the static impl is, by construction, static).
 *   - Malformed env value → layer build fails with `StaticRegistryParseError`.
 *   - Empty / missing env value → empty registry, not an error.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  StaticRegistryParseError,
  WorkerId,
  WorkerRegistry,
  parseWorkerList,
  workerRegistryFromEnv,
  workerRegistryFromString,
} from "../../../src/sip-front-proxy/index.js"

// `WorkerId` is both a type and a value (a brand factory) — keeping the
// import list as a value-namespace import lets us call WorkerId("…") at
// runtime in test helpers below.

describe("sip-front-proxy/registry/static — parseWorkerList", () => {
  it("parses a single entry", () => {
    const r = parseWorkerList("inline", "pod-0@10.0.0.10:5060")
    expect(r._tag).toBe("ok")
    if (r._tag !== "ok") throw new Error("unreachable")
    expect(r.entries).toEqual([
      {
        id: WorkerId("pod-0"),
        address: { host: "10.0.0.10", port: 5060 },
        health: "alive",
      },
    ])
  })

  it("parses multiple entries with surrounding whitespace", () => {
    const r = parseWorkerList(
      "inline",
      "  pod-0@10.0.0.10:5060 , pod-1@10.0.0.11:5070  "
    )
    expect(r._tag).toBe("ok")
    if (r._tag !== "ok") throw new Error("unreachable")
    expect(r.entries.length).toBe(2)
    expect(r.entries[0]!.id).toBe("pod-0")
    expect(r.entries[1]!.address).toEqual({ host: "10.0.0.11", port: 5070 })
  })

  it("returns ok with empty list for empty input", () => {
    expect(parseWorkerList("inline", "")).toEqual({ _tag: "ok", entries: [] })
    expect(parseWorkerList("inline", "   ")).toEqual({ _tag: "ok", entries: [] })
  })

  it("rejects entries missing the @", () => {
    const r = parseWorkerList("inline", "pod-0:5060")
    expect(r._tag).toBe("error")
  })

  it("rejects empty worker id", () => {
    const r = parseWorkerList("inline", "@10.0.0.10:5060")
    expect(r._tag).toBe("error")
  })

  it("rejects malformed host:port (missing port)", () => {
    const r = parseWorkerList("inline", "pod-0@10.0.0.10")
    expect(r._tag).toBe("error")
  })

  it("rejects port out of range", () => {
    const r = parseWorkerList("inline", "pod-0@10.0.0.10:99999")
    expect(r._tag).toBe("error")
  })

  it("rejects duplicate ids", () => {
    const r = parseWorkerList(
      "inline",
      "pod-0@10.0.0.10:5060,pod-0@10.0.0.11:5061"
    )
    expect(r._tag).toBe("error")
  })

  it("rejects empty entries between commas", () => {
    const r = parseWorkerList("inline", "pod-0@10.0.0.10:5060,,pod-1@10.0.0.11:5061")
    expect(r._tag).toBe("error")
  })
})

describe("sip-front-proxy/registry/static — fromString layer", () => {
  it.effect("snapshot returns the parsed entries (and is non-suspending)", () =>
    Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const snap = yield* reg.snapshot
      expect(snap.length).toBe(2)
      expect(snap.map((e) => e.id).sort()).toEqual(["pod-0", "pod-1"])
      expect(snap.every((e) => e.health === "alive")).toBe(true)

      // D4 invariant: snapshot is just a Ref.get; runSync must succeed.
      // (If snapshot ever started suspending on a sleep / fiber join,
      // runSync would throw `AsyncFiberException`.) The Effect language
      // service flags `runSync` inside Effect.gen as redundant, but in
      // this case the runSync IS the assertion — keep it.
      // @effect-diagnostics-next-line runEffectInsideEffect:off
      const sync = Effect.runSync(reg.snapshot)
      expect(sync.length).toBe(2)
    }).pipe(
      Effect.provide(
        workerRegistryFromString("pod-0@10.0.0.10:5060,pod-1@10.0.0.11:5060")
      )
    )
  )

  it.effect("resolve returns Some for a known id, None otherwise", () =>
    Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const known = yield* reg.resolve(WorkerId("pod-0"))
      expect(Option.isSome(known)).toBe(true)
      if (Option.isSome(known)) {
        expect(known.value.address).toEqual({ host: "10.0.0.10", port: 5060 })
      }
      const missing = yield* reg.resolve(WorkerId("pod-9"))
      expect(Option.isNone(missing)).toBe(true)
    }).pipe(
      Effect.provide(
        workerRegistryFromString("pod-0@10.0.0.10:5060,pod-1@10.0.0.11:5060")
      )
    )
  )

  it.effect("changes stream is empty (static impl emits nothing)", () =>
    Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      // Stream.empty terminates immediately; runCollect yields the empty
      // chunk. No TestClock advance needed.
      const collected = yield* reg.changes.pipe(Stream.runCollect)
      expect(Array.from(collected)).toEqual([])
      // TestClock is unused — this is just to make the test deterministic
      // even if a future change accidentally introduces a delay.
      yield* TestClock.adjust("1 millis")
    }).pipe(Effect.provide(workerRegistryFromString("pod-0@10.0.0.10:5060")))
  )

  it.effect("malformed inline value → Layer build fails with StaticRegistryParseError", () =>
    Effect.gen(function* () {
      const layer = workerRegistryFromString("not-a-valid-entry")
      // Build the layer in a bracketed scope; the failing effect is the
      // layer build itself, so we surface it via Layer.build → Effect.exit.
      const result = yield* Layer.build(layer).pipe(
        Effect.scoped,
        Effect.flip
      )
      expect(result).toBeInstanceOf(StaticRegistryParseError)
      expect(result.source).toBe("<inline>")
    })
  )

  it.effect("empty string → empty registry (not an error)", () =>
    Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const snap = yield* reg.snapshot
      expect(snap).toEqual([])
    }).pipe(Effect.provide(workerRegistryFromString("")))
  )
})

describe("sip-front-proxy/registry/static — fromEnv layer", () => {
  it.effect("reads PROXY_WORKERS at layer build time", () =>
    Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const snap = yield* reg.snapshot
      expect(snap.length).toBe(1)
      expect(snap[0]!.id).toBe("env-pod-0")
      expect(snap[0]!.address).toEqual({ host: "10.10.0.1", port: 5060 })
    }).pipe(
      Effect.provide(workerRegistryFromEnv("PROXY_WORKERS_TEST_OK")),
      Effect.tap(() =>
        Effect.sync(() => {
          // No-op; the env var was already set in the wrapper below.
        })
      )
    )
  )

  it.effect("missing env var → empty registry", () =>
    Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const snap = yield* reg.snapshot
      expect(snap).toEqual([])
    }).pipe(Effect.provide(workerRegistryFromEnv("PROXY_WORKERS_TEST_MISSING")))
  )

  it.effect("malformed env value → Layer build fails", () =>
    Effect.gen(function* () {
      const result = yield* Layer.build(
        workerRegistryFromEnv("PROXY_WORKERS_TEST_BAD")
      ).pipe(Effect.scoped, Effect.flip)
      expect(result).toBeInstanceOf(StaticRegistryParseError)
      expect(result.source).toBe("PROXY_WORKERS_TEST_BAD")
    })
  )
})

// Set env vars for the fromEnv tests at module load — process.env is
// global and the layer builders call it lazily inside Effect.suspend, so
// per-test wiring sees the values set here.
process.env["PROXY_WORKERS_TEST_OK"] = "env-pod-0@10.10.0.1:5060"
process.env["PROXY_WORKERS_TEST_BAD"] = "this-is-not-valid"
delete process.env["PROXY_WORKERS_TEST_MISSING"]
