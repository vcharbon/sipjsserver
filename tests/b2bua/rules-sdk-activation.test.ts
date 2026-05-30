/**
 * Activation + harness-seam contract for SDK-authored callflow services
 * (ADR-0016 / `feature-activation-closed`).
 *
 * Proves an integrator authoring against `@vcharbon/sipjs/rules-sdk` can:
 *   - register a service via `createRuleRegistry` (stamped SERVICE_LAYER),
 *   - activate it by ext-presence (`call.ext[id]` seeded from `/call/new`'s
 *     `serviceExt`) with no `features` member and no header sniffing,
 * and that the coverage/kill registry transforms (`transformRegistry` /
 * `disableRule`) preserve the consumer rule's `layer` field — the harness-seam
 * watch-out from the handoff.
 */

import { describe, expect, test } from "vitest"
import { Effect, Schema } from "effect"

import { defineService } from "@vcharbon/sipjs/rules-sdk"
import {
  createRuleRegistry,
  disableRule,
  transformRegistry,
} from "../../src/b2bua/rules/framework/RuleRegistry.js"
import { SERVICE_LAYER } from "../../src/b2bua/rules/framework/RuleDefinition.js"
import type { RuleContext } from "../../src/b2bua/rules/framework/RuleDefinition.js"

const ringback = defineService({
  id: "ringback",
  callExt: Schema.Struct({ step: Schema.Number }),
})

const ringRule = ringback.rule({
  id: "ringback-ring",
  name: "ringback ring",
  match: { kind: "response", cseqMethod: "INVITE", statusClass: "1xx", direction: "from-b" },
  handle: (_ctx, callExt) =>
    Effect.succeed({ actions: [{ type: "relay-to-peer" as const }], callExt }),
})

/** Minimal context — the composed match.filter only reads `call.ext` / `sourceLeg.ext`. */
const ctxWithExt = (ext: Record<string, unknown> | undefined): RuleContext =>
  ({ call: { ext }, sourceLeg: { ext: undefined } }) as unknown as RuleContext

describe("rules-sdk service activation", () => {
  test("a service rule is registered in SERVICE_LAYER and recorded as a service", () => {
    const registry = createRuleRegistry([], [ringback.toPolicyModule()])
    const def = registry.definitions.get("ringback-ring")
    expect(def?.layer).toBe(SERVICE_LAYER)
    expect(registry.services.has("ringback")).toBe(true)
  })

  test("activation is ext-presence: filter active iff call.ext[id] is set", () => {
    const registry = createRuleRegistry([], [ringback.toPolicyModule()])
    const filter = registry.definitions.get("ringback-ring")!.match.filter!

    // Seeded slice (what applyRoute writes from the decision response's serviceExt).
    expect(filter(ctxWithExt(ringback.activate({ step: 0 })))).toBe(true)
    // No slice → inactive, no header sniffing required.
    expect(filter(ctxWithExt(undefined))).toBe(false)
    expect(filter(ctxWithExt({}))).toBe(false)
  })

  test("transformRegistry / disableRule preserve the consumer rule's layer", () => {
    const registry = createRuleRegistry([], [ringback.toPolicyModule()])

    const wrapped = transformRegistry(registry, {
      wrapHandle: (_rule, original) => original,
    })
    expect(wrapped.definitions.get("ringback-ring")?.layer).toBe(SERVICE_LAYER)
    expect(wrapped.services.has("ringback")).toBe(true)

    const killed = disableRule(registry, "ringback-ring")
    expect(killed.definitions.get("ringback-ring")?.layer).toBe(SERVICE_LAYER)
    expect(killed.services.has("ringback")).toBe(true)
  })

  // The minted rule exists so `defineService`'s ext encoding closure is wired.
  test("the minted rule is a usable definition", () => {
    expect(ringRule.id).toBe("ringback-ring")
  })
})

// ── Typed Leg.ext role correlation (ADR-0014 leg-ext runtime consumer) ───────
// PRBT's media leg cannot be id-addressed up front, so it correlates by a
// typed `Leg.ext` role tag. This proves a service rule reads the decoded
// per-leg slice in its filter — the in-tree runtime consumer the REFER
// migration removed.
const mediaCorrelator = defineService({
  id: "media-correlator",
  callExt: Schema.Struct({ active: Schema.Boolean }),
  legExt: Schema.Struct({ role: Schema.Literals(["media"]) }),
})

const mediaRule = mediaCorrelator.rule({
  id: "media-correlator-on-media-leg",
  name: "act only on the media leg",
  match: { kind: "response", cseqMethod: "INVITE", status: 200, direction: "from-b" },
  filter: (_ctx, _callExt, legExt) => legExt?.role === "media",
  handle: (_ctx, callExt) => Effect.succeed({ actions: [], callExt }),
})
void mediaRule

const ctxWithLegExt = (
  callExt: Record<string, unknown> | undefined,
  legExt: Record<string, unknown> | undefined,
): RuleContext =>
  ({ call: { ext: callExt }, sourceLeg: { ext: legExt } }) as unknown as RuleContext

describe("typed Leg.ext role correlation", () => {
  test("a service rule's filter reads the decoded per-leg slice", () => {
    const registry = createRuleRegistry([], [mediaCorrelator.toPolicyModule()])
    const filter = registry.definitions.get("media-correlator-on-media-leg")!.match.filter!
    const active = mediaCorrelator.activate({ active: true })

    // Active service + media-tagged leg → rule applies.
    expect(filter(ctxWithLegExt(active, { "media-correlator": { role: "media" } }))).toBe(true)
    // Active service but the leg is not the media leg → rule declines.
    expect(filter(ctxWithLegExt(active, undefined))).toBe(false)
    // Service inactive → rule never competes.
    expect(filter(ctxWithLegExt(undefined, { "media-correlator": { role: "media" } }))).toBe(false)
  })
})
