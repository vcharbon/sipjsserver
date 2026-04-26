import { Effect } from "effect"
import { listPods, podExec } from "./kubectl.js"

export interface MetricSample {
  readonly name: string
  readonly labels: Readonly<Record<string, string>>
  readonly value: number
}

/**
 * Parse a Prometheus text exposition payload.
 * Skips HELP / TYPE comment lines.
 */
export const parsePrometheusText = (text: string): ReadonlyArray<MetricSample> => {
  const out: Array<MetricSample> = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const sample = parseSampleLine(trimmed)
    if (sample) out.push(sample)
  }
  return out
}

const SAMPLE_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(\S+)(?:\s+\d+)?$/
const LABEL_RE = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g

const parseSampleLine = (line: string): MetricSample | null => {
  const m = SAMPLE_RE.exec(line)
  if (!m) return null
  const name = m[1] ?? ""
  const labelBlob = m[2] ?? ""
  const valueStr = m[3] ?? ""
  const value = parseFloat(valueStr)
  if (!Number.isFinite(value)) return null
  const labels: Record<string, string> = {}
  let lm: RegExpExecArray | null
  LABEL_RE.lastIndex = 0
  while ((lm = LABEL_RE.exec(labelBlob)) !== null) {
    labels[lm[1] ?? ""] = (lm[2] ?? "").replace(/\\(.)/g, "$1")
  }
  return { name, labels, value }
}

/**
 * Fetch + parse the Prometheus exposition from a proxy pod's
 * MetricsServer (`:9090/metrics`). The proxy chart doesn't currently
 * expose port 9090 in `containerPorts`, so we read it via `kubectl exec
 * wget`.
 *
 * NOTE (Phase A): `bin/proxy.ts` does not currently wire up
 * `MetricsServer`, so the wget will return ECONNREFUSED and this helper
 * returns an empty array. Tests that need metric-based assertions
 * (INV-3, INV-5) currently rely on log signals instead. Wiring
 * MetricsServer is a small production-code follow-up.
 */
export const fetchProxyMetrics = (namespace: string) =>
  Effect.gen(function* () {
    const pods = yield* listPods(namespace, "app.kubernetes.io/name=sip-front-proxy")
    const samples: Array<MetricSample & { proxyPod: string }> = []
    for (const pod of pods) {
      if (!pod.ready) continue
      const text = yield* podExec(namespace, pod.name, [
        "wget",
        "-qO-",
        "http://localhost:9090/metrics",
      ]).pipe(Effect.orElseSucceed(() => ""))
      for (const s of parsePrometheusText(text)) {
        samples.push({ ...s, proxyPod: pod.name })
      }
    }
    return samples
  })

/**
 * Sum a metric across all proxy pods, optionally filtered by labels.
 */
export const sumMetric = (
  samples: ReadonlyArray<MetricSample>,
  name: string,
  labelMatch: Readonly<Record<string, string>> = {},
): number => {
  let total = 0
  for (const s of samples) {
    if (s.name !== name) continue
    let ok = true
    for (const [k, v] of Object.entries(labelMatch)) {
      if (s.labels[k] !== v) {
        ok = false
        break
      }
    }
    if (ok) total += s.value
  }
  return total
}
