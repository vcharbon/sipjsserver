/**
 * Default rule registry — all built-in B2BUA rules.
 *
 * These rules implement the standard B2BUA behavior as always-active rules.
 * Custom rules (REFER, MRF, 183→200) are registered separately per-deployment.
 */

import type { AnyRuleDefinition } from "../framework/RuleDefinition.js"

// Relay rules
import { relayOptionsRule, relayByeRule, relayAckRule, relayReinviteRule, relayPrackRule, relayInfoRule } from "./RelayRules.js"

// Lifecycle rules
import { handleTimeoutRule, handleCancelRule, handle481Rule, resolveCancelResponseRule } from "./LifecycleRules.js"

// Terminating-state rules
import {
  resolveByeResponseRule,
  resolveCrossByeRule,
  terminatingSafetyTimeoutRule,
  terminatingDropRule,
} from "./TerminatingRules.js"

// Dialog rules
import {
  relayProvisionalRule,
  confirmDialogRule,
  absorbBye200Rule,
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

/** All default rules in registration order. Priority is set on each rule definition. */
export const defaultRules: ReadonlyArray<AnyRuleDefinition> = [
  // Terminating-state rules (800 band) — intercept events during teardown
  resolveByeResponseRule,
  resolveCrossByeRule,
  terminatingSafetyTimeoutRule,
  resolveCancelResponseRule,

  // Corner cases (830-860 band) — must match before default rules
  cancel200CrossingRule,
  retransmit200Rule,
  relayReinviteResponseRule,
  absorbBye200Rule,
  absorbOptions200Rule,
  handle481Rule,

  // Glare detection (priority 890) — before relay-reinvite
  reinviteGlareRule,

  // Default relay and lifecycle rules (900 band)
  relayOptionsRule,
  relayInfoRule,
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

  // Terminating catch-all (priority 999) — absorb anything else during teardown
  terminatingDropRule,
]
