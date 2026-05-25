# Slice 7 — SignalingNetwork.paranoidInputs + perf checkpoint 2

Parent plan: [review-this-plan-and-noble-goblet.md](../review-this-plan-and-noble-goblet.md)
ADR: [0013-effect-layer-wrappers-and-typed-recorder.md](../../adr/0013-effect-layer-wrappers-and-typed-recorder.md)

## Deliverables landed

1. **`paranoidInputs` wrapper.** `src/sip/SignalingNetwork.contracts.ts`
   gains a `paranoidInputs(inner)` Layer wrapper that asserts
   caller-side preconditions on every `bindUdp` and `send` call.
   Violations surface via `Effect.die(new SignalingParanoidInputViolation)`
   — programmer errors, not recoverable failures — symmetric with the
   codec's `paranoidInputs` for sync APIs (which `throw`).

2. **Failure class.** `SignalingParanoidInputViolation extends Error`
   with `_tag = "SignalingParanoidInputViolation"`. Same shape as
   `CodecParanoidInputViolation` so test introspection via
   `Cause.failureOption`-style is consistent across services.

3. **`withAllContracts` extended.** The forwarder now also composes
   `paranoidInputs`. Default: ON (caller passes nothing → PA layer
   applied). Opt-out: `withAllContracts(impl, { paranoidInputs: false })`.

4. **`stackLayer` defaults.**
   - `perfMode: "full"` (default) → PA + 24-rule pack + scopedAudit.
   - `perfMode: "no-audit"` → PA SKIPPED + empty rule packs (this is
     the "recording-overhead only" measurement).
   - `perfMode: "baseline"` → no wrappers at all.

5. **Verification.**
   - `npm run typecheck`: zero tsc errors, zero Effect-plugin warnings.
   - `npm run test:fake`: 204 files / 1468 tests passing, 1 file / 5
     tests skipped — identical to Slice 6 baseline. No PA check caught
     any pre-existing caller bug; every legitimate call site already
     respects the preconditions.
   - Canary test (`tests/fullcall/canary-signaling-audit.test.ts`)
     still fires `rfc.contentLength` on a deliberately broken INVITE.

## PA checks landed

| ID | Method | Check | Cost | Notes |
|---|---|---|---|---|
| `PA1_bindOpts_validAddr` | `bindUdp` | `opts.ip` non-empty string + `opts.port` integer in 0..65535 | µs — always on | `port: 0` accepted (ephemeral allocation on real impl; simulated treats it as the literal port 0). |
| `PA2_bindOpts_queueMax` | `bindUdp` | `opts.queueMax` positive integer | µs — always on | A `0` queueMax would deadlock the simulated fabric on first enqueue. |
| `PA3_send_validDest` | `send` | `dstAddress` non-empty string + `dstPort` integer in 1..65535 | µs — always on | Port `0` is illegal as a destination. |
| `PA4_send_msgBuffer` | `send` | `msg` is Buffer with length > 0 | µs — always on | Empty UDP frames are never legitimate SIP. |
| `PA5_send_msgSizeBound` | `send` | `msg.length ≤ MAX_UDP_PAYLOAD (65507)` | µs — always on | The theoretical max UDP payload (65535 - 20 IP - 8 UDP). SIP fragments above ~1.4 KB but the wrapper only rejects values the kernel itself cannot accept. |

**Not wrapped** (sync getters / mutators with no caller-side
precondition worth enforcing):
- `inFlight()`, `queueDepth()`, `transitDelayMs`, `queueDepths()`
- `drainTrace()`, `drainUndeliverable()`
- `bumpInFlight(delta)` — sync mutator. Considered adding a "delta is
  finite integer" check; declined because the only call site is
  `UdpTransport.ts:122` which forwards a fresh integer from
  `BufferedUdpEndpoint`'s internal accounting. Adding a check there
  would catch nothing the type-system doesn't already enforce.

## Perf checkpoint 2

Two consecutive `npm run test:fake` runs per configuration (matching
Slice 1's protocol):

| Config       | Run 1    | Run 2    | Average  |
| ------------ | -------- | -------- | -------- |
| baseline     | 25.16 s  | 25.10 s  | 25.13 s  |
| no-audit     | 25.34 s  | 25.49 s  | 25.42 s  |
| full         | 25.59 s  | 25.76 s  | 25.68 s  |

Deltas:

- **`no-audit` vs `baseline`: +0.29 s (+1.2 %).** Well below the +10 %
  alert threshold. Recording-channel overhead is in the noise; the
  per-method `recordEffectCall` / `recordStreamLifecycle` pass-through
  is essentially free at this suite size.
- **`full` vs `baseline`: +0.55 s (+2.2 %).** Far below the +50 % soft
  ceiling. The five paranoid checks plus the 24-rule pack plus
  per-bindUdp finalizers all in, the cost is still noise-dominated.
- **`full` vs `no-audit`: +0.26 s (+1.0 %).** PA + rules together cost
  ~250 ms across a 25 s suite. PA itself is in the µs-per-call range;
  the rule pack runs once per `bindUdp` scope close on the filtered
  event slice. Neither hot path needs targeted optimisation.

Read: same conclusion as Slice 1 — noise dominates all three deltas;
no quadratic-rule blunders, no recording-channel surprises. The
checkpoint passes its threshold checks comfortably. Perf checkpoint 3
lands at Slice 14 once the full wrapper stack covers all five layers.

Note: numbers are slightly lower than Slice 1's (~25 s vs ~30 s)
because of intervening Slice 2a/2b/4/5/6 wins (stack unification, the
old RFC runner deletion). The relative deltas remain the meaningful
signal.

## Anomalies / deviations from the plan

- The plan suggested PA1 might be env-gated like the codec's. For
  SignalingNetwork all five checks are µs-scale type/range guards —
  no Schema.is, no buffer round-trip. Made all five always-on; no
  env switch needed.
- The plan listed `port` validation as `(0, 65535]` for both bindUdp
  and send. Bind accepts `port: 0` (ephemeral allocation on the real
  impl, literal-port-0 on the simulated fabric). Send must have a
  positive destination port. PA1 / PA3 differ accordingly.
- The `paranoidInputs?: boolean` flag on
  `SignalingNetworkContractsOptions` lets callers opt out without
  rebuilding the whole option payload — keeps the perf-checkpoint
  "no-audit" mode a one-line stackLayer change.

## Caller bugs caught: none

The PA layer caught no pre-existing violations. Every `bindUdp`/`send`
call site in `src/` and `tests/` already passes well-formed inputs.
That's the expected outcome — the codec's `paranoidInputs` similarly
turned up no caller bugs when it landed.

## Slice 8 handoff (codec retrofit)

One observation for Slice 8: the codec's existing wrappers compose by
direct function nesting (`scopedAudit(propertyTest(MsgpackLayer))`)
rather than through `withCanonicalContracts`. When the codec retrofits
its typed-channel recording in Slice 8, the natural way to integrate
is the same per-Tag `withAllContracts(impl, options)` forwarder shape
SignalingNetwork now uses. That keeps the canonical-order constraint
centralised and lets the codec's `parity` keep its current outside-the-helper
position (per D7: `parity` is not in `withCanonicalContracts`; build the
parity layer first, pass it as `impl`).

The other observation: SignalingNetwork's `paranoidInputs` wraps the
endpoint object returned by `bindUdp` (the `send` precondition lives
on the endpoint, not on the service-level API). The codec has no
analogous nested surface — encode/decode live directly on
`CallBodyCodecApi` — so the retrofit is structurally simpler. The PA
layer is already in place there since the original landing.
