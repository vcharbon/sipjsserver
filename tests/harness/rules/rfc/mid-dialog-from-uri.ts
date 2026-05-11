/**
 * Rule `rfc.midDialogFromUri` — RFC 3261 §12.2.1.1.
 *
 * Within an established dialog the UAC of any in-dialog request MUST set
 * From URI to the dialog's local URI and To URI to the dialog's remote
 * URI. Bob's stack inventing `From: <sip:bob@test>` when the dialog's
 * local URI is `sip:+1234@127.0.0.1:15060` is the canonical case this
 * catches.
 *
 * Scope: per-agent **sent** in-dialog requests (not initial INVITE,
 * not CANCEL — CANCEL is out-of-dialog per §9.1).
 */

import type { PerCallRule, RuleViolation } from "../types.js"
import {
  advanceDialogModel,
  emptyDialogModel,
  eventsByAgent,
  isInDialogRequest,
} from "./_replay.js"

export const midDialogFromUriRule: PerCallRule = {
  name: "rfc.midDialogFromUri",
  family: "rfc",
  description: "RFC 3261 §12.2.1.1: in-dialog From/To URIs match dialog local/remote URIs",
  evaluate(ctx) {
    const violations: RuleViolation[] = []
    const byAgent = eventsByAgent(ctx.recording)

    for (const [agent, events] of byAgent.entries()) {
      const m = emptyDialogModel()

      for (const ev of events) {
        // Evaluate BEFORE advancing the model so the model captures the
        // post-INVITE state when checking subsequent in-dialog sends.
        if (ev.kind === "sent" && ev.msg.type === "request") {
          const msg = ev.msg
          if (msg.method === "CANCEL") {
            advanceDialogModel(m, ev)
            continue
          }
          // Skip the initial INVITE — only re-INVITEs / BYE / etc. count.
          if (msg.method === "INVITE" && !m.initialInviteSentBranch && !m.initialInviteReceivedBranch) {
            advanceDialogModel(m, ev)
            continue
          }
          if (!isInDialogRequest(msg, m)) {
            advanceDialogModel(m, ev)
            continue
          }
          if (m.dialogLocalUri && msg.getHeader("from").uri !== m.dialogLocalUri) {
            violations.push({
              message:
                `[rfc.midDialogFromUri] agent=${agent}: in-dialog ${msg.method} ` +
                `From URI "${msg.getHeader("from").uri}" differs from dialog local URI ` +
                `"${m.dialogLocalUri}" — RFC 3261 §12.2.1.1`,
              entryIndex: ev.idx,
              details: { agent, method: msg.method, fromUri: msg.getHeader("from").uri, dialogLocalUri: m.dialogLocalUri },
            })
          }
          if (m.dialogRemoteUri && msg.getHeader("to").uri !== m.dialogRemoteUri) {
            violations.push({
              message:
                `[rfc.midDialogFromUri] agent=${agent}: in-dialog ${msg.method} ` +
                `To URI "${msg.getHeader("to").uri}" differs from dialog remote URI ` +
                `"${m.dialogRemoteUri}" — RFC 3261 §12.2.1.1`,
              entryIndex: ev.idx,
              details: { agent, method: msg.method, toUri: msg.getHeader("to").uri, dialogRemoteUri: m.dialogRemoteUri },
            })
          }
        }
        advanceDialogModel(m, ev)
      }
    }

    return violations
  },
}
