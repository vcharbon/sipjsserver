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

// Transfer rules (REFER-driven blind transfer)
import { transferRules } from "./TransferRules.js"

/**
 * All default rules. Order does not matter — the Matcher selects winners
 * by specificity score (with `overrides` removing displaced rules).
 */
export const defaultRules: ReadonlyArray<AnyRuleDefinition> = [
  // REFER-driven blind transfer
  ...transferRules,

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
