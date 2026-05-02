/**
 * @vcharbon/sipjs/observability — public surface.
 *
 * Optional OTLP HTTP tracing layer for consumers who want to wire
 * `@effect/opentelemetry/NodeSdk` + `@opentelemetry/exporter-trace-otlp-http`
 * into the embedded b2bua. The b2bua itself defaults to a noop tracer
 * (sample rate 0); this subpath is the opt-in.
 *
 * The OTel packages are declared as **optional peer dependencies** of
 * `@vcharbon/sipjs`. Importing this subpath in a consumer that hasn't
 * installed them will fail at runtime — install them only when needed.
 */

export {
  otlpHttpTracingLayer,
} from "./otlp-http-tracing-layer.js"
export type { OtlpHttpTracingOptions } from "./otlp-http-tracing-layer.js"

// MetricsRegistry — base in-process metrics map used by OverloadController
// and consumers wanting Prometheus snapshots.
export { MetricsRegistry } from "./MetricsRegistry.js"
