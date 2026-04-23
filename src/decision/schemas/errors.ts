/**
 * CallDecisionError — tagged ADT covering every failure mode of a
 * CallDecisionEngine adapter.
 *
 * Two observability tiers (see SplitServiceLogic.md §D11):
 *   - Transient (timeout, network, http-5xx): infrastructure hiccup. WARN.
 *     newCall → 503 to A-leg. callFailure → terminate. callRefer → 500 sipfrag.
 *   - Permanent (http-4xx, schema-violation, semantic-violation, defect): bug
 *     in the adapter or the server. ERROR. newCall → 500. callFailure →
 *     terminate. callRefer → 500 sipfrag.
 *
 * Semantic violations arise from the validator pipeline that runs after the
 * adapter returns (forbidden headers, cid cross-ref, feature activations).
 * One validator, all adapters safe.
 */

import { Schema } from "effect"

export const CallDecisionErrorKind = Schema.Literals([
  "timeout",
  "network",
  "http-5xx",
  "http-4xx",
  "schema-violation",
  "semantic-violation",
  "defect",
])
export type CallDecisionErrorKind = typeof CallDecisionErrorKind.Type

export const CallDecisionMethod = Schema.Literals(["newCall", "callFailure", "callRefer"])
export type CallDecisionMethod = typeof CallDecisionMethod.Type

const TRANSIENT_KINDS: ReadonlySet<CallDecisionErrorKind> = new Set([
  "timeout",
  "network",
  "http-5xx",
])

export class CallDecisionError extends Schema.TaggedErrorClass<CallDecisionError>()(
  "CallDecisionError",
  {
    kind: CallDecisionErrorKind,
    adapterName: Schema.String,
    method: CallDecisionMethod,
    detail: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/** True for retryable/infra failures (WARN tier), false for bugs (ERROR tier). */
export function isTransient(err: CallDecisionError): boolean {
  return TRANSIENT_KINDS.has(err.kind)
}

/**
 * SIP status the stack emits when this error surfaces on /call/new.
 * Transient = 503 (Service Unavailable) — caller may retry.
 * Permanent = 500 (Internal Server Error) — surfaces the adapter bug.
 */
export function newCallSipStatus(err: CallDecisionError): 500 | 503 {
  return isTransient(err) ? 503 : 500
}
