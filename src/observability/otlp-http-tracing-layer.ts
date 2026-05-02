/**
 * OTLP HTTP tracing layer — extracted from `src/main.ts` so it can be
 * re-used by external consumers via `@vcharbon/sipjs/observability`.
 *
 * Wraps `@effect/opentelemetry/NodeSdk` + `@opentelemetry/sdk-trace-base`
 * `BatchSpanProcessor` + `@opentelemetry/exporter-trace-otlp-http`.
 *
 * These three packages are declared as **optional peer dependencies** of
 * `@vcharbon/sipjs`. Consumers who want to ship spans to an OTLP HTTP
 * endpoint must add them to their own `package.json`. Consumers who do
 * not need OTLP export should NOT install them and should NOT use this
 * layer — `TracingService.layer` (the default in `b2buaEmbeddedLayer`)
 * is fully functional without any OTel SDK package.
 */

import { Effect, Layer } from "effect"
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"

export interface OtlpHttpTracingOptions {
  /**
   * The OTLP HTTP traces endpoint, e.g.
   * `"http://localhost:4318/v1/traces"`.
   */
  readonly tracesUrl: string
  /** Service identifier reported as the OTel resource. */
  readonly serviceName: string
  /** Service version reported as the OTel resource. Default `"unknown"`. */
  readonly serviceVersion?: string
  /**
   * Per-span attribute value cap (in characters). Defaults to 32_768 to
   * accommodate scrubbed SIP message bodies on heavy-tracing builds.
   */
  readonly maxAttributeValueLength?: number
}

/**
 * Build a NodeSdk layer that exports spans via OTLP HTTP. Provide it
 * to `b2buaEmbeddedLayer` as the `tracing` option, or compose it under
 * any Effect program that uses `Effect.tracerWith` / span APIs.
 */
export const otlpHttpTracingLayer = (
  opts: OtlpHttpTracingOptions,
) =>
  Layer.unwrap(
    Effect.sync(() =>
      NodeSdk.layer(() => ({
        resource: {
          serviceName: opts.serviceName,
          serviceVersion: opts.serviceVersion ?? "unknown",
        },
        spanProcessor: new BatchSpanProcessor(
          new OTLPTraceExporter({ url: opts.tracesUrl }),
        ),
        tracerConfig: {
          spanLimits: {
            attributeValueLengthLimit: opts.maxAttributeValueLength ?? 32_768,
          },
        },
      })),
    ),
  )
