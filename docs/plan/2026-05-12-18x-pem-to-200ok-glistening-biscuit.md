# 18x PEM → 200 OK promotion mode

## Context

Some calling phones (legacy or constrained handsets) cannot send DTMF in the
early-dialog phase. They can only send DTMF after their INVITE transaction
reaches the confirmed state (200 OK + ACK), because their stack only opens
the DTMF channel — RFC 2833 inband or SIP INFO — once the call is confirmed
on their side.

When the called party sends `183 Session Progress` with SDP and the
`P-Early-Media` header (RFC 5009 PEM), the B-side is announcing that its
early media stream is established and ready for two-way RTP. The constrained
A-side however needs to believe the call is fully answered before it will
emit DTMF.

This plan adds a new B2BUA mode, controlled per call by the HTTP backend,
that promotes such a `183 + SDP + PEM` from B into a synthetic `200 OK
INVITE` toward A. A sees an answered call and emits DTMF; B is unaware
because we keep its dialog in the early state and continue handling its
final response normally. When B finally answers, we either silently bridge
(SDP unchanged) or re-INVITE A (SDP changed) to align media. Failure modes
tear the call down with a diagnostic Reason header.

The mode is mutually exclusive with the existing 18x-handling strategies
(`drop-sdp`, `keep-sdp`, `fake-prack`); exclusivity is enforced at the
schema level so backend authors cannot combine them.

## Design summary

| Aspect | Decision |
|---|---|
| Activation | New variant `promote-pem-to-200` on the existing 18x policy field |
| Wire field rename | `relay_first_18x_to_180` → `early_media_mode` (with shim) |
| Trigger | Strict: only `183` + non-empty SDP + `P-Early-Media` header |
| Subsequent 18x from B | Suppress on A side; keep B-leg dialog alive |
| PRACK on B (if `Require: 100rel`) | B2BUA generates locally (reuse `send-prack-to-leg`) |
| B fails post-promote | BYE A with `Reason: SIP;cause=<status>;text="<phrase>"` |
| B answers (2xx) | If SDP equivalent → silent bridge; else re-INVITE A with B's SDP |
| SDP comparison | media descriptors (m=/c=/a=); ignore `o=` version |
| A in-dialog during window | re-INVITE/UPDATE → 491; INFO/MESSAGE/NOTIFY/REFER → 488; BYE normal |
| A BYE during window | CANCEL B + 200 to A's BYE; teardown |
| A rejects resync re-INVITE | BYE both legs with diagnostic Reason |
| Window close | When B is confirmed AND any required re-INVITE to A is ACK'd |
| Forking | Same code path; commit-to-A SDP held on call ext, diffed against winning fork's 200 OK |

## Files to modify

### Schema / wire

- [src/decision/schemas/responses.ts](../../src/decision/schemas/responses.ts) —
  Add `"promote-pem-to-200"` to the literal union of `relay_first_18x_to_180`
  on `NewCallRouteResponse` (line 64-69), `CallFailureFailoverResponse`
  (line 158-163), and `CallReferAllowResponse` (line 213-218). Then rename
  the field to `early_media_mode` (keep `relay_first_18x_to_180` as a
  deprecated read-also alias in the wire decoder for one release — see
  `src/decision/adapters/http-reference/schemas.ts`).

- [src/decision/schemas/features.ts](../../src/decision/schemas/features.ts) —
  Extend `RelayFirst18xTo180Feature.strategy` literal union (line 63) to
  add `"promote-pem-to-200"`. Rename the type to `EarlyMediaModeFeature` and
  the field on `FeatureActivations` to `earlyMediaMode` (a single-rename
  search/replace; ~15 callsites including the existing custom rule and the
  translator).

- [src/decision/adapters/http-reference/translate.ts](../../src/decision/adapters/http-reference/translate.ts) —
  Update `RelayFirst18xWire` (line 39) and `relayFirst18xStrategy()`
  (line 41-47) to admit the new variant. The wire→canonical mapping is
  one-to-one for the literal forms, so only the type union widens.

### Rule logic — new policy module

- **NEW** `src/b2bua/rules/custom/promote18xPemTo200.ts` — sibling to
  `relayFirst18xTo180.ts`. PolicyModule guarded on
  `ctx.call.features?.earlyMediaMode?.strategy === "promote-pem-to-200"`.
  Contains the rules listed below.

- **NEW** `src/b2bua/rules/custom/_shared/sdpDiff.ts` — small helper that
  parses two SDP buffers and returns `true` iff the negotiated media
  descriptors (`m=` lines + their `c=`/`a=rtpmap`/`a=fmtp`) match. Ignore
  `o=` session-version and any comment/whitespace differences. Covered by
  pure unit tests.

- [src/b2bua/B2buaCore.ts](../../src/b2bua/B2buaCore.ts) — register the new
  PolicyModule alongside `relayFirst18xTo180` in the `createRuleRegistry`
  call.

### Call model — new ext fields

- [src/call/CallModel.ts](../../src/call/CallModel.ts) —
  Add to `Call.ext` (or a fresh `Call.ext.earlyPromote` substruct):
  - `promotedSdp: Uint8Array | undefined` — the SDP we sent to A in the
    promoted 200 OK (used to diff B's eventual 200 OK).
  - `promoted: boolean` — true once we've sent 200 OK to A.
  - `resyncReinviteCSeq: number | undefined` — the CSeq of our outbound
    re-INVITE to A; cleared when its 200/4xx settles.

  Window-active predicate (used by reject rules' `filter`):
  `call.ext.promoted && (aLeg.state !== "confirmed" || resyncReinviteCSeq !== undefined)`.
  Strictly: window active = "promoted AND (B not confirmed OR resync re-INVITE
  outstanding)". Cleaner: `call.ext.earlyPromote.windowOpen: boolean` updated
  by the rules at the same points they mutate state.

### Action executor — re-INVITE generation

- [src/b2bua/rules/framework/ActionExecutor.ts](../../src/b2bua/rules/framework/ActionExecutor.ts) —
  Two options:
  1. **Recommended**: add a new action type
     `{ type: "send-reinvite-to-leg"; legId: string; body: Uint8Array }`
     and an executor that (a) bumps the leg's confirmed-dialog CSeq,
     (b) builds an in-dialog INVITE with `Content-Type: application/sdp`,
     (c) registers a `pendingReInvite` entry on the dialog so the existing
     `relay-reinvite-response` rule correlates the response back, and
     (d) emits the request via the standard egress queue. ACK-on-2xx is
     produced by an extension to the framework's existing in-dialog ACK
     path.
  2. **Cheap alt**: extend the allow-list at line 1415 to permit `INVITE`.
     Risk: that path was not designed for an INVITE 3-way handshake (it
     fire-and-forgets), so the response correlation and ACK still need
     adding. Prefer option 1.

  Add the new action type to `RuleAction` in
  [src/b2bua/rules/framework/RuleDefinition.ts](../../src/b2bua/rules/framework/RuleDefinition.ts)
  near line 366 alongside `send-request-to-leg`.

### Mutual exclusivity

The single-union schema field already enforces it at compile time and at
runtime decode. Add one translator unit test asserting the wire decoder
rejects a hypothetical payload that tries to set both a legacy and a new
variant — guards the deprecation alias.

## Rules in the new PolicyModule

All rules carry `guard: ctx.call.features?.earlyMediaMode?.strategy === "promote-pem-to-200"`.

### 1. `promote-183-pem` (overrides `relay-provisional`)

```
match: { kind: "response", cseqMethod: "INVITE", statusClass: "1xx",
         direction: "from-b",
         filter: (ctx) =>
           ctx.event.message.status === 183 &&
           ctx.event.message.body.byteLength > 0 &&
           getHeader(ctx.event.message.headers, "p-early-media") !== undefined &&
           !ctx.call.ext.earlyPromote.promoted }
```

Actions on first match:
- `add-tag-mapping` with a freshly generated A-facing tag (locks A's
  dialog identity to this promoted 200 OK across any later forks).
- `relay-to-peer` with `transform: { status: 200, reason: "OK",
  headerUpdates: [drop P-Early-Media, drop Require, drop RSeq] }`. SDP
  body passes through untouched.
- If the 183 carried `Require: 100rel` + `RSeq`: `send-prack-to-leg`
  (reuse the existing action — same as `fake-prack`).
- `set-call-ext` (or a new dedicated action) marking
  `ext.earlyPromote = { promoted: true, promotedSdp: <body>, windowOpen: true }`.
- CDR provisional event with reason `"promote-pem-to-200"`.

### 2. `suppress-post-promote-18x` (overrides `relay-provisional`, lower-priority filter than the above)

```
match: { kind: "response", cseqMethod: "INVITE", statusClass: "1xx",
         direction: "from-b",
         filter: (ctx) => ctx.call.ext.earlyPromote.promoted }
```

Drop the message; if reliable, still issue `send-prack-to-leg`. CDR a
suppressed-provisional marker.

### 3. `confirm-after-promote` (composes with `confirm-dialog`)

```
match: { kind: "response", cseqMethod: "INVITE", statusClass: "2xx",
         direction: "from-b",
         filter: (ctx) => ctx.call.ext.earlyPromote.promoted }
```

After the standard `confirm-dialog` runs (which generates the local ACK to
B and merges legs):
- Diff `resp.body` against `ctx.call.ext.earlyPromote.promotedSdp` using
  `sdpDiff`. If equal → emit `set-call-ext` to set
  `windowOpen: false`. Done.
- If different → emit `send-reinvite-to-leg` to A with `body: resp.body`,
  set `windowOpen` to remain true and stash the outbound CSeq on
  `ext.earlyPromote.resyncReinviteCSeq`. Window closes when A's 200 OK
  + ACK lands (handled in a new `resync-reinvite-response` rule, below).
- The default `confirm-dialog` already relays the 200 OK to A. We must
  **suppress that relay** in the promote case (A already saw 200 OK).
  Compose by overriding the `relay-to-peer` action emitted by
  `confirm-dialog` — easiest path: instead of composing, declare this
  rule with `overrides: "confirm-dialog"` and re-emit a trimmed action
  list (no `relay-to-peer`, plus our diff/resync logic, plus the
  destroy-other-b-legs / merge / timer-schedule actions copied from
  `confirmBridgedCall`). Keeps the relay suppression explicit.

### 4. `resync-reinvite-response`

```
match: { kind: "response", cseqMethod: "INVITE", direction: "from-a",
         filter: (ctx) =>
           ctx.call.ext.earlyPromote.resyncReinviteCSeq !== undefined &&
           ctx.event.message.getHeader("cseq").seq ===
             ctx.call.ext.earlyPromote.resyncReinviteCSeq }
```

- 1xx: ignore (still pending).
- 2xx: emit `ack-leg` to A; clear `resyncReinviteCSeq`; set
  `windowOpen: false`. CDR resync-success.
- 3xx/4xx/5xx/6xx: emit BYE to A with `Reason:
  SIP;cause=<status>;text="resync-failed"`, BYE to B (now confirmed) with
  same Reason, mark call for teardown. CDR resync-failure.

### 5. `reject-a-in-dialog-window-reinvite-update` (overrides `relay-reinvite`, `relay-update`)

```
match: { kind: "request", method: ["INVITE", "UPDATE"], direction: "from-a",
         filter: (ctx) => ctx.call.ext.earlyPromote.windowOpen }
```

Action: `respond status:491 reason:"Request Pending"`.

### 6. `reject-a-in-dialog-window-other` (overrides `relay-info`, `relay-message`, `relay-notify`, `relay-refer`)

```
match: { kind: "request", method: ["INFO", "MESSAGE", "NOTIFY", "REFER"],
         direction: "from-a",
         filter: (ctx) => ctx.call.ext.earlyPromote.windowOpen }
```

Action: `respond status:488 reason:"Not Acceptable Here"`.

### 7. `b-fails-post-promote` (composes with route-failure handler)

```
match: { kind: "response", cseqMethod: "INVITE", statusClass: ["3xx","4xx","5xx","6xx"],
         direction: "from-b",
         filter: (ctx) =>
           ctx.call.ext.earlyPromote.promoted &&
           !ctx.call.ext.earlyPromote.confirmed }
```

Action: send BYE to A with `Reason: SIP;cause=<status>;text="<phrase>"`,
mark call for teardown. (The default failure rule would 4xx A — wrong
because A is already confirmed.) Override appropriate failure rules.

### 8. `a-bye-during-early-window`

The existing BYE-from-A path already CANCELs in-progress B INVITEs as
part of teardown. Verify by reading the BYE handler chain; if the
teardown logic does not already CANCEL a still-early B leg, add a
composer that does. No new logic should be needed beyond what
`destroy-leg` already does for early legs (which CANCELs them per the
forking exploration findings, ActionExecutor.ts:1662-1666).

## RFC checklist

- **RFC 3261 §13.2.2.4** — When ACKing a non-winning fork's 200 OK and
  immediately BYE-ing it: handled by existing forking teardown
  (`destroy-leg` for confirmed b-legs sends BYE).
- **RFC 3262 §3-4** — Reliable provisional must be PRACK'd. Our
  `send-prack-to-leg` action reused.
- **RFC 5009** — `P-Early-Media` is a request/response header. We strip
  it from the synthetic 200 OK toward A (it has no defined semantics on
  a 200 OK; some stacks reject unknown headers in 2xx).
- **RFC 3326** — `Reason` header used on the BYEs we generate to give
  upstream a cause.
- **RFC 3311** — UPDATE rejection during window: 491 is semantically
  defined for UPDATE re-offer collisions; safe choice.

## Test plan

All scenarios use the existing fake-stack harness
(`tests/scenarios/`, `tests/fullcall/e2e-fake-clock.*`) per
[CLAUDE.md](../../CLAUDE.md) "Test structure (fake vs live)" — TestClock,
mock HTTP backend, simulated UDP. No live tests required.

### Scenario 1 — Happy path, SDP unchanged

1. Backend returns `early_media_mode: "promote-pem-to-200"` in /call/new.
2. Alice INVITE → B2BUA → Bob.
3. Bob responds `183 + SDP_v1 + P-Early-Media` (no 100rel).
4. **Assert** Alice receives `200 OK` carrying `SDP_v1`, no
   `P-Early-Media` header. Alice ACKs.
5. Bob responds `200 OK + SDP_v1` (identical media descriptors).
6. **Assert** Alice sees no further INVITE/UPDATE traffic.
7. **Assert** B2BUA generates ACK to Bob.
8. **Assert** call.ext.earlyPromote.windowOpen === false.
9. Alice sends BYE → both legs torn down cleanly.

### Scenario 2 — Resync path, SDP changed

Same as 1 through step 4. Then:

5. Bob responds `200 OK + SDP_v2` (different m=/c=).
6. **Assert** B2BUA generates ACK to Bob.
7. **Assert** Alice receives a re-INVITE with `SDP_v2`. Alice 200-OKs;
   B2BUA ACKs Alice.
8. **Assert** windowOpen flips to false after Alice's ACK.
9. **Assert** subsequent UPDATE from Alice is now relayed to Bob (not
   rejected) — issues a UPDATE via the scenario DSL and inspects Bob's
   inbox.
10. BYE teardown.

### Scenario 3a — B fails post-promote

1-4 as Scenario 1. Then:

5. Bob responds `503 Service Unavailable`.
6. **Assert** Alice receives BYE with `Reason: SIP;cause=503;text="Service Unavailable"`.
7. **Assert** call torn down; CDR records both promote and the failure.

### Scenario 3b — A rejects resync re-INVITE

1-4 as Scenario 1, then 5-7 as Scenario 2 except:

7'. Alice responds `488` to the re-INVITE.
8. **Assert** B2BUA sends BYE to both Alice and Bob with
   `Reason: SIP;cause=488;text="resync-failed"`.

### Scenario 3c — A BYEs during early window

1-4 as Scenario 1. Then:

5. Alice sends BYE before Bob's final response.
6. **Assert** B2BUA replies `200 OK` to Alice's BYE.
7. **Assert** B2BUA sends CANCEL to Bob's pending INVITE.
8. **Assert** when Bob replies 487, the call is fully torn down.

### Scenario 4 — Negative gate

Same packet flow as Scenario 1 but **without** the
`early_media_mode` field in the backend response.

- **Assert** Alice receives `183` (not promoted to 200), with SDP and
  PEM intact (default behavior of `relayProvisionalRule`).
- **Assert** the new policy module's rules never fire (CDR markers
  absent).

### Scenario 5 — Forking on B side, promotion holds

1. Backend opt-in. Alice INVITE.
2. Bob's upstream forks: dialog-1 (to-tag t1) sends `183 + SDP_v1 + PEM`.
3. **Assert** Alice receives `200 OK + SDP_v1`.
4. Dialog-2 (to-tag t2) sends `200 OK + SDP_v2` (the winning fork).
5. **Assert** B2BUA ACKs t2's 200 OK locally on the B side.
6. **Assert** B2BUA emits CANCEL for dialog-1 (still in early state).
7. **Assert** Alice receives a re-INVITE with `SDP_v2`.
8. After Alice ACKs, **assert** subsequent in-dialog messages from
   Alice (e.g. INFO) are routed to Bob using **t2** in the To-tag —
   inspect the request received by Bob's fake UAS.

### Scenario 6 — In-dialog rejection during window

1-4 as Scenario 1. Between Alice's 200-OK ACK and Bob's final response:

5. Alice sends UPDATE with SDP. **Assert** Alice receives 491.
6. Alice sends INFO. **Assert** Alice receives 488.
7. Alice sends re-INVITE. **Assert** Alice receives 491.
8. Alice sends BYE. **Assert** processed normally (Scenario 3c flow).

### Scenario 7 — Schema mutual exclusivity (translator unit test)

In `src/decision/adapters/http-reference/translate.test.ts`: feed the
wire decoder a payload setting `early_media_mode: "fake-prack"` AND
a hypothetical second early-media field. **Assert** decode failure or
the union narrows to a single variant — guarantees backend authors
cannot smuggle conflicting policies.

## Verification end-to-end

```bash
npm run typecheck       # tsc + Effect plugin must both be silent
npm run test:fake       # all 7 scenarios above plus regressions
```

Manual eyeball of trace logs for Scenarios 1, 2, 5: confirm the SIP
message ladder matches the expectations above (B2BUA's `tests/support`
harness emits a textual ladder per scenario).

## Open follow-ups (not in this plan)

- Live (real-clock) coverage of Scenario 5 forking in
  `tests/fullcall/e2e-real-clock.test.ts` if the fake-stack version
  proves flaky against real UDP timing.
- Promotion telemetry (counters per outcome: silent-bridge,
  resync-success, resync-fail, b-fail-post-promote, a-bye-early) —
  emit via the existing OpenTelemetry rule chain.
- If we observe stacks that reject 200 OK with `P-Early-Media` stripped
  but require some other signal, extend the transform to drop additional
  early-media-only headers.
