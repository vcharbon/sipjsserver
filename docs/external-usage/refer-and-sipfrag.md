# REFER handling and the NOTIFY-sipfrag contract

> **Audience:** consumers wiring a `CallDecisionEngine` who expect to
> control transfer outcomes from the call-control HTTP service.

## TL;DR

- `sipjsserver` **always answers REFER with 200 OK** (or transparently
  relays it when the B2BUA is in a relay role).
- The decision engine **cannot reject a REFER request at the SIP message
  level** — there is no 4xx-on-REFER path. `CallReferRejectResponse`'s
  `reject_*` fields drive the transfer outcome that travels on the
  *implicit subscription*, not a 4xx response on the REFER itself.
- If the call-control service wants to refuse the transfer, it instructs
  the B2BUA to emit a `NOTIFY` carrying a `message/sipfrag` body with
  the failure status line (RFC 3515 §2.4.5 / RFC 3420). The receiving
  UAC interprets that as "transferee unreachable" — which is the
  semantically correct answer.

## Why not "just" return 4xx on the REFER?

REFER establishes an implicit `refer` subscription (RFC 3515 §2.4.4).
The transfer's outcome is a *subscription event*, not a SIP transaction
result. Conflating the two has two failure modes:

1. **Wrong-error misinterpretation.** Many UACs read `4xx-on-REFER` as
   *"transferor unwilling to transfer"* (a permission failure). That is
   semantically different from *"transferee unreachable / declined"*
   (a routing failure). Routing both through 4xx loses the distinction
   and breaks UAC retry / fallback logic.

2. **No good place for partial progress.** The implicit subscription
   carries `100 Trying`, then `180 Ringing`, then the final outcome.
   Forcing the final outcome into a 4xx on the REFER throws away the
   call-progress signaling the transferor needs to render the right UI.

Routing exclusively through NOTIFY-sipfrag preserves both signals.

## What the consumer sees in the `CallDecisionEngine` API

The schema for `CallReferRejectResponse` carries a `reject_code` and
`reject_reason` field, but those values become the **status line of the
sipfrag NOTIFY body**, not the status line of the REFER's response. The
REFER itself is always 200-OK'd at the SIP layer.

```ts
import { Effect, Layer } from "effect"
import { CallDecisionEngine } from "@vcharbon/sipjs/b2bua"

const myCallDecision = Layer.succeed(CallDecisionEngine, {
  newCall: ...,
  callFailure: ...,
  callRefer: (req) =>
    // The 403 + reason become the NOTIFY sipfrag status line —
    // "SIP/2.0 403 Carrier blocked transfers" — not a 403 response
    // on the REFER request.
    Effect.succeed({
      action: "reject",
      reject_code: 403,
      reject_reason: "Carrier blocked transfers",
    }),
})
```

## What about Issue 9's `update_headers` on `NewCallRejectResponse`?

`NewCallRejectResponse.update_headers` does NOT exist on
`CallReferRejectResponse`. The two paths are different layers:

| Path | Is the rejection a SIP message? | Where do consumer headers go? |
|------|--------------------------------|-------------------------------|
| `newCall` reject | Yes — the rejection IS a 4xx response on the INVITE | `update_headers` on the response we emit |
| `callRefer` reject | No — the REFER itself is 200-OK'd; the rejection travels on the NOTIFY sipfrag | (not applicable; the sipfrag is the status line, no extra headers) |

If a future requirement surfaces for arbitrary headers on the NOTIFY
that carries the sipfrag, that gets its own design pass — it is not the
same problem as Issue 9.

## Cross-references

- RFC 3515 — The Session Initiation Protocol (SIP) Refer Method
- RFC 3420 — Internet Media Type message/sipfrag
- RFC 3261 §8.2.6.2 — Headers and Tags (response construction rules)
- Internal: [docs/CallModel.md](../CallModel.md) for the call/leg/dialog model
- Internal: `src/b2bua/rules/defaults/TransferRules.ts` for the actual
  REFER → NOTIFY pipeline
