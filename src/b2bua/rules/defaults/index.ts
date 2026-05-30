/**
 * Default rule registry — all built-in B2BUA rules.
 *
 * These rules implement the standard B2BUA behavior as always-active rules.
 * Custom rules (REFER, MRF, 183→200) are registered separately per-deployment.
 */

import type { AnyRuleDefinition } from "../framework/RuleDefinition.js"

// Relay rules
import {
  relayOptionsRule,
  relayByeRule,
  relayAckRule,
  relayReinviteRule,
  relayPrackRule,
  relayInfoRule,
  relayUpdateRule,
  relayMessageRule,
} from "./RelayRules.js"

// Lifecycle rules
import { handleTimeoutRule, handleCancelRule, handle481Rule, resolveCancelResponseRule } from "./LifecycleRules.js"

// Terminating-state rules
import {
  resolveByeResponseRule,
  resolveCrossByeRule,
  terminatingSafetyTimeoutRule,
} from "./TerminatingRules.js"

// Dialog rules
import {
  relayProvisionalRule,
  confirmDialogRule,
  absorbBye200Rule,
  absorbNotify200Rule,
  absorbOptions200Rule,
  relayNonInvite200Rule,
} from "./DialogRules.js"

// Corner case rules
import {
  cancel200CrossingRule,
  retransmit200Rule,
  reinviteGlareRule,
  relayReinviteResponseRule,
} from "./CornerCaseRules.js"

// Timer rules (limiter-refresh is a framework concern, not a rule)
import {
  maxDurationRule,
  keepaliveRule,
  keepaliveTimeoutRule,
} from "./TimerRules.js"

// Failure rules
import { routeFailureRule, noAnswerFailoverRule, absorbStaleFailureRule } from "./FailureRules.js"

// Transfer default rules (REFER seed rules; phase-gated rules live in the
// referTransfer callflow service — registered as a policy module in B2buaCore).
import { transferDefaultRules } from "./TransferRules.js"

/**
 * All default rules (CORE_LAYER). ORDER MATTERS: selection is first-match-wins
 * within a layer (no specificity scoring), so more specific / corner-case rules
 * MUST precede the broad relay+lifecycle rules they refine. The registry's
 * reachability lint throws at startup if a later rule is fully shadowed by an
 * earlier filterless one. `overrides` still removes a displaced rule outright.
 */
export const defaultRules: ReadonlyArray<AnyRuleDefinition> = [
  // REFER-driven blind transfer (seed rules only)
  ...transferDefaultRules,

  // Terminating-state intercept
  resolveByeResponseRule,
  resolveCrossByeRule,
  terminatingSafetyTimeoutRule,
  resolveCancelResponseRule,

  // Corner cases — narrower matches that take precedence over default rules
  cancel200CrossingRule,
  retransmit200Rule,
  relayReinviteResponseRule,
  absorbBye200Rule,
  absorbNotify200Rule,
  absorbOptions200Rule,
  handle481Rule,
  reinviteGlareRule,

  // Default relay and lifecycle
  relayOptionsRule,
  relayInfoRule,
  relayUpdateRule,
  relayMessageRule,
  relayByeRule,
  relayAckRule,
  relayReinviteRule,
  relayPrackRule,
  relayProvisionalRule,
  confirmDialogRule,
  relayNonInvite200Rule,
  handleTimeoutRule,
  handleCancelRule,
  maxDurationRule,
  keepaliveRule,
  keepaliveTimeoutRule,
  absorbStaleFailureRule,
  routeFailureRule,
  noAnswerFailoverRule,
]
