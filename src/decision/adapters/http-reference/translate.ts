/**
 * Wire ↔ canonical translators for the HTTP Reference Adapter.
 *
 * Keeps vendor-shape knowledge out of the Effect pipeline in
 * `HttpReferenceAdapter.ts` and out of every downstream consumer.
 *
 * v1 responsibilities:
 *   - Synthesize canonical `FeatureActivations` from the vendor's flat
 *     `relay_first_18x_to_180` / `no_answer_timeout_sec` / `call_limiter`
 *     fields plus platform ceilings from AppConfig.
 *   - Pass the remaining wire fields through unchanged (in v1 they still
 *     match the canonical 1:1 shape — §D12).
 *
 * v2/Slice C will add richer mappings here (`update_body → BodyIntent`,
 * `update_headers` → partitioned header map).
 */

import type { AppConfigData } from "../../../config/AppConfig.js"
import type { FeatureActivations } from "../../schemas/features.js"
import type {
  CallFailureResponse,
  CallReferResponse,
  NewCallResponse,
} from "../../schemas/responses.js"
import type {
  WireCallFailureResponse,
  WireCallReferResponse,
  WireNewCallResponse,
} from "./schemas.js"

/**
 * Build canonical `FeatureActivations` from a vendor-flat response frame.
 *
 * The platform-level ceilings (`maxDurationSec`, keepalive) come from
 * AppConfig: the v1 vendor contract does not carry them. Vendors that
 * want leg-specific overrides must embed the values in their future
 * richer response shape — the canonical field exists for that purpose.
 */
type RelayFirst18xWire = boolean | "drop-sdp" | "keep-sdp" | "fake-prack" | undefined

function relayFirst18xStrategy(
  wire: RelayFirst18xWire,
): "drop-sdp" | "keep-sdp" | "fake-prack" | undefined {
  if (typeof wire === "string") return wire
  if (wire === true) return "drop-sdp"
  return undefined
}

function synthesizeFeatures(
  wire: {
    readonly relay_first_18x_to_180?: RelayFirst18xWire
    readonly no_answer_timeout_sec?: number | undefined
    readonly call_limiter?: ReadonlyArray<{ readonly id: string; readonly limit: number }> | undefined
  },
  config: AppConfigData,
): FeatureActivations {
  // keepaliveTimeoutSec is a seconds-based total timeout in legacy config,
  // not a miss counter. Derive a safe maxMissed so B.7's synthesis matches
  // the handler-side synthesis the extraction replaced.
  const maxMissed = Math.max(
    1,
    Math.ceil(config.keepaliveTimeoutSec / config.keepaliveIntervalSec),
  ) || 1

  const strategy = relayFirst18xStrategy(wire.relay_first_18x_to_180)

  return {
    platform: {
      maxDurationSec: config.callMaxDurationSec,
      keepalive: { intervalSec: config.keepaliveIntervalSec, maxMissed },
    },
    ...(strategy !== undefined
      ? { relayFirst18xTo180: { strategy } }
      : {}),
    ...(wire.no_answer_timeout_sec !== undefined
      ? { noAnswerTimeoutSec: wire.no_answer_timeout_sec }
      : {}),
    ...(wire.call_limiter !== undefined
      ? { callLimiters: wire.call_limiter.map((e) => ({ id: e.id, limit: e.limit })) }
      : {}),
  }
}

export function translateNewCallResponse(
  wire: WireNewCallResponse,
  config: AppConfigData,
): NewCallResponse {
  if (wire.action === "reject") return wire
  return { ...wire, features: synthesizeFeatures(wire, config) }
}

export function translateCallFailureResponse(
  wire: WireCallFailureResponse,
  config: AppConfigData,
): CallFailureResponse {
  if (wire.action === "terminate") return wire
  return { ...wire, features: synthesizeFeatures(wire, config) }
}

export function translateCallReferResponse(
  wire: WireCallReferResponse,
  config: AppConfigData,
): CallReferResponse {
  if (wire.action === "reject") return wire
  return { ...wire, features: synthesizeFeatures(wire, config) }
}
