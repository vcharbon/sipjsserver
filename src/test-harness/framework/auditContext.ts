/**
 * `mkAuditContext` — the standard preamble for a `scopedAudit` wrapper.
 *
 * Every per-Tag `scopedAudit` opens with the same wiring: build the
 * inner Layer, fetch the impl out of the ServiceMap, resolve Recorder
 * + RunContext, open a typed channel for the Tag, and assemble the
 * per-Tag anomaly buffer + the standard severity rule
 * (`real-run` downgrades baseline `deferred-fail` to `advisory`).
 *
 * The helper deliberately does NOT register a projector: the Recorder's
 * `registerProjector` is first-wins (silently no-ops on a second call),
 * so the caller stays in charge of which projector shape — identity,
 * event-walking, or anomaly-combining — gets attached for the Tag.
 *
 * Use in `scopedAudit` wrappers where the audit shape is
 * "single anomaly buffer + `check`/`detail`/`baseline` push pattern".
 * SignalingNetwork's audit is the exception — it splits findings into
 * deferred / advisory upfront via the rule-pack severity, so it builds
 * its anomaly bookkeeping directly without this helper.
 */

import { Effect, Layer, type Scope, ServiceMap } from "effect"
import type { RecordedAnomaly, TaggedChannel } from "./report-recorder/types.js"
import { Recorder, type RecorderApi } from "./report-recorder/Recorder.js"
import { RunContext, type RunContextValue } from "./RunContext.js"

export interface AuditContext<S, E> {
  readonly innerApi: S
  readonly recorder: RecorderApi
  readonly channel: TaggedChannel<E>
  readonly ctx: RunContextValue
  readonly anomalies: RecordedAnomaly[]
  /**
   * Apply the standard severity-tier rule:
   *   `real-run` → `advisory`
   *   otherwise  → baseline as supplied.
   * `unit-test-of-layer` paranoid violations short-circuit via
   * `Effect.die`, never reaching this path.
   */
  readonly severityFor: (
    baseline: "advisory" | "deferred-fail",
  ) => "advisory" | "deferred-fail"
  /**
   * Append a `signalingAudit` anomaly with the configured `checkPrefix`
   * prepended to `check`. Severity follows `severityFor(baseline)`.
   */
  readonly pushAnomaly: (
    check: string,
    detail: string,
    baseline: "advisory" | "deferred-fail",
  ) => void
}

export const mkAuditContext = <E, I, S>(
  tag: ServiceMap.Key<I, S>,
  inner: Layer.Layer<I>,
  checkPrefix: string,
): Effect.Effect<
  AuditContext<S, E>,
  never,
  Recorder | RunContext | Scope.Scope
> =>
  Effect.gen(function* () {
    const svcs = yield* Layer.build(inner)
    const innerApi = ServiceMap.get(svcs, tag)
    const recorder = yield* Recorder
    const ctx = yield* RunContext
    const channel = recorder.forTag<I, E>(tag)
    const anomalies: RecordedAnomaly[] = []
    const severityFor = (
      baseline: "advisory" | "deferred-fail",
    ): "advisory" | "deferred-fail" =>
      ctx.kind === "real-run" ? "advisory" : baseline
    const pushAnomaly = (
      check: string,
      detail: string,
      baseline: "advisory" | "deferred-fail",
    ): void => {
      anomalies.push({
        kind: "signalingAudit",
        check: `${checkPrefix}.${check}`,
        detail,
        severity: severityFor(baseline),
      })
    }
    return {
      innerApi,
      recorder,
      channel,
      ctx,
      anomalies,
      severityFor,
      pushAnomaly,
    }
  })
