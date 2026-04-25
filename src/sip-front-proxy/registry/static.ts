/**
 * Static `WorkerRegistry` — D3, env-driven impl for dev/local.
 *
 * Reads `PROXY_WORKERS` (or an explicit string passed to `fromString`) at
 * Layer build time. The format is comma-separated tuples:
 *
 *   PROXY_WORKERS=pod-0@10.0.0.10:5060,pod-1@10.0.0.11:5060
 *
 * Whitespace around entries is tolerated; everything else (missing `@`,
 * empty id, malformed `host:port`, duplicate id, port out of range) is a
 * **layer-build failure**: production-style misconfiguration should fail
 * the proxy at startup, not silently route nowhere. We surface this with
 * a `Data.TaggedError` so callers can pattern-match on the failure tag.
 *
 * The static registry is "static" in the literal sense — `changes` never
 * emits anything, and every snapshot returns the same list. K8s-driven
 * dynamic membership lives in PR5's `kubernetesStatefulSet` impl.
 */

import { Data, Effect, HashMap, Layer, Ref, Stream } from "effect"
import type { SocketAddr } from "../RoutingStrategy.js"
import {
  type RegistryEvent,
  WorkerId,
  WorkerRegistry,
  type WorkerRegistryApi,
  type WorkerEntry,
} from "./WorkerRegistry.js"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Layer-build failure when the static registry cannot parse its source.
 * Carries a human-readable `reason` for logs and a `source` that points
 * at the offending input (e.g. `"PROXY_WORKERS"`, `"<inline>"`).
 */
export class StaticRegistryParseError extends Data.TaggedError(
  "StaticRegistryParseError"
)<{
  readonly reason: string
  readonly source: string
}> {}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const parseSocketAddr = (raw: string): SocketAddr | undefined => {
  const colon = raw.lastIndexOf(":")
  if (colon === -1) return undefined
  const host = raw.slice(0, colon).trim()
  const portStr = raw.slice(colon + 1).trim()
  if (host.length === 0 || portStr.length === 0) return undefined
  const port = Number.parseInt(portStr, 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return undefined
  return { host, port }
}

/**
 * Parse `id@host:port,id@host:port,...` into a list of `WorkerEntry`s,
 * all marked `alive`. Returns a tagged result so the Layer builder can
 * lift the failure into a tagged effect error.
 */
export const parseWorkerList = (
  source: string,
  raw: string
):
  | { readonly _tag: "ok"; readonly entries: ReadonlyArray<WorkerEntry> }
  | { readonly _tag: "error"; readonly reason: string } => {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return { _tag: "ok", entries: [] }
  }
  const out: WorkerEntry[] = []
  const seen = new Set<string>()
  const parts = trimmed.split(",")
  for (const partRaw of parts) {
    const part = partRaw.trim()
    if (part.length === 0) {
      return { _tag: "error", reason: `empty entry in ${source}` }
    }
    const at = part.indexOf("@")
    if (at <= 0 || at === part.length - 1) {
      return {
        _tag: "error",
        reason: `entry "${part}" must be of the form id@host:port`,
      }
    }
    const id = part.slice(0, at).trim()
    if (id.length === 0) {
      return { _tag: "error", reason: `empty worker id in entry "${part}"` }
    }
    if (seen.has(id)) {
      return { _tag: "error", reason: `duplicate worker id "${id}"` }
    }
    seen.add(id)
    const addr = parseSocketAddr(part.slice(at + 1))
    if (addr === undefined) {
      return {
        _tag: "error",
        reason: `entry "${part}" has malformed host:port (port must be 1..65535)`,
      }
    }
    out.push({ id: WorkerId(id), address: addr, health: "alive" })
  }
  return { _tag: "ok", entries: out }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const makeFromEntries = (
  entries: ReadonlyArray<WorkerEntry>
): Effect.Effect<WorkerRegistryApi> =>
  Effect.gen(function* () {
    // The list is fixed at construction time, but we still front it with a
    // `Ref` so `snapshot`/`resolve` look identical to the simulated /
    // Kubernetes impls (D4: snapshot == Ref.get, no suspension).
    const stateRef = yield* Ref.make(
      HashMap.fromIterable(entries.map((e) => [e.id, e] as const))
    )

    // ── D4 invariant: pure Ref.get reads, no I/O, no Effect.sleep. ──────
    const snapshot: Effect.Effect<ReadonlyArray<WorkerEntry>> = Ref.get(stateRef).pipe(
      Effect.map((map) => Array.from(HashMap.values(map)))
    )
    const resolve = (id: WorkerId) =>
      Ref.get(stateRef).pipe(Effect.map((map) => HashMap.get(map, id)))

    // No dynamic membership in the static impl.
    const changes: Stream.Stream<RegistryEvent> = Stream.empty

    return {
      snapshot,
      resolve,
      changes,
    } satisfies WorkerRegistryApi
  })

// ---------------------------------------------------------------------------
// Layer factories
// ---------------------------------------------------------------------------

/**
 * Build a Layer providing `WorkerRegistry` from an inline string (for
 * tests and programmatic wiring). Same grammar as `PROXY_WORKERS`. Fails
 * the layer with `StaticRegistryParseError` on malformed input.
 */
export const fromString = (
  raw: string,
  source = "<inline>"
): Layer.Layer<WorkerRegistry, StaticRegistryParseError> =>
  Layer.effect(
    WorkerRegistry,
    Effect.suspend(() => {
      const result = parseWorkerList(source, raw)
      if (result._tag === "error") {
        return Effect.fail(
          new StaticRegistryParseError({ reason: result.reason, source })
        )
      }
      return makeFromEntries(result.entries)
    })
  )

/**
 * Build a Layer providing `WorkerRegistry` from the `PROXY_WORKERS`
 * environment variable. Missing / empty → empty registry (snapshot is
 * `[]`, every `resolve` is `Option.none`). Malformed → layer-build
 * failure.
 *
 * Reading `process.env` is wrapped in `Effect.suspend` so the env lookup
 * happens at layer-build time rather than module-evaluation time — this
 * matters for tests that override `PROXY_WORKERS` per-suite.
 */
export const fromEnv = (
  envVar = "PROXY_WORKERS"
): Layer.Layer<WorkerRegistry, StaticRegistryParseError> =>
  Layer.effect(
    WorkerRegistry,
    Effect.suspend(() => {
      const raw = process.env[envVar] ?? ""
      const result = parseWorkerList(envVar, raw)
      if (result._tag === "error") {
        return Effect.fail(
          new StaticRegistryParseError({ reason: result.reason, source: envVar })
        )
      }
      return makeFromEntries(result.entries)
    })
  )
