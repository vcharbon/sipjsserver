# SignalingNetwork refactor — surprises & follow-ups

Grilling pass (2026-04-19) resolved each item below. This doc is now the
spec for the follow-up slices; the original junior write-up is preserved
in git history.

## Resolved



---

## Follow-up work (spec)

### Slice B — strict fake / live test split

The project splits the test harness into two non-mixing modes. This is
the durable fix for H2 (settle-sleep hazard) and M4 (under-specified
settle contract), and it unlocks the 24h TestClock sweep.

**Principle.** A test is either fully fake (TestClock + simulated
network + in-memory CallStateCache + in-memory CallLimiter + mock HTTP
call-control) or fully live (real clock + real UDP + real Redis + real
HTTP). Nothing in between.

**In-memory service variants (must land first).**
- `src/call/CallStateCache.ts`: add `memoryLayer` sibling to
  `redisLayer`. Same-module colocation per Effect convention.
- `src/call/CallLimiter.ts`: rename existing `layer` → `redisLayer`; add
  `memoryLayer`. Both variants must drive time via
  `Clock.currentTimeMillis` — never `Date.now()`. This is the invariant
  that makes the 24h TestClock sweep actually flush limiter windows.

**Directory layout.**
```
tests/scenarios/                 — SHARED scenarios (from tests/e2e/scenarios/)
tests/support/
  fakeStack.ts                   — FakeStackLayer = Layer.mergeAll(memoryLayer×2,
                                   SignalingNetwork.simulated, MockCallControl, …)
  liveStack.ts                   — LiveStackLayer = Layer.mergeAll(redisLayer×2,
                                   SignalingNetwork.real, real HTTP call-control, …)
  testAppConfigDefaults.ts       — M1 resolution
  harness.ts                     — SHARED runner; takes a stack layer
tests/fake/**/*.test.ts          — it.effect only
tests/live/**/*.test.ts          — it.live only
tests/fullcall/                  — renamed from tests/e2e/ — signals
                                   "near-real call simulation, not unitary"
vitest.config.fake.ts
vitest.config.live.ts
```

**Import boundary.** ESLint `no-restricted-imports`:
- `tests/fake/**` cannot import `SignalingNetwork.real`, `it.live`, real
  Redis clients, or `liveStack.ts`.
- `tests/live/**` cannot import `TestClock`, `MockCallControlLayer`,
  `memoryLayer` variants, or `fakeStack.ts`.

> _Deferred:_ the project does not currently ship ESLint config; add this
> rule only if/when ESLint is introduced. Without it the boundary is
> enforced by directory layout + fake/live stack-layer selection only.

**Scenario tiering (new metadata).** Add
`readonly tier?: "short" | "medium" | "long"` to `Scenario` in
[tests/e2e/framework/types.ts](../../tests/e2e/framework/types.ts).
Default = short.

| Tier | Budget | Signal |
|------|--------|--------|
| short | ≤ 2s real | happy path, basic signaling, BYE. No retransmit reliance. |
| medium | ≤ 30s real | first INVITE retransmit (T1=500ms), Timer E/F, one limiter-window traversal |
| long | > 30s real | Timer B/H (32s), `noAnswerTimeoutSec`, keepalive timeout |

**Package scripts.**
```
test:fake               # tests/fake/**
test:live:short         # tier=short (default live)
test:live:medium        # tier ∈ {short, medium}
test:live:long          # tier ∈ {short, medium, long}
test                    # test:fake && test:live:short
test:ci                 # test:fake && test:live:medium
test:nightly            # test:fake && test:live:long
```

**End-of-scenario sweep (kills H2 band-aid).**
- Fake: `yield* TestClock.adjust("24 hours")` + scheduler-yield loop. Fires
  every pending SIP retransmit, Timer B/H, CallState cleanup, limiter
  migration. Order is: sweep → drain-for-unexpected → `verifyCleanState`.
- Live: short real sleep (~100ms) for ingress-gap only. Live is
  explicitly NOT tasked with retransmit-sweep detection — that's fake's
  job. Split documented on `TestTransport.settle` interface.
- Expected fallout: existing scenarios that currently end mid-dialog
  will surface leaks when the sweep fires timers. Fix by adding `.bye()`
  where appropriate; scenarios that deliberately leave state dirty opt
  out via `{ skipFinalSweep: true }`.

**H2 structural fix (prerequisite for killing the 10ms sleep).** Stamp
`arrivalMs` at ingress inside `SignalingNetwork` (either as a field on
`UdpPacket` or via an optional bind-time callback), then have the live
backend read endpoint.messages directly. This eliminates the two-queue
hop (`endpoint queue → Stream.runForEach fork → per-agent
ReceivedPacket queue`) and removes the reason the 10ms settle sleep was
needed.

**Redis drift protection (M3).** Remove `NETWORK_DELAY_MS` from
simulated-backend.ts. Expose `transitDelayMs` as a readonly field on the
`SignalingNetwork` service (simulated: the configured value; real:
`undefined`). Trace renderer reads from the service.

**Test fixture dedup (M1).** `testAppConfigDefaults()` in
`tests/support/`. Retrofit the two existing call sites
([tests/sip/UdpTransport-brake.test.ts:33-81](../../tests/sip/UdpTransport-brake.test.ts#L33-L81)
and [tests/e2e/framework/simulated-backend.ts](../../tests/e2e/framework/simulated-backend.ts)).
Deliberately NOT in `src/` — test fixtures don't ship with prod.

---

### Slice C — mechanical cleanups

**M2 — `UdpTransportMetrics` idiomatic getters.** Replace the
`Object.defineProperty` block at
[src/sip/UdpTransport.ts:107-127](../../src/sip/UdpTransport.ts#L107-L127)
with a plain object using getter syntax:
```ts
const metrics: UdpTransportMetrics = {
  queueMax,
  get queueDepth() { return endpoint.queueDepth() },
  get dropsTailDrop() { return endpoint.counters.tailDropped },
  get dropsTier1Brake() { return dropsTier1Brake },
  get tier1RejectSent() { return tier1RejectSent },
}
```
No separate snapshot API — both Prometheus scraping and test reads want
live values.

**L1 — `Global 'Error' loses type safety` pattern.** Add a short section
to [docs/typescript-effect.md](../typescript-effect.md) with the exact
warning text and the `Effect.orDie` fix.

**L2 — `verifyCleanState` extension points.** Add a comment on
`TestTransport.verifyCleanState?` in
[tests/e2e/framework/types.ts](../../tests/e2e/framework/types.ts)
listing what's currently checked and pointing to the extension pattern.

---

## Out of scope / no action

**L3 — `Effect.catch` vs `catchAll`.** Already covered by the effect
skill.

**L4 — plan filename gibberish.** Claude Code harness behavior, not
codebase work.

**HK1 — `sippperftest/README.md` unrelated diff.** Ask the doc owner
before touching.

---

## Implementation order

1. **Slice B.1** — in-memory variants. `CallStateCache.memoryLayer`,
   `CallLimiter.redisLayer` rename + `memoryLayer`. Unit tests proving
   TestClock drives window rotation.
2. **Slice B.2** — stamp `arrivalMs` at ingress in `SignalingNetwork`;
   collapse two-queue hop in live-backend; delete the 10ms settle sleep.
3. **Slice B.3** — `fakeStack.ts` / `liveStack.ts` + runner plumbing;
   move scenarios to `tests/scenarios/`; M1 and M3 fall out here.
4. **Slice B.4** — scenario tiering metadata, 24h TestClock sweep in
   `settle`, fix cascade-broken scenarios (add `.bye()`), ESLint
   `no-restricted-imports` on both sides.
5. **Slice B.5** — rename `tests/e2e/` → `tests/fullcall/`; vitest config
   split; npm scripts; short CLAUDE.md section documenting the
   structure (supersedes the original H3 ask).
6. **Slice C** — M2 getter cleanup, L1/L2 doc additions. Non-blocking;
   can land alongside any of the above.
