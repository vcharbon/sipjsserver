/**
 * MetricsServer — PR6.
 *
 * Tiny HTTP server that exposes Prometheus exposition (text v0.0.4) at
 * `:port/metrics`. Built on `node:http` directly — no Express, no
 * `@effect/platform-node` HTTP layer, because the proxy package's
 * dependency boundary forbids the latter and Express isn't on the dep
 * tree.
 *
 * Layer lifecycle. The server is bound on layer build and closed on
 * layer release via `Effect.acquireRelease`. The listening port is
 * configurable; binding `0` lets the OS pick a free port (used by tests).
 *
 * Exposition rendering. We walk every metric the Effect runtime knows
 * about via `Metric.snapshot`, filter to the ones whose name starts with
 * `sip_` (so worker / B2BUA metrics in a shared process don't bleed in),
 * and render each snapshot type:
 *
 *   - `Counter`   → one `<name>{labels} <count>` line.
 *   - `Gauge`     → one `<name>{labels} <value>` line.
 *   - `Histogram` → one bucket line per boundary, plus `_bucket{le=+Inf}`,
 *                   `_sum`, `_count`. Cumulative bucket counts per Prom.
 *   - `Summary`   → quantile lines + `_sum` + `_count`. (Not used today
 *                   but the renderer handles it for forward-compat.)
 *   - `Frequency` → one line per occurrence value (label `value=`).
 *
 * Labels. Effect labels are stamped via `Metric.withAttributes`, which
 * appends them to the metric metadata. Two metric instances with the
 * same `id` but different attribute sets become two snapshots — exactly
 * the cardinality model Prometheus expects.
 */

import { createServer, type Server } from "node:http"
import { Data, Effect, Layer, type Scope, ServiceMap } from "effect"
import { snapshot as metricSnapshot } from "./Metrics.js"

class MetricsServerBindError extends Data.TaggedError("MetricsServerBindError")<{
  readonly cause: unknown
}> {}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MetricsServerOpts {
  /** Bind host. Default `"0.0.0.0"`. */
  readonly host?: string
  /** Bind port. Use `0` to let the OS pick. Default `9090`. */
  readonly port?: number
  /**
   * Substring filter for metric ids. Default `"sip_"` — only proxy metrics
   * are exposed. Set to `""` to export every registered metric.
   */
  readonly idPrefix?: string
}

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export interface MetricsServerApi {
  /** Bound address — host + actual port (after OS-assigned-port resolution). */
  readonly address: { readonly host: string; readonly port: number }
  /**
   * Render the Prometheus exposition body that `/metrics` would return
   * right now. Useful for tests and for status-page bundling.
   */
  readonly render: Effect.Effect<string>
}

export class MetricsServer extends ServiceMap.Service<MetricsServer, MetricsServerApi>()(
  "@sipjsserver/sip-front-proxy/MetricsServer"
) {
  static readonly layer = (
    opts: MetricsServerOpts = {}
  ): Layer.Layer<MetricsServer> => Layer.effect(MetricsServer, makeServer(opts).pipe(Effect.orDie))
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

const DEFAULT_HOST = "0.0.0.0"
const DEFAULT_PORT = 9090
const DEFAULT_PREFIX = "sip_"

function makeServer(
  opts: MetricsServerOpts
): Effect.Effect<MetricsServerApi, MetricsServerBindError, Scope.Scope> {
  const host = opts.host ?? DEFAULT_HOST
  const requestedPort = opts.port ?? DEFAULT_PORT
  const idPrefix = opts.idPrefix ?? DEFAULT_PREFIX

  const render: Effect.Effect<string> = metricSnapshot.pipe(
    Effect.map((snaps) => renderPrometheus(snaps, idPrefix))
  )

  // We capture parent services so the request handler (a node:http
  // callback) can run the render effect in the same runtime — annotated
  // logs and timing services flow through.
  return Effect.gen(function* () {
    const parentServices = yield* Effect.services<never>()

    const server: Server = createServer((req, res) => {
      // Only handle GET /metrics; anything else gets a 404 so the exposed
      // surface is intentional. We don't even try to be RESTful.
      if (req.method !== "GET" || (req.url ?? "/").split("?")[0] !== "/metrics") {
        res.statusCode = 404
        res.setHeader("content-type", "text/plain; charset=utf-8")
        res.end("not found\n")
        return
      }
      // Run the render effect on the parent runtime — this gives us the
      // same Metric registry the proxy core writes to.
      Effect.runPromiseWith(parentServices)(render).then(
        (body) => {
          res.statusCode = 200
          res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8")
          res.end(body)
        },
        (err) => {
          res.statusCode = 500
          res.setHeader("content-type", "text/plain; charset=utf-8")
          res.end(`render error: ${String(err)}\n`)
        }
      )
    })

    const bound = yield* Effect.callback<
      { host: string; port: number },
      MetricsServerBindError
    >((resume) => {
      server.once("error", (err) => resume(Effect.fail(new MetricsServerBindError({ cause: err }))))
      server.listen(requestedPort, host, () => {
        const addr = server.address()
        if (addr === null || typeof addr === "string") {
          resume(
            Effect.fail(
              new MetricsServerBindError({
                cause: `unexpected address ${String(addr)}`,
              })
            )
          )
          return
        }
        resume(Effect.succeed({ host: addr.address, port: addr.port }))
      })
    })

    yield* Effect.addFinalizer(() =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void))
      })
    )

    return {
      address: bound,
      render,
    } satisfies MetricsServerApi
  })
}

// ---------------------------------------------------------------------------
// Prometheus rendering
// ---------------------------------------------------------------------------

interface RenderableSnapshot {
  readonly id: string
  readonly type: string
  readonly description: string | undefined
  readonly attributes: Readonly<Record<string, string>> | undefined
  readonly state: unknown
}

const escapeLabelValue = (v: string): string =>
  // Prometheus label-value escaping: \\, \", \n
  v.replace(/\\/g, "\\\\").replace(/\"/g, '\\"').replace(/\n/g, "\\n")

const formatLabels = (
  attrs: Readonly<Record<string, string>> | undefined,
  extra?: Readonly<Record<string, string>>
): string => {
  const all: Array<[string, string]> = []
  if (attrs !== undefined) {
    for (const [k, v] of Object.entries(attrs)) all.push([k, v])
  }
  if (extra !== undefined) {
    for (const [k, v] of Object.entries(extra)) all.push([k, v])
  }
  if (all.length === 0) return ""
  // Sort label keys for deterministic output (helpful for tests).
  all.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return (
    "{" +
    all.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",") +
    "}"
  )
}

/** Serialize a number Prometheus-style ("+Inf", "-Inf", "NaN", finite). */
const fmtNumber = (n: number): string => {
  if (Number.isNaN(n)) return "NaN"
  if (n === Number.POSITIVE_INFINITY) return "+Inf"
  if (n === Number.NEGATIVE_INFINITY) return "-Inf"
  return String(n)
}

/**
 * Render a single Prometheus exposition body from an Effect metric snapshot
 * list. Groups by metric id so the `# HELP`/`# TYPE` headers appear once
 * per family.
 */
export const renderPrometheus = (
  snaps: ReadonlyArray<RenderableSnapshot>,
  idPrefix: string
): string => {
  const filtered = idPrefix.length === 0
    ? snaps
    : snaps.filter((s) => s.id.startsWith(idPrefix))

  const byId = new Map<string, RenderableSnapshot[]>()
  for (const s of filtered) {
    const arr = byId.get(s.id) ?? []
    arr.push(s)
    byId.set(s.id, arr)
  }

  const lines: string[] = []

  for (const [id, group] of byId) {
    const head = group[0]!
    const promType = mapType(head.type)
    if (head.description !== undefined) {
      lines.push(`# HELP ${id} ${head.description}`)
    }
    lines.push(`# TYPE ${id} ${promType}`)

    for (const snap of group) {
      switch (snap.type) {
        case "Counter": {
          const state = snap.state as { count: number | bigint }
          lines.push(
            `${id}${formatLabels(snap.attributes)} ${
              typeof state.count === "bigint" ? state.count.toString() : fmtNumber(state.count)
            }`
          )
          break
        }
        case "Gauge": {
          const state = snap.state as { value: number | bigint }
          lines.push(
            `${id}${formatLabels(snap.attributes)} ${
              typeof state.value === "bigint" ? state.value.toString() : fmtNumber(state.value)
            }`
          )
          break
        }
        case "Histogram": {
          const state = snap.state as {
            buckets: ReadonlyArray<[number, number]>
            count: number
            sum: number
          }
          // Effect's HistogramState exposes per-bucket counts which are
          // already cumulative from -Inf up to the bucket's upper bound,
          // matching Prometheus semantics directly.
          for (const [le, cumulative] of state.buckets) {
            lines.push(
              `${id}_bucket${formatLabels(snap.attributes, { le: fmtNumber(le) })} ${cumulative}`
            )
          }
          lines.push(
            `${id}_bucket${formatLabels(snap.attributes, { le: "+Inf" })} ${state.count}`
          )
          lines.push(`${id}_sum${formatLabels(snap.attributes)} ${fmtNumber(state.sum)}`)
          lines.push(`${id}_count${formatLabels(snap.attributes)} ${state.count}`)
          break
        }
        case "Summary": {
          const state = snap.state as {
            quantiles: ReadonlyArray<[number, number]>
            count: number
            sum: number
          }
          for (const [q, v] of state.quantiles) {
            lines.push(
              `${id}${formatLabels(snap.attributes, { quantile: fmtNumber(q) })} ${fmtNumber(v)}`
            )
          }
          lines.push(`${id}_sum${formatLabels(snap.attributes)} ${fmtNumber(state.sum)}`)
          lines.push(`${id}_count${formatLabels(snap.attributes)} ${state.count}`)
          break
        }
        case "Frequency": {
          const state = snap.state as { occurrences: ReadonlyMap<string, number> }
          for (const [value, count] of state.occurrences) {
            lines.push(
              `${id}${formatLabels(snap.attributes, { value })} ${count}`
            )
          }
          break
        }
        default:
          // Unknown metric type — skip with a comment so the output
          // remains parseable.
          lines.push(`# UNKNOWN type ${snap.type} for ${id}`)
      }
    }
  }

  return lines.length === 0 ? "" : lines.join("\n") + "\n"
}

const mapType = (t: string): string => {
  switch (t) {
    case "Counter":
      return "counter"
    case "Gauge":
      return "gauge"
    case "Histogram":
      return "histogram"
    case "Summary":
      return "summary"
    case "Frequency":
      return "counter"
    default:
      return "untyped"
  }
}
