/**
 * Consumer-API gate for `@vcharbon/sipjs/rules-sdk` (ADR-0015).
 *
 * Authored against ONLY the public SDK entrypoint — the same constraint the
 * `~/prbt` dogfood compiles under. Proves an integrator can:
 *   - author a standalone rule (`defineRule`) and a callflow service
 *     (`defineService`) + bundle them (`definePolicyModule`),
 *   - build a worker handler registry (`createRuleRegistry` / `buildHandlers`),
 *   - seed activation (`service.activate`),
 * and that the public/internal action boundary holds: emitting an internal
 * action is a COMPILE error (the `@ts-expect-error` lines below).
 */

import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"

import {
  buildHandlers,
  createRuleRegistry,
  defaultRules,
  definePolicyModule,
  defineRule,
  defineService,
  getHeader,
  H,
  newTag,
  removeH,
} from "@vcharbon/sipjs/rules-sdk"
import type { RuleAction, RuleContext } from "@vcharbon/sipjs/rules-sdk"

// ── A standalone rule authored against the narrowed context + public actions ──
const tagOnInvite = defineRule({
  id: "consumer-tag-on-invite",
  name: "consumer tag on invite",
  match: { kind: "request", method: "INVITE", direction: "from-a" },
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,
  init: () => undefined,
  handle: (ctx) =>
    Effect.succeed({
      actions: [
        { type: "relay-to-peer", transform: { headerUpdates: new Map([[H.Subject, removeH()]]) } },
      ] as ReadonlyArray<RuleAction>,
      state: undefined,
    }),
})

const consumerModule = definePolicyModule({
  id: "consumer-module",
  guard: () => true,
  rules: [tagOnInvite],
})

// ── A callflow service with typed call-ext + activation ──────────────────────
const flow = defineService({
  id: "consumer-flow",
  callExt: Schema.Struct({ step: Schema.Number }),
})

const flowRule = flow.rule({
  id: "consumer-flow-ring",
  name: "consumer flow ring",
  match: { kind: "response", cseqMethod: "INVITE", statusClass: "1xx", direction: "from-b" },
  handle: (_ctx, callExt) =>
    Effect.succeed({
      actions: [{ type: "relay-to-peer" as const }],
      callExt: { step: callExt.step + 1 },
    }),
})
void flowRule

describe("@vcharbon/sipjs/rules-sdk", () => {
  it("composes a worker handler registry from SDK-authored rules + services", () => {
    const registry = createRuleRegistry(defaultRules, [consumerModule, flow.toPolicyModule()])
    const handlers = buildHandlers(registry)
    expect(handlers.inDialog).toBeDefined()
    expect(handlers.initialInvite).toBeDefined()
    expect(registry.definitions.has("consumer-tag-on-invite")).toBe(true)
    expect(registry.definitions.has("consumer-flow-ring")).toBe(true)
    expect(registry.services.has("consumer-flow")).toBe(true)
  })

  it("builds a typed activation descriptor for the /call/new serviceExt", () => {
    const descriptor = flow.activate({ step: 0 })
    expect(descriptor).toEqual({ "consumer-flow": { step: 0 } })
  })

  it("re-exports the SIP helpers integrator rules need", () => {
    expect(typeof getHeader).toBe("function")
    expect(typeof newTag).toBe("function")
    expect(newTag().length).toBeGreaterThan(0)
  })
})

// ── Contract: internal actions are NOT reachable through the SDK ─────────────
// These never execute; they exist purely as a compile-time assertion that the
// public action union excludes the internal escape hatches.
void (() => {
  // @ts-expect-error — `send-raw` is an internal action, hidden from the SDK's `RuleAction`.
  const internal: RuleAction = { type: "send-raw", message: undefined, destination: undefined, label: "x" }
  void internal

  // A public action object remains assignable to the exported `RuleAction`.
  const ok: RuleAction = { type: "begin-termination" }
  void ok
  // `RuleContext` is the narrowed form — no `callControl` / `limiter` handles.
  type _NoCallControl = RuleContext extends { callControl: unknown } ? never : true
  const _assert: _NoCallControl = true
  void _assert
})
