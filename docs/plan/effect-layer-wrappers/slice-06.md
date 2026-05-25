# Slice 6 — Old RFC runner end-of-life

Parent plan: [review-this-plan-and-noble-goblet.md](../review-this-plan-and-noble-goblet.md)
ADR: [0013-effect-layer-wrappers-and-typed-recorder.md](../../adr/0013-effect-layer-wrappers-and-typed-recorder.md)

**Irreversible.** Once landed, the recording-driven RFC engine is gone.
The remaining rule families (call-shape / cross-call / service-case)
still flow through `RuleEngine` via `tests/harness/runner.ts` until
Slice 14 collapses the recording engine entirely; `RuleEngine` itself
therefore stays.

## Files deleted

- `tests/harness/rules/rfc/_replay.ts` — every helper is duplicated in
  `_dialog-model.ts` (extracted by Slice 5). No remaining consumer.
- `tests/harness/rules/rfc/allow-supported-on-invite.ts`
- `tests/harness/rules/rfc/mid-dialog-from-uri.ts`
- `tests/harness/rules/rfc/mid-dialog-route.ts`
- `tests/harness/rules/rfc/proxy-100-trying-not-forwarded.ts`
- `tests/harness/rules/rfc/record-route-placement.ts`
- `tests/harness/rules/rfc/rport-echo.ts`
- `tests/harness/rules/rfc/sdp-o-continuity.ts`
  — the seven legacy `PerCallRule` modules. Their check logic was
  re-implemented in `cross-message-rules.ts` (Slice 5). The legacy
  modules had no consumer beyond their own export name; verified via
  `git grep`.
- `tests/harness/rules/rfc/rule.test.ts` — `describe.skip`-wrapped
  by Slice 5; targeted the empty `rfcRules` array.
- `tests/harness/rules/escape-hatches.test.ts` — same, exercised
  `RuleEngine(rfcRules)`.
- `tests/harness/rules/rfc/index.ts` — the empty-array stub.
  `tests/harness/rules/index.ts` is updated to drop the import; no
  remaining consumer.

## Files kept (intentionally)

- `RuleEngine` (`tests/harness/rules/types.ts`) — still consumed by
  `runner.ts:runDriveOnly`, `call-shape/rule.test.ts`,
  `cross-call/rule.test.ts`, `service-case/rule.test.ts`. Slice 14
  retires the recording-driven engine entirely.
- `tests/harness/rules/rfc/_dialog-model.ts`,
  `cross-message-rules.ts`, `starter-peer-rules.ts` — the new
  SignalingNetwork.scopedAudit-driven path.

## Files updated

- `tests/harness/rules/index.ts` — drops the empty `rfcRules` spread
  from `allRules`. Comment explains that RFC enforcement moved to the
  scopedAudit path.

## Files added

- `tests/harness/rules/rfc/unit/base-rules.test.ts` — three per-rule
  unit tests under `RunContext.unitTestOf(SignalingNetwork)`:
  - `rfc.maxForwards` fires on Max-Forwards: 200 (the one active
    test in the deleted `rule.test.ts`).
  - `rfc.maxForwards` passes on the clean baseline.
  - `rfc.branchPrefix` fires when the Via branch drops the magic
    cookie.

  The unit tests build a two-peer SignalingNetwork stack (alice
  10.0.0.1 ↔ bob 10.0.0.2), provide `Recorder.fake` and
  `RunContext.unitTestOf(SignalingNetwork)`, send one packet, advance
  TestClock past the transit delay, and assert the layer-close
  finalizer surfaces a `SignalingAuditViolation` with the expected
  `check` field.

## Fixture migration summary

Deleted `rule.test.ts` carried 5 `it`/`it.skip` blocks. Of those, 4
were already `.skip`'d at the legacy-engine layer (smoke checks
against `rfc.cseq`, `rfc.branchPrefix`, `rfc.contentLength`, and the
"clean fixture passes every rule" probe). Only `rfc.maxForwards` was
active.

- `rfc.maxForwards` — kept (ported).
- `rfc.branchPrefix` — kept (ported) because the canary already
  exercises `rfc.contentLength` and the per-rule test slot deserved
  one structural sanity check.
- `rfc.contentLength` — dropped; the canary at
  `tests/fullcall/canary-signaling-audit.test.ts` already covers it
  end-to-end.
- `rfc.cseq` — dropped; the legacy test was `.skip` (smoke).
- "clean fixture passes every rfc rule" — dropped; redundant with
  every fake-stack scenario that the full RFC pack runs against in
  `stackLayer({ mode: "fake" })`.

Deleted `escape-hatches.test.ts` carried 4 `it` blocks, all
`describe.skip`'d. They tested `RuleEngine`'s `disableRules` /
`expectViolations` opt-out levers against `rfc.maxForwards`. Dropped
without porting — the escape-hatch concept is a property of the
soon-to-die `RuleEngine`. The new scopedAudit path uses
`shouldAuditBind` and `severityOverride` instead; both are exercised
in-line by the broader fake-stack suite.

## References rewired outside `tests/harness/rules/`

None. `RuleEngine` consumers outside the RFC family
(`call-shape/rule.test.ts`, `cross-call/rule.test.ts`,
`service-case/rule.test.ts`, `runner.ts`) all continued to compile and
pass with the `RuleEngine` class intact.

## Verification

- `npm run typecheck` — zero tsc errors, zero Effect-plugin warnings.
- `npm run test:fake` — 204 files / 1 skipped (205); 1468 passed /
  5 skipped (1473).
  Baseline shift vs Slice 5: +3 tests passing (new unit tests), -9
  skipped (5 `rfc/rule.test.ts` + 4 `escape-hatches.test.ts`).
  Skipped count: 14 → 5.
- `git grep -l "RuleEngine\|_replay\|rfcRules" tests/ src/` — returns
  only the three call-shape / cross-call / service-case `rule.test.ts`
  files, `runner.ts`, `types.ts` (RuleEngine class). `_replay` and
  `rfcRules` are gone everywhere.
- Slice 1 canary (`tests/fullcall/canary-signaling-audit.test.ts`)
  still fails for the right reason (`rfc.contentLength`).
- `ls tests/harness/rules/rfc/` — `_dialog-model.ts`,
  `cross-message-rules.ts`, `starter-peer-rules.ts`, `unit/`. No
  `index.ts`, no `_replay.ts`, no per-rule legacy modules.

## Surprises

- `RuleEngine` is not RFC-only. The slice prompt flagged this risk
  and it landed exactly as the plan suggested: three non-RFC
  `rule.test.ts` files plus `runDriveOnly` keep the class alive. The
  scope of this slice was therefore tighter than a naive "delete the
  runner" read of the parent plan would suggest.

## One-liner for Slice 7

`SignalingNetwork.contracts.ts` has no RFC-era cruft left to clean
up before `paranoidInputs` lands; the only RFC coupling is the
`PeerAuditRule` / `CrossMessageAuditRule` interfaces and the
`scopedAudit` finalizer, both of which `paranoidInputs` does not
touch.
