# REFER-Driven Blind Transfer on the B2BUA

**Status:** Slice 1, 2, 3, 4, 5, 6, 7, 8, 9 done
**Driver:** Implement REFER blind transfer for called

## Context

Today the B2BUA has no REFER handling — `/call/refer` exists as a stub on `MockCallControlServer` that always rejects 603, and no rule in `src/b2bua/rules/` matches REFER. We want **B2BUA-mediated blind transfer** where the B2BUA, not A, places the outbound call to the transfer target C, hides the transfer from A (no REFER/NOTIFY reaches A), and swaps A's media endpoint from B to C via B2BUA-originated re-INVITEs. Direction: REFER arrives on the **B leg** (B is the remote UAS talking to our b-leg UAC). Scope v1: **only blind in-dialog REFER on the B leg.** Attended-with-Replaces, REFER on A-leg, and out-of-dialog REFER are rejected with clean SIP errors.

### Wire diagram (happy path)

```
A                      B2BUA                      B                      C
|                        |                        |                        |
|====== A↔B call in progress ====================|                        |
|                        |                        |                        |
|                        |<---- REFER (Refer-To:C)|                        |
|                        |----- 202 Accepted ---->|                        |
|                        |----- NOTIFY 100 ------>|      (active;expires=60)
|                                                 |                        |
|                        |--- POST /call/refer -->|                        |
|                        |<--- {allow,dest=...,..}|                        |
|                        |                        |                        |
|                        |-------------------- INVITE C (held SDP) ------->|
|                        |<-------------------------- 180 Ringing ---------|
|                        |----- NOTIFY 180 ------>|                        |
|                        |<-------------------------- 200 OK ---------------|
|                        |------------------------ ACK C ----------------->|
|                        |----- NOTIFY 200 (terminated) ----------------->|
|                        |<------ BYE ------------|                        |
|                        |------- 200 ----------->|                        |
|                        |                                                 |
|                        |---- re-INVITE C (A_sdp) ---------------------->|  (phase c-realigning)
|                        |<-------------------------- 200 OK ---------------|
|                        |------------------------ ACK C ----------------->|
|                        |                                                 |
|<--- re-INVITE (C_sdp) --|                                                 |  (phase a-realigning)
|--- 200 OK ------------>|                                                 |
|<-- ACK ----------------|                                                 |
|                        |  merge(a,c); call.transfer=null                 |
|                                                                          |
|========== A↔C call aligned ==============================================|
```

### Key design commitments (all grilled and confirmed)

| # | Decision | Why |
|---|----------|-----|
| D1 | v1 scope: **blind in-dialog REFER on B leg only** | Everything else (Replaces, A-leg REFER, OOD REFER) is rare and multiplies test surface. Reject with 501/481/491 as appropriate. |
| D2 | `CallReferAllowResponse` = superset of `NewCallRouteResponse` (destination, new_refer_to, update_headers, no_answer_timeout_sec, call_limiter, callback_context, relay_first_18x_to_180) | Reuse `createBLegFromRoute()` for the C leg. Backend gets the same routing/policy levers as for a fresh call. |
| D3 | Initial INVITE to C carries **synthetic held SDP** (`a=inactive`, port 0) with A's codec list copied in | Protects against C responding 488 when our placeholder codecs don't match C's support. |
| D4 | Two re-INVITEs, **sequential, C first** | C first lets us fully configure C, then swap A. On A failure we roll back without leaving A in a weird state. |
| D5 | **Final NOTIFY at C's initial 200** | User choice. B drops itself early. Trade-off: failures during c-realigning/a-realigning can't be signalled to B — we terminate the whole call. |
| D6 | NOTIFY sipfrag sequence: 202 immediately → NOTIFY 100 immediately → NOTIFY 1xx per distinct C status → NOTIFY 200 terminated at C pickup | Minimises B-side timeouts; user accepted. |
| D7 | **B2BUA never originates BYE to B on the success path.** Absorb B's BYE. Safety net = existing `terminating-safety-timeout` | Matches "B BYEs itself after final NOTIFY." |
| D8 | On abort (A hangs up mid-ring, HTTP reject, etc.) B2BUA *does* BYE B via `begin-termination`. | The "don't BYE B" rule is only the success path. |
| D9 | New typed `Call.transfer: TransferState \| null` field | Schema-validated, observable in traces/CDR. C-leg's own state/disposition stays on the `Leg` — `TransferState` only carries pointer+payload data and the phase marker. |
| D10 | Regime 1 (phases `refer-authorizing`, `c-ringing`): **fully transparent A↔B relay**, only REFER is intercepted + BYE has a side-effect (cancel C). Regime 2 (phases `c-realigning`, `a-realigning`): **aggressive 491 / 481** | Two-regime model: let A and B keep communicating until the SDP swap actually starts. |
| D11 | C re-INVITE immediately after its 200 → **491 Request Pending** | Deflects the glare; C retries after merge and it flows through normal A↔C relay. |
| D12 | C INVITE failure in CR: v1 just NOTIFY B with the failure code (no failover). Failover deferred to a later slice (same `/call/failure` plumbing). | Limits v1 surface per user. |
| D13 | Transfer timers: `refer_subscription_expiry=60s`, `refer_reinvite_answer=32s`, `refer_overall_safety=120s` | Prevents stuck state. |
| D14 | New rules go in `src/b2bua/rules/defaults/TransferRules.ts` (always-on). Not a policy module. | REFER-as-blind-transfer is core B2BUA behavior, not a customer policy. |

---

## Post-refactor constraints (apply to every remaining slice)

The rule-framework ADT refactor (slices A–G of [RULE-FRAMEWORK-ADT-REFACTOR.md](RULE-FRAMEWORK-ADT-REFACTOR.md)) landed after REFER slices 1–4 shipped. Every remaining REFER slice must respect the following contracts — they are compile-time enforced:

1. **Typed body / header / URI slots only.** Any rule that mutates outbound bodies, headers, or Request-URIs routes through the ADTs in [src/b2bua/rules/framework/actions/types.ts](../../src/b2bua/rules/framework/actions/types.ts):
   - Body → `bodyUpdate: BodyUpdate` (`{ kind: "inherit" | "set" | "drop" }`).
   - Headers → `headerUpdates: HeaderUpdates` with `replaceH(...)` / `removeH()` factories from [actions/factories.ts](../../src/b2bua/rules/framework/actions/factories.ts).
   - Request-URI → `ruri: RuriOp` with `toBareUri(...)` — never a raw string. Name-addr strings (from `Refer-To`, `Contact`) must be converted via `toBareUri` which strips brackets/display/header-params.
   - The legacy `updateBody` / `updateHeaders` / `newRuri` fields no longer exist (removed in slice F). Do not reintroduce them.

2. **`MessageTransform` on relay actions uses the same ADTs.** If a transfer-rule mutates a relayed message, it passes `headerUpdates` / `bodyUpdate` inside `MessageTransform` — not `Record<string, string | null>` / `Uint8Array | null`.

3. **Executor destructure discipline (slice G).** Any new `executeXxx` for a new action (e.g. `send-reinvite`) MUST begin:
   ```ts
   const { type, /* every other field */ } = action
   void type
   ```
   `noUnusedLocals` / `noUnusedParameters` in [tsconfig.json](../../tsconfig.json) turns any ignored action field into a typecheck error — preventing the class of bug where `create-leg.updateBody` shipped "typed but never read" through four review passes.

4. **Single-reach primitive actions.** Prefer primitives over composites. `confirmDialog({legId})` touches only the named leg; `updateLegState({legId, state})` touches only that leg's state; the `confirmBridgedCall(sourceLeg, aLeg, sourceTag)` factory in [actions/composites.ts](../../src/b2bua/rules/framework/actions/composites.ts) is the documented composite for the full A↔B confirm dance. **The C-leg confirm** at `transfer-c-200-initial` MUST use `confirmDialog({ legId: cLeg.legId })` directly — not `confirmBridgedCall` (the C leg is not yet peered to A) and not a `skipPeerSync` workaround (that flag no longer exists — it was removed in slice B).

5. **Reach tests per new primitive.** `tests/unit/rules/actions-reach.test.ts` gains one test per new action field introduced by REFER. A `send-reinvite` with `bodyUpdate: { kind: "set", value }` must have a test asserting the outbound carries exactly that value and no other state is touched.

---

## Files to create or modify

### Create
- `src/sip/SdpUtils.ts` — `extractCodecProfile(body)`, `buildHeldSdpFromProfile(profile)`. Minimal string-level SDP parsing; no external library. Unit-tested.
- `src/sip/SipFragUtils.ts` — `sipfragFromStatus(code, reason): Uint8Array` producing `SIP/2.0 <code> <reason>\r\n`.
- `src/b2bua/rules/defaults/TransferRules.ts` — all new rules (see inventory below).

### Modify
- `src/http/CallControlSchemas.ts` — expand `CallReferAllowResponse` to superset of `NewCallRouteResponse`. Document in comments that `CallReferRequest.call_id` is the A-leg Call-ID.
- `src/http/CallControlClient.ts` — add `callRefer(req): Effect<CallReferResponse, HttpError>`.
- `src/http/MockCallControlServer.ts` — implement `/call/refer` with X-Api-Call driven matrix (keys: `refer-allow-c`, `refer-allow-failover` [deferred slice], `refer-reject-403`, `refer-http-timeout`, `refer-http-500`). The allow response returns a C destination keyed by the transfer target's host (e.g., Refer-To `sip:c@…` → `destination: { host: "127.0.0.1", port: <c-port-from-header> }`).
- `docs/sip-call-control.yaml` — OpenAPI spec update for `/call/refer`.
- `src/sip/MessageFactory.ts` — add `buildNotify()` (structured NOTIFY request builder: event name, subscription state, sipfrag body, dialog context). Add `buildOriginatedInvite(dialog, sdp, extraHeaders)` for B2BUA-originated re-INVITE carrying chosen SDP.
- `src/call/CallModel.ts` — add `TransferPhase` literal, `TransferState` struct, `Call.transfer?: TransferState | null` field. Extend `TimerType` with `refer_subscription_expiry | refer_reinvite_answer | refer_overall_safety`.
- `src/b2bua/rules/framework/RuleDefinition.ts` — extend `Match.filter` with a `transferPhase?: TransferPhase | TransferPhase[]` hint that the Matcher evaluates against `call.transfer?.phase`.
- `src/b2bua/rules/framework/Matcher.ts` — read the new filter hint and gate candidates.
- `src/b2bua/rules/framework/ActionExecutor.ts` — `send-notify` is already landed (slice 4). Still to add: `send-reinvite` action (composes `buildOriginatedInvite` + CSeq bump + placeholder stamping + route-set). It sits next to `send-request-to-leg` and shares its infrastructure; REFER-specific semantics stay in the rules. **Post-refactor constraints (slices A–G of the rule-framework ADT refactor):**
  - SDP/body parameter on `send-reinvite` MUST be a `bodyUpdate: BodyUpdate` slot (from [`./actions/types.ts`](../../src/b2bua/rules/framework/actions/types.ts)), not a raw `Uint8Array | null`. Build with `{ kind: "set", value: sdpBytes }` at the call site. Matches the `create-leg.bodyUpdate` shape so `applyBodyUpdate` can be reused.
  - Any extra headers MUST use `headerUpdates: HeaderUpdates` via `replaceH(...)` / `removeH()` factories — not `Record<string, string | null>`.
  - `executeSendReinvite` MUST begin with a full destructure of every action field + `void type` discriminator marker (Slice G destructure discipline). `noUnusedLocals` / `noUnusedParameters` will break the build if any declared field is not read.
- `src/b2bua/B2buaCore.ts` — register the new TransferRules in the handler registry.
- `src/b2bua/InitialInviteHandler.ts` or `helpers.ts` — if `createBLegFromRoute` needs a new parameter for "build with held SDP instead of copying a-leg body", add it. Otherwise call it as-is and have the rule override the body via `create-leg.bodyUpdate` + `create-leg.headerUpdates` (the typed ADT slots; the old `updateBody` / `updateHeaders` / `newRuri` fields were removed in slice F).

### Tests
- `tests/sip/sdp-utils.test.ts` — unit
- `tests/sip/sipfrag-utils.test.ts` — unit
- `tests/sip/message-factory-notify.test.ts` — unit
- `tests/sip/message-factory-originated-invite.test.ts` — unit
- `tests/b2bua/transfer-state-schema.test.ts` — unit (Schema roundtrip, phase transitions)
- `tests/e2e/refer/*.test.ts` — one file per slice (see below)

---

## Rule inventory (all in `TransferRules.ts`, custom band priority 100–199)

| Rule id | Match | Emits actions |
|---------|-------|---------------|
| `transfer-intercept-refer` | `{ kind:"request", method:"REFER", direction:"inbound", legDisposition:"bridged", transferPhase:null, filter: no Replaces }` | `respond 202`, `schedule-timer refer_subscription_expiry`, `schedule-timer refer_overall_safety`, set `call.transfer.phase="refer-authorizing"`, `send-notify 100 active`, async kick HTTP `/call/refer` (via a call-control effect) |
| `transfer-reject-second-refer` | `{ kind:"request", method:"REFER", direction:"inbound", transferPhase:["refer-authorizing","c-ringing","c-realigning","a-realigning"] }` | `respond 491` |
| `transfer-reject-replaces` | `{ kind:"request", method:"REFER", direction:"inbound", filter: has Replaces in Refer-To }` | `respond 501` |
| `transfer-reject-a-leg-refer` | `{ kind:"request", method:"REFER", direction:"inbound", legDisposition: "a-leg-something" }` | `respond 501` |
| `transfer-http-allow` | `{ kind:"callcontrol-response", endpoint:"/call/refer", outcome:"allow", transferPhase:"refer-authorizing" }` — new match kind (see below) | `create-leg` with destination + held SDP body passed as `bodyUpdate: { kind: "set", value: heldSdp }` (built from `extractCodecProfile` on `call.aLeg.lastRemoteSdp`); `update-transfer { phase: "c-ringing", cLegId }` |
| `transfer-http-reject` | `{ kind:"callcontrol-response", endpoint:"/call/refer", outcome:"reject", transferPhase:"refer-authorizing" }` | `send-notify <code> terminated`, clear `call.transfer`, `cancel-timer refer_*` |
| `transfer-http-timeout` | `{ kind:"timer", timerType:"refer_subscription_expiry", transferPhase:"refer-authorizing" }` | `send-notify 500 terminated`, clear transfer |
| `transfer-c-1xx-to-notify` | `{ kind:"response", cseqMethod:"INVITE", statusClass:"1xx", sourceLeg:"c", transferPhase:"c-ringing" }` | `send-notify <1xx> active`; dedup by last-sent-status |
| `transfer-c-200-initial` | `{ kind:"response", cseqMethod:"INVITE", statusClass:"2xx", sourceLeg:"c", transferPhase:"c-ringing" }` | `ack-leg C`, capture `cInitialSdp` into transfer state, `send-notify 200 terminated`, `cancel-timer refer_subscription_expiry`, `update-transfer { phase: "c-realigning", cInitialSdp }`, `schedule-timer refer_reinvite_answer`, `send-reinvite C` with `bodyUpdate: { kind: "set", value: aLegSdp }` |
| `transfer-c-fail-initial` | `{ kind:"response", cseqMethod:"INVITE", statusClass:["3xx","4xx","5xx","6xx"], sourceLeg:"c", transferPhase:"c-ringing" }` | `send-notify <code> terminated`, clear transfer (C leg auto-terminates via existing route-failure rule) |
| `transfer-c-realign-200` | `{ kind:"response", cseqMethod:"INVITE", statusClass:"2xx", sourceLeg:"c", transferPhase:"c-realigning" }` | `ack-leg C`, `cancel-timer refer_reinvite_answer`, `update-transfer { phase: "a-realigning" }`, `schedule-timer refer_reinvite_answer`, `send-reinvite A` with `bodyUpdate: { kind: "set", value: cInitialSdp }` |
| `transfer-c-realign-fail` | `{ kind:"response", cseqMethod:"INVITE", statusClass:["4xx","5xx","6xx"], sourceLeg:"c", transferPhase:"c-realigning" }` OR timer | `begin-termination`, CDR `transfer-rollback-c-realign` |
| `transfer-a-realign-200` | `{ kind:"response", cseqMethod:"INVITE", statusClass:"2xx", sourceLeg:"a", transferPhase:"a-realigning" }` | `ack-leg A`, `cancel-timer refer_*`, `merge(a,c)`, clear `call.transfer`, CDR `transfer-completed` |
| `transfer-a-realign-fail` | response 4xx/5xx/6xx on A or timer | `begin-termination`, CDR `transfer-rollback-a-realign` |
| `transfer-c-glare-reinvite` | `{ kind:"request", method:"INVITE", direction:"inbound", sourceLeg:"c", transferPhase:["c-realigning","a-realigning"] }` | `respond 491` |
| `transfer-a-glare-reinvite` | `{ kind:"request", method:"INVITE", direction:"inbound", sourceLeg:"a", transferPhase:["c-realigning","a-realigning"] }` | `respond 491` |
| `transfer-a-bye-during-cr` | `{ kind:"request", method:"BYE", direction:"inbound", sourceLeg:"a", transferPhase:["refer-authorizing","c-ringing"] }` | `send-notify 487 terminated`, `cancel-leg C` (CANCEL if trying/early, BYE if confirmed), then fall through so `relay-bye` still runs (uses `composesWith` if needed, or emit the actions directly including relay-bye equivalents) |
| `transfer-b-bye-during-transfer` | `{ kind:"request", method:"BYE", direction:"inbound", sourceLeg:"b", transferPhase:["refer-authorizing","c-ringing"] }` | best-effort `send-notify 487 terminated`, `cancel-leg C`, relay BYE to A |
| `transfer-overall-timeout` | `{ kind:"timer", timerType:"refer_overall_safety" }` | `begin-termination`, CDR `transfer-overall-timeout` |
| `transfer-b-in-cre-are-reject` | `{ kind:"request", sourceLeg:"b", transferPhase:["c-realigning","a-realigning"], filter: method != BYE }` | `respond 481` |

**New match kind:** `callcontrol-response` (above rows reference this). Since rules currently only match SIP events, we need either (a) a new `Match.kind="callcontrol-response"` feeding off a new stream of HTTP events routed through the rule chain, or (b) run the HTTP call as an effect in `transfer-intercept-refer` and self-emit a synthetic SIP-like event. Option (b) is cheaper: the rule `transfer-intercept-refer` fires the HTTP call as an effect, and the success/failure handler emits a **call-scoped synthetic event** `{kind:"internal-event", topic:"refer-http-result", outcome, payload}`. We add `internal-event` as a Match.kind.

---

## Testable slices

Each slice ends on green `npm test` and green `npm run typecheck`. Slices 1–3 are non-functional (types/builders only). Slices 4–7 implement REFER behavior; slice 4 is *always-reject* end-to-end, slices 5–7 add the allow path behind a feature flag `REFER_ALLOW_ENABLED=false` until slice 7 removes it. Every slice has its own commit on master.

### Slice 1 — HTTP contract + mock
- Expand `CallReferAllowResponse` schema (D2).
- Implement `CallControlClient.callRefer()`.
- Implement X-Api-Call-driven `/call/refer` in `MockCallControlServer`: keys `refer-reject-403`, `refer-http-timeout`, `refer-http-500`. (`refer-allow-c` added in slice 5.)
- Update `docs/sip-call-control.yaml`.
- **Tests:** `tests/http/call-control-client-refer.test.ts` — POST /call/refer with each X-Api-Call key, assert response shape. Schema roundtrip tests.

### Slice 2 — SIP builders (NOTIFY, sipfrag, held SDP)
- `MessageFactory.buildNotify()`.
- `SipFragUtils.sipfragFromStatus()`.
- `SdpUtils.extractCodecProfile()` and `buildHeldSdpFromProfile()`.
- `MessageFactory.buildOriginatedInvite()` — new re-INVITE builder that takes a confirmed dialog + SDP body + Contact/Via placeholders.
- **Tests (unit):**
  - SDP: parse `m=audio 20000 RTP/AVP 8 18 101` → codecs [8,18,101] with rtpmaps preserved; round-trip synthetic held SDP.
  - sipfrag: `sipfragFromStatus(180, "Ringing")` → exact bytes match.
  - NOTIFY: parse back, assert Event: refer, Subscription-State, Content-Type: message/sipfrag, CSeq bump against dialog.
  - Originated INVITE: assert CSeq = `dialog.localCSeq + 1`, Contact has placeholder, Via has placeholder, body is passed through.

### Slice 3 — TransferState typed field + timer types + match filter
- `CallModel.ts`: add `TransferPhase`, `TransferState`, `Call.transfer`, extend `TimerType`.
- `RuleDefinition.ts`: add `transferPhase` to `Match.filter`.
- `Matcher.ts`: read and gate on it.
- **Tests:**
  - Schema roundtrip: `Call` with `transfer: { phase: "c-ringing", cLegId: "b-2", ... }` encodes/decodes.
  - Matcher unit: two rules, one gated on `transferPhase:"c-ringing"` and one on `null`; Matcher picks correctly based on `call.transfer?.phase`.

### Slice 4 — Reject paths only (no C leg)
- New rules: `transfer-intercept-refer` (HTTP call + NOTIFY 100), `transfer-http-reject`, `transfer-http-timeout`, `transfer-reject-second-refer`, `transfer-reject-replaces`, `transfer-reject-a-leg-refer`.
- New `internal-event` match kind for the HTTP result.
- **Feature flag:** `REFER_ALLOW_ENABLED=false`: when the HTTP response is `allow`, log + emit NOTIFY 501 terminated. Keeps slice self-contained.
- **E2E tests (`tests/e2e/refer/reject.test.ts`):**
  - REFER → X-Api-Call=`refer-reject-403` → assert wire: 202, NOTIFY 100 active, NOTIFY 403 terminated. A↔B still alive.
  - REFER → X-Api-Call=`refer-http-timeout` → 202, NOTIFY 100, 60s later NOTIFY 500 terminated (TestClock).
  - REFER with `Replaces=` in Refer-To → 501.
  - REFER out-of-dialog (unknown Call-ID) → 481.
  - Second REFER during `refer-authorizing` → 491.

### Slice 5 — Allow path through final NOTIFY (no re-INVITEs)
- Rules: `transfer-http-allow` (creates C leg via `create-leg` with `bodyUpdate: { kind: "set", value: heldSdpBytes }` — `createBLegFromRoute` is invoked by `executeCreateLeg` and the typed `bodyUpdate` overrides the a-leg body), `transfer-c-1xx-to-notify`, `transfer-c-200-initial` (but stop before `send-reinvite C` — ACK + final NOTIFY only + `confirmDialog({ legId: cLeg.legId })` for the C dialog; phase stays `c-ringing` or set a dummy), `transfer-c-fail-initial`.
- MockCallControlServer: add `refer-allow-c` returning destination pointing at the e2e harness's C UA.
- **Still feature-flagged:** leave re-INVITEs disabled.
- **E2E tests (`tests/e2e/refer/c-leg-lifecycle.test.ts`):**
  - Happy up-to-final-NOTIFY: REFER → 202 → 100 → HTTP allow → INVITE C → 180 → NOTIFY 180 active → 200 → ACK → NOTIFY 200 terminated → B BYE → 200 → transfer state cleared (except no A↔C merge). Call ends when A BYEs (A↔B-less, A alone — drop).
  - C rejects 486: NOTIFY 486 terminated, transfer cleared, A↔B continues.
  - C rejects 603: NOTIFY 603 terminated.
  - C no-answer (no_answer_timeout_sec): NOTIFY 408 terminated.
  - Multiple 18x (180 then 183 then 180): exactly one NOTIFY per distinct code.
  - A BYE during c-ringing: NOTIFY 487 terminated, CANCEL C, begin-termination.
  - B BYE during c-ringing: NOTIFY 487, CANCEL C, BYE relayed to A.

### Slice 6 — re-INVITE C with A's SDP (c-realigning)
- Add the `send-reinvite` action variant to `RuleAction` in `RuleDefinition.ts` with shape `{ type, legId, bodyUpdate?: BodyUpdate, headerUpdates?: HeaderUpdates }` and its `executeSendReinvite` in `ActionExecutor.ts`. Executor MUST destructure every field + `void type` per slice-G discipline. Reuse `applyBodyUpdate` and `applyHeaderUpdates` from the existing helpers so the same ADT semantics hold as for `create-leg`.
- Add a reach test in `tests/unit/rules/actions-reach.test.ts` asserting `send-reinvite { legId, bodyUpdate: { kind: "set", value } }` produces exactly one outbound INVITE with that body and mutates no unrelated state.
- Enable `send-reinvite C` path in `transfer-c-200-initial`. Add rules: `transfer-c-realign-200`, `transfer-c-realign-fail`, `transfer-c-glare-reinvite`, `transfer-b-in-cre-are-reject`.
- **E2E tests (`tests/e2e/refer/c-realign.test.ts`):**
  - Happy c-realign: observe re-INVITE C carries A's SDP, CSeq bumped, Contact stamped with leg=b-2; C answers 200; ACK; phase = a-realigning (stops before a-realign in this slice? better: leave a-realigning as another stub stop, or continue — simpler to wire both at once in S7).
  - C rejects re-INVITE 488: observe rollback (BYE C, BYE A, BYE B if alive); CDR has `transfer-rollback-c-realign`.
  - re-INVITE-C timeout (32s TestClock): rollback.
  - C sends its own re-INVITE immediately after 200: assert 491.
  - A sends in-dialog INFO during c-realigning: 481 (B leg semi-dead) OR relay (TBD; initial plan says locally 200; either way assert consistent).
  - B re-INVITEs during c-realigning: 491 (or 481; assert whichever we pick).

### Slice 7 — re-INVITE A + merge (feature flag off)
- Rules: `transfer-a-realign-200`, `transfer-a-realign-fail`, `transfer-a-glare-reinvite`.
- Remove `REFER_ALLOW_ENABLED` flag — production path live.
- **E2E tests (`tests/e2e/refer/full-transfer.test.ts`):**
  - Happy full: A↔B established, REFER, HTTP allow, INVITE C, 200, NOTIFY 200 terminated, B BYE, re-INVITE C, 200 ACK, re-INVITE A, 200 ACK, merge(a,c) verified. Subsequent A INFO → C; C INFO → A; BYE on either side tears down both.
  - A rejects re-INVITE 488 in a-realigning: rollback, begin-termination; all three legs get BYE. CDR `transfer-rollback-a-realign`.
  - A sends re-INVITE during a-realigning (glare): 491.
  - A BYE during a-realigning (A hangs up while its re-INVITE is outstanding): begin-termination.
  - Check Via `;cr=` and `;lg=` stamping is correct on every B2BUA-originated message (re-INVITEs and NOTIFYs).

### Slice 8 — Safety timers
- Wire `refer_overall_safety` (120s) and ensure `refer_reinvite_answer` (32s per re-INVITE) actually fires when a re-INVITE times out. `refer_subscription_expiry` already wired in slice 4.
- **E2E tests with TestClock (`tests/e2e/refer/timers.test.ts`):**
  - HTTP hangs indefinitely: 60s subscription expiry → NOTIFY 500 terminated, A↔B continues.
  - C never answers the initial INVITE: existing `no_answer_timeout` fires first, triggers `transfer-c-fail-initial`.
  - Overall safety: inject state where phase gets stuck in `c-realigning` somehow (bad mock); after 120s, rollback.
  - 32s re-INVITE A answer timeout: rollback.

### Slice 9 — Regime-1 transparency + Regime-2 gating
- Audit: already covered across slices 4–7 via specific rules. Slice 9 is the *verification* slice: targeted tests that the gating matrix from Q7 holds.
- **E2E tests (`tests/e2e/refer/gating.test.ts`):**
  - A re-INVITE during refer-authorizing: relays transparently to B. B answers 200, A gets 200.
  - A re-INVITE during c-ringing: relays transparently to B. C still ringing.
  - A re-INVITE during c-realigning: 491.
  - A re-INVITE during a-realigning: 491.
  - INFO from A during refer-authorizing: relays to B.
  - INFO from A during c-ringing: relays to B.
  - B INFO during refer-authorizing: relays to A.
  - B INFO during c-realigning: 481.
  - Second REFER during every phase: 491.
  - CANCEL against REFER transaction: 481.

### Slice 10 — Rule coverage + kill testing
- Run `npm test` — confirm all new rules appear in `test-results/fake-clock/index.html` rule-coverage with ≥1 firing.
- Kill testing: `npm run test:rule-kill` is currently a no-op pending a fake-clock speedup. Run `tsx scripts/rule-kill.ts` manually against the transfer rule ids and assert zero surviving mutants. Where mutants survive, add the missing test in the relevant slice's test file (not here — backfill). See [rule-coverage-and-killing.md](../rule-coverage-and-killing.md).

---

## Verification plan

- **Static:** `npm run typecheck` passes with zero errors, zero warnings, after every slice commit.
- **Unit:** `npm test` (unit subset) green after each slice. New unit tests listed per slice.
- **E2E simulated:** each slice's e2e file runs under the e2e framework in `tests/e2e/` against the in-memory `simulated-backend.ts` (which uses `B2buaCoreLayer`). No real network. Fake clock for timers.
- **Rule coverage:** inspect `test-results/fake-clock/index.html` after slice 10 — every new rule has non-zero firing count.
- **Rule kill (mutation testing):** `tsx scripts/rule-kill.ts` (run manually — `npm run test:rule-kill` is a no-op pending fake-clock speedup) must report zero surviving mutants for the new transfer rules.
- **Interop (optional, post-v1):** run a real SIPp scenario from `sippperftest/` against a live B2BUA instance with MockCallControlServer; issue REFER via a modified SIPp scenario; capture pcap and verify wire compliance.

---

## Out of scope (deferred slices)

- REFER with `Replaces=` (attended transfer).
- REFER originated from the A leg.
- REFER-Sub: false (RFC 4488).
- Failover on C INVITE failure (`/call/failure` returning failover to a C2).
- 3xx redirect handling for C INVITE.
- Mid-transfer worker crash recovery.
- Originating BYE on B for the success path (intentionally excluded by D7).
