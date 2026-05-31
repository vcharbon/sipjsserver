/**
 * PublicRuleAction — the curated subset of `RuleAction` exposed to integrators
 * through the `@vcharbon/sipjs/rules-sdk` entrypoint (ADR-0015).
 *
 * The public/internal boundary IS the stability promise: internal actions
 * (`send-raw`, the PRACK / transfer / tag-mapping / fake-prack plumbing) stay
 * unexported so they never become a frozen public contract. We start narrow and
 * widen as the dogfood demands ("easier to open than to close").
 *
 * `Extract` keeps this structurally in sync with `RuleAction`: each listed
 * discriminant projects to the real variant, so adding an optional field to a
 * public action (e.g. `create-leg { kind, adopted }`) flows through automatically.
 */

import type { RuleAction } from "../RuleDefinition.js"

/** Action discriminants safe for integrator rules. See ADR-0015. */
export type PublicRuleActionType =
  | "relay-to-peer"
  | "relay-to-leg"
  | "respond"
  | "ack-leg"
  | "send-request-to-leg"
  | "send-provisional-to-leg"
  | "create-leg"
  | "destroy-leg"
  | "cancel-leg"
  | "merge"
  | "split"
  | "schedule-timer"
  | "cancel-timer"
  | "cancel-all-timers"
  | "terminate-call"
  | "begin-termination"
  | "terminate-leg"
  | "update-leg-state"
  | "confirm-dialog"
  | "pin-a-tag"
  | "add-cdr-event"
  | "deactivate-rule"
  | "set-call-ext"
  | "set-leg-ext"

/**
 * The integrator-facing action union. A strict subset of `RuleAction`, so a
 * `ReadonlyArray<PublicRuleAction>` is assignable wherever the framework wants
 * `ReadonlyArray<RuleAction>` — the SDK wrappers narrow on the way in and the
 * runtime is identical.
 */
export type PublicRuleAction = Extract<RuleAction, { readonly type: PublicRuleActionType }>
