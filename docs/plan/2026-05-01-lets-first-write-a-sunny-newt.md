# Slice 4 — Closing the failover loop (auto-flush + per-method E2E replication matrix)

This plan is done to complete [previous work](docs/plan/management-of-k8s-reliability-compiled-dijkstra.md)

## Context

Slices 3a-3c laid the harness foundation for fake-clock failover testing of
the SIP B2BUA: simulated `SimulatedK8sCluster`, `WorkerConnectivity` gate,
`PeerFabric` per-peer storage, and per-worker `ReplPuller` pull loops
([k8sFakeStack.ts](../../tests/support/k8sFakeStack.ts)). The first
failover test
([basic-call-primary-killed.test.ts](../../tests/sip-front-proxy/failover/basic-call-primary-killed.test.ts))
proves alice's BYE post-kill is routed via `decode_forward_backup` to
the backup, which now finds a replicated copy and answers 200 OK on
the a-leg. Bob's b-leg side is still broken (CANCEL instead of BYE)
because the bak: snapshot is stuck at the b-leg "trying" state.

Closing the failover loop requires four things:

1. **Fully consistent replication for every state-mutating rule** — not
   just `confirm-dialog`. Every in-dialog method that changes the call
   (BYE, INFO, UPDATE, MESSAGE, re-INVITE, PRACK, NOTIFY, OPTIONS,
   timer firings, …) must be mirrored to the backup partition before
   the next event lands. Without this, every method becomes its own
   stale-state hazard. The auto-flush approach (next section) covers
   this by construction — but we MUST verify with a comprehensive
   per-method test matrix, not just one BYE test.

2. **Two stub harness primitives** — `cluster.respawn()` and
   `cluster.expectRoutedTo()` ship as `skip` records today
   ([interpreter.ts:522-534](../../tests/fullcall/framework/interpreter.ts#L522-L534)
   and [interpreter.ts:700-713](../../tests/fullcall/framework/interpreter.ts#L700-L713)).
   The respawn primitive must take a controllable downtime (via the
   surrounding `s.pause()` call between kill and respawn) so scenarios
   exercise both short and long outages.

3. **Two missing in-dialog request rules** — UPDATE and MESSAGE have
   2xx-response handlers (`relay-non-invite-200`,
   [DialogRules.ts:241-254](../../src/b2bua/rules/defaults/DialogRules.ts#L241-L254))
   but no request-relay rules registered in `defaultRules`
   ([defaults/index.ts:79-85](../../src/b2bua/rules/defaults/index.ts#L79-L85)).
   The factory `makeTransparentRelayRule` already exists in
   [RelayRules.ts:20-41](../../src/b2bua/rules/defaults/RelayRules.ts#L20-L41);
   we just need two more `defineRule` lines.

4. **Per-method × per-direction × per-failover-pattern test matrix** —
   each in-dialog method tested with both alice-initiated and
   bob-initiated requests, against single-switch and double-switch
   failover patterns. Each scenario uses the existing fullcall framework
   so HTML + txt reports are auto-generated via `flushIndexReport`.

We split the work into two slices to bound blast radius. **Slice 4a**
is production-code (auto-flush + 2 missing rules). **Slice 4b** is
harness work + the test matrix.

---

## Implementation discipline (applies to BOTH slices)

Tests land **one at a time**. The explicit cycle for every new test:

1. Write the test against the current implementation.
2. Run it (`npx vitest run --config vitest.config.fake.ts <path>`).
3. If it fails: diagnose, fix in the smallest possible delta, re-run.
4. Verify non-regression with `npm run typecheck` clean and the full
   `npm run test:fake` green (not just the new test).
5. Commit the test + any fix together. Move to the next test.

No batch-writing of a dozen scenario files. No "I'll fix three at
once." The reason: in slice 3c we discovered the b-leg-stale issue
only because the previous test failed in a specific way. Writing
multiple scenarios up-front would have masked that signal.

---

## Slice 4a — Auto-flush on call-state mutation + missing relay rules

### Goal

The rule framework should automatically persist the call (and its
embedded timer entries) to Redis whenever a rule mutates state, with
no per-rule `flush-redis` emission needed. UPDATE and MESSAGE
in-dialog requests must also be relayed end-to-end so the matrix can
exercise them.

### 4a.1 — Auto-flush in `RuleExecutor`

The rule framework already holds the canonical "did this rule change
state?" signal: in [RuleExecutor.ts:200-235](../../src/b2bua/rules/framework/RuleExecutor.ts#L200-L235),
`callBefore` (input) and `result.call` (post-action) are both in
scope. Action mutations always produce a new object via immutable
`updateLeg` / `updateDialog` helpers, so reference equality is sound.

**Insertion point**: in `RuleExecutor`, just before each
`return enforceInvariants(callBefore, result)` site. Hoist a small
helper:

```ts
function appendAutoFlush(callBefore: Call, result: HandlerResult): HandlerResult {
  if (result.call === callBefore) return result
  if (result.effects.some((e) => e.type === "flush-redis")) return result
  return {
    ...result,
    effects: [...result.effects, { type: "flush-redis" }],
  }
}
```

Apply at every return site (composed and non-composed paths). The
existing manual emissions at [helpers.ts:332](../../src/b2bua/helpers.ts#L332)
and [ActionExecutor.ts:1689](../../src/b2bua/rules/framework/ActionExecutor.ts#L1689)
become redundant but harmless — the de-dup keeps slice-4b HA tests
counter-clean. Removing those manual emissions is a follow-up
cleanup.

### 4a.2 — Why this covers EVERY in-dialog method (by construction)

The auto-flush is policy-free: any rule whose actions produce a new
`Call` triggers a flush. Below is the full audit of state-mutating
rules under [src/b2bua/rules/](../../src/b2bua/rules/):

| Rule | File | Mutates state via | Was flushing? | Now flushes? |
|------|------|-------------------|---------------|--------------|
| `confirm-dialog` (200 OK INVITE) | DialogRules.ts:46-145 | `confirm-dialog`, `merge`, `update-leg-state` | no | yes (CRITICAL) |
| `relay-provisional` (1xx) | DialogRules.ts:17-44 | `relay-to-peer` (updates remoteCSeq) | no | yes |
| `relay-bye` | RelayRules.ts:64-85 | `terminate-leg`, `begin-termination` | yes (manual) | yes (de-dup) |
| `relay-ack` | RelayRules.ts:87-107 | `relay-to-peer` (sometimes updates state) | no | yes when state changes |
| `relay-options` | RelayRules.ts:46 | `relay-to-peer` | no | yes when state changes |
| `relay-info` | RelayRules.ts:55 | `relay-to-peer` | no | yes when state changes |
| `relay-update` (NEW, 4a.3) | (added) | `relay-to-peer` | n/a | yes when state changes |
| `relay-message` (NEW, 4a.3) | (added) | `relay-to-peer` | n/a | yes when state changes |
| `relay-reinvite` | RelayRules.ts:112 | `relay-to-peer` | no | yes |
| `relay-prack` | RelayRules.ts:121 | `relay-to-peer` | no | yes |
| `relay-reinvite-response` | CornerCaseRules.ts:165 | dialog updates | no | yes |
| `cancel-200-crossing` | CornerCaseRules.ts:43 | leg state change | no | yes |
| `relay-non-invite-200` | DialogRules.ts:243 | dialog/leg updates | no | yes |
| `absorb-bye-200` / `absorb-options-200` / `absorb-notify-200` | DialogRules.ts:150,179,… | `actions: []` | no | NO — no state change |
| `handle-cancel` | LifecycleRules.ts:34-67 | destroy-leg, cancel-leg, begin-termination | yes (via begin-termination) | yes (de-dup) |
| `handle-481` | LifecycleRules.ts:120-151 | terminate-leg, begin-termination | yes (via begin-termination) | yes (de-dup) |
| `handle-timeout` | LifecycleRules.ts:13-29 | begin-termination | yes (via begin-termination) | yes (de-dup) |
| Timer rules (`max-duration`, `keepalive`, `keepalive-timeout`) | TimerRules.ts | various — state mutations on timer fire | no | yes |
| Failure rules (`route-failure`, `no-answer-failover`, `absorb-stale-failure`) | FailureRules.ts | various | no | yes |
| Transfer rules (REFER) | TransferRules.ts | dialog/leg/transfer state | varies | yes |
| `confirm-dialog` (transfer C-leg) | TransferRules.ts:594-599 | C-leg state change | no | yes |
| Custom: `relayFirst18x_to_180` | custom/relayFirst18xTo180.ts | tag-mapping pre-seed | no | yes |

**Key property**: timer entries are part of `Call.timers` (immutable
field updated alongside the `schedule-timer` effect, e.g.
[ActionExecutor.ts:1684](../../src/b2bua/rules/framework/ActionExecutor.ts#L1684)
and [helpers.ts:328](../../src/b2bua/helpers.ts#L328)). `flushToRedis`
serialises the entire `Call` via `JsonCallSchema` ([CallState.ts:303-353](../../src/call/CallState.ts#L303-L353)),
so the timer schedule travels with the call body. A backup taking
over re-arms the timer via `TimerService.restoreFromEntries`. **No
extra plumbing needed**.

### 4a.3 — Add UPDATE and MESSAGE relay rules

Edit [src/b2bua/rules/defaults/RelayRules.ts](../../src/b2bua/rules/defaults/RelayRules.ts):

```ts
/** Relay in-dialog UPDATE end-to-end (RFC 3311; payload-transparent). */
export const relayUpdateRule: RuleDefinition<undefined, undefined> =
  makeTransparentRelayRule("UPDATE", {
    id: "relay-update",
    name: "Relay UPDATE",
  })

/** Relay in-dialog MESSAGE end-to-end (RFC 3428; payload-transparent). */
export const relayMessageRule: RuleDefinition<undefined, undefined> =
  makeTransparentRelayRule("MESSAGE", {
    id: "relay-message",
    name: "Relay MESSAGE",
  })
```

Register in [src/b2bua/rules/defaults/index.ts:79-85](../../src/b2bua/rules/defaults/index.ts#L79-L85).
Add `relayUpdateRule` and `relayMessageRule` to `defaultRules`.

Also verify that ActionExecutor.relayRequest accepts UPDATE / MESSAGE
([ActionExecutor.ts:629-630](../../src/b2bua/rules/framework/ActionExecutor.ts#L629-L630)
already lists them).

### 4a.4 — Files modified

- [src/b2bua/rules/framework/RuleExecutor.ts](../../src/b2bua/rules/framework/RuleExecutor.ts) — auto-flush helper + apply at every return.
- [src/b2bua/rules/defaults/RelayRules.ts](../../src/b2bua/rules/defaults/RelayRules.ts) — add UPDATE and MESSAGE.
- [src/b2bua/rules/defaults/index.ts](../../src/b2bua/rules/defaults/index.ts) — register them.

### 4a.5 — Tests

- New unit test under [tests/b2bua/rules/](../../tests/b2bua/rules/) covering the auto-flush behaviour: a rule that mutates state without emitting `flush-redis` produces an effect list containing one; a rule that emits both produces only one (de-dup); a rule whose actions don't change state (e.g. `absorb-bye-200`) produces no flush.
- New unit tests for `relay-update` and `relay-message` rule registration + relay behaviour (mirror existing `relay-info` test if any).
- Update existing assertions under [tests/sip-front-proxy/HA/](../../tests/sip-front-proxy/HA/) and [tests/replication/](../../tests/replication/) for any propagate-set ZADD count drift caused by new flushes.
- Slice 3c's [basic-call-primary-killed.test.ts](../../tests/sip-front-proxy/failover/basic-call-primary-killed.test.ts) — drop `bob.allowExtra("CANCEL")` and `bob.allowExtra(487)` (no longer needed) and assert bob receives a real BYE.

### 4a.6 — Verification

1. `npm run typecheck` clean.
2. `npm run test:fake` ≥ 877 passing (any shifted ZADD-count tests fixed in same commit). +N new tests for auto-flush + UPDATE/MESSAGE.
3. The slice 3c failover test now verifies a clean a-leg + b-leg BYE round-trip end-to-end (no `allowExtra` admissions remaining).

---

## Slice 4b — Harness primitives + per-method E2E replication matrix

### Goal

Materialise the slice-3b stubs against real cluster machinery, then
build a parameterised test matrix that exercises bidirectional
replication for every in-dialog method, both as a single-switch and
as a double-switch failover.

### 4b.1 — Per-worker child Scope plumbing in `k8sFakeStack`

Today's [k8sFakeStack.ts](../../tests/support/k8sFakeStack.ts) builds
all workers eagerly via `Layer.mergeAll(...workerInstances)`. Each
worker must own its lifecycle scope so respawn can rebuild one
without touching peers.

**Refactor**:

- Replace eager `Workers` layer with an effectful builder inside
  `Layer.effectDiscard(...)`. For each worker, open a child scope via
  `Scope.fork` from the SUT scope and call a `buildWorker(workerId)`
  closure that returns `{ scope, services }`.
- Track per-worker handles in a Map exposed via the cluster facade:
  ```ts
  interface WorkerRuntimeHandle {
    readonly id: WorkerId
    readonly scope: Scope.Closeable
    readonly buildWorker: () => Effect.Effect<...>  // for respawn rebuild
  }
  ```
- The existing per-worker setup (UdpTransport binding, SipRouter
  fiber, WorkerConnectivity bind, ReplPuller pull loops, ReadyGate
  drain) moves inside `buildWorker` so closing the child scope tears
  down EVERY worker-side fiber atomically.

**Reference pattern**: [proxyB2bFakeStack.ts:248-256](../../tests/support/proxyB2bFakeStack.ts#L248-L256).

### 4b.2 — `cluster.kill` extension and `cluster.respawn` implementation

Update [SimulatedK8sCluster.ts](../../tests/support/SimulatedK8sCluster.ts):

- **`kill(id, timing?)`** — append a phase 5 `Scope.close(workerHandle.scope, Exit.void)` after the existing 4-phase pipeline. SipRouter / UdpTransport / ReplPuller fibers are interrupted cleanly.
- **`respawn(id, opts?)`** (replaces stub):
  1. Pre-condition: worker is `dead` (registry), gate disconnected, scope closed.
  2. `PeerFabricControl.rebootWorker(ordinal)` — fresh storage handle.
  3. `WorkerConnectivity.reconnect(id)` — gate flag flipped on.
  4. `WorkerRegistrySimulatedControl.add(id, address)` with `health="unknown"`.
  5. `Scope.fork(sutScope)` → call `buildWorker(id)` against the new scope. Register the new handle.
  6. Inside `buildWorker`, the post-spawn flow includes `yield* (yield* ReadyGate).run` BEFORE forking the SipRouter ingest. Drain completes within the 30s ceiling (instant under TestClock for empty propagate sets).

**Controllable downtime** comes naturally from the DSL: the test calls `s.pause(Nms)` between `cluster.kill(id)` and `cluster.respawn(id)`. The respawn primitive itself is instantaneous; the gap is the test's choice.

A `RespawnEvent` is recorded into `phaseEvents` for `expectKillPhase`-style assertions if needed.

### 4b.3 — `expectRoutedTo` via metric snapshot delta

The proxy already records routing decisions:
- `sip_routing_decision_total{strategy, decision}` ([ProxyCore.ts:555-558](../../src/sip-front-proxy/ProxyCore.ts#L555-L558))
- `sipfp_decode_forward_promoted_total{from}` ([Metrics.ts:124-131](../../src/sip-front-proxy/observability/Metrics.ts#L124-L131))

**Implementation**:

1. Extend `SimulatedK8sClusterApi` with `snapshotRoutingMetrics: Effect.Effect<RoutingMetricsSnapshot>`.
2. The DSL's `cluster.expectRoutedTo(workerId, opts)` records a baseline snapshot when first emitted into the scenario; the assertion post-step verifies the delta.
3. Replace [interpreter.ts:700-713](../../tests/fullcall/framework/interpreter.ts#L700-L713) `skip` block with the snapshot-delta logic.

DSL signature:
```ts
cluster.expectRoutedTo(workerId: string, {
  decision: RoutingDecisionKind  // "decode_forward_backup" | "decode_forward" | ...
  minCount?: number              // default 1
}): K8sStep
```

`from="dead"` filter is deferred (would require expanding `DecodeForwardPromotionReason`).

### 4b.4 — ReadyGate wiring on (re)spawn

Inside `buildWorker(...)`:

```ts
const PeerEnumeratorL = Layer.sync(PeerEnumerator, () => ({
  currentPeers: Effect.succeed(otherWorkers.map((w) => w.ordinal)),
}))
const ReplogClientL = Layer.sync(ReplogClient, () => ({
  streamFromPeer: (peer) =>
    peerLogs.get(peer)?.stream(self, /* sinceSeq */ 0, { drainOnly: true })
      ?? Stream.empty,
}))
const ReadyGateL = ReadyGate.layer().pipe(
  Layer.provide(Layer.mergeAll(
    PeerEnumeratorL,
    ReplogClientL,
    Layer.sync(ReplPuller, () => puller),
    WorkerReadiness.test(false),
  ))
)
```

Run on boot: `yield* (yield* ReadyGate).run` BEFORE `Effect.forkIn(router.start(handlers), scope)`. Drain blocks under the 30s ceiling.

`WriteNotifier.noopLayer` remains acceptable (slice 3c reasoning: backlog drain on `drainOnly` mode picks up everything in the propagate set at open-time).

### 4b.5 — Test matrix structure

**Shared scenario builder** (new file `tests/sip-front-proxy/failover/_matrix.ts`):

```ts
type Method = "BYE" | "INFO" | "UPDATE" | "MESSAGE" | "REINVITE" | "PRACK"
type Initiator = "alice" | "bob"
type SwitchPattern = "single" | "double"

interface MatrixCase {
  readonly method: Method
  readonly initiator: Initiator
  readonly switchPattern: SwitchPattern
}

export function buildFailoverScenario(c: MatrixCase): Scenario { ... }
```

The builder constructs a scenario with the standard alice ↔ bob ↔ proxy
↔ workers topology, runs the INVITE/200/ACK setup, performs the
failover sequence (one or two kill/respawn pairs), then exercises the
in-dialog method as the chosen initiator. Each scenario runs against
the `k8sFailover` SUT.

**Single-switch sequence**:
1. INVITE established via b2b-1 (cookie pins primary=A, backup=B).
2. `s.pause(1_000)` — replication settle.
3. `cluster.kill("b2b-1")`.
4. `cluster.expectRoutedTo("b2b-2", { decision: "decode_forward_backup" })`.
5. method (alice→bob OR bob→alice depending on `initiator`).
6. BYE alice→bob to terminate cleanly.
7. Single-owner invariant: `pri:b2b-2:call:*` empty throughout.

**Double-switch sequence**:
1. INVITE established via b2b-1.
2. `s.pause(1_000)`.
3. `cluster.kill("b2b-1")` — first switch.
4. method #1 (chosen test method, post-kill-A).
5. `s.pause(2_000)` — controllable downtime; arbitrary value, the test exercises both fast and slow recovery.
6. `cluster.respawn("b2b-1")` — A boots, ReadyGate drains B's reverse-propagate stream.
7. `s.pause(500)` — let pri:A: rebuild.
8. `cluster.expectCallStateOn("b2b-1", { partition: "pri", owner: "b2b-1" })` — A holds the call again.
9. `cluster.kill("b2b-2")` — second switch (backup is now killed; A keeps serving as primary, no failover destination but no new failover needed for cleanup).
10. method #2 (same method, opposite direction OR same — case-defined).
11. BYE to terminate.
12. Single-owner invariant assertions.

### 4b.6 — Test files

Each combination is its own `.test.ts` file under
`tests/sip-front-proxy/failover/matrix/`. The path-naming convention
(used for HTML+txt report grouping):

```
tests/sip-front-proxy/failover/matrix/
  bye-alice-single.test.ts
  bye-alice-double.test.ts
  bye-bob-single.test.ts
  bye-bob-double.test.ts
  info-alice-single.test.ts
  info-alice-double.test.ts
  info-bob-single.test.ts
  info-bob-double.test.ts
  update-alice-single.test.ts
  update-alice-double.test.ts
  update-bob-single.test.ts
  update-bob-double.test.ts
  message-alice-single.test.ts
  message-alice-double.test.ts
  message-bob-single.test.ts
  message-bob-double.test.ts
  reinvite-alice-single.test.ts
  reinvite-alice-double.test.ts
  reinvite-bob-single.test.ts
  reinvite-bob-double.test.ts
  prack-alice-single.test.ts
  prack-alice-double.test.ts
  prack-bob-single.test.ts
  prack-bob-double.test.ts
```

24 scenarios total. Each file:
- Imports the shared builder.
- Defines `OUTPUT_DIR = "test-results/failover/matrix/<method>-<initiator>-<pattern>"`.
- Calls `flushIndexReport(OUTPUT_DIR)` in `afterAll` so the existing fullcall framework writes its HTML + txt reports per scenario.
- Runs via `createSimulatedRunner({ outputDir, sut: "k8sFailover" })`.

**Implementation order** (the user's "one-by-one" discipline):

1. First land the **3 harness primitives** (4b.1, 4b.2, 4b.3, 4b.4) and re-validate slice 3c's basic-call-primary-killed test still passes (now with `expectRoutedTo` and no `allowExtra`).
2. Then write `bye-alice-single.test.ts` — simplest in-matrix case. Run it. Fix surfaced issues. Verify `npm run test:fake` clean.
3. `bye-bob-single.test.ts`. Repeat cycle.
4. `bye-alice-double.test.ts` — first scenario that exercises full kill→respawn loop with ReadyGate reverse-drain. Highest chance of surfacing new bugs.
5. `bye-bob-double.test.ts`.
6. INFO single ×2 (alice / bob), then INFO double ×2.
7. UPDATE single ×2, double ×2.
8. MESSAGE single ×2, double ×2.
9. re-INVITE single ×2, double ×2 — re-INVITE has SDP renegotiation, watch for offer/answer state issues.
10. PRACK single ×2, double ×2 — needs `Require: 100rel` setup; bob sends 18x reliably + alice sends PRACK.

Each step: write → run → fix → verify non-regression → commit → next.

If a step surfaces a bug that requires multiple fixes (e.g.
re-INVITE breaks the offer/answer SDP tracker), each fix is its own
commit. We do NOT proceed to the next test file until the current one
plus the full `test:fake` suite is green.

### 4b.7 — Files added / modified

- [tests/support/k8sFakeStack.ts](../../tests/support/k8sFakeStack.ts) — refactor to per-worker child scopes; add `buildWorker` closure; wire ReadyGate inside the worker scope.
- [tests/support/SimulatedK8sCluster.ts](../../tests/support/SimulatedK8sCluster.ts) — phase-5 scope close on `kill`; real `respawn` impl; `snapshotRoutingMetrics` API.
- [tests/fullcall/framework/types.ts](../../tests/fullcall/framework/types.ts) — finalise `respawn` and `expectRoutedTo` action shapes.
- [tests/fullcall/framework/interpreter.ts](../../tests/fullcall/framework/interpreter.ts) — replace both `skip` blocks with real implementations.
- [tests/sip-front-proxy/failover/basic-call-primary-killed.test.ts](../../tests/sip-front-proxy/failover/basic-call-primary-killed.test.ts) — drop `allowExtra`s; add `expectRoutedTo`.
- **NEW**: `tests/sip-front-proxy/failover/_matrix.ts` (shared scenario builder).
- **NEW**: 24 × `tests/sip-front-proxy/failover/matrix/<method>-<initiator>-<pattern>.test.ts`.

### 4b.8 — Verification

1. `npm run typecheck` clean after each landed test.
2. `npm run test:fake` green after each landed test.
3. Each scenario produces an HTML and txt report under `test-results/failover/matrix/...`. Manually spot-check at least one HTML per method to confirm the trace is readable.
4. Single-owner invariant — `pri:b2b-2:call:*` empty throughout EVERY scenario (asserted in the shared builder).
5. Determinism — pick one matrix scenario (e.g. `reinvite-alice-double`) and run it 50× same seed → bit-identical outcome under TestClock.

---

## Out of scope (still deferred after slice 4)

- **NOTIFY / SUBSCRIBE / REFER** in-dialog methods — REFER has a transfer subsystem that needs its own scenario suite; NOTIFY/SUBSCRIBE are subscription-based and out of the standard B2BUA call shape we test here. Add a `transfer-` matrix subdir in a follow-up.
- **B-leg failover** (bob's contact dies after A's failure) — needs Record-Route consultation; out of scope for this slice.
- **`ReclaimRunner` rename / redesign** — flagged in slice 0 audit; mechanical, not blocking.
- **Other `Math.random()` sites** — OverloadController, Tracing — not on failover path.
- **Reproducing a kind-suite flake as a fake-clock regression** — once the matrix is in place, picking the original `proxy-drain.test.ts` BYE-481 regression and writing its fake equivalent is a clean follow-up.
- **`from="dead"` label on `sipfp_decode_forward_promoted_total`** — production-label expansion, deferred unless a scenario demands it.
- **Triple-switch+** — once double-switch works, longer chains add no new behaviour to test.

## End-to-end verification (after 4a + 4b)

1. `npm run typecheck` clean.
2. `npm run test:fake` ≥ (877 + 24 matrix + N auto-flush unit + 2 UPDATE/MESSAGE rule unit) tests passing.
3. `npm run test:k8s` smoke gate green.
4. Spot-check 3 random matrix HTML reports for trace readability (alice INVITE, kill phase markers, respawn markers, method round-trip, BYE teardown all visible).
5. Determinism: pick `reinvite-alice-double` and run 50× same seed → identical outcome.
