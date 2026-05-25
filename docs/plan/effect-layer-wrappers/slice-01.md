# Slice 1 — SignalingNetwork.contracts + scopedAudit + canary

Parent plan: [review-this-plan-and-noble-goblet.md](../review-this-plan-and-noble-goblet.md)
ADR: [0013-effect-layer-wrappers-and-typed-recorder.md](../../adr/0013-effect-layer-wrappers-and-typed-recorder.md)

## Deliverables landed

1. **Impl split.** `src/sip/SignalingNetwork.ts` keeps the public types
   (`UdpPacket`, `UdpEndpoint`, errors, Tag classes) plus the static
   sugar (`SignalingNetwork.real`, `.realTracing`, `.simulated`).
   Implementations moved to:
    - `src/sip/SignalingNetwork.real.ts`
    - `src/sip/SignalingNetwork.realTracing.ts`
    - `src/sip/SignalingNetwork.simulated.ts`

   `realLayer` uses `Layer.suspend` so the cyclic top-level import
   (sibling impl modules reference the Tag class declared in the
   main module) is safe at module-evaluation time.

2. **Typed events + scopedAudit + projector.** `src/sip/SignalingNetwork.contracts.ts`
   exports the `SignalingNetworkEvent` discriminated union, the
   `SignalingAuditViolation` Data.TaggedError, the `scopedAudit`
   wrapper, the `toSipWire` projector, and `withAllContracts(options)`.

   `scopedAudit`:
    - Wraps `bindUdp` via `recordScopedAcquire` (acquire/release events).
    - Wraps `send` via `recordEffectCall` (called + result events).
    - Wraps `messages` Stream via `recordStreamLifecycle`.
    - Also wraps `take` / `poll` to emit `messages.streamItem` —
      the test harness reads via `take()` and would otherwise bypass
      the Stream tap.
    - Per-bindUdp finalizer runs configured peer rules over the
      `bindKey`-filtered event slice.
    - Layer-close finalizer dies with `SignalingAuditViolation` in
      `test-with-recorder` mode if any deferred-fail finding is queued.
    - `shouldAuditBind(bindKey)` predicate exempts the DUT's own
      bind from per-peer dialog rules (the B2BUA worker rewrites
      Call-IDs across legs on one socket, which trips per-dialog
      validators authored against pure UAC/UAS agents).

3. **Five RFC rules ported.** `tests/harness/rules/rfc/starter-peer-rules.ts`
   exposes `rfcCseq`, `rfcTags`, `rfcBranchPrefix`,
   `rfcContentLength`, `rfcCallId` as `PeerAuditRule[]`. Each rule
   reuses the existing `runValidationChecks` validator filtered to
   one check. State replay is partitioned per `Call-ID` so a single
   bind handling multiple dialogs doesn't cross-contaminate.

   The same five entries are removed from `tests/harness/rules/rfc/index.ts`
   `rfcRules` array (per D9). Three corresponding rule self-tests
   in `tests/harness/rules/rfc/rule.test.ts` (`rfc.cseq`,
   `rfc.branchPrefix`, `rfc.contentLength`) are `it.skip`'d; the
   formal per-rule unit-of-layer fixtures land in Slice 6 per D9.

4. **fakeStackLayer wiring.** `tests/support/fakeStack.ts`:
    - Provides `Recorder.fake` + `RunContext.testWithRecorder`.
    - Pipes `SignalingNetwork.simulated` through
      `withAllContracts({ scopedAudit: { rules: starterPeerRules,
      shouldAuditBind } })`.
    - Exposes `Recorder` outward so tests can yield it.
    - Accepts `perfMode: "baseline" | "no-audit" | "full"` (default
      `"full"`) for D11 perf checkpoints.
    - Accepts `extraPeerRules` for tests that want to seed extra
      rules without touching the default pack.
    - `liveStack.ts` UNCHANGED (Slice 2a moves the wiring to
      stackLayer).

5. **Canary test.** `tests/fullcall/canary-signaling-audit.test.ts`.
   Builds a minimal two-peer fabric (no DUT, no agents library),
   alice sends a deliberately Content-Length-mismatched INVITE to
   bob, the `rfc.contentLength` rule fires at bob's bindUdp scope
   close, and the layer-close finalizer surfaces a
   `SignalingAuditViolation` defect. The test passes when the
   audit path is alive and fails when the wrapper is silenced.

## Verification

- `npm run typecheck` — zero tsc errors, zero Effect-plugin warnings.
- `npm run test:fake` — 205 files / 1471 tests passing, 3 files skipped
  (the three rule self-tests covered by the new path in Slice 6).
  No regressions vs pre-slice baseline beyond the deliberate skips.

## Perf checkpoint 1

Two consecutive `npm run test:fake` runs per configuration:

| Config       | Run 1      | Run 2      | Average    |
| ------------ | ---------- | ---------- | ---------- |
| baseline     | 29.15 s    | 30.91 s    | 30.03 s    |
| no-audit     | 29.84 s    | 28.79 s    | 29.32 s    |
| full         | 30.02 s    | 29.17 s    | 29.60 s    |

Deltas (negative = faster than baseline):

- `no-audit` vs `baseline`: **−0.71 s (−2.4 %)**. Well below the
  +10 % alert threshold; the recording channel is essentially free
  here because most fake-clock tests are dominated by TestClock
  bookkeeping and Layer build/teardown, not per-call overhead.
- `full` vs `baseline`: **−0.43 s (−1.4 %)**. Far below the +50 %
  soft ceiling. The five starter rules only run at scope close,
  parsing message-bytes once per peer — negligible against a
  ~30 s suite.
- `full` vs `no-audit`: **+0.28 s (+1.0 %)**. Rule evaluation cost
  is below per-run noise.

Read: noise dominates the deltas — all three modes are statistically
indistinguishable at this suite size. No quadratic-rule blunders;
no recording-channel overhead worth fixing this slice. The next
perf checkpoint (Slice 7, +paranoidInputs) is the next natural test.

## Anomalies / deviations from the plan

- Plan referred to `UdpEnvelope` in the event payload; the actual
  exported type is `UdpPacket`. Used `UdpPacket` (renaming the type
  is out of scope).
- Plan said per-bindUdp finalizer should fail `Effect.fail(SignalingAuditViolation)`
  immediately in `unit-test-of-layer`. Finalizers can't carry typed
  errors, so we `Effect.die` with the same value — symmetric with
  `src/call/codec/contracts.ts`'s scopedAudit, which uses the same
  trick.
- Plan said wrappers must also handle `propertyTest` / `paranoidInputs`
  forwarders; both are intentionally omitted for SignalingNetwork
  (no natural input domain → propertyTest skipped per D6's footnote;
  paranoidInputs deferred to Slice 7).
- `shouldAuditBind` predicate isn't in the original spec — added as
  the minimal escape hatch for the B2BUA worker's multi-leg socket.
  Without it, per-dialog CSeq fires on legitimate B2BUA Call-ID
  rewrites. The cleaner solution (per-dialog projection) is part of
  Slice 5's 7 cross-message rules.

## Slice 2a handoff

`tests/support/fakeStack.ts` is now responsible for:
- building `Recorder.fake` and `RunContext.testWithRecorder`
- piping `SignalingNetwork.simulated` through `withAllContracts`
- threading the DUT bind exemption (`shouldAuditBind`)
- exposing `Recorder` outward
- the three `perfMode` configurations

In Slice 2a this wiring moves to the new `tests/support/stackLayer.ts`
behind `stackLayer({ mode: "fake" })`. `fakeStack.ts` then becomes a
thin re-export until the rest of the catalog catches up. `liveStack.ts`
is UNCHANGED this slice — Slice 2a does its first pass at the
unified shape.
