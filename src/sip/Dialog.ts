/**
 * StackDialog — RFC 3261 §12 dialog state, owned by the SIP stack.
 *
 * This is the dialog view the stack generators consume. The B2BUA wraps this
 * in a composite `Dialog` that adds B2BUA-only extensions (ackBranch, pending
 * INVITE transaction handles, etc.) — see `src/call/CallModel.ts`.
 *
 * Pure data. No Effect, no mutation — all updates return a new StackDialog.
 */

/**
 * Pure SIP-level dialog state (RFC 3261 §12).
 *
 * - `localTag`  — tag the B2BUA used on this leg (From-tag if B2BUA is UAC,
 *                 To-tag if UAS).
 * - `remoteTag` — peer tag on this leg (opposite side of localTag).
 * - `localUri` / `remoteUri` — URIs used for From / To when the B2BUA sends
 *                              in-dialog. Display name may be included; the
 *                              generator wraps bare URIs in angle brackets.
 * - `remoteTarget` — peer Contact URI; becomes the Request-URI for in-dialog
 *                    requests (§12.2.1.1).
 * - `localCSeq` — last sequence number the B2BUA sent on this dialog.
 * - `routeSet` — outbound route set derived from Record-Route of the
 *                dialog-creating response (§12.1.2).
 */
export interface StackDialog {
  readonly callId: string
  readonly localTag: string
  readonly remoteTag: string
  readonly localUri: string
  readonly remoteUri: string
  readonly remoteTarget: string
  readonly localCSeq: number
  readonly routeSet: ReadonlyArray<string>
}
